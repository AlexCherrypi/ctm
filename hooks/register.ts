import type { EngineInterface, Register } from 'claude-code'
import type { IdleWatch, KeptBriefing, KeptIdleUpdates, KeptWakeups, LimitKind, LimitWatch } from '../types'

// CTM – Context and Token Manager
//
// 1. Keeps the model informed about its context window and the 5h/7d rate limits,
//    each with its change since the previous report, in a short block:
//    - on every user prompt (can be turned off)
//    - while it works, at most every N minutes on a tool result
//    - while idle, if the model turned that on (each update starts a turn)
//    - on demand through the `status` tool
// 2. Lets the model compact or clear its own conversation – only with a resume
//    prompt, and a compact only with instructions for the summary.
// 3. A short CTM briefing sits in the system prompt for good (it survives compact
//    and clear) and is sent once more after every CTM reset. Where an organization
//    manages Claude Code and keeps plugins out of the system prompt, the main agent's
//    blocks carry it instead: once, and again after the context started over.
// 4. Lets the model see its own model and effort and the models it can switch to (with
//    the engine's own descriptions where it can get them), and switch model and/or
//    effort (on its own or together with a compact or clear) – again with a resume prompt.
//    Turns Ultracode (the standing opt-in to multi-agent workflows, which no longer
//    depends on the effort) on or off the same way.
// 5. Settings the model (`settings` tool) or the person (/ctm, userConfig) can set:
//    the update interval, a compact threshold (the blocks remind the model to compact
//    once the context passes it; while it is unset they remind it now and then to ask
//    the person for one), and pause thresholds for the 5-hour and 7-day limits (the
//    blocks ask the model to pause past them; `limit_wakeup` wakes it once the limit
//    is back below).
// 6. Reads the 5h/7d limits from the server – a second `claude`'s get_usage request,
//    no model request, no tokens – while something waits on them and no response has
//    brought a newer reading; the newest reading, the server's or the host's own (from
//    the last model response), is the one that counts.
//
// Settings are kept across sessions in $.store. The armed wake-ups and idle updates are
// kept in $.state as well: a reload of the mod, or a hooks worker the engine replaces,
// starts the module over without its variables and timers (session.start runs again in
// the fresh copy, and takes them back). Everything else lives in module
// variables: it survives /clear (the module is not reloaded then) and is scoped to
// this session; a reload of the mod starts it over.

type Mode = 'compact' | 'clear'
// What runs at the end of the turn, in this order: a compact or clear, a model switch,
// an effort change (its levels depend on the model), Ultracode on or off (an effort
// change may turn it off). Any of them may be left out.
type PendingReset = {
  mode: Mode | null
  model: string | null
  effort: string | null
  ultracode: boolean | null
  instructions: string | null
  resumePrompt: string
}
type LimitReading = { percent: number; resetsAt: string | null }
// marks: the limits this block asked to pause for, so the next tool result tells of a
// newly passed one at once instead of at the interval.
type Snapshot = {
  at: number
  contextTokens: number | null
  limits: Record<string, LimitReading>
  marks: string[]
}
// What the model or the person set; a missing key falls back to userConfig.
type Settings = {
  intervalMinutes?: number
  compactThreshold?: string // "300k", "300000", "30%" or "off"
  pauseAt?: Partial<Record<LimitKind, number>> // percent; 0 = off
}
// A rate limit as a block shows it: from the server, or the host's own. asOf: a server
// reading old enough to say when it was taken.
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string; asOf?: number }
type ServerLimit = { kind: LimitKind; percentUsed: number; resetsAt?: string }
type ServerReading = { at: number; account: string | null; limits: ServerLimit[] }

const PREFIX = 'mcp__ctm__'
const T_STATUS = 'mcp__ctm__status'
const T_IDLE = 'mcp__ctm__idle_updates'
const T_RESET = 'mcp__ctm__reset'
const T_SETTINGS = 'mcp__ctm__settings'
const T_WAKEUP = 'mcp__ctm__limit_wakeup'
const T_MODELS = 'mcp__ctm__models'
const T_SWITCH = 'mcp__ctm__switch_model'
const T_EFFORT = 'mcp__ctm__set_effort'
const T_ULTRACODE = 'mcp__ctm__set_ultracode'
// The account-switcher plugin's tools: where it is installed, a block past a pause mark
// points the main agent to another of the person's accounts before asking it to pause.
const T_SWITCHER_ACCOUNTS = 'mcp__account-switcher__accounts'
const T_SWITCHER_SWITCH = 'mcp__account-switcher__switch'
const SWITCHER_CHECK_MS = 60_000
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const STORE_SETTINGS = 'settings'
const NAG_EVERY_MS = 30 * 60_000
// The compact threshold where neither the person nor the model set one (userConfig's default).
const DEFAULT_COMPACT_THRESHOLD = '350k'
// Built-in safety net: this close to a limit the blocks always ask the model to pause,
// whatever is configured. Not a setting.
const FALLBACK_PAUSE_AT: Record<LimitKind, number> = { five_hour: 95, seven_day: 97 }
const MAX_INTERVAL_MINUTES = 60
// A subagent waiting in limit_wakeup checks the limits again after each step; short
// enough that it stops soon after its signal aborts (a hook still running 5 s after
// that counts toward a runaway, and two in a row get the hooks worker replaced).
const WAIT_STEP_MS = 3_000
// It stops waiting while this much of its hook's budget is left, rather than overrun it.
const WAIT_BUDGET_MARGIN_MS = WAIT_STEP_MS + 2_000
// In a subagent's prompt: its own pause thresholds, e.g. [CTM limits: 5h=70 7d=90].
const LIMITS_MARK = /\[CTM limits:([^\]]*)\]/i

const MIN_RESUME_CHARS = 20
const MIN_INSTRUCTION_CHARS = 20
const IDLE_TICK_MS = 30_000
const TICK_DEAD_MS = 3 * IDLE_TICK_MS // no tick for this long: the ticker is gone, start it again
const RESET_DELAY_MS = 1_000
const COMPACT_CONFIRM_MS = 10 * 60_000
const CLEAR_CONFIRM_MS = 2 * 60_000
const COMPACT_POLL_MS = 5_000 // how often a /compact run as a command is checked for having shrunk the conversation
const CHECK_TIMEOUT_MS = 30_000
const CATALOG_TIMEOUT_MS = 20_000
const CATALOG_TTL_MS = 15 * 60_000
const USAGE_TIMEOUT_MS = 10_000
const USAGE_GAP_MS = 3 * 60_000 // a reading this old is taken again from the server
const USAGE_DEMAND_GAP_MS = 30_000 // between two the model asks for (status refresh)
const USAGE_MAX_AGE_MS = 10 * 60_000 // an answer older than this is the engine's cache
const USAGE_SNAPSHOT_MS = 60_000 // the engine answers get_usage from a snapshot up to this old, as fresh
const USAGE_BACKOFF_MS = 5 * 60_000 // after a failed reading, doubling each time
const USAGE_BACKOFF_MAX_MS = 60 * 60_000

const MINUTE = 60_000

const lastSent = new Map<string, number>() // recipient ('main' | agentId) -> last delivery
const previousReport = new Map<string, Snapshot>() // recipient -> snapshot of its last report
let lastTurnEndAt = 0
let lastResetAt = Number.NEGATIVE_INFINITY
let lastEffortAt = Number.NEGATIVE_INFINITY
let lastEffort: string | null = null // the main loop's effort, as its last model request carried it
let lastUltracodeAt = Number.NEGATIVE_INFINITY
let lastUltracode: boolean | null = null // Ultracode as CTM last set it; null: not set by CTM
// The engine's model list, kept for CATALOG_TTL_MS – a failed fetch too, so a host where
// it does not work is not asked again on every call.
let catalog: { at: number; list: Promise<CatalogEntry[] | null> } | null = null
let busy = false
let idle: IdleWatch | null = null
let pending: PendingReset | null = null
let awaiting: PendingReset | null = null // a reset run as a command, not yet confirmed by the engine
let awaitTimer: { cancel: () => void } | null = null
let ticker: { cancel: () => void } | null = null // wake-up checks, idle updates, server readings
let lastTickAt = Number.NEGATIVE_INFINITY // the ticker's heartbeat
let ticking = false
let restored = false // the wake-ups and idle updates kept in $.state are taken back
let settings: Settings | null = null // loaded from $.store on first use
let lastNagAt = Number.NEGATIVE_INFINITY
let lastWatchCheckAt = 0
const watches = new Map<LimitKind, LimitWatch>()
const agentPauseAt = new Map<string, Partial<Record<LimitKind, number>>>() // subagent -> its own pause thresholds
let waitingAgents = 0 // subagents waiting inside limit_wakeup
let lastDrop: string | null = null // why the engine last dropped one of CTM's own prompts
let resave = false // after /clear: the session id changed, so the kept values are written anew
// The process a waiting subagent sleeps in; null: none runs here; undefined: not probed yet.
let sleeper: string[] | null | undefined
// Where an organization manages Claude Code, the hooks of plugins a person installed do not
// run on prompt.compose (nor session.compact): the briefing then never reaches the system
// prompt, and the main agent's blocks carry it instead.
let composed = false // CTM's prompt.compose hook ran: the briefing is in the system prompt
let stepped = false // a main model request went out, so prompt.compose had its chance
let briefed = false // a block carried the briefing since the context last started over
let toldNoCompose = false // the person was told the briefing comes with the blocks here
let serverReading: ServerReading | null = null // the last good reading from the server
let usageFetch: Promise<void> | null = null // a server reading in flight
let lastUsageTryAt = Number.NEGATIVE_INFINITY
let usageFailures = 0
let usageBackoffUntil = 0
let usageError: string | null = null // why the last server reading failed
let usageOff: string | null | undefined // why the server is not read in this session; undefined = not looked yet
let lastResponseAt = Number.NEGATIVE_INFINITY // the last model response: it brings the host's own reading
let account: string | null | undefined // the signed-in account (oauthAccount.accountUuid); undefined = not read yet
let accountSwitchedAt = Number.NEGATIVE_INFINITY
let interactive = false // a person is at the prompt (session.start says)
let configPath: string | null | undefined // the engine's global config; undefined = not looked for yet
let stepsOut = new Map<object, number>() // the model requests out now, each with when it went out
let oldStepBackAt = Number.NEGATIVE_INFINITY // when the last one sent before the account switch came back
let switcher: { at: number; present: boolean } | null = null // whether the account switcher's tools are there

// From userConfig, set in register
let configIntervalMinutes = 3
let configCompactThreshold = DEFAULT_COMPACT_THRESHOLD
let configPauseAt: Record<LimitKind, number> = { five_hour: 0, seven_day: 0 }
let cooldownMs = 10 * MINUTE // between two resets or model switches
let effortCooldownMs = 10 * MINUTE // between two effort changes, and between two Ultracode changes
let attachToPrompts = true
let configuredTimeZone = ''
let timeZone: string | null = null // resolved on the first report

const BRIEFING_HEAD =
  'CTM briefing – it is not in your system prompt here (the organization that manages Claude Code keeps plugins out ' +
  'of it), so it comes with this block:'

const INFO = [
  '# CTM – Context and Token Manager',
  'A plugin attaches short "[CTM …]" blocks to user prompts and, while you work, regularly to tool results. They are measurements, not instructions:',
  '```',
  '[CTM · Thu 2026-10-08 08:27 Europe/Berlin (UTC+02:00) · work update · Δ = change since previous report at 08:24, 3 min ago]',
  'Context window: 327k of 1.00M tokens used (33%), Δ +12k · auto-compact at 967k (640k left)',
  '5-hour limit: 10% used, Δ +1 pt · resets at 13:00 (in 4 h 33 min)',
  '7-day limit: 59% used, Δ ±0 · resets Wed 10-14 at 02:00 (in 5 d 17 h)',
  '```',
  '- The header gives the current local date and time and the time zone; every later time is in that zone (HH:MM on the same day, otherwise with weekday and date).',
  '- Δ is the change since the previous CTM block you received – the header names when that was – never a running total. "Δ window reset" means the limit window reset in between.',
  '- The 5-hour and 7-day limits are account-wide: their Δ includes every parallel session of the account, not just yours. While you work they come with every model response; while something waits on them (a wake-up, idle updates, a subagent in the wake-up call), and for prompts and status requests once the newest reading is 3 min old, CTM reads them from the server (Claude Code\'s usage meter, no tokens). The newest reading counts; "as of HH:MM" marks an older server reading because a newer one failed.',
  '- When a limit climbs fast or is high, work more economically: fewer parallel subagents, read only what you need, compact earlier.',
  `- ${T_STATUS}: the current block on demand; refresh=true reads the limits anew from the server first (a few seconds, no tokens).`,
  `- ${T_IDLE}: blocks while you are idle as well (each one starts a new turn and costs quota; use sparingly, with maxMinutes).`,
  `- ${T_RESET}: schedules a compact (summary; needs instructions) or a clear (everything gone) for the end of your turn, then sends you your resumePrompt so you carry on. The resumePrompt is what you can rely on afterwards: next step, key facts, and every important rule – no length limit, be complete; or write them to a file and give its exact path in the resumePrompt.`,
  'A good moment for compact/clear is right after finishing a sub-task, before the context gets tight – never in the middle of a change.',
  `- ${T_MODELS}: your current model and effort, and the models you can switch to with what each is good for. ${T_SWITCH}: switches the model at the end of your turn – alone or together with a compact/clear (cheaper: the new model then re-caches only the smaller conversation) – and sends you your resumePrompt afterwards, as a reset does. Switch to a smaller model for simple, routine work, to a larger one for hard problems.`,
  `- ${T_EFFORT}: raises or lowers how long you think, from the end of your turn on, then you carry on. Raise it when your solutions stay half-baked or the problem is harder than it looked; lower it for routine work.`,
  `- ${T_ULTRACODE}: turns Ultracode (multi-agent workflows on every substantive task) on or off for this session, from the end of your turn on, then you carry on. It does not depend on the effort. Turn it on for exhaustive work – broad audits, migrations, hard multi-part problems – and off for routine work or when a limit runs high: workflows cost far more quota.`,
  '- If the user told you to stay on a model, an effort level or an Ultracode setting, do not change it yourself.',
  `- ${T_SETTINGS}: how often these blocks come (1–${MAX_INTERVAL_MINUTES} min), a compact threshold (tokens like 300k, or a % of the window), and pause thresholds for the 5-hour and 7-day limits. No arguments = show the current settings. Kept across sessions.`,
  '- Past the compact threshold the blocks remind you to compact: do it at the next clean point if your task allows it (a smaller context makes every further request cheaper on the limits) – never break off critical work for it.',
  '- Built-in safety net, always active and not configurable: from 95% of the 5-hour limit and 97% of the 7-day limit the blocks ask you to pause, even with no pause threshold set.',
  `- Past a pause threshold the blocks ask you to pause – a request, not a hard stop: first finish anything that must not be left half-done (e.g. a config file deleted on a live server and not yet recreated, a migration midway), then at that clean point call ${T_WAKEUP} and end your turn; you are woken once the limit is back below. Do not start new work in between. You can also use ${T_WAKEUP} on your own, e.g. "wake me when the 5-hour window has reset".`,
  `- Subagents get these blocks too. A subagent cannot end its turn and be woken – its turn ending is its end – so for it ${T_WAKEUP} waits right inside the call and returns once the limit is back below. To give a subagent its own pause thresholds, put e.g. [CTM limits: 5h=70 7d=90] into its prompt (one of the two is enough; "off" leaves only the safety net); CTM takes the mark out and tells the subagent. Lower marks for helpers let the main agent keep going a little longer than they do.`,
].join('\n')

// ---------------------------------------------------------------- Settings

function isLimitKind(k: unknown): k is LimitKind {
  return k === 'five_hour' || k === 'seven_day'
}

async function ensureSettings($: EngineInterface): Promise<Settings> {
  if (settings) return settings
  const stored = await safe(() => $.store.get(STORE_SETTINGS))
  settings = stored && typeof stored === 'object' ? { ...(stored as Settings) } : {}
  return settings
}

async function saveSettings($: EngineInterface, next: Settings): Promise<void> {
  settings = next
  await safe(() => $.store.set(STORE_SETTINGS, next))
}

function clampInterval(n: number): number {
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(1, Math.round(n)))
}

function intervalMinutes(): number {
  return settings?.intervalMinutes ?? configIntervalMinutes
}

function intervalMs(): number {
  return intervalMinutes() * MINUTE
}

// "" = unset (the blocks nag), "off" = declined (no nagging), else a threshold.
function compactThresholdSetting(): string {
  return settings?.compactThreshold ?? configCompactThreshold
}

type Threshold = { tokens: number } | { percent: number }

// 300000, "300000", "300k", "1.2m", "30%"; null when it is no threshold.
function parseThreshold(raw: unknown): Threshold | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_.,](?=\d{3}\b)/g, '')
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|m|%)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (m[2] === '%') return n > 0 && n <= 100 ? { percent: n } : null
  const tokens = Math.round(n * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1))
  return tokens >= 1_000 ? { tokens } : null
}

function thresholdTokens(t: Threshold, window: number): number {
  return 'tokens' in t ? t.tokens : Math.round((window * t.percent) / 100)
}

function fmtThreshold(t: Threshold): string {
  return 'tokens' in t ? fmtTokens(t.tokens) : fmtPercent(t.percent)
}

function pauseAt(kind: LimitKind): number {
  return settings?.pauseAt?.[kind] ?? configPauseAt[kind]
}

// A subagent's own threshold where it has one, else the common one.
function pauseAtFor(kind: LimitKind, agent?: string): number {
  return (agent ? agentPauseAt.get(agent)?.[kind] : undefined) ?? pauseAt(kind)
}

type PastMark = { kind: LimitKind; percent: number; mark: number; own: boolean; resetsAt: number | null }

// The limits past the pause mark for this agent: its threshold when passed, else the
// built-in safety net. A reading from before its window's reset counts as below.
function pastMarks(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], now: number, agent?: string): PastMark[] {
  const out: PastMark[] = []
  for (const r of rateLimits) {
    const kind = r.kind
    if (!isLimitKind(kind) || readingIsStale(r, now)) continue
    const p = pauseAtFor(kind, agent)
    const own = p > 0 && r.percentUsed >= p
    if (!own && r.percentUsed < FALLBACK_PAUSE_AT[kind]) continue
    out.push({
      kind,
      percent: r.percentUsed,
      mark: own ? p : FALLBACK_PAUSE_AT[kind],
      own,
      resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : null,
    })
  }
  return out
}

// "5h=70 7d=off" -> { five_hour: 70, seven_day: 0 }; null when nothing in it is valid.
function parseAgentLimits(raw: string): Partial<Record<LimitKind, number>> | null {
  const out: Partial<Record<LimitKind, number>> = {}
  for (const m of raw.matchAll(/(5h|7d)\s*[=:]\s*(off|\d+(?:\.\d+)?)\s*%?/gi)) {
    const n = m[2]!.toLowerCase() === 'off' ? 0 : Number(m[2])
    if (n > 100) continue
    out[m[1]!.toLowerCase() === '5h' ? 'five_hour' : 'seven_day'] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

function describeAgentLimits(own: Partial<Record<LimitKind, number>>): string {
  return (['five_hour', 'seven_day'] as const)
    .filter(k => own[k] !== undefined)
    .map(k => `${limitName(k)} ${own[k]! > 0 ? fmtPercent(own[k]!) : 'off (safety net only)'}`)
    .join(', ')
}

type WaitNext = { signal: AbortSignal; budget?: { remainingMs: number } }

// One step of a subagent's wait in a process: `sleep`, on Windows `ping` (no `sleep` is
// on its PATH by default). The first that works is kept; false where none does.
async function sleepStep($: EngineInterface): Promise<boolean> {
  const seconds = WAIT_STEP_MS / 1000
  const tries =
    sleeper !== undefined
      ? sleeper ? [sleeper] : []
      : [['sleep', String(seconds)], ...((await safe(() => $.env.get('OS'))) === 'Windows_NT' ? [['ping', '-n', String(seconds + 1), '127.0.0.1']] : [])]
  for (const argv of tries) {
    const before = await $.clock.now()
    const r = await safe(() => $.process.run(argv, { timeoutMs: WAIT_STEP_MS + 10_000 }))
    if (r?.exitCode === 0 && (await $.clock.now()) - before >= WAIT_STEP_MS / 2) {
      sleeper = argv
      return true
    }
  }
  if (sleeper === undefined) sleeper = null
  return false
}

// Waits until done() says so, in steps of WAIT_STEP_MS: 'met', 'aborted', or 'budget'
// once the hook's own budget runs low – the wait ends rather than overrun it. A hook's
// budget stops while one of its $ calls is in flight but runs on through $.clock.sleep,
// so the step is a process; $.clock.sleep only where none runs (then the budget lasts a
// few steps). done() must not wait for a server reading: the ticker takes them.
async function waitUntil($: EngineInterface, next: WaitNext, done: () => Promise<boolean>): Promise<'met' | 'aborted' | 'budget'> {
  waitingAgents += 1
  try {
    while (!(await done())) {
      if (next.signal.aborted) return 'aborted'
      if ((next.budget?.remainingMs ?? Number.POSITIVE_INFINITY) < WAIT_BUDGET_MARGIN_MS) return 'budget'
      if (!(await sleepStep($))) {
        try {
          await $.clock.sleep(WAIT_STEP_MS, { signal: next.signal })
        } catch {
          return 'aborted'
        }
      }
    }
    return 'met'
  } finally {
    waitingAgents -= 1
  }
}

// A reading whose window has reset since it was taken: rate limits come with the
// responses, so while the model pauses the last reading stays the one before the reset.
function readingIsStale(r: { resetsAt?: string }, now: number): boolean {
  return r.resetsAt !== undefined && Date.parse(r.resetsAt) <= now
}

function describeSettings(): string {
  const ct = compactThresholdSetting()
  const parsed = parseThreshold(ct)
  const isDefault = settings?.compactThreshold === undefined && ct === DEFAULT_COMPACT_THRESHOLD
  const compact =
    ct === 'off' ? 'off (declined)' : parsed ? `${fmtThreshold(parsed)}${isDefault ? ' (default)' : ''}` : 'not set (blocks remind you to ask)'
  const pause = (k: LimitKind) => (pauseAt(k) > 0 ? fmtPercent(pauseAt(k)) : 'off')
  const lines = [
    'CTM settings:',
    `- intervalMinutes: ${intervalMinutes()} (work and idle updates)`,
    `- compactThreshold: ${compact}`,
    `- fiveHourPauseAt: ${pause('five_hour')}`,
    `- sevenDayPauseAt: ${pause('seven_day')}`,
    `- briefing: ${
      composed
        ? 'in the system prompt'
        : stepped
          ? 'in the blocks – prompt.compose does not reach CTM here (an organization manages Claude Code; an administrator can make CTM one of its own plugins)'
          : 'not known yet (no model request so far)'
    }`,
  ]
  if (agentPauseAt.size > 0) {
    lines.push(
      `- subagents' own pause thresholds: ${[...agentPauseAt].map(([a, own]) => `${a}: ${describeAgentLimits(own)}`).join('; ')}`,
    )
  }
  if (watches.size > 0) {
    lines.push(
      `- limit wake-ups armed: ${[...watches.values()].map(w => `${limitName(w.kind)} below ${fmtPercent(w.below)}`).join(', ')}`,
    )
  }
  return lines.join('\n')
}

type SettingsChange = {
  intervalMinutes?: unknown
  compactThreshold?: unknown
  fiveHourPauseAt?: unknown
  sevenDayPauseAt?: unknown
}

// Applies what is given (null = back to the default); returns an error or null.
async function changeSettings($: EngineInterface, change: SettingsChange): Promise<string | null> {
  const next: Settings = { ...(await ensureSettings($)), pauseAt: { ...(settings?.pauseAt ?? {}) } }

  if (change.intervalMinutes === null) delete next.intervalMinutes
  else if (change.intervalMinutes !== undefined) {
    const n = Number(change.intervalMinutes)
    if (!Number.isFinite(n) || n < 1) return `intervalMinutes must be a number from 1 to ${MAX_INTERVAL_MINUTES}.`
    next.intervalMinutes = clampInterval(n)
  }

  if (change.compactThreshold === null || change.compactThreshold === 'default') delete next.compactThreshold
  else if (change.compactThreshold !== undefined) {
    const raw = String(change.compactThreshold).trim().toLowerCase()
    if (raw === 'off') next.compactThreshold = 'off'
    else {
      const t = parseThreshold(raw)
      if (!t) return 'compactThreshold must be tokens (e.g. 300k or 300000), a percent of the window (e.g. 30%), "off" or null.'
      next.compactThreshold = fmtThreshold(t)
    }
  }

  for (const [key, kind] of [
    ['fiveHourPauseAt', 'five_hour'],
    ['sevenDayPauseAt', 'seven_day'],
  ] as const) {
    const v = change[key]
    if (v === null || v === 'default') delete next.pauseAt![kind]
    else if (v !== undefined) {
      const n = v === 'off' ? 0 : Number(String(v).replace('%', ''))
      if (!Number.isFinite(n) || n < 0 || n > 100) return `${key} must be a percent from 1 to 100, "off" (0) or null.`
      next.pauseAt![kind] = n
    }
  }
  if (Object.keys(next.pauseAt!).length === 0) delete next.pauseAt

  await saveSettings($, next)
  return null
}

// Right after a change: the settings plus the current block, so a threshold that is
// already passed shows at once (as a ⚑ line), not only with the next block.
async function settingsAnswer($: EngineInterface, changed: boolean): Promise<string> {
  const block = await report($, changed ? 'settings changed' : 'settings')
  const passed = block.split('\n').filter(l => l.startsWith('⚑') && !l.includes('No compact threshold set'))
  const head = passed.length > 0 && changed
    ? 'Saved. ATTENTION: a threshold you just set is already passed – see the ⚑ lines below and act on them.'
    : changed
      ? 'Saved. No threshold is passed right now.'
      : ''
  return [head, describeSettings(), '', block].filter((x, i) => i > 0 || x).join('\n')
}

// A notice for the person; must never get in the way of the actual work.
function toast($: EngineInterface, text: string): void {
  void Promise.resolve()
    .then(() => $.ui.toast(text))
    .catch(() => undefined)
}

function fmtTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`
  if (abs >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function fmtSigned(n: number, fmt: (n: number) => string): string {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '±0'
}

// 4 h 37 min, 5 d 17 h, 50 min, <1 min
function fmtDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / MINUTE)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`
}

function fmtIn(ms: number): string {
  return ms <= 0 ? 'now' : `in ${fmtDuration(ms)}`
}

// Span between two shown clock times. Both are cut to the minute first, the way
// they are printed, so "06:43 … 06:46" always reads "3 min" and never "4 min".
function fmtSpan(from: number, to: number): string {
  return fmtDuration((Math.floor(to / MINUTE) - Math.floor(from / MINUTE)) * MINUTE)
}

function fmtPercent(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

// One time zone everywhere. Order: userConfig `timeZone`, the TZ variable,
// /etc/localtime or /etc/timezone (Linux, macOS, containers), the system's Intl
// zone, else UTC. Resolved once per load of the mod.
function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

async function ensureTimeZone($: EngineInterface): Promise<string> {
  if (timeZone !== null) return timeZone
  const candidates: (string | undefined)[] = [configuredTimeZone]
  candidates.push((await safe(() => $.env.get('TZ')))?.replace(/^:/, ''))
  const localtime = await safe(() => $.fs.stat('/etc/localtime', { resolve: true }))
  candidates.push(localtime?.realPath?.match(/zoneinfo\/(.+)$/)?.[1])
  candidates.push((await safe(() => $.fs.read('/etc/timezone')))?.trim())
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    // no system zone from Intl
  }
  timeZone = candidates.map(c => c?.trim() ?? '').find(isValidTimeZone) ?? 'UTC'
  return timeZone
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type LocalTime = { date: string; year: string; monthDay: string; time: string; weekday: string; offset: string }

function localTime(ms: number): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '??'
  const year = get('year')
  const monthDay = `${get('month')}-${get('day')}`
  return {
    date: `${year}-${monthDay}`,
    year,
    monthDay,
    time: `${get('hour')}:${get('minute')}`,
    weekday: WEEKDAYS[new Date(Date.UTC(+year, +get('month') - 1, +get('day'))).getUTCDay()] ?? '???',
    offset: get('timeZoneName').replace(/^GMT$/, 'GMT+00:00').replace(/^GMT/, 'UTC'),
  }
}

// The header's full stamp: Thu 2026-10-08 08:22 Europe/Berlin (UTC+02:00)
function fmtStamp(ms: number): string {
  const t = localTime(ms)
  return `${t.weekday} ${t.date} ${t.time} ${timeZone ?? 'UTC'} (${t.offset})`
}

// Any other time, relative to the header's: 13:00 the same day, "Wed 10-14 02:00" on
// another, with the year when that differs, and with the offset when it differs (DST).
function fmtClock(ms: number, ref: number): string {
  const t = localTime(ms)
  const r = localTime(ref)
  let s = t.date === r.date ? t.time : `${t.weekday} ${t.year === r.year ? t.monthDay : t.date} ${t.time}`
  if (t.offset !== r.offset) s += ` (${t.offset})`
  return s
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: '7-day limit',
  spend_limit: 'Spend limit',
}

function limitName(kind: string): string {
  return LIMIT_NAMES[kind] ?? kind
}

// ---------------------------------------------------------------- Deltas

// Every figure carries one delta against the previous report the same recipient got:
// the context in tokens, each limit in points. Nothing is compared across more than
// that one window.
function limitDelta(before: LimitReading | undefined, now: LimitReading, at: number): string | null {
  if (!before) return null
  const resetBetween =
    before.resetsAt !== null &&
    now.resetsAt !== null &&
    Math.abs(Date.parse(now.resetsAt) - Date.parse(before.resetsAt)) > MINUTE &&
    Date.parse(before.resetsAt) <= at
  if (resetBetween) {
    return `Δ window reset at ${fmtClock(Date.parse(before.resetsAt as string), at)} (was ${fmtPercent(before.percent)})`
  }
  const points = Math.round((now.percent - before.percent) * 10) / 10
  return points === 0 ? 'Δ ±0' : `Δ ${fmtSigned(points, String)} pt${Math.abs(points) === 1 ? '' : 's'}`
}

// "at 13:00" the same day, "Wed 10-14 at 02:00" on another
function fmtAt(ms: number, ref: number): string {
  const s = fmtClock(ms, ref)
  const i = s.lastIndexOf(' ', s.indexOf(':'))
  return i < 0 ? `at ${s}` : `${s.slice(0, i)} at ${s.slice(i + 1)}`
}

// ---------------------------------------------------------------- Server readings

// The host fills $.session.usage().rateLimits only from the headers of model responses:
// while the session is idle that reading stays frozen, usage elsewhere on the account
// stays unseen, and right after /login to another account it is the old account's. So
// the limits come from a second, short-lived `claude` asked for the account's usage
// meter – the SDK's get_usage request, the fetch /usage does. It sends nothing to a
// model and costs no tokens (about 3 s). The endpoint answers 429 when asked too often:
// a reading is taken only once the newest one at hand is USAGE_GAP_MS old, and a failure
// backs off. Whichever is newer counts, the server's reading or the host's own.
//
// A hook never waits for a reading another hook or the ticker started: only the hook's
// own $ calls stop its budget clock, so waiting on someone else's child process spends
// the budget, and a hook still running 5 s past it counts toward a runaway – two in a row
// and the engine replaces the hooks worker, whose fresh copy of the module has lost every
// armed wake-up that lived only in its variables. So the
// ticker (no budget) takes the readings anything waits on; a hook takes one itself only
// for a block the person or the model asked for, and only when none is in flight.

// The engine's global config (~/.claude.json), found as the engine finds it: an older
// install's <$CLAUDE_CONFIG_DIR or ~/.claude>/.config.json while that holds anything,
// else $CLAUDE_CONFIG_DIR/.claude.json or the home folder's (os.homedir(): USERPROFILE
// on Windows, also where a shell sets HOME) – .claude-custom-oauth.json with a custom
// OAuth URL.
async function configFile($: EngineInterface): Promise<string | null> {
  if (configPath !== undefined) return configPath
  const home = await safe(() => $.env.get('HOME'))
  const profile = await safe(() => $.env.get('USERPROFILE'))
  const isWindows = (await safe(() => $.env.get('OS'))) === 'Windows_NT'
  const homeDir = (isWindows ? profile || home : home || profile)?.replace(/[\\/]+$/, '')
  const configDir = (await safe(() => $.env.get('CLAUDE_CONFIG_DIR')))?.replace(/[\\/]+$/, '')
  const suffix = (await safe(() => $.env.get('CLAUDE_CODE_CUSTOM_OAUTH_URL'))) ? '-custom-oauth' : ''
  const dir = configDir || homeDir
  const current = dir ? `${dir}/.claude${suffix}.json` : null
  const legacyDir = configDir || (homeDir ? `${homeDir}/.claude` : null)
  const legacy = legacyDir ? `${legacyDir}/.config.json` : null
  const st = legacy ? await safe(() => $.fs.stat(legacy)) : undefined
  const isLegacy = st?.kind === 'file' && (st.size > 0 || !current || !(await safe(() => $.fs.stat(current))))
  configPath = isLegacy ? legacy : current
  return configPath
}

// The engine's global config, parsed; null where it cannot be read (missing, over
// $.fs.read's 4 MiB, not JSON).
async function readConfig($: EngineInterface): Promise<Record<string, any> | null> {
  const path = await configFile($)
  if (!path) return null
  const text = await safe(() => $.fs.read(path))
  try {
    const config = typeof text === 'string' ? JSON.parse(text) : null
    return config && typeof config === 'object' ? config : null
  } catch {
    return null
  }
}

// The signed-in account, as ~/.claude.json names it; null where it cannot be read
// (no claude.ai login, or the file cannot be read).
async function readAccount($: EngineInterface): Promise<string | null> {
  const id = (await readConfig($))?.oauthAccount?.accountUuid
  return typeof id === 'string' && id ? id : null
}

// Whether the session itself runs on the API key in the environment, which the host
// picks this way: -p and the SDK take it as it is (not under VS Code), a session with a
// person at the prompt only once they let it – ~/.claude.json keeps the last 20
// characters of each key they did. undefined where that cannot be read.
async function sessionUsesKey($: EngineInterface, key: string): Promise<boolean | undefined> {
  if (!interactive && (await safe(() => $.env.get('CLAUDE_CODE_ENTRYPOINT'))) !== 'claude-vscode') return true
  const config = await readConfig($)
  if (!config) return undefined
  const approved = config.customApiKeyResponses?.approved
  return Array.isArray(approved) && approved.includes(key.trim().slice(-20))
}

// True when the account changed since the last look (a /login to another one): the
// host's own reading and every delta then belong to the old account. A look that reads
// no account keeps the one known: an unreadable file is no switch.
async function checkAccount($: EngineInterface): Promise<boolean> {
  const now = await readAccount($)
  if (now === null) return false
  const before = account
  account = now
  if (before === undefined || before === null || before === now) return false
  accountSwitchedAt = await $.clock.now()
  usageFailures = 0
  usageBackoffUntil = 0
  for (const [k, p] of previousReport) previousReport.set(k, { ...p, limits: {} })
  return true
}

// Whether the host's own reading is the account's since the last switch once the response
// to a request sent at `sentAt` came: the request went out after the switch, and none
// sent before it came back since or is still out – its headers, under the old account,
// would put that one's numbers back.
function isNewAccount(sentAt: number): boolean {
  if (sentAt < accountSwitchedAt || sentAt < oldStepBackAt) return false
  for (const s of stepsOut.values()) if (s < accountSwitchedAt) return false
  return true
}

// An ISO time or epoch seconds / milliseconds -> ms; null when it is none.
function parseTime(v: unknown): number | null {
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

// Why the server is not read in this session at all, or null: nothing here changes while
// the process runs.
// - The usage meter is traffic Claude Code counts as nonessential. Where the person turned
//   that off, the child would read it only with the setting undone, and send everything
//   else nonessential with it.
// - An apiKeyHelper in the settings: the session runs on its key, not on the claude.ai
//   login, which the child – reading no settings – would read the limits of. The engine
//   counts the helper everywhere but in the desktop app, a local agent and a remote
//   session, where the host's login wins – unless the host hands in auth of its own (the
//   3p desktop app, CLAUDE_CODE_HOST_AUTH_ENV_VAR) without managing the provider.
async function serverOff($: EngineInterface): Promise<string | null> {
  if (await safe(() => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) {
    return 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, and the usage meter is nonessential traffic'
  }
  if (!(await safe(() => $.settings.read({ key: 'apiKeyHelper' })))) return null
  const entrypoint = (await safe(() => $.env.get('CLAUDE_CODE_ENTRYPOINT'))) ?? ''
  const hosted = !!(await safe(() => $.env.get('CLAUDE_CODE_REMOTE'))) || ['claude-desktop', 'claude-desktop-3p', 'local-agent'].includes(entrypoint)
  const helperCounts =
    !hosted ||
    ((!!(await safe(() => $.env.get('CLAUDE_CODE_HOST_AUTH_ENV_VAR'))) || entrypoint === 'claude-desktop-3p') &&
      !(await safe(() => $.env.get('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'))))
  return helperCounts ? 'the session runs on an apiKeyHelper, which has no rate limits to read' : null
}

type UsageAnswer = { limits: ServerLimit[] } | { error: string; final?: boolean }

async function fetchUsage($: EngineInterface): Promise<UsageAnswer> {
  const exe = (await safe(() => $.env.get('CLAUDE_CODE_EXECPATH'))) || 'claude'
  // -p would take a key from the environment over the claude.ai login the session runs
  // on, and answer that there are no rate limits.
  const key = (await safe(() => $.env.get('ANTHROPIC_API_KEY')))?.trim()
  const usesKey = key ? await sessionUsesKey($, key) : true
  if (usesKey === undefined) {
    return { error: 'the global config cannot be read, so it is not known whether the session runs on ANTHROPIC_API_KEY' }
  }
  const dropKey = !usesKey
  try {
    const r = await $.process.run(
      [
        exe,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources', // no settings: no plugins or hooks of the user's or the project's (no second CTM)
        '',
      ],
      {
        stdin: `${JSON.stringify({ type: 'control_request', request_id: 'ctm', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`,
        env: dropKey ? { ANTHROPIC_API_KEY: '' } : {},
        timeoutMs: USAGE_TIMEOUT_MS,
      },
    )
    refusedBy(r)
    const answer = parseUsage(r.stdout, await $.clock.now())
    if ('error' in answer && answer.error === 'no answer' && r.exitCode !== 0) {
      const why = r.stderr.trim().split('\n')[0]?.slice(0, 200)
      return { error: `the second claude exited with ${r.exitCode}${why ? `: ${why}` : ''}` }
    }
    return answer
  } catch (err) {
    return { error: errorText(err) }
  }
}

// control_response.response.response.rate_limits.five_hour|seven_day = { utilization,
// resets_at }. An answer from the engine's cache (its fetch failed, e.g. 429) has no
// rate_limits.limits[], and seven_day_breakdown.as_of is the server time of the body:
// both are checked, or old numbers would pass as fresh. rate_limits_available false is
// a login without rate limits; rate_limits null beside it true is a fetch that failed
// with nothing cached (429, network) – worth another try after the usual back-off.
function parseUsage(stdout: string, now: number): UsageAnswer {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"control_response"')) continue
    let res: Record<string, any> | undefined
    try {
      res = JSON.parse(line)?.response
    } catch {
      continue // not the line we are after
    }
    if (res?.subtype === 'error') return { error: String(res.error ?? 'the request failed') }
    const body = res?.response
    if (!body || typeof body !== 'object') continue
    const rl = body.rate_limits
    if (body.rate_limits_available === false) return { error: 'this login has no rate limits to read', final: true }
    if (!rl || typeof rl !== 'object') return { error: 'the server was not reached (or answered 429), and nothing was cached' }
    const asOf = parseTime(rl.seven_day_breakdown?.as_of)
    if (!Array.isArray(rl.limits) || (asOf !== null && now - asOf > USAGE_MAX_AGE_MS)) {
      return { error: 'only a cached answer – the server was not reached (or answered 429)' }
    }
    const limits: ServerLimit[] = []
    for (const kind of ['five_hour', 'seven_day'] as const) {
      const x = rl[kind]
      if (!x || typeof x.utilization !== 'number' || !Number.isFinite(x.utilization)) continue
      const reset = parseTime(x.resets_at)
      limits.push({ kind, percentUsed: x.utilization, ...(reset !== null ? { resetsAt: new Date(reset).toISOString() } : {}) })
    }
    return limits.length > 0 ? { limits } : { error: 'the answer holds no 5-hour or 7-day limit' }
  }
  return { error: 'no answer' }
}

// Takes a server reading unless one was tried too recently or a failure holds it back;
// `demand` (the model asked, or the account changed) waits less. A reading already in
// flight is waited for only with `join` – by the ticker, which has no budget to spend.
// Never throws.
async function refreshLimits($: EngineInterface, { demand = false, join = false } = {}): Promise<void> {
  if (usageFetch) return join ? usageFetch : undefined
  if (usageOff === undefined) usageOff = await serverOff($)
  if (usageOff) return
  const now = await $.clock.now()
  if (now < usageBackoffUntil || now - lastUsageTryAt < (demand ? USAGE_DEMAND_GAP_MS : USAGE_GAP_MS)) return
  lastUsageTryAt = now
  const run = async () => {
    await checkAccount($)
    const forAccount = account ?? null
    const r = await fetchUsage($)
    const at = await $.clock.now()
    if ('limits' in r) {
      // Dated when it was asked for, so the next one is due USAGE_GAP_MS after this one.
      serverReading = { at: now, account: forAccount, limits: r.limits }
      usageFailures = 0
      usageBackoffUntil = 0
      usageError = null
      return
    }
    usageFailures += 1
    usageError = r.error
    usageBackoffUntil = at + (r.final ? USAGE_BACKOFF_MAX_MS : Math.min(USAGE_BACKOFF_MAX_MS, USAGE_BACKOFF_MS * 2 ** (usageFailures - 1)))
  }
  usageFetch = run()
    .catch(() => undefined)
    .finally(() => {
      usageFetch = null
    })
  return usageFetch
}

// For the status tool's refresh: a line on why there is no fresh reading, '' when there is.
async function refreshOnDemand($: EngineInterface): Promise<string> {
  if (usageFetch) return 'No fresh reading yet: one is being taken from the server right now – ask again in a few seconds.'
  const tried = lastUsageTryAt
  const had = serverReading
  await refreshLimits($, { demand: true })
  if (usageOff) return `No reading from the server in this session: ${usageOff}.`
  if (serverReading !== had) return ''
  const now = await $.clock.now()
  if (lastUsageTryAt !== tried) return `No fresh reading from the server: ${usageError ?? 'no answer'}.`
  if (now < usageBackoffUntil) {
    return `No fresh reading from the server: the last attempt failed (${usageError ?? 'no answer'}); next try possible ${fmtIn(usageBackoffUntil - now)}.`
  }
  return `No fresh reading from the server: the last one was asked for ${fmtDuration(now - tried)} ago (at most every ${USAGE_DEMAND_GAP_MS / 1000} s).`
}

// The rate limits to go by, per limit the newest reading: the server's for this account
// when its numbers are newer than the last model response (they may come from a snapshot
// up to USAGE_SNAPSHOT_MS old), else the host's own (which come with every response, so
// while the model works they are the newest); either fills in what the other does not name. After a switch to another account the host's own belong to
// the old one until the next response, so they are left out.
function limitsNow(own: readonly RateLimit[], now: number): RateLimit[] {
  const out: RateLimit[] = accountSwitchedAt > lastResponseAt ? [] : [...own]
  const s = serverReading
  if (!s || s.account !== (account ?? null)) return out
  const newer = s.at - USAGE_SNAPSHOT_MS > lastResponseAt
  const old = now - s.at >= USAGE_GAP_MS // a newer one failed or is held back
  for (const l of s.limits) {
    const i = out.findIndex(x => x.kind === l.kind)
    if (i >= 0 && !newer) continue
    const r: RateLimit = old ? { ...l, asOf: s.at } : { ...l }
    if (i >= 0) out[i] = r
    else out.push(r)
  }
  return out
}

// When the newest reading at hand was taken: the server's for this account, or the last
// response's – unless that one belongs to the account before a switch.
function newestReadingAt(): number {
  const s = serverReading && serverReading.account === (account ?? null) ? serverReading.at : Number.NEGATIVE_INFINITY
  return Math.max(s, accountSwitchedAt > lastResponseAt ? Number.NEGATIVE_INFINITY : lastResponseAt)
}

// Before a block the person or the model asked for (a prompt, status, arming a wake-up):
// a server reading of the hook's own once the newest at hand is USAGE_GAP_MS old –
// never one already in flight.
async function refreshForBlock($: EngineInterface): Promise<void> {
  if (usageFetch || (await $.clock.now()) - newestReadingAt() < USAGE_GAP_MS) return
  await refreshLimits($)
}

// The ticker's server reading: for what waits on the limits – a wake-up check or an idle
// update about to run, a subagent inside limit_wakeup – once the newest reading at hand
// is USAGE_GAP_MS old. While the model works, every response brings the host's own anyway.
async function refreshWhileWaited($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (waitingAgents === 0 && !watchDue(now) && !idleDue(now)) return
  if (now - newestReadingAt() < USAGE_GAP_MS) return
  await refreshLimits($, { join: true })
}

// ---------------------------------------------------------------- The report

// `recipient` is whoever reads this block ('main' or a subagent's id); deltas are
// measured against the previous report that same recipient got. It takes no server
// reading itself: the callers that may wait for one take it first.
async function report($: EngineInterface, reason: string, recipient = 'main', { noBrief = false } = {}): Promise<string> {
  await ensureTimeZone($)
  await ensureSettings($)
  const now = await $.clock.now()
  const u = await $.session.usage({ breakdown: 'summary' })
  const prev = previousReport.get(recipient)
  const canSwitch = recipient === 'main' && (await switcherPresent($, now))
  const c = u.context
  const threshold = c.breakdown?.autoCompactThreshold
  const brief = recipient === 'main' && !noBrief && briefingDue(c.tokens, prev?.contextTokens)

  const window = prev
    ? `Δ = change since previous report ${fmtAt(prev.at, now)}, ${fmtSpan(prev.at, now)} ago`
    : 'first report, no change (Δ) yet'
  const lines = [`[CTM · ${fmtStamp(now)} · ${reason} · ${window}]`]

  // Context
  let ctx = `Context window: ${c.tokens === undefined ? '?' : fmtTokens(c.tokens)} of ${fmtTokens(c.window)} tokens used`
  if (c.percent !== undefined) ctx += ` (${c.percent}%)`
  if (c.tokens !== undefined && prev?.contextTokens != null) {
    ctx += `, Δ ${fmtSigned(c.tokens - prev.contextTokens, fmtTokens)}`
  }
  if (threshold !== undefined) {
    ctx += ` · auto-compact at ${fmtTokens(threshold)}`
    if (c.tokens !== undefined) ctx += ` (${fmtTokens(Math.max(0, threshold - c.tokens))} left)`
  }
  lines.push(ctx)

  // Compact threshold: a reminder past it; while unset, now and then a nudge to ask.
  // Only the main agent can compact, so subagents get neither.
  const notes: string[] = []
  if (recipient === 'main') {
    const setting = compactThresholdSetting()
    const t = parseThreshold(setting)
    if (t && c.tokens !== undefined && c.tokens >= thresholdTokens(t, c.window)) {
      notes.push(
        `Compact threshold passed (${fmtTokens(c.tokens)} ≥ ${fmtThreshold(t)}): if your task allows it, compact at the ` +
          `next clean point (${T_RESET}) – a smaller context keeps the 5-hour and 7-day limits from growing needlessly. ` +
          'Do not break off critical work for it.',
      )
    } else if (!t && setting !== 'off' && now - lastNagAt >= NAG_EVERY_MS) {
      lastNagAt = now
      notes.push(
        `No compact threshold set. When it fits, ask the user whether to set one (e.g. 300k tokens or 30% of the window) ` +
          `and save it with ${T_SETTINGS} – or compactThreshold "off" if they do not want one.`,
      )
    }
  }

  // Rate limits
  const limits: Record<string, LimitReading> = {}
  const marks: string[] = []
  const rateLimits = limitsNow(u.rateLimits, now)
  if (rateLimits.length > 0) {
    for (const r of rateLimits) {
      const reading = { percent: r.percentUsed, resetsAt: r.resetsAt ?? null }
      limits[r.kind] = reading
      const stale = readingIsStale(r, now)
      let line = `${limitName(r.kind)}: ${fmtPercent(r.percentUsed)} used`
      const d = prev ? limitDelta(prev.limits[r.kind], reading, now) : null
      if (d) line += `, ${d}`
      if (r.resetsAt) {
        const at = Date.parse(r.resetsAt)
        line += stale
          ? ` · window reset ${fmtAt(at, now)} – this reading is from before, it is lower now`
          : ` · resets ${fmtAt(at, now)} (in ${fmtSpan(now, at)})`
      }
      if (r.asOf !== undefined) line += ` · as of ${fmtClock(r.asOf, now)}`
      lines.push(line)
    }
    const agent = recipient === 'main' ? undefined : recipient
    for (const p of pastMarks(rateLimits, now, agent)) {
      notes.push(pauseNote(p, now, agent, canSwitch))
      marks.push(p.kind)
    }
  } else if (accountSwitchedAt > lastResponseAt) {
    lines.push(
      'Rate limits: account switched – no reading for the new account yet (it comes with the server reading or the ' +
        'first response to a request sent after the switch, once none from before it is out)',
    )
  } else {
    lines.push('Rate limits: not reported (not signed in with a subscription, or no response yet)')
  }
  for (const w of recipient === 'main' ? watches.values() : []) {
    if (!notes.some(n => n.startsWith(limitName(w.kind)))) {
      const gone = !rateLimits.some(r => r.kind === w.kind)
      notes.push(
        `Wake-up armed: ${limitName(w.kind)} below ${fmtPercent(w.below)}` +
          (gone && w.resetsAt !== null
            ? ` (no current reading; its window ${w.resetsAt <= now ? 'reset' : 'resets'} ${fmtAt(w.resetsAt, now)}).`
            : '.'),
      )
    }
  }
  for (const n of notes) lines.push(`⚑ ${n}`)

  if (idle) {
    lines.push(
      `Idle updates: on${idle.until === null ? '' : ` until ${fmtClock(idle.until, now)}`} ` +
        `(turn off with ${T_IDLE} enabled=false)`,
    )
  }

  previousReport.set(recipient, { at: now, contextTokens: c.tokens ?? null, limits, marks })
  if (!brief) return lines.join('\n')
  briefed = true
  if (!toldNoCompose) {
    toldNoCompose = true
    toast($, 'CTM: plugins are kept out of the system prompt here (organization-managed Claude Code) – the CTM briefing comes with the blocks instead')
  }
  return [BRIEFING_HEAD, INFO, '', ...lines].join('\n')
}

// Whether the main agent's next block carries the briefing: where a model request went out
// without CTM's prompt.compose hook running, once – and again once the context started
// over (a compaction shrinks it to under half; /clear resets `briefed`).
function briefingPending(): boolean {
  return !composed && stepped && !briefed
}

function briefingDue(tokens: number | undefined, before: number | null | undefined): boolean {
  if (composed || !stepped) return false
  if (briefed && tokens !== undefined && before != null && before >= 20_000 && tokens < before / 2) briefed = false
  return !briefed
}

// A pause mark passed that the recipient's last block did not ask to pause for: the next
// tool result carries a block at once, not only at the interval.
async function newlyPastMark($: EngineInterface, recipient: string, now: number): Promise<boolean> {
  const u = await $.session.usage()
  const told = previousReport.get(recipient)?.marks ?? []
  return pastMarks(limitsNow(u.rateLimits, now), now, recipient === 'main' ? undefined : recipient).some(p => !told.includes(p.kind))
}

// What a block says past a pause mark – a request, never a hard stop: the main agent
// pauses and arms a wake-up; a subagent cannot end its turn and be woken, so it waits
// inside the wake-up call.
function pauseNote(p: PastMark, now: number, agent?: string, canSwitch = false): string {
  const name = limitName(p.kind)
  const what = p.own
    ? `your ${agent && agentPauseAt.get(agent)?.[p.kind] !== undefined ? 'own ' : ''}pause threshold ${fmtPercent(p.mark)}`
    : `the built-in safety threshold ${fmtPercent(p.mark)} (always active, not configurable – a fallback on top ` +
      'of any pause threshold you set)'
  const resets = p.resetsAt !== null ? ` (the window resets ${fmtAt(p.resetsAt, now)})` : ''
  if (agent) {
    return (
      `${name} at ${fmtPercent(p.percent)} ≥ ${what}: please pause – a request, not a hard stop. First finish ` +
      'anything that must not be left half-done, then at that clean point call ' +
      `${T_WAKEUP} (limit "${p.kind}"): for a subagent it waits inside the call until the limit is back below${resets}, ` +
      'then you carry on.'
    )
  }
  const w = watches.get(p.kind)
  if (w) return `${name} is past ${what}; wake-up armed for below ${fmtPercent(w.below)} – stay paused until then.`
  const instead = canSwitch
    ? ` Before that: ${T_SWITCHER_ACCOUNTS} shows whether another of the user's accounts has room – if one has and ` +
      `you may switch, switch to it (${T_SWITCHER_SWITCH}) at that clean point and carry on instead of pausing.`
    : ''
  return (
    `${name} at ${fmtPercent(p.percent)} ≥ ${what}: please pause your work at the next clean point – first finish ` +
    `anything that must not be left half-done, then call ${T_WAKEUP} (limit "${p.kind}") and end your turn; you ` +
    `will be woken once it is back below${resets}.${instead}`
  )
}

// Whether the account-switcher plugin's tools are listed, looked up at most once a minute.
async function switcherPresent($: EngineInterface, now: number): Promise<boolean> {
  if (switcher && now - switcher.at < SWITCHER_CHECK_MS) return switcher.present
  const tools = await safe(() => $.tool.list())
  switcher = { at: now, present: Boolean(tools?.some(t => t.name === T_SWITCHER_SWITCH)) }
  return switcher.present
}

// ---------------------------------------------------------------- Models

type ModelInfo = {
  current: string | null
  effort: string | null
  ultracode: boolean | null
  setting: string | null
  options: string[]
  catalog: CatalogEntry[] | null
  locked: boolean
}

// The current model as /model shows it, and the choices of the /config Model row
// (aliases; a full model id works as well). Each part is null/empty where the host
// has nothing to say.
async function modelInfo($: EngineInterface, withCatalog = true): Promise<ModelInfo> {
  const current = (await safe(() => $.session.model())) ?? null
  const row = (await safe(() => $.config.list()))?.find(r => r.key === 'model')
  const cat = withCatalog ? await getCatalog($) : null
  const options = [...(row?.options ?? [])]
  for (const c of cat ?? []) if (!options.includes(c.value)) options.push(c.value)
  return {
    current,
    effort: await currentEffort($),
    ultracode: lastUltracode,
    setting: row?.value === undefined ? null : String(row.value),
    options,
    catalog: cat,
    locked: (row as { isLocked?: boolean } | undefined)?.isLocked === true,
  }
}

function fmtLevels(levels: string[] | undefined): string {
  if (!levels || levels.length === 0) return 'no effort levels'
  return levels.length > 2 ? `effort ${levels[0]}–${levels[levels.length - 1]}` : `effort ${levels.join('/')}`
}

function describeModels(m: ModelInfo): string {
  const lines = [
    'CTM models:',
    `- Current model (main agent): ${m.current ?? 'unknown'}`,
    `- Current effort: ${m.effort ?? 'unknown (the model may have no effort levels)'}`,
    `- Ultracode: ${m.ultracode === null ? 'not changed by CTM in this session (the system reminders say whether it is on)' : m.ultracode ? 'on' : 'off'}`,
  ]
  if (m.setting !== null) lines.push(`- Model setting: ${m.setting}`)
  if (m.catalog) {
    lines.push('- Available (alias → model: what it is good for), as Claude Code describes them:')
    for (const c of m.catalog) {
      const extras = [fmtLevels(c.supportedEffortLevels), c.supportsFastMode ? 'fast mode' : null].filter(Boolean)
      const target = c.resolvedModel && c.resolvedModel !== c.value ? ` → ${c.resolvedModel}` : ''
      lines.push(`  - ${c.value}${target}: ${c.description ?? c.displayName ?? ''} (${extras.join(', ')})`)
    }
    const more = m.options.filter(o => !m.catalog!.some(c => c.value === o))
    lines.push(`  Also accepted: ${more.length > 0 ? `${more.join(', ')}, ` : ''}or a full model ID (e.g. claude-…).`)
  } else {
    lines.push(
      m.options.length > 0
        ? `- Available: ${m.options.join(', ')} – or a full model ID (e.g. claude-…).`
        : '- Available: the host lists none; aliases like sonnet, opus, haiku or a full model ID usually work.',
    )
  }
  if (m.locked) lines.push('- The Model setting is locked by a policy: a switch may be refused.')
  lines.push(
    `Switch with ${T_SWITCH} (at the end of your turn, with a resumePrompt). It is for this session only; the ` +
      'prompt cache is rebuilt on the new model, so combine it with a compact or clear when the context is large. ' +
      `Effort: ${T_EFFORT}. Ultracode: ${T_ULTRACODE}.`,
  )
  return lines.join('\n')
}

// A model id or alias: no spaces, nothing odd. The engine decides whether it exists.
function isModelName(s: string): boolean {
  return /^[A-Za-z0-9][\w.:\/@-]*(\[\w+\])?$/.test(s) && s.length <= 200
}

// The engine's own model list, as the /model picker shows it: alias, the model it
// stands for, a line on what it is good for, its effort levels. No plugin call hands
// it out, so CTM asks a second, short-lived `claude` for it – the SDK's initialize
// request, which sends nothing to a model and costs no tokens (about 2 s). Kept for
// 15 minutes; null where that does not work (the list falls back to the bare aliases).
type CatalogEntry = {
  value: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportedEffortLevels?: string[]
  supportsFastMode?: boolean
}

async function fetchCatalog($: EngineInterface): Promise<CatalogEntry[] | null> {
  const exe = (await safe(() => $.env.get('CLAUDE_CODE_EXECPATH'))) || 'claude'
  const r = await safe(() =>
    $.process.run(
      [exe, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
      {
        stdin: `${JSON.stringify({ type: 'control_request', request_id: 'ctm', request: { subtype: 'initialize' } })}\n`,
        timeoutMs: CATALOG_TIMEOUT_MS,
      },
    ),
  )
  return r ? parseCatalog(r.stdout) : null
}

function parseCatalog(stdout: string): CatalogEntry[] | null {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"control_response"')) continue
    try {
      const models = JSON.parse(line)?.response?.response?.models
      if (!Array.isArray(models)) continue
      const entries = models.filter(m => m && typeof m.value === 'string') as CatalogEntry[]
      return entries.length > 0 ? entries : null
    } catch {
      // not the line we are after
    }
  }
  return null
}

async function getCatalog($: EngineInterface): Promise<CatalogEntry[] | null> {
  const now = await $.clock.now()
  if (!catalog || now - catalog.at >= CATALOG_TTL_MS) catalog = { at: now, list: fetchCatalog($) }
  return catalog.list
}

// The current effort: what the main loop's last request carried; before the first
// one, the level the session started with.
async function currentEffort($: EngineInterface): Promise<string | null> {
  return lastEffort ?? ((await safe(() => $.env.get('CLAUDE_EFFORT'))) || null)
}

// Does the model exist and may this session use it? Aliases the host lists exist; any
// other name gets a one-token test request, resolved and allowlist-checked like
// --model: the API answers 404 model_not_found for a name it does not know, and the
// engine refuses a model a policy blocks. Only a call cut short leaves it open (null):
// the switch itself still checks.
async function checkModel($: EngineInterface, model: string, options: string[]): Promise<{ check: string; error: string | null }> {
  if (options.includes(model)) return { check: 'listed in the /config Model row', error: null }
  const check = `a one-token test request to "${model}"`
  try {
    const r = await $.model.complete({ model, prompt: 'Reply with: ok', maxTokens: 1, timeoutMs: CHECK_TIMEOUT_MS })
    refusedBy(r)
    if (r.isAnswered || r.reason !== 'api-error') return { check, error: null }
    const status = (r as { status?: number }).status
    const kind = (r as { error?: string }).error
    return { check, error: `the API answered ${[status, kind].filter(x => x !== undefined).join(' ') || 'with an error'}` }
  } catch (err) {
    return { check, error: `the engine refused it: ${errorText(err)}` }
  }
}

// Switches through /model <name> – for this session only, never in the settings – and
// checks the outcome: the command answers "Set model to …" on success, and a name it
// does not know or a policy refusal leaves the model as it was.
async function switchModel($: EngineInterface, model: string): Promise<{ ok: boolean; note: string }> {
  const before = (await safe(() => $.session.model())) ?? null
  let text = ''
  try {
    const r = await $.command.run({ command: 'model', args: model })
    refusedBy(r)
    text = (r.text ?? '').trim()
  } catch (err) {
    text = errorText(err)
  }
  const after = (await safe(() => $.session.model())) ?? null
  const ok = /^set model to\b/i.test(text) || (before !== null && after !== null && after !== before)
  if (ok) {
    return { ok, note: `[CTM] Your model was switched as you scheduled: now ${after ?? model}${before && before !== after ? ` (was ${before})` : ''}.` }
  }
  return {
    ok,
    note:
      `[CTM] The switch to model "${model}" you scheduled failed. Command: /model ${model} – the engine answered: ` +
      `${text ? `"${text}"` : 'nothing'}. You are still on ${after ?? before ?? 'the previous model'}. ` +
      `See ${T_MODELS} for what is available.`,
  }
}

// Sets the effort through /effort <level> – for this session only – and checks the
// answer: "Set effort level to …" / "Effort level set to …" on success.
async function setEffort($: EngineInterface, level: string): Promise<{ ok: boolean; note: string; ultracodeOff?: boolean }> {
  const before = await currentEffort($)
  let text = ''
  try {
    const r = await $.command.run({ command: 'effort', args: level })
    refusedBy(r)
    text = (r.text ?? '').trim()
  } catch (err) {
    text = errorText(err)
  }
  if (/^(set effort level to|effort level set to)\b/i.test(text)) {
    if (level !== 'auto') lastEffort = level
    else lastEffort = null
    // Where the engine turns Ultracode off with an effort change, its answer says so.
    const offToo = /·\s*ultracode off\b/i.test(text)
    if (offToo) lastUltracode = false
    return {
      ok: true,
      note: `[CTM] Your effort was set as you scheduled: now ${level}${before && before !== level ? ` (was ${before})` : ''}.`,
      ultracodeOff: offToo,
    }
  }
  return {
    ok: false,
    note:
      `[CTM] The effort change to "${level}" you scheduled failed. Command: /effort ${level} – the engine answered: ` +
      `${text ? `"${text}"` : 'nothing'}. Your effort is unchanged${before ? ` (${before})` : ''}.`,
  }
}

// Turns Ultracode on or off through /effort ultracode on|off – for this session only –
// and checks the answer: "Ultracode on (this session only): …" / "Ultracode off. …" on
// success. Where it is not available (dynamic workflows off, a model without it) the
// engine says so and changes nothing.
async function setUltracode($: EngineInterface, on: boolean): Promise<{ ok: boolean; note: string }> {
  const args = `ultracode ${on ? 'on' : 'off'}`
  let text = ''
  try {
    const r = await $.command.run({ command: 'effort', args })
    refusedBy(r)
    text = (r.text ?? '').trim()
  } catch (err) {
    text = errorText(err)
  }
  if ((on ? /^ultracode on\b/i : /^ultracode off\b/i).test(text)) {
    lastUltracode = on
    return { ok: true, note: `[CTM] Ultracode was turned ${on ? 'on' : 'off'} as you scheduled.` }
  }
  return {
    ok: false,
    note:
      `[CTM] Turning Ultracode ${on ? 'on' : 'off'} as you scheduled failed. Command: /effort ${args} – the engine ` +
      `answered: ${text ? `"${text}"` : 'nothing'}. Ultracode is unchanged.`,
  }
}

// ---------------------------------------------------------------- Reset (runs after the turn)

function describeJob(job: { mode: Mode | null; model: string | null; effort: string | null; ultracode: boolean | null }): string {
  return [
    job.mode,
    job.model ? `model switch to ${job.model}` : null,
    job.effort ? `effort ${job.effort}` : null,
    job.ultracode === null ? null : `Ultracode ${job.ultracode ? 'on' : 'off'}`,
  ]
    .filter(Boolean)
    .join(' + ')
}

async function resetMessage($: EngineInterface, job: PendingReset, note: string): Promise<string> {
  briefed = true // it carries the briefing itself
  const model = (await safe(() => $.session.model())) ?? null
  const effort = await currentEffort($)
  return [
    note,
    ...(model
      ? [`Current model: ${model}${effort ? `, effort ${effort}` : ''}${lastUltracode === null ? '' : `, Ultracode ${lastUltracode ? 'on' : 'off'}`}`]
      : []),
    '',
    INFO,
    '',
    '--- Your resume prompt ---',
    job.resumePrompt,
    '',
    await report($, `after ${describeJob(job)}`, 'main', { noBrief: true }),
  ].join('\n')
}

// Not every host offers every call: a headless session (-p, the SDK, cloud sessions)
// refuses $.session.compact, and a slash command can only run through $.command.run
// (never as a submitted prompt). So a compact the engine refuses falls back to the
// /compact command, and a clear always runs as the /clear command. The resume prompt
// goes out only once the engine confirms the reset – session.compact resolved, or
// session.end with reason "clear" – otherwise the model is told the reset failed.
// A model switch always runs as /model <name>, after the reset if there is one.

// A host or hook can refuse an engine call by rejecting it or by answering { deny }.
function refusedBy(result: unknown): void {
  const deny = (result as { deny?: unknown } | null | undefined)?.deny
  if (typeof deny === 'string') throw new Error(deny)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function finishReset($: EngineInterface, job: PendingReset, note: string): void {
  awaiting = null
  awaitTimer?.cancel()
  awaitTimer = null
  $.clock.after(RESET_DELAY_MS, () => void deliverResume($, job, note))
}

async function deliverResume($: EngineInterface, job: PendingReset, note: string): Promise<void> {
  if (job.model) {
    const sw = await switchModel($, job.model)
    if (!sw.ok) toast($, `CTM: model switch failed – ${job.model}`)
    note = note ? `${note}\n${sw.note}` : sw.note
  }
  if (job.effort) {
    const ef = await setEffort($, job.effort)
    if (!ef.ok) toast($, `CTM: effort change failed – ${job.effort}`)
    note = note ? `${note}\n${ef.note}` : ef.note
    if (ef.ultracodeOff && job.ultracode === null) {
      note += `\n[CTM] The engine turned Ultracode off with the effort change (${T_ULTRACODE} turns it on again).`
    }
  }
  if (job.ultracode !== null) {
    const uc = await setUltracode($, job.ultracode)
    if (!uc.ok) toast($, `CTM: Ultracode ${job.ultracode ? 'on' : 'off'} failed`)
    note = note ? `${note}\n${uc.note}` : uc.note
  }
  const now = await $.clock.now()
  if (job.mode || job.model) lastResetAt = now
  if (job.effort) lastEffortAt = now
  if (job.ultracode !== null) lastUltracodeAt = now
  lastSent.set('main', now)
  await $.prompt.submit({ text: await resetMessage($, job, note) })
}

async function failReset($: EngineInterface, job: PendingReset, message: string): Promise<void> {
  if (awaiting === job) awaiting = null
  awaitTimer?.cancel()
  awaitTimer = null
  toast($, `CTM: ${job.mode} failed – ${message}`)
  const rest = [
    job.model ? `model switch to "${job.model}"` : null,
    job.effort ? `effort change to "${job.effort}"` : null,
    job.ultracode === null ? null : `Ultracode ${job.ultracode ? 'on' : 'off'}`,
  ]
    .filter(Boolean)
    .join(' and ')
  const skipped = rest ? ` The ${rest} was skipped as well.` : ''
  await $.prompt.submit({
    text: `[CTM] The ${job.mode} you scheduled failed (${message}). The conversation is unchanged; carry on as usual.${skipped}\n\n--- Your resume prompt ---\n${job.resumePrompt}`,
  })
}

// Runs /compact or /clear as a command and waits for the engine's confirmation.
async function runAsCommand($: EngineInterface, job: PendingReset & { mode: Mode }): Promise<void> {
  awaiting = job
  awaitTimer?.cancel()
  const timeout = job.mode === 'compact' ? COMPACT_CONFIRM_MS : CLEAR_CONFIRM_MS
  awaitTimer = $.clock.after(timeout, () => {
    if (awaiting === job) void failReset($, job, `no confirmation that /${job.mode} ran within ${fmtDuration(timeout)}`)
  })
  const before = job.mode === 'compact' ? await messageCount($) : null
  try {
    refusedBy(await $.command.run({ command: job.mode, args: job.mode === 'compact' ? (job.instructions ?? '') : '' }))
  } catch (err) {
    if (awaiting === job) await failReset($, job, errorText(err))
    return
  }
  if (before !== null && before > 0) $.clock.after(COMPACT_POLL_MS, () => void confirmByShrink($, job, before))
}

async function messageCount($: EngineInterface): Promise<number | null> {
  const m = await safe(() => $.session.messages())
  return Array.isArray(m) ? m.length : null
}

// The session.compact hook confirms a /compact run as a command. Where that event does not
// reach CTM (an organization that manages Claude Code passes it over the plugins a person
// installed), the confirmation is measured instead: the conversation the engine holds
// shrinks once the compact ran.
async function confirmByShrink($: EngineInterface, job: PendingReset, before: number): Promise<void> {
  if (awaiting !== job) return
  const now = await messageCount($)
  if (now !== null && now < before) {
    finishReset($, job, '[CTM] Your conversation was compacted as you scheduled.')
    return
  }
  $.clock.after(COMPACT_POLL_MS, () => void confirmByShrink($, job, before))
}

async function runReset($: EngineInterface): Promise<void> {
  const job = pending
  if (!job) return
  if (busy) return // a new turn is already running: try again at its turn.complete
  pending = null

  if (job.mode === null) return deliverResume($, job, '') // a model, effort and/or Ultracode change alone
  if (job.mode === 'clear') return runAsCommand($, { ...job, mode: job.mode })

  try {
    const res = await $.session.compact({ instructions: job.instructions ?? undefined })
    refusedBy(res)
    if (res.skip) toast($, `CTM: compact refused – ${res.skip}`)
    finishReset(
      $,
      job,
      res.skip
        ? `[CTM] The compact you scheduled was refused: ${res.skip}. The conversation is unchanged.`
        : '[CTM] Your conversation was compacted as you scheduled.',
    )
  } catch {
    await runAsCommand($, { ...job, mode: job.mode }) // e.g. headless: compaction runs as the /compact command there
  }
}

// ---------------------------------------------------------------- Idle updates

// Sends one of CTM's own prompts (a wake-up, an idle update); throws when it did not enter.
// The engine answers { drop } rather than rejecting – a hook's or settings hook's block, a
// host limit, or the hold after the person stopped the session (until they send input) –
// and then no turn starts that would clear `busy`. The reason is told once per reason.
async function submitOwn($: EngineInterface, what: string, text: string): Promise<void> {
  const r = await $.prompt.submit({ text })
  const drop = (r as { drop?: unknown } | undefined)?.drop
  if (typeof drop === 'string') {
    if (drop !== lastDrop) toast($, `CTM: ${what} held back – ${drop}; it is tried again at the next check`)
    lastDrop = drop
    throw new Error(drop)
  }
  lastDrop = null
}

// An idle update is due: on, not expired, the model idle, an interval since the last block.
function idleDue(now: number): boolean {
  if (!idle || busy || pending || awaiting || (idle.until !== null && now >= idle.until)) return false
  return now - Math.max(lastSent.get('main') ?? 0, lastTurnEndAt) >= intervalMs()
}

async function idleTick($: EngineInterface): Promise<void> {
  if (!idle || busy || pending || awaiting) return
  const now = await $.clock.now()
  if (idle.until !== null && now >= idle.until) {
    idle = null
    await saveIdle($)
    toast($, 'CTM: idle updates expired')
    return
  }
  if (!idleDue(now)) return
  lastSent.set('main', now)
  busy = true // until turn.start / turn.complete take over
  try {
    await submitOwn($, 'idle update', await report($, 'idle update'))
  } catch {
    busy = false // no turn was started: the next interval tries again
  }
}

// ---------------------------------------------------------------- Limit wake-ups

// Is the limit back below the watch's mark? A reading from before its window's reset
// counts as below: no new reading comes while the model pauses. So does no reading at
// all once the reset the watch knows of has passed – the host drops a limit whose
// window has ended – and a reading that names no reset time then.
function watchMet(w: LimitWatch, r: { percentUsed: number; resetsAt?: string } | undefined, now: number): string | null {
  const knownReset = w.resetsAt !== null && w.resetsAt <= now ? `its window reset ${fmtAt(w.resetsAt, now)}` : null
  if (!r) return knownReset
  if (!r.resetsAt) return r.percentUsed < w.below ? `it is at ${fmtPercent(r.percentUsed)}` : knownReset
  w.resetsAt = Date.parse(r.resetsAt)
  if (readingIsStale(r, now)) return `its window reset ${fmtAt(w.resetsAt, now)}`
  if (r.percentUsed < w.below) return `it is at ${fmtPercent(r.percentUsed)}`
  return null
}

// A wake-up check is due: a wake-up armed, the model idle, and an interval since the last
// check or a known window reset passed since.
function watchDue(now: number): boolean {
  if (watches.size === 0 || busy || pending || awaiting) return false
  const resetPassed = [...watches.values()].some(w => w.resetsAt !== null && w.resetsAt > lastWatchCheckAt && w.resetsAt <= now)
  return resetPassed || now - lastWatchCheckAt >= intervalMs()
}

// Checks the armed wake-ups once per interval, and right when a known window reset has
// passed – only while the model is idle: a wake-up starts a turn. It goes by the readings
// at hand; the ticker has taken a server reading first where one was due.
async function watchTick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!watchDue(now)) return
  const u = await $.session.usage({ breakdown: 'summary' })
  if (busy || pending || awaiting) return // a turn started meanwhile: the check stays due
  lastWatchCheckAt = now
  const limits = limitsNow(u.rateLimits, now)
  const fired: LimitWatch[] = []
  const met: string[] = []
  const notes: string[] = []
  let moved = false
  for (const w of [...watches.values()]) {
    const before = w.resetsAt
    const why = watchMet(w, limits.find(r => r.kind === w.kind), now)
    if (w.resetsAt !== before) moved = true
    if (!why) continue
    watches.delete(w.kind)
    fired.push(w)
    met.push(`the ${limitName(w.kind)} is below ${fmtPercent(w.below)} again (${why})`)
    if (w.note) notes.push(w.note)
  }
  if (fired.length === 0) {
    if (moved) await saveWatches($) // the reset time it learned survives a reload too
    return
  }
  lastSent.set('main', now)
  busy = true // until turn.start / turn.complete take over
  await saveWatches($)
  try {
    const parts = [`[CTM] Limit wake-up: ${met.join('; ')}. You can carry on with your work.`]
    if (notes.length > 0) parts.push('', '--- Your note ---', ...notes)
    parts.push('', await report($, 'limit wake-up'))
    await submitOwn($, 'limit wake-up', parts.join('\n'))
    toast($, `CTM: limit wake-up – ${met.join('; ')}`)
  } catch {
    // No turn was started: keep the wake-ups, the next check sends them again.
    for (const w of fired) if (!watches.has(w.kind)) watches.set(w.kind, w)
    await saveWatches($)
    busy = false
  }
}

// ---------------------------------------------------------------- The ticker

// Every IDLE_TICK_MS: the server reading something waits on, then the wake-up checks
// and the idle updates – one after the other, so a wake-up marks the model busy before an
// idle update could follow it. One tick at a time; the heartbeat goes on even while one
// still runs.
async function tick($: EngineInterface): Promise<void> {
  lastTickAt = await $.clock.now()
  if (ticking) return
  ticking = true
  try {
    await refreshWhileWaited($)
    await watchTick($)
    await idleTick($)
  } catch {
    // the next tick tries again
  } finally {
    ticking = false
  }
}

// The ticker runs from session.start, which the engine raises again in a fresh copy of
// the module – a reload of the mod, or a hooks worker it replaced (a crash, a runaway
// plugin): such a copy starts over, its variables and timers gone, so it takes the armed
// wake-ups and idle updates back from $.state. Every other hook makes sure as well, in
// case the timer was dropped. Never throws.
async function ensureRunning($: EngineInterface): Promise<void> {
  try {
    if (!restored) {
      restored = true
      await restoreState($)
    } else if (resave) {
      resave = false // /clear gave the session a new id: keep them under it
      await saveWatches($)
      await saveIdle($)
    }
    const now = await $.clock.now()
    if (ticker && now - lastTickAt < TICK_DEAD_MS) return
    ticker?.cancel()
    lastTickAt = now
    ticker = $.clock.every(IDLE_TICK_MS, () => void tick($))
  } catch {
    // the next hook tries again
  }
}

const WAKEUPS = { plugin: 'ctm', key: 'wakeups' } as const
const IDLE_UPDATES = { plugin: 'ctm', key: 'idleUpdates' } as const
const BRIEFING = { plugin: 'ctm', key: 'briefing' } as const

async function sessionId($: EngineInterface): Promise<string> {
  return (await safe(() => $.session.id())) ?? ''
}

async function saveWatches($: EngineInterface): Promise<void> {
  const kept: KeptWakeups = { session: await sessionId($), watches: [...watches.values()].map(w => ({ ...w })) }
  await safe(() => $.state.set(WAKEUPS, kept))
}

async function saveIdle($: EngineInterface): Promise<void> {
  const kept: KeptIdleUpdates = { session: await sessionId($), idle: idle ? { ...idle } : null }
  await safe(() => $.state.set(IDLE_UPDATES, kept))
}

// What the previous copy of the module kept for this session – only this session's;
// what this copy already holds wins. Taken back, they start from now: the turn that may
// be running went to the old copy, so the first check and idle update wait an interval.
async function restoreState($: EngineInterface): Promise<void> {
  const session = await sessionId($)
  const kept = (await safe(() => $.state.get(WAKEUPS)))?.value as Partial<KeptWakeups> | undefined
  let any = false
  if (watches.size === 0 && kept?.session === session && Array.isArray(kept.watches)) {
    for (const w of kept.watches as Partial<LimitWatch>[]) {
      if (!w || !isLimitKind(w.kind) || typeof w.below !== 'number') continue
      watches.set(w.kind, {
        kind: w.kind,
        below: w.below,
        note: typeof w.note === 'string' ? w.note : '',
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null,
      })
      any = true
    }
  }
  const keptIdle = (await safe(() => $.state.get(IDLE_UPDATES)))?.value as Partial<KeptIdleUpdates> | undefined
  if (idle === null && keptIdle?.session === session && keptIdle.idle && typeof keptIdle.idle === 'object') {
    const until = keptIdle.idle.until
    idle = { until: typeof until === 'number' ? until : null }
    any = true
  }
  if (any) {
    const now = await $.clock.now()
    lastWatchCheckAt = now
    lastTurnEndAt = Math.max(lastTurnEndAt, now)
  }
  // A copy that came in mid-session may see no prompt.compose for a while (the engine
  // need not render the system prompt anew): what an earlier copy saw still holds.
  const keptBriefing = (await safe(() => $.state.get(BRIEFING)))?.value as Partial<KeptBriefing> | undefined
  if (keptBriefing?.session === session && keptBriefing.composed === true) composed = true
}

// A subagent's settings call: only its own pause thresholds, which apply to it alone.
async function changeAgentLimits($: EngineInterface, agent: string, change: SettingsChange): Promise<string> {
  const others = (['intervalMinutes', 'compactThreshold'] as const).filter(k => k in change)
  if (others.length > 0) {
    return (
      `CTM: ${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} the main agent's to set; a subagent can set only ` +
      'its own fiveHourPauseAt / sevenDayPauseAt.'
    )
  }
  const own = { ...(agentPauseAt.get(agent) ?? {}) }
  for (const [key, kind] of [
    ['fiveHourPauseAt', 'five_hour'],
    ['sevenDayPauseAt', 'seven_day'],
  ] as const) {
    if (!(key in change)) continue
    const v = change[key]
    if (v === null || v === 'default') delete own[kind]
    else {
      const n = v === 'off' ? 0 : Number(String(v).replace('%', ''))
      if (!Number.isFinite(n) || n < 0 || n > 100) return `CTM: ${key} must be a percent from 1 to 100, "off" (0) or null.`
      own[kind] = n
    }
  }
  if (Object.keys(own).length > 0) agentPauseAt.set(agent, own)
  else agentPauseAt.delete(agent)
  lastSent.set(agent, await $.clock.now())
  const mine = agentPauseAt.get(agent)
  return [
    mine ? `Your own pause thresholds: ${describeAgentLimits(mine)}.` : 'You follow the common pause thresholds.',
    '',
    await report($, 'settings', agent),
  ].join('\n')
}

export const register: Register = (on, options) => {
  configIntervalMinutes = clampInterval(Number(options.intervalMinutes ?? 3) || 3)
  configCompactThreshold = String(options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD).trim().toLowerCase()
  const pct = (v: unknown) => Math.min(100, Math.max(0, Number(v ?? 0) || 0))
  configPauseAt = { five_hour: pct(options.fiveHourPauseAt), seven_day: pct(options.sevenDayPauseAt) }
  settings = null
  lastNagAt = Number.NEGATIVE_INFINITY
  lastWatchCheckAt = 0
  watches.clear()
  agentPauseAt.clear()
  waitingAgents = 0
  ticker = null
  lastTickAt = Number.NEGATIVE_INFINITY
  ticking = false
  restored = false
  resave = false
  lastDrop = null
  sleeper = undefined
  composed = false
  stepped = false
  briefed = false
  toldNoCompose = false
  serverReading = null
  usageFetch = null
  lastUsageTryAt = Number.NEGATIVE_INFINITY
  usageFailures = 0
  usageBackoffUntil = 0
  usageError = null
  usageOff = undefined
  lastResponseAt = Number.NEGATIVE_INFINITY
  account = undefined
  accountSwitchedAt = Number.NEGATIVE_INFINITY
  interactive = false
  configPath = undefined
  stepsOut = new Map()
  oldStepBackAt = Number.NEGATIVE_INFINITY
  switcher = null
  cooldownMs = Math.max(0, Number(options.resetCooldownMinutes ?? 10)) * MINUTE
  effortCooldownMs = Math.max(0, Number(options.effortCooldownMinutes ?? 10)) * MINUTE
  attachToPrompts = options.attachToPrompts !== false
  configuredTimeZone = String(options.timeZone ?? '')
  timeZone = null

  // ---------------------------------------------------------------- Session

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'status',
      description:
        'CTM: Returns the current CTM block – context window fill and auto-compact threshold, the 5-hour and ' +
        '7-day rate limits with reset times, and how each changed since your previous CTM block. Once the ' +
        'newest reading of the limits is 3 min old they are read anew from the server first; refresh=true does so at once.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description:
              'true: read the 5-hour and 7-day limits anew from the server first (a few seconds, no tokens) – ' +
              'e.g. when a reading is marked "as of" or is from before its window reset. At most every 30 s.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'idle_updates',
      description:
        'CTM: Turns updates while you are idle on or off for this session. When on, you get the current ' +
        `figures at the update interval (default ${configIntervalMinutes} min; see ${T_SETTINGS}) even when you are ` +
        'doing nothing. ' +
        'WARNING: every idle update starts a new turn and uses quota. Only turn it on while you are waiting ' +
        'for something (e.g. a limit reset), and bound it with maxMinutes. While you work you get updates ' +
        'on tool results anyway.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          maxMinutes: { type: 'number', minimum: 1, description: 'Turns itself off after this. Omit = until turned off.' },
        },
        required: ['enabled'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'reset',
      description:
        'CTM: Schedules a compact or a clear of your conversation for the END of your current turn. Afterwards ' +
        'you automatically receive resumePrompt as a new message and continue with it. Finish your answer ' +
        'promptly after calling this.\n' +
        '- mode "compact": the conversation is summarized. "instructions" (required) tells the summarizer ' +
        'what it must keep.\n' +
        '- mode "clear": the conversation is deleted COMPLETELY; only resumePrompt survives.\n' +
        'The resumePrompt is the one thing you can rely on afterwards – a summary can lose details, a clear ' +
        'loses everything. Write it so a fresh you can carry on from it alone, structured as:\n' +
        '1. Next step: exactly what to continue with.\n' +
        '2. Key facts: goal, current state, decisions taken and why, open items, relevant files, paths, ' +
        'commands, IDs.\n' +
        '3. Rules: every important rule, constraint and preference you were given (by the user, CLAUDE.md, ' +
        'the task) – verbatim where the wording matters.\n' +
        'There is NO length limit on resumePrompt or instructions: be complete rather than short. Either put ' +
        'everything directly into the resumePrompt, or write the details to a file and give its exact path in ' +
        'the resumePrompt (with the next step and a pointer to read the file first). ' +
        `At least ${cooldownMs / MINUTE} minutes must pass between two resets. Main agent only.`,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['compact', 'clear'] },
          instructions: {
            type: 'string',
            description:
              'Required for compact, no length limit: what the summary must keep (goal, state, decisions, open ' +
              'items, files, rules).',
          },
          resumePrompt: {
            type: 'string',
            description:
              'Required, no length limit: the message you continue with after the reset – next step, key ' +
              'facts, and every important rule; or the next step plus the exact path of a file holding them.',
          },
        },
        required: ['mode', 'resumePrompt'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'settings',
      description:
        'CTM: Shows or changes the CTM settings (kept across sessions). Call without arguments to see them. ' +
        'Change them when the user asks or agrees, or on your own judgement where the user left it to you. ' +
        'null resets a setting to its default.\n' +
        `- intervalMinutes (1–${MAX_INTERVAL_MINUTES}): how often CTM blocks come while you work and, with idle ` +
        'updates on, while you are idle.\n' +
        '- compactThreshold: context size from which the blocks remind you to compact when your task allows it – ' +
        `tokens ("300k", 300000) or a percent of the window ("30%"); default ${DEFAULT_COMPACT_THRESHOLD}; "off" = the ` +
        'user does not want one.\n' +
        '- fiveHourPauseAt / sevenDayPauseAt (percent, "off"): from this usage on, the blocks ask you to pause ' +
        `and wait for the limit with ${T_WAKEUP}.\n` +
        'A subagent can set only its own fiveHourPauseAt / sevenDayPauseAt: they apply to it alone.',
      inputSchema: {
        type: 'object',
        properties: {
          intervalMinutes: { type: ['number', 'null'], minimum: 1, maximum: MAX_INTERVAL_MINUTES },
          compactThreshold: { type: ['string', 'number', 'null'], description: '"300k", 300000, "30%", "off" or null.' },
          fiveHourPauseAt: { type: ['number', 'string', 'null'], description: 'Percent 1–100, "off" or null.' },
          sevenDayPauseAt: { type: ['number', 'string', 'null'], description: 'Percent 1–100, "off" or null.' },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'limit_wakeup',
      description:
        'CTM: Arms a wake-up for when a rate limit is back below a mark – after its window resets or once it ' +
        'drops. CTM checks at the update interval while you are idle and then sends you a message, so you can ' +
        'pause: first finish anything that must not be left half-done, then call this and end your turn. Use it when a block says a limit is past your pause threshold, ' +
        'or on your own ("wake me when the 5-hour window has reset"). One wake-up per limit; arming again ' +
        'replaces it, cancel=true removes it. From a subagent it waits right in the call instead and returns ' +
        'once the limit is back below – then carry on.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'string', enum: ['five_hour', 'seven_day'] },
          belowPercent: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            description:
              'Wake when usage is below this. Default: the pause threshold of that limit, else the built-in ' +
              'safety threshold (5-hour 95%, 7-day 97%).',
          },
          note: { type: 'string', description: 'Optional: what to continue with, sent back with the wake-up.' },
          cancel: { type: 'boolean' },
        },
        required: ['limit'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'models',
      description:
        'CTM: Shows your current model and the models you can switch to (aliases such as sonnet, opus, haiku, ' +
        `their [1m] variants, or a full model ID). Switch with ${T_SWITCH}.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'switch_model',
      description:
        'CTM: Schedules a switch of your model for the END of your current turn – for this session only. ' +
        'Afterwards you automatically receive resumePrompt as a new message (with the model you now run on) and ' +
        'continue with it. Finish your answer promptly after calling this. ' +
        `See ${T_MODELS} for the current model and what is available.\n` +
        '- Use a smaller model (e.g. haiku, sonnet) for simple, routine work or when the limits run high, a larger ' +
        'one (e.g. opus) for hard problems.\n' +
        '- A switch rebuilds the prompt cache on the new model for the whole conversation. With a large context, ' +
        'combine it with reset "compact" (needs instructions) or "clear": the reset runs first, then the switch.\n' +
        '- If the host or a policy refuses the model, you stay on the current one and are told why, with your ' +
        'resumePrompt.\n' +
        `- Optional effort: set the effort for the new model in the same go (see ${T_EFFORT}).\n` +
        '- If the user told you to stay on a model, do not switch on your own.\n' +
        'Write the resumePrompt as for a reset: 1. next step, 2. key facts, 3. every important rule – no length ' +
        'limit; or the next step plus the exact path of a file holding the rest. ' +
        `Shares the ${cooldownMs / MINUTE}-minute minimum gap with ${T_RESET}. Main agent only.`,
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: `An alias or full model ID, as ${T_MODELS} lists them.` },
          resumePrompt: {
            type: 'string',
            description:
              'Required, no length limit: the message you continue with after the switch – next step, key facts, ' +
              'and every important rule; or the next step plus the exact path of a file holding them.',
          },
          reset: {
            type: 'string',
            enum: ['compact', 'clear'],
            description: 'Optional: compact or clear the conversation first, then switch.',
          },
          instructions: {
            type: 'string',
            description: 'Required with reset "compact": what the summary must keep.',
          },
          effort: {
            type: 'string',
            enum: EFFORT_LEVELS,
            description: 'Optional: the effort level to set after the switch.',
          },
        },
        required: ['model', 'resumePrompt'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_effort',
      description:
        'CTM: Changes how long you think (your reasoning effort) from the END of your current turn on – for this ' +
        'session only – then you automatically get a message and carry on (with resumePrompt if you give one). ' +
        'Finish your answer promptly after calling this. ' +
        `See ${T_MODELS} for your current effort and the levels your model supports.\n` +
        '- Raise it (high, xhigh, max) when your solutions stay half-baked, you keep going in circles, or the ' +
        'problem turns out harder than it looked. Lower it (low, medium) for simple, routine work – it saves time ' +
        'and quota. "auto" hands the choice back to Claude Code.\n' +
        '- If the user told you to keep a certain effort, do not change it on your own.\n' +
        `At least ${effortCooldownMs / MINUTE} minutes between two effort changes. Main agent only.`,
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: EFFORT_LEVELS },
          resumePrompt: {
            type: 'string',
            description:
              'Optional: what to continue with once the new effort is in place. Your conversation stays as it is, ' +
              'so the next step is enough. Left out: you are told to carry on where you left off.',
          },
        },
        required: ['level'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_ultracode',
      description:
        'CTM: Turns Ultracode on or off from the END of your current turn on – for this session only – then you ' +
        'automatically get a message and carry on (with resumePrompt if you give one). Finish your answer promptly ' +
        'after calling this. Ultracode is the standing opt-in to multi-agent workflows: while it is on, you run a ' +
        'workflow for every substantive task. It does not depend on your effort; set that separately with ' +
        `${T_EFFORT}.\n` +
        '- Turn it on for work that gains from many agents: broad audits or reviews, migrations, research across ' +
        'many sources, hard problems that need independent attempts and adversarial checks.\n' +
        '- Turn it off for routine or conversational work, or when a limit runs high – workflows cost far more ' +
        'quota than working alone.\n' +
        '- If the user told you to keep Ultracode on or off, do not change it on your own.\n' +
        `At least ${effortCooldownMs / MINUTE} minutes between two Ultracode changes. Main agent only.`,
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true: Ultracode on; false: off.' },
          resumePrompt: {
            type: 'string',
            description:
              'Optional: what to continue with once Ultracode is on or off. Your conversation stays as it is, ' +
              'so the next step is enough. Left out: you are told to carry on where you left off.',
          },
        },
        required: ['enabled'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await safe(() =>
      $.command.register({
        name: 'ctm',
        description:
          'CTM settings: /ctm shows them; /ctm interval 5 · /ctm compact 300k|30%|off|default · ' +
          '/ctm pause5h 80|off|default · /ctm pause7d 90|off|default',
      }),
    )
    await ensureSettings($)
    ticker?.cancel()
    ticker = null
    interactive = e.isInteractive === true
    await ensureRunning($)
    await checkAccount($)
    return next(e)
  })

  // /ctm – the person's own way to see and change the settings.
  on('command.run', { command: 'ctm' }, async ($, e) => {
    const [what = '', raw = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const value = raw === 'default' ? null : raw
    const key = {
      interval: 'intervalMinutes',
      compact: 'compactThreshold',
      pause5h: 'fiveHourPauseAt',
      pause7d: 'sevenDayPauseAt',
    }[what]
    if (what && (!key || raw === '')) {
      return {
        text:
          'Usage: /ctm · /ctm interval 5 · /ctm compact 300k|30%|off|default · /ctm pause5h 80|off|default · ' +
          '/ctm pause7d 90|off|default',
      }
    }
    if (key) {
      const err = await changeSettings($, { [key]: value })
      if (err) return { text: `CTM: ${err}` }
    } else await ensureSettings($)
    if (!key) return { text: describeSettings() }
    await refreshForBlock($)
    const answer = await settingsAnswer($, true)
    lastSent.set('main', await $.clock.now())
    return { text: answer, context: [`The user changed the CTM settings with /ctm.\n${answer}`] }
  })

  on('session.end', async ($, e, next) => {
    briefed = false // the context starts over
    if (e.reason === 'clear') {
      // /clear only ends the session formally; timer and state stay, kept under the new id.
      resave = true
    } else {
      // Another session takes its place in this process (/resume, a new login), or the
      // process ends: nothing of the one that ended may fire into the next. The next hook
      // takes that session's own wake-ups from $.state.
      ticker?.cancel()
      ticker = null
      watches.clear()
      idle = null
      busy = false
      pending = null
      awaiting = null
      awaitTimer?.cancel()
      awaitTimer = null
      agentPauseAt.clear()
      lastSent.clear()
      previousReport.clear()
      lastWatchCheckAt = 0
      restored = false
    }
    const r = await next(e)
    const job = awaiting
    if (e.reason === 'clear' && job?.mode === 'clear') {
      finishReset($, job, '[CTM] Your conversation was cleared completely as you scheduled.')
    }
    return r
  })

  // Confirms a /compact that CTM submitted as a prompt (headless hosts).
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const job = awaiting
    if (job?.mode === 'compact' && e.trigger !== 'precompute' && !e.agentId) {
      finishReset(
        $,
        job,
        r.skip
          ? `[CTM] The compact you scheduled was refused: ${r.skip}. The conversation is unchanged.`
          : '[CTM] Your conversation was compacted as you scheduled.',
      )
    }
    return r
  })

  // Permanent briefing in the system prompt: there from the start, survives compact and clear.
  on('prompt.compose', async ($, e, next) => {
    if (!composed) {
      composed = true
      const kept: KeptBriefing = { session: await sessionId($), composed: true }
      await safe(() => $.state.set(BRIEFING, kept))
    }
    const r = await next(e)
    return { sections: [...r.sections, { id: 'ctm:info', text: INFO, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- Turns

  // Only the main loop's turns make it busy: a subagent's turn – a background one too,
  // after the main turn has ended – holds no wake-up or idle update back.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) busy = true
    await ensureRunning($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await ensureRunning($)
    if (e.agentId) return r // a subagent's run does not end a turn of the main agent
    busy = false
    lastTurnEndAt = await $.clock.now()
    if (pending) {
      if (e.isAborted) {
        // Interrupted: the person is stepping in, so nothing fires on its own.
        toast($, `CTM: scheduled ${describeJob(pending)} dropped (turn interrupted)`)
        pending = null
      } else {
        $.clock.after(RESET_DELAY_MS, () => void runReset($))
      }
    }
    return r
  })

  // ---------------------------------------------------------------- The model's tools

  on('tool.call', { tool: T_STATUS }, async ($, e) => {
    await ensureRunning($)
    const recipient = e.agentId ?? 'main'
    let note = ''
    if ((e as unknown as { refresh?: unknown }).refresh === true) note = await refreshOnDemand($)
    else await refreshForBlock($)
    lastSent.set(recipient, await $.clock.now())
    const block = await report($, 'status request', recipient)
    return { result: note ? `${block}\n${note}` : block }
  }).catch(() => ({ deny: 'CTM: could not read the current figures.' }))

  on('tool.call', { tool: T_IDLE }, async ($, e) => {
    await ensureRunning($)
    const input = e as unknown as { enabled?: unknown; maxMinutes?: unknown }
    if (typeof input.enabled !== 'boolean') return { deny: 'CTM: "enabled" (true/false) is missing.' }
    if (!input.enabled) {
      idle = null
      await saveIdle($)
      return { result: 'CTM: idle updates OFF.' }
    }
    const max = typeof input.maxMinutes === 'number' && input.maxMinutes > 0 ? input.maxMinutes : null
    const now = await $.clock.now()
    idle = { until: max === null ? null : now + max * MINUTE }
    await saveIdle($)
    toast($, `CTM: idle updates on${max === null ? '' : ` for ${max} min`}`)
    return {
      result:
        `CTM: idle updates ON${max === null ? ' until turned off' : ` for ${max} min`}. ` +
        `Next update within ${intervalMinutes()} min, unless you are working then.`,
    }
  }).catch(() => ({ deny: 'CTM: could not switch idle updates.' }))

  on('tool.call', { tool: T_RESET }, async ($, e) => {
    if (e.agentId) return { deny: 'CTM: only the main agent may compact or clear.' }
    const input = e as unknown as { mode?: unknown; instructions?: unknown; resumePrompt?: unknown }
    const mode = input.mode
    if (mode !== 'compact' && mode !== 'clear') return { deny: 'CTM: "mode" must be "compact" or "clear".' }
    const resumePrompt = typeof input.resumePrompt === 'string' ? input.resumePrompt.trim() : ''
    if (resumePrompt.length < MIN_RESUME_CHARS) {
      return { deny: `CTM: no ${mode} without a meaningful resumePrompt (at least ${MIN_RESUME_CHARS} characters).` }
    }
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
    if (mode === 'compact' && instructions.length < MIN_INSTRUCTION_CHARS) {
      return {
        deny: `CTM: compact needs "instructions" (at least ${MIN_INSTRUCTION_CHARS} characters): what the summary must keep.`,
      }
    }
    const now = await $.clock.now()
    const wait = lastResetAt + cooldownMs - now
    if (wait > 0) return { deny: `CTM: the last reset was too recent. Next one possible ${fmtIn(wait)}.` }

    const replaced = pending !== null
    pending = { mode, model: null, effort: null, ultracode: null, instructions: mode === 'compact' ? instructions : null, resumePrompt }
    toast($, `CTM: the model scheduled a ${mode} for the end of this turn`)
    return {
      result:
        `CTM: ${mode} scheduled for the end of this turn${replaced ? ' (replaces the reset or switch scheduled before)' : ''}. ` +
        'Finish your answer now; you will then receive your resume prompt.',
    }
  }).catch(() => ({ deny: 'CTM: could not schedule the reset.' }))

  on('tool.call', { tool: T_SETTINGS }, async ($, e) => {
    const input = e as unknown as SettingsChange
    const change: SettingsChange = {}
    for (const k of ['intervalMinutes', 'compactThreshold', 'fiveHourPauseAt', 'sevenDayPauseAt'] as const) {
      if (k in input) change[k] = input[k]
    }
    await refreshForBlock($)
    if (e.agentId) return { result: await changeAgentLimits($, e.agentId, change) }
    const changed = Object.keys(change).length > 0
    if (changed) {
      const err = await changeSettings($, change)
      if (err) return { deny: `CTM: ${err}` }
      toast($, 'CTM: settings changed by the model')
    } else await ensureSettings($)
    lastSent.set(e.agentId ?? 'main', await $.clock.now())
    return { result: await settingsAnswer($, changed) }
  }).catch(() => ({ deny: 'CTM: could not read or save the settings.' }))

  on('tool.call', { tool: T_WAKEUP }, async ($, e, next) => {
    await ensureRunning($)
    const agent = e.agentId
    const input = e as unknown as { limit?: unknown; belowPercent?: unknown; note?: unknown; cancel?: unknown }
    const kind = input.limit
    if (!isLimitKind(kind)) return { deny: 'CTM: "limit" must be "five_hour" or "seven_day".' }
    if (input.cancel === true) {
      if (agent) return { result: 'CTM: a subagent has no wake-up to remove – its wait ends with the call.' }
      const had = watches.delete(kind)
      if (had) await saveWatches($)
      return { result: `CTM: ${had ? 'wake-up removed' : 'no wake-up was armed'} for the ${limitName(kind)}.` }
    }
    await ensureSettings($)
    const below =
      typeof input.belowPercent === 'number'
        ? input.belowPercent
        : pauseAtFor(kind, agent) > 0
          ? pauseAtFor(kind, agent)
          : FALLBACK_PAUSE_AT[kind]
    if (!(below > 0 && below <= 100)) return { deny: 'CTM: belowPercent must be from 1 to 100.' }
    await refreshForBlock($)
    const now = await $.clock.now()
    const u = await $.session.usage({ breakdown: 'summary' })
    const r = limitsNow(u.rateLimits, now).find(x => x.kind === kind)
    const watch: LimitWatch = {
      kind,
      below,
      note: typeof input.note === 'string' ? input.note.trim() : '',
      resetsAt: r?.resetsAt ? Date.parse(r.resetsAt) : null,
    }
    if (!r) return { deny: `CTM: no reading for the ${limitName(kind)} (not on a subscription, or no response yet).` }
    const already = watchMet(watch, r, now)
    if (already) return { result: `CTM: no need to wait – the ${limitName(kind)} is below ${fmtPercent(below)} already (${already}).` }
    if (agent) {
      // A subagent's turn ending is its end: it waits here instead.
      let why: string | null = null
      const done = await waitUntil($, next, async () => {
        const u2 = await $.session.usage()
        const at = await $.clock.now()
        why = watchMet(watch, limitsNow(u2.rateLimits, at).find(x => x.kind === kind), at)
        return why !== null
      })
      if (done === 'aborted') return { result: 'CTM: the wait was interrupted.' }
      if (done === 'budget' && sleeper === null) {
        // No process to wait in: another call would end as soon, a model request each time.
        return {
          result:
            `CTM: the ${limitName(kind)} is not below ${fmtPercent(below)} yet, and a subagent cannot wait inside ` +
            `${T_WAKEUP} on this host (no sleep process runs here). Finish what must not be left half-done, then end ` +
            'your work with a short report of where you stopped – the main agent can pause and be woken.' +
            (watch.note ? `\n--- Your note ---\n${watch.note}` : ''),
        }
      }
      if (done === 'budget') {
        return {
          result:
            `CTM: the ${limitName(kind)} is not below ${fmtPercent(below)} yet, and this wait had to end (a hook's time ` +
            `is bounded). Call ${T_WAKEUP} again (limit "${kind}") to wait on; do not start new work meanwhile.` +
            (watch.note ? `\n--- Your note ---\n${watch.note}` : ''),
        }
      }
      return {
        result:
          `CTM: the ${limitName(kind)} is below ${fmtPercent(below)} again (${why}). Carry on with your work.` +
          (watch.note ? `\n--- Your note ---\n${watch.note}` : ''),
      }
    }
    watches.set(kind, watch)
    await saveWatches($)
    lastWatchCheckAt = now
    toast($, `CTM: wake-up armed – ${limitName(kind)} below ${fmtPercent(below)}`)
    return {
      result:
        `CTM: wake-up armed for the ${limitName(kind)} below ${fmtPercent(below)} (now ${fmtPercent(r.percentUsed)}` +
        `${r.resetsAt ? `, window resets ${fmtAt(Date.parse(r.resetsAt), now)}` : ''}). CTM checks every ` +
        `${intervalMinutes()} min while you are idle. End your turn now; you will get a message when it is time ` +
        'to carry on.',
    }
  }).catch(() => ({ deny: 'CTM: could not arm the wake-up.' }))

  on('tool.call', { tool: T_MODELS }, async $ => {
    return { result: describeModels(await modelInfo($)) }
  }).catch(() => ({ deny: 'CTM: could not read the models.' }))

  on('tool.call', { tool: T_SWITCH }, async ($, e) => {
    if (e.agentId) return { deny: 'CTM: only the main agent may switch the model.' }
    const input = e as unknown as { model?: unknown; resumePrompt?: unknown; reset?: unknown; instructions?: unknown; effort?: unknown }
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!isModelName(model)) return { deny: `CTM: "model" must be an alias or a full model ID (see ${T_MODELS}).` }
    const mode = input.reset ?? null
    if (mode !== null && mode !== 'compact' && mode !== 'clear') return { deny: 'CTM: "reset" must be "compact", "clear" or left out.' }
    const effort = input.effort ?? null
    if (effort !== null && (typeof effort !== 'string' || !EFFORT_LEVELS.includes(effort))) {
      return { deny: `CTM: "effort" must be one of ${EFFORT_LEVELS.join(', ')} or left out.` }
    }
    const resumePrompt = typeof input.resumePrompt === 'string' ? input.resumePrompt.trim() : ''
    if (resumePrompt.length < MIN_RESUME_CHARS) {
      return { deny: `CTM: no model switch without a meaningful resumePrompt (at least ${MIN_RESUME_CHARS} characters).` }
    }
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
    if (mode === 'compact' && instructions.length < MIN_INSTRUCTION_CHARS) {
      return {
        deny: `CTM: reset "compact" needs "instructions" (at least ${MIN_INSTRUCTION_CHARS} characters): what the summary must keep.`,
      }
    }
    const now = await $.clock.now()
    const wait = lastResetAt + cooldownMs - now
    if (wait > 0) return { deny: `CTM: the last reset or model switch was too recent. Next one possible ${fmtIn(wait)}.` }

    // First: does the model exist (and may this session use it)? Only then is the switch scheduled.
    const info = await modelInfo($)
    const { check, error } = await checkModel($, model, info.options)
    if (error) {
      return {
        deny:
          `CTM: model "${model}" is not available – nothing was scheduled. Check: ${check}; ${error}. ` +
          `Available: ${info.options.length > 0 ? info.options.join(', ') : 'see ' + T_MODELS} – or a full model ID.`,
      }
    }

    const replaced = pending !== null
    const target = info.catalog?.find(c => c.value === model || c.resolvedModel === model)
    if (effort && effort !== 'auto' && target?.supportedEffortLevels && !target.supportedEffortLevels.includes(effort)) {
      return {
        deny: `CTM: ${model} does not support effort "${effort}" (it supports ${target.supportedEffortLevels.join(', ')}) – nothing was scheduled.`,
      }
    }
    pending = { mode, model, effort, ultracode: null, instructions: mode === 'compact' ? instructions : null, resumePrompt }
    toast($, `CTM: the model scheduled a ${describeJob(pending)} for the end of this turn`)
    return {
      result:
        `CTM: model "${model}" checked (${check}). ` +
        `${describeJob(pending)} scheduled for the end of this turn (now on ${info.current ?? 'unknown'})` +
        `${replaced ? '; replaces the reset or switch scheduled before' : ''}.` +
        `${info.locked ? ' Note: the Model setting is locked by a policy – the switch may be refused.' : ''} ` +
        'Finish your answer now; you will then receive your resume prompt.',
    }
  }).catch(() => ({ deny: 'CTM: could not schedule the model switch.' }))

  on('tool.call', { tool: T_EFFORT }, async ($, e) => {
    if (e.agentId) return { deny: 'CTM: only the main agent may change its effort.' }
    const input = e as unknown as { level?: unknown; resumePrompt?: unknown }
    const level = input.level
    if (typeof level !== 'string' || !EFFORT_LEVELS.includes(level)) {
      return { deny: `CTM: "level" must be one of ${EFFORT_LEVELS.join(', ')}.` }
    }
    const now = await $.clock.now()
    const wait = lastEffortAt + effortCooldownMs - now
    if (wait > 0) return { deny: `CTM: the last effort change was too recent. Next one possible ${fmtIn(wait)}.` }

    const info = await modelInfo($)
    const own = info.catalog?.find(c => c.resolvedModel === info.current) ?? info.catalog?.find(c => c.value === info.current)
    if (level !== 'auto' && own?.supportedEffortLevels && !own.supportedEffortLevels.includes(level)) {
      return {
        deny: `CTM: your model ${info.current} does not support effort "${level}" (it supports ${own.supportedEffortLevels.join(', ')}).`,
      }
    }
    if (own && (!own.supportedEffortLevels || own.supportedEffortLevels.length === 0)) {
      return { deny: `CTM: your model ${info.current} has no effort levels.` }
    }
    const given = typeof input.resumePrompt === 'string' ? input.resumePrompt.trim() : ''
    const resumePrompt = given || 'Carry on with your task where you left off, now with the new effort.'

    const replaced = pending !== null
    // Joins a reset or model switch already scheduled for this turn; else stands alone.
    pending = pending
      ? { ...pending, effort: level, resumePrompt: given ? `${pending.resumePrompt}\n\n${given}` : pending.resumePrompt }
      : { mode: null, model: null, effort: level, ultracode: null, instructions: null, resumePrompt }
    toast($, `CTM: the model scheduled effort ${level} for the end of this turn`)
    return {
      result:
        `CTM: effort ${level} scheduled for the end of this turn (now ${info.effort ?? 'unknown'})` +
        `${replaced ? '; added to the reset or switch already scheduled' : ''}. ` +
        'Finish your answer now; you will then get a message to carry on.',
    }
  }).catch(() => ({ deny: 'CTM: could not schedule the effort change.' }))

  on('tool.call', { tool: T_ULTRACODE }, async ($, e) => {
    if (e.agentId) return { deny: 'CTM: only the main agent may turn Ultracode on or off.' }
    const input = e as unknown as { enabled?: unknown; resumePrompt?: unknown }
    const enabled = input.enabled
    if (typeof enabled !== 'boolean') return { deny: 'CTM: "enabled" must be true or false.' }
    const now = await $.clock.now()
    const wait = lastUltracodeAt + effortCooldownMs - now
    if (wait > 0) return { deny: `CTM: the last Ultracode change was too recent. Next one possible ${fmtIn(wait)}.` }
    const state = enabled ? 'on' : 'off'
    const given = typeof input.resumePrompt === 'string' ? input.resumePrompt.trim() : ''
    const resumePrompt = given || `Carry on with your task where you left off, now with Ultracode ${state}.`

    const replaced = pending !== null
    // Joins a reset, model switch or effort change already scheduled for this turn; else stands alone.
    pending = pending
      ? { ...pending, ultracode: enabled, resumePrompt: given ? `${pending.resumePrompt}\n\n${given}` : pending.resumePrompt }
      : { mode: null, model: null, effort: null, ultracode: enabled, instructions: null, resumePrompt }
    toast($, `CTM: the model scheduled Ultracode ${state} for the end of this turn`)
    return {
      result:
        `CTM: Ultracode ${state} scheduled for the end of this turn` +
        `${replaced ? '; added to the reset, switch or effort change already scheduled' : ''}. ` +
        'Finish your answer now; you will then get a message to carry on.',
    }
  }).catch(() => ({ deny: 'CTM: could not schedule the Ultracode change.' }))

  // The main loop's effort, as each of its model requests carries it. A main step also
  // means a main turn runs – a fresh copy of the module may not have heard its start.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      busy = true
      if (e.effort !== undefined) lastEffort = String(e.effort)
    }
    const sentAt = await $.clock.now()
    const step = {}
    stepsOut.set(step, sentAt)
    try {
      const r = yield* next(e)
      if (!e.agentId) stepped = true
      // A response came: the host's own limit reading is from now – unless it may still
      // be the account's before a switch.
      if (r.stopReason !== null && isNewAccount(sentAt)) lastResponseAt = await $.clock.now()
      return r
    } finally {
      // Gone from stepsOut only once oldStepBackAt holds it, with no wait in between.
      const back = await safe(() => $.clock.now())
      stepsOut.delete(step)
      if (sentAt < accountSwitchedAt) oldStepBackAt = Math.max(oldStepBackAt, back ?? sentAt)
    }
  })

  // ---------------------------------------------------------------- Subagents

  // [CTM limits: 5h=70 7d=90] in a subagent's prompt: its own pause thresholds.
  on('agent.spawn', async ($, e, next) => {
    const m = LIMITS_MARK.exec(e.prompt)
    const own = m ? parseAgentLimits(m[1]!) : null
    if (!own) return next(e)
    const prompt =
      `${e.prompt.replace(LIMITS_MARK, '').trim()}\n\n(CTM: your own pause thresholds are ${describeAgentLimits(own)}. ` +
      `Past one, finish what must not be left half-done, then wait with ${T_WAKEUP}; the CTM blocks say when.)`
    const r = await next({ ...e, prompt })
    if (r.agentId) agentPauseAt.set(r.agentId, own)
    return r
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- Figures while working

  // At most every interval – and at once when a pause mark is newly passed, or when the
  // briefing has to come with a block (see `composed`). It takes no
  // server reading: while the model works, every response brings a fresh one.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    await ensureRunning($)
    if (r.deny !== undefined || String(e.tool).startsWith(PREFIX)) return r
    const recipient = e.agentId ?? 'main'
    const now = await $.clock.now()
    const due = now - (lastSent.get(recipient) ?? 0) >= intervalMs()
    const marked = !due && (await newlyPastMark($, recipient, now))
    if (!due && !marked && !(recipient === 'main' && briefingPending())) return r
    lastSent.set(recipient, now)
    return { ...r, context: [...(r.context ?? []), await report($, marked ? 'limit update' : 'work update', recipient)] }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- The person's prompts

  on('prompt.submit', async ($, e, next) => {
    await ensureRunning($)
    if (!attachToPrompts) return next(e)
    if (e.origin?.kind === 'plugin') return next(e) // our own wake-up and resume prompts carry the figures already
    if (await checkAccount($)) {
      if (!usageFetch) await refreshLimits($, { demand: true }) // a /login to another account
    } else await refreshForBlock($)
    lastSent.set('main', await $.clock.now())
    return next({ ...e, context: [...(e.context ?? []), await report($, 'prompt')] })
  }).catch(($, e, next) => next(e))
}
