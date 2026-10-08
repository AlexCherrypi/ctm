import type { EngineInterface, Register } from 'claude-code'

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
//    and clear) and is sent once more after every CTM reset.
// 4. Lets the model see its own model and effort and the models it can switch to (with
//    the engine's own descriptions where it can get them), and switch model and/or
//    effort (on its own or together with a compact or clear) – again with a resume prompt.
// 5. Settings the model (`settings` tool) or the person (/ctm, userConfig) can set:
//    the update interval, a compact threshold (the blocks remind the model to compact
//    once the context passes it; while it is unset they remind it now and then to ask
//    the person for one), and pause thresholds for the 5-hour and 7-day limits (the
//    blocks ask the model to pause past them; `limit_wakeup` wakes it once the limit
//    is back below).
//
// Settings are kept across sessions in $.store. Everything else lives in module
// variables: it survives /clear (the module is not reloaded then) and is scoped to
// this session; a reload of the mod starts it over.

type Mode = 'compact' | 'clear'
// What runs at the end of the turn, in this order: a compact or clear, a model switch,
// an effort change (its levels depend on the model). Any of them may be left out.
type PendingReset = {
  mode: Mode | null
  model: string | null
  effort: string | null
  instructions: string | null
  resumePrompt: string
}
type IdleWatch = { until: number | null }
type LimitReading = { percent: number; resetsAt: string | null }
type Snapshot = {
  at: number
  contextTokens: number | null
  limits: Record<string, LimitReading>
}
type LimitKind = 'five_hour' | 'seven_day'
// What the model or the person set; a missing key falls back to userConfig.
type Settings = {
  intervalMinutes?: number
  compactThreshold?: string // "300k", "300000", "30%" or "off"
  pauseAt?: Partial<Record<LimitKind, number>> // percent; 0 = off
}
type LimitWatch = { kind: LimitKind; below: number; note: string }

const PREFIX = 'mcp__ctm__'
const T_STATUS = 'mcp__ctm__status'
const T_IDLE = 'mcp__ctm__idle_updates'
const T_RESET = 'mcp__ctm__reset'
const T_SETTINGS = 'mcp__ctm__settings'
const T_WAKEUP = 'mcp__ctm__limit_wakeup'
const T_MODELS = 'mcp__ctm__models'
const T_SWITCH = 'mcp__ctm__switch_model'
const T_EFFORT = 'mcp__ctm__set_effort'
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const STORE_SETTINGS = 'settings'
const NAG_EVERY_MS = 30 * 60_000
// Built-in safety net: this close to a limit the blocks always ask the model to pause,
// whatever is configured. Not a setting.
const FALLBACK_PAUSE_AT: Record<LimitKind, number> = { five_hour: 95, seven_day: 97 }
const MAX_INTERVAL_MINUTES = 60

const MIN_RESUME_CHARS = 20
const MIN_INSTRUCTION_CHARS = 20
const IDLE_TICK_MS = 30_000
const RESET_DELAY_MS = 1_000
const COMPACT_CONFIRM_MS = 10 * 60_000
const CLEAR_CONFIRM_MS = 2 * 60_000
const CHECK_TIMEOUT_MS = 30_000
const CATALOG_TIMEOUT_MS = 20_000
const CATALOG_TTL_MS = 15 * 60_000

const MINUTE = 60_000

const lastSent = new Map<string, number>() // recipient ('main' | agentId) -> last delivery
const previousReport = new Map<string, Snapshot>() // recipient -> snapshot of its last report
let lastTurnEndAt = 0
let lastResetAt = Number.NEGATIVE_INFINITY
let lastEffortAt = Number.NEGATIVE_INFINITY
let lastEffort: string | null = null // the main loop's effort, as its last model request carried it
// The engine's model list, kept for CATALOG_TTL_MS – a failed fetch too, so a host where
// it does not work is not asked again on every call.
let catalog: { at: number; list: Promise<CatalogEntry[] | null> } | null = null
let busy = false
let idle: IdleWatch | null = null
let pending: PendingReset | null = null
let awaiting: PendingReset | null = null // a reset run as a command, not yet confirmed by the engine
let awaitTimer: { cancel: () => void } | null = null
let idleTimer: { cancel: () => void } | null = null
let settings: Settings | null = null // loaded from $.store on first use
let lastNagAt = Number.NEGATIVE_INFINITY
let lastWatchCheckAt = 0
const watches = new Map<LimitKind, LimitWatch>()

// From userConfig, set in register
let configIntervalMinutes = 3
let configCompactThreshold = ''
let configPauseAt: Record<LimitKind, number> = { five_hour: 0, seven_day: 0 }
let cooldownMs = 10 * MINUTE // between two resets or model switches
let effortCooldownMs = 10 * MINUTE // between two effort changes
let attachToPrompts = true
let configuredTimeZone = ''
let timeZone: string | null = null // resolved on the first report

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
  '- The 5-hour and 7-day limits are account-wide: their Δ includes every parallel session of the account, not just yours.',
  '- When a limit climbs fast or is high, work more economically: fewer parallel subagents, read only what you need, compact earlier.',
  `- ${T_STATUS}: the current block on demand.`,
  `- ${T_IDLE}: blocks while you are idle as well (each one starts a new turn and costs quota; use sparingly, with maxMinutes).`,
  `- ${T_RESET}: schedules a compact (summary; needs instructions) or a clear (everything gone) for the end of your turn, then sends you your resumePrompt so you carry on. The resumePrompt is what you can rely on afterwards: next step, key facts, and every important rule – no length limit, be complete; or write them to a file and give its exact path in the resumePrompt.`,
  'A good moment for compact/clear is right after finishing a sub-task, before the context gets tight – never in the middle of a change.',
  `- ${T_MODELS}: your current model and effort, and the models you can switch to with what each is good for. ${T_SWITCH}: switches the model at the end of your turn – alone or together with a compact/clear (cheaper: the new model then re-caches only the smaller conversation) – and sends you your resumePrompt afterwards, as a reset does. Switch to a smaller model for simple, routine work, to a larger one for hard problems.`,
  `- ${T_EFFORT}: raises or lowers how long you think, from the end of your turn on, then you carry on. Raise it when your solutions stay half-baked or the problem is harder than it looked; lower it for routine work.`,
  '- If the user told you to stay on a model or an effort level, do not change it yourself.',
  `- ${T_SETTINGS}: how often these blocks come (1–${MAX_INTERVAL_MINUTES} min), a compact threshold (tokens like 300k, or a % of the window), and pause thresholds for the 5-hour and 7-day limits. No arguments = show the current settings. Kept across sessions.`,
  '- Past the compact threshold the blocks remind you to compact: do it at the next clean point if your task allows it (a smaller context makes every further request cheaper on the limits) – never break off critical work for it.',
  '- Built-in safety net, always active and not configurable: from 95% of the 5-hour limit and 97% of the 7-day limit the blocks ask you to pause, even with no pause threshold set.',
  `- Past a pause threshold the blocks ask you to pause: at a clean point call ${T_WAKEUP} and end your turn; you are woken once the limit is back below. You can also use ${T_WAKEUP} on your own, e.g. "wake me when the 5-hour window has reset".`,
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

// A reading whose window has reset since it was taken: rate limits come with the
// responses, so while the model pauses the last reading stays the one before the reset.
function readingIsStale(r: { resetsAt?: string }, now: number): boolean {
  return r.resetsAt !== undefined && Date.parse(r.resetsAt) <= now
}

function describeSettings(): string {
  const ct = compactThresholdSetting()
  const parsed = parseThreshold(ct)
  const compact = ct === 'off' ? 'off (declined)' : parsed ? fmtThreshold(parsed) : 'not set (blocks remind you to ask)'
  const pause = (k: LimitKind) => (pauseAt(k) > 0 ? fmtPercent(pauseAt(k)) : 'off')
  const lines = [
    'CTM settings:',
    `- intervalMinutes: ${intervalMinutes()} (work and idle updates)`,
    `- compactThreshold: ${compact}`,
    `- fiveHourPauseAt: ${pause('five_hour')}`,
    `- sevenDayPauseAt: ${pause('seven_day')}`,
  ]
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

// ---------------------------------------------------------------- The report

// `recipient` is whoever reads this block ('main' or a subagent's id); deltas are
// measured against the previous report that same recipient got.
async function report($: EngineInterface, reason: string, recipient = 'main'): Promise<string> {
  await ensureTimeZone($)
  await ensureSettings($)
  const now = await $.clock.now()
  const u = await $.session.usage({ breakdown: 'summary' })
  const prev = previousReport.get(recipient)
  const c = u.context
  const threshold = c.breakdown?.autoCompactThreshold

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
  if (u.rateLimits.length > 0) {
    for (const r of u.rateLimits) {
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
      lines.push(line)

      const kind = r.kind
      if (isLimitKind(kind) && !stale) {
        // The configured threshold when passed, else the built-in safety net.
        const own = pauseAt(kind) > 0 && r.percentUsed >= pauseAt(kind)
        const safety = !own && r.percentUsed >= FALLBACK_PAUSE_AT[kind]
        if (own || safety) {
          const mark = own ? pauseAt(kind) : FALLBACK_PAUSE_AT[kind]
          const what = own
            ? `your pause threshold ${fmtPercent(mark)}`
            : `the built-in safety threshold ${fmtPercent(mark)} (always active, not configurable – a fallback on top ` +
              'of any pause threshold you set)'
          const w = watches.get(kind)
          notes.push(
            w
              ? `${limitName(kind)} is past ${what}; wake-up armed for below ${fmtPercent(w.below)} – stay paused until then.`
              : `${limitName(kind)} at ${fmtPercent(r.percentUsed)} ≥ ${what}: please pause your work at the next clean ` +
                  `point – call ${T_WAKEUP} (limit "${kind}") and end your turn; you will be woken once it is back below` +
                  `${r.resetsAt ? ` (the window resets ${fmtAt(Date.parse(r.resetsAt), now)})` : ''}.`,
          )
        }
      }
    }
  } else {
    lines.push('Rate limits: not reported (not signed in with a subscription, or no response yet)')
  }
  for (const w of watches.values()) {
    if (!notes.some(n => n.startsWith(limitName(w.kind)))) {
      notes.push(`Wake-up armed: ${limitName(w.kind)} below ${fmtPercent(w.below)}.`)
    }
  }
  for (const n of notes) lines.push(`⚑ ${n}`)

  if (idle) {
    lines.push(
      `Idle updates: on${idle.until === null ? '' : ` until ${fmtClock(idle.until, now)}`} ` +
        `(turn off with ${T_IDLE} enabled=false)`,
    )
  }

  previousReport.set(recipient, { at: now, contextTokens: c.tokens ?? null, limits })
  return lines.join('\n')
}

// ---------------------------------------------------------------- Models

type ModelInfo = {
  current: string | null
  effort: string | null
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
      `Effort: ${T_EFFORT}.`,
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
async function setEffort($: EngineInterface, level: string): Promise<{ ok: boolean; note: string }> {
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
    return { ok: true, note: `[CTM] Your effort was set as you scheduled: now ${level}${before && before !== level ? ` (was ${before})` : ''}.` }
  }
  return {
    ok: false,
    note:
      `[CTM] The effort change to "${level}" you scheduled failed. Command: /effort ${level} – the engine answered: ` +
      `${text ? `"${text}"` : 'nothing'}. Your effort is unchanged${before ? ` (${before})` : ''}.`,
  }
}

// ---------------------------------------------------------------- Reset (runs after the turn)

function describeJob(job: { mode: Mode | null; model: string | null; effort: string | null }): string {
  return [job.mode, job.model ? `model switch to ${job.model}` : null, job.effort ? `effort ${job.effort}` : null]
    .filter(Boolean)
    .join(' + ')
}

async function resetMessage($: EngineInterface, job: PendingReset, note: string): Promise<string> {
  const model = (await safe(() => $.session.model())) ?? null
  const effort = await currentEffort($)
  return [
    note,
    ...(model ? [`Current model: ${model}${effort ? `, effort ${effort}` : ''}`] : []),
    '',
    INFO,
    '',
    '--- Your resume prompt ---',
    job.resumePrompt,
    '',
    await report($, `after ${describeJob(job)}`),
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
  }
  const now = await $.clock.now()
  if (job.mode || job.model) lastResetAt = now
  if (job.effort) lastEffortAt = now
  lastSent.set('main', now)
  await $.prompt.submit({ text: await resetMessage($, job, note) })
}

async function failReset($: EngineInterface, job: PendingReset, message: string): Promise<void> {
  if (awaiting === job) awaiting = null
  awaitTimer?.cancel()
  awaitTimer = null
  toast($, `CTM: ${job.mode} failed – ${message}`)
  const rest = [job.model ? `model switch to "${job.model}"` : null, job.effort ? `effort change to "${job.effort}"` : null]
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
  try {
    refusedBy(await $.command.run({ command: job.mode, args: job.mode === 'compact' ? (job.instructions ?? '') : '' }))
  } catch (err) {
    if (awaiting === job) await failReset($, job, errorText(err))
  }
}

async function runReset($: EngineInterface): Promise<void> {
  const job = pending
  if (!job) return
  if (busy) return // a new turn is already running: try again at its turn.complete
  pending = null

  if (job.mode === null) return deliverResume($, job, '') // a model and/or effort change alone
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

async function idleTick($: EngineInterface): Promise<void> {
  if (!idle || busy || pending || awaiting) return
  const now = await $.clock.now()
  if (idle.until !== null && now >= idle.until) {
    idle = null
    toast($, 'CTM: idle updates expired')
    return
  }
  const since = Math.max(lastSent.get('main') ?? 0, lastTurnEndAt)
  if (now - since < intervalMs()) return
  lastSent.set('main', now)
  busy = true // until turn.start / turn.complete take over
  await $.prompt.submit({ text: await report($, 'idle update') })
}

// ---------------------------------------------------------------- Limit wake-ups

// Is the limit back below the watch's mark? A reading from before its window's reset
// counts as below: no new reading comes while the model pauses.
function watchMet(w: LimitWatch, r: { percentUsed: number; resetsAt?: string } | undefined, now: number): string | null {
  if (!r) return null
  if (readingIsStale(r, now)) return `its window reset ${fmtAt(Date.parse(r.resetsAt as string), now)}`
  if (r.percentUsed < w.below) return `it is at ${fmtPercent(r.percentUsed)}`
  return null
}

// Checks the armed wake-ups once per interval, and only while the model is idle: a
// wake-up starts a turn.
async function watchTick($: EngineInterface): Promise<void> {
  if (watches.size === 0 || busy || pending || awaiting) return
  const now = await $.clock.now()
  if (now - lastWatchCheckAt < intervalMs()) return
  lastWatchCheckAt = now
  const u = await $.session.usage({ breakdown: 'summary' })
  const met: string[] = []
  const notes: string[] = []
  for (const w of [...watches.values()]) {
    const why = watchMet(w, u.rateLimits.find(r => r.kind === w.kind), now)
    if (!why) continue
    watches.delete(w.kind)
    met.push(`the ${limitName(w.kind)} is below ${fmtPercent(w.below)} again (${why})`)
    if (w.note) notes.push(w.note)
  }
  if (met.length === 0) return
  lastSent.set('main', now)
  busy = true // until turn.start / turn.complete take over
  toast($, `CTM: limit wake-up – ${met.join('; ')}`)
  const parts = [`[CTM] Limit wake-up: ${met.join('; ')}. You can carry on with your work.`]
  if (notes.length > 0) parts.push('', '--- Your note ---', ...notes)
  parts.push('', await report($, 'limit wake-up'))
  await $.prompt.submit({ text: parts.join('\n') })
}

export const register: Register = (on, options) => {
  configIntervalMinutes = clampInterval(Number(options.intervalMinutes ?? 3) || 3)
  configCompactThreshold = String(options.compactThreshold ?? '').trim().toLowerCase()
  const pct = (v: unknown) => Math.min(100, Math.max(0, Number(v ?? 0) || 0))
  configPauseAt = { five_hour: pct(options.fiveHourPauseAt), seven_day: pct(options.sevenDayPauseAt) }
  settings = null
  lastNagAt = Number.NEGATIVE_INFINITY
  lastWatchCheckAt = 0
  watches.clear()
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
        '7-day rate limits with reset times, and how each changed since your previous CTM block.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
        'tokens ("300k", 300000) or a percent of the window ("30%"); "off" = the user does not want one (stops ' +
        'the reminders to ask).\n' +
        '- fiveHourPauseAt / sevenDayPauseAt (percent, "off"): from this usage on, the blocks ask you to pause ' +
        `and wait for the limit with ${T_WAKEUP}.`,
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
        'pause: call this, then end your turn. Use it when a block says a limit is past your pause threshold, ' +
        'or on your own ("wake me when the 5-hour window has reset"). One wake-up per limit; arming again ' +
        'replaces it, cancel=true removes it.',
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
    await safe(() =>
      $.command.register({
        name: 'ctm',
        description:
          'CTM settings: /ctm shows them; /ctm interval 5 · /ctm compact 300k|30%|off|default · ' +
          '/ctm pause5h 80|off|default · /ctm pause7d 90|off|default',
      }),
    )
    await ensureSettings($)

    idleTimer?.cancel()
    // One after the other: a wake-up marks the model busy, so no idle update follows it at once.
    idleTimer = $.clock.every(IDLE_TICK_MS, () => void watchTick($).then(() => idleTick($)))
    return next(e)
  })

  // /ctm – the person's own way to see and change the settings.
  on('command.run', { command: 'ctm' }, async ($, e) => {
    const [what = '', raw = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const value = raw === 'default' ? null : raw
    const key = { interval: 'intervalMinutes', compact: 'compactThreshold', pause5h: 'fiveHourPauseAt', pause7d: 'sevenDayPauseAt' }[
      what
    ]
    if (what && (!key || raw === '')) {
      return { text: 'Usage: /ctm · /ctm interval 5 · /ctm compact 300k|30%|off|default · /ctm pause5h 80|off|default · /ctm pause7d 90|off|default' }
    }
    if (key) {
      const err = await changeSettings($, { [key]: value })
      if (err) return { text: `CTM: ${err}` }
    } else await ensureSettings($)
    if (!key) return { text: describeSettings() }
    const answer = await settingsAnswer($, true)
    lastSent.set('main', await $.clock.now())
    return { text: answer, context: [`The user changed the CTM settings with /ctm.\n${answer}`] }
  })

  on('session.end', async ($, e, next) => {
    // /clear only ends the session formally; timer and state stay.
    if (e.reason !== 'clear') {
      idleTimer?.cancel()
      idleTimer = null
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
    const r = await next(e)
    return { sections: [...r.sections, { id: 'ctm:info', text: INFO, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- Turns

  on('turn.start', async ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
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
    const recipient = e.agentId ?? 'main'
    lastSent.set(recipient, await $.clock.now())
    return { result: await report($, 'status request', recipient) }
  }).catch(() => ({ deny: 'CTM: could not read the current figures.' }))

  on('tool.call', { tool: T_IDLE }, async ($, e) => {
    const input = e as unknown as { enabled?: unknown; maxMinutes?: unknown }
    if (typeof input.enabled !== 'boolean') return { deny: 'CTM: "enabled" (true/false) is missing.' }
    if (!input.enabled) {
      idle = null
      return { result: 'CTM: idle updates OFF.' }
    }
    const max = typeof input.maxMinutes === 'number' && input.maxMinutes > 0 ? input.maxMinutes : null
    const now = await $.clock.now()
    idle = { until: max === null ? null : now + max * MINUTE }
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
    pending = { mode, model: null, effort: null, instructions: mode === 'compact' ? instructions : null, resumePrompt }
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
    const changed = Object.keys(change).length > 0
    if (changed) {
      const err = await changeSettings($, change)
      if (err) return { deny: `CTM: ${err}` }
      toast($, 'CTM: settings changed by the model')
    } else await ensureSettings($)
    lastSent.set(e.agentId ?? 'main', await $.clock.now())
    return { result: await settingsAnswer($, changed) }
  }).catch(() => ({ deny: 'CTM: could not read or save the settings.' }))

  on('tool.call', { tool: T_WAKEUP }, async ($, e) => {
    if (e.agentId) return { deny: 'CTM: only the main agent can arm a limit wake-up.' }
    const input = e as unknown as { limit?: unknown; belowPercent?: unknown; note?: unknown; cancel?: unknown }
    const kind = input.limit
    if (!isLimitKind(kind)) return { deny: 'CTM: "limit" must be "five_hour" or "seven_day".' }
    if (input.cancel === true) {
      const had = watches.delete(kind)
      return { result: `CTM: ${had ? 'wake-up removed' : 'no wake-up was armed'} for the ${limitName(kind)}.` }
    }
    await ensureSettings($)
    const below =
      typeof input.belowPercent === 'number' ? input.belowPercent : pauseAt(kind) > 0 ? pauseAt(kind) : FALLBACK_PAUSE_AT[kind]
    if (!(below > 0 && below <= 100)) return { deny: 'CTM: belowPercent must be from 1 to 100.' }
    const watch: LimitWatch = { kind, below, note: typeof input.note === 'string' ? input.note.trim() : '' }
    const now = await $.clock.now()
    const u = await $.session.usage({ breakdown: 'summary' })
    const r = u.rateLimits.find(x => x.kind === kind)
    if (!r) return { deny: `CTM: no reading for the ${limitName(kind)} (not on a subscription, or no response yet).` }
    const already = watchMet(watch, r, now)
    if (already) return { result: `CTM: no need to wait – the ${limitName(kind)} is below ${fmtPercent(below)} already (${already}).` }
    watches.set(kind, watch)
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
    pending = { mode, model, effort, instructions: mode === 'compact' ? instructions : null, resumePrompt }
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
      : { mode: null, model: null, effort: level, instructions: null, resumePrompt }
    toast($, `CTM: the model scheduled effort ${level} for the end of this turn`)
    return {
      result:
        `CTM: effort ${level} scheduled for the end of this turn (now ${info.effort ?? 'unknown'})` +
        `${replaced ? '; added to the reset or switch already scheduled' : ''}. ` +
        'Finish your answer now; you will then get a message to carry on.',
    }
  }).catch(() => ({ deny: 'CTM: could not schedule the effort change.' }))

  // The main loop's effort, as each of its model requests carries it.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && e.effort !== undefined) lastEffort = String(e.effort)
    return yield* next(e)
  })

  // ---------------------------------------------------------------- Figures while working

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || String(e.tool).startsWith(PREFIX)) return r
    const recipient = e.agentId ?? 'main'
    const now = await $.clock.now()
    if (now - (lastSent.get(recipient) ?? 0) < intervalMs()) return r
    lastSent.set(recipient, now)
    return { ...r, context: [...(r.context ?? []), await report($, 'work update', recipient)] }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- The person's prompts

  on('prompt.submit', async ($, e, next) => {
    if (!attachToPrompts) return next(e)
    if (e.origin?.kind === 'plugin') return next(e) // our own wake-up and resume prompts carry the figures already
    lastSent.set('main', await $.clock.now())
    return next({ ...e, context: [...(e.context ?? []), await report($, 'prompt')] })
  }).catch(($, e, next) => next(e))
}
