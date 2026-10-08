import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

const USAGE: Usage = {
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-08T17:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-12T09:00:00.000Z' },
  ],
}

// The world beneath the plugin: figures, compact, clear, queued prompts. Swap
// `usage.current` mid-test to make the figures move.
const MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]']
const MODEL_IDS: Record<string, string> = {
  default: 'claude-sonnet-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
  'claude-haiku-5-5': 'claude-haiku-5-5',
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
// The engine's model list as a second `claude` answers the SDK's initialize request.
const CATALOG = [
  { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks', supportedEffortLevels: LEVELS },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: LEVELS, supportsFastMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers', supportedEffortLevels: ['low', 'medium', 'high'] },
]
const INIT_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'ui_status', text: 'x' }),
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'ctm', response: { models: CATALOG } } }),
  '',
].join('\n')

type WorldOpts = {
  headless?: boolean
  lockedModel?: boolean
  refuseModel?: string
  blockedModel?: string
  catalog?: boolean
  refuseEffort?: string
  effort?: string
}

function world(on: On, initial: Usage = USAGE, opts: WorldOpts = {}) {
  const usage = { current: initial }
  const model = { current: 'claude-opus-5-5' }
  const seen = {
    compacts: [] as (string | undefined)[],
    commands: [] as string[],
    prompts: [] as string[],
    tools: [] as { name: string; description: string }[],
    usage,
    model,
    checks: [] as string[],
    spawns: [] as string[][],
  }
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    seen.spawns.push(argv)
    return { value: { exitCode: opts.catalog ? 0 : 1, stdout: opts.catalog ? INIT_STDOUT : '', stderr: '' } } as never
  })
  // The effort the session started with (CLAUDE_EFFORT); left out, the time tests own env.get.
  if (opts.effort) on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'CLAUDE_EFFORT' ? opts.effort : undefined }) as never)
  on('session.model', () => ({ value: model.current }) as never)
  // The existence check: a one-token request; 404 for a name the API does not know.
  on('model.complete', (_$, e) => {
    seen.checks.push(e.model)
    if (opts.blockedModel === e.model) return { deny: `model "${e.model}" is not in the allowed models of your organization` }
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return {
      value: MODEL_IDS[e.model]
        ? { isAnswered: true, text: 'ok', usage: zero }
        : { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: zero },
    } as never
  })
  on('config.list', () =>
    ({
      value: [
        { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: { plugin: 'engine', tier: 'core' } },
        {
          key: 'model',
          label: 'Model',
          kind: 'choice',
          value: 'Default (recommended)',
          options: MODEL_OPTIONS,
          provider: { plugin: 'engine', tier: 'core' },
          isLocked: opts.lockedModel === true,
        },
      ],
    }) as never,
  )
  on('session.usage', () => ({ value: usage.current }) as never)
  // Headless: the plugin's own first $.session.compact is refused, as such a host does.
  let refuseCompacts = opts.headless ? 1 : 0
  on('session.compact', (_$, e) => {
    if (refuseCompacts > 0) {
      refuseCompacts -= 1
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet')
    }
    seen.compacts.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('command.run', (_$, e) => {
    seen.commands.push(e.args ? `${e.command} ${e.args}` : e.command)
    if (e.command === 'effort') {
      if (opts.refuseEffort) return { text: opts.refuseEffort }
      return { text: `Set effort level to ${e.args} (this session only): …` }
    }
    if (e.command === 'model') {
      // As /model answers: an unknown name or a policy refusal leaves the model as it was.
      if (opts.refuseModel) return { text: opts.refuseModel }
      const id = MODEL_IDS[e.args]
      if (!id) return { text: `Model '${e.args}' not found` }
      model.current = id
      return { text: `Set model to \`${id}\` for this session only` }
    }
    return { text: '' }
  })
  on('prompt.submit', (_$, e) => {
    seen.prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.register', (_$, e) => {
    seen.tools.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__ctm__${e.name}` } } as never
  })
  return seen
}

const RESUME = 'Next step: continue with step 3 of the migration. Rules: never push to main.'
const INSTRUCTIONS = 'Keep the goal, the migration status and the open TODOs.'

const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never

async function status($: Engine, agentId?: string): Promise<string> {
  return String((await $.tool.call({ tool: 'mcp__ctm__status', ...(agentId ? { agentId } : {}) } as never)).result)
}

describe('reset', () => {
  test('refuses a clear without a resume prompt', async ($, on) => {
    world(on)
    const r = await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear' } as never)
    expect(r.deny).toMatch(/resumePrompt/)
  })

  test('refuses a compact without instructions', async ($, on) => {
    world(on)
    const r = await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'compact', resumePrompt: RESUME } as never)
    expect(r.deny).toMatch(/instructions/)
  })

  test('refuses subagents', async ($, on) => {
    world(on)
    const r = await $.tool.call({
      tool: 'mcp__ctm__reset',
      mode: 'clear',
      resumePrompt: RESUME,
      agentId: 'sub-1',
    } as never)
    expect(r.deny).toMatch(/main agent/)
  })

  test('compacts after the turn and sends the resume prompt', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    const r = await $.tool.call({
      tool: 'mcp__ctm__reset',
      mode: 'compact',
      instructions: INSTRUCTIONS,
      resumePrompt: RESUME,
    } as never)
    expect(r.deny).toBeUndefined()
    expect(seen.compacts).toEqual([])

    await $.turn.complete(turn)
    await clock.advance(2_000)

    expect(seen.compacts).toEqual([INSTRUCTIONS])
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain(RESUME)
    expect(seen.prompts[0]).toContain('[CTM] Your conversation was compacted')
    expect(seen.prompts[0]).toContain('5-hour limit: 23.5% used · resets ')
  })

  test('clears through /clear and then enforces the cooldown', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear', resumePrompt: RESUME } as never)
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.commands).toEqual(['clear'])
    expect(seen.prompts).toEqual([]) // not before the engine confirms the clear

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await clock.advance(1_000)
    expect(seen.prompts[0]).toContain('[CTM] Your conversation was cleared completely as you scheduled.')
    expect(seen.prompts[0]).toContain(RESUME)

    const again = await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear', resumePrompt: RESUME } as never)
    expect(again.deny).toMatch(/too recent/)
  })

  test('has no length limit on resume prompt or instructions', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    const long = `Next step: go on.\n${'Key fact. '.repeat(20_000)}`
    const r = await $.tool.call({
      tool: 'mcp__ctm__reset',
      mode: 'compact',
      instructions: long,
      resumePrompt: long,
    } as never)
    expect(r.deny).toBeUndefined()
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect(seen.compacts[0]?.length).toBe(long.trim().length)
    expect(seen.prompts[0]).toContain(long.trim())
  })

  test('the reset tool tells the model there is no length limit and how to structure the prompt', async ($, on) => {
    const seen = world(on)
    on('session.start', () => ({ cwd: '/' }) as never)
    mock.clock(on, { now: 0 })
    await $.session.start({ cwd: '/' } as never)
    const reset = seen.tools.find(t => t.name === 'reset')
    expect(reset?.description).toContain('NO length limit')
    expect(reset?.description).toMatch(/Next step[\s\S]*Key facts[\s\S]*Rules/)
    expect(reset?.description).toMatch(/write the details to a file and give its exact path/)
  })

  test('an interrupted turn drops the scheduled reset', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear', resumePrompt: RESUME } as never)
    await $.turn.complete({ ...(turn as object), isAborted: true, reason: 'aborted' } as never)
    await clock.advance(5_000)
    expect(seen.commands).toEqual([])
    expect(seen.prompts).toEqual([])
  })
})

describe('reset in a headless host', () => {
  test('compact falls back to the /compact command and resumes once it ran', async ($, on) => {
    const seen = world(on, USAGE, { headless: true })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call({
      tool: 'mcp__ctm__reset',
      mode: 'compact',
      instructions: INSTRUCTIONS,
      resumePrompt: RESUME,
    } as never)
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.commands).toEqual([`compact ${INSTRUCTIONS}`])
    expect(seen.prompts).toEqual([])

    // The engine runs that /compact.
    await $.session.compact({
      trigger: 'manual',
      instructions: INSTRUCTIONS,
      messages: [{ role: 'user', text: 'hi', toolUses: [] }],
    } as never)
    await clock.advance(1_000)
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('[CTM] Your conversation was compacted as you scheduled.')
    expect(seen.prompts[0]).toContain(RESUME)
  })

  test('without confirmation it reports the failure', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear', resumePrompt: RESUME } as never)
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.commands).toEqual(['clear'])
    await clock.advance(2 * 60_000)
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('[CTM] The clear you scheduled failed (no confirmation that /clear ran within 2 min)')
    expect(seen.prompts[0]).toContain(RESUME)
  })
})

describe('figures', () => {
  test('attaches to tool results at most every 3 minutes', async ($, on) => {
    world(on)
    const clock = mock.clock(on, { now: 10 * 60_000 })
    on('tool.call', { tool: 'Read' }, () => ({ result: 'content' }) as never)

    const first = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(first.context?.join('\n')).toContain('Context window: 84k of 200k tokens used (42%)')

    const second = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(second.context).toBeUndefined()

    await clock.advance(3 * 60_000)
    const third = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(third.context?.join('\n')).toContain('[CTM')
  })

  test('status returns the figures', async ($, on) => {
    world(on)
    mock.clock(on, { now: 0 })
    const r = await status($)
    expect(r).toContain('7-day limit: 41.2% used · resets')
    expect(r).not.toContain('cost')
  })

  test('attaches the figures to the person’s prompts', async ($, on) => {
    world(on)
    mock.clock(on, { now: 0 })
    const r = await $.prompt.submit({ text: 'go on' } as never)
    expect(r.context?.join('\n')).toContain('Context window: 84k of 200k')
  })

  test('idle updates wake the model only when turned on', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 10 * 60_000 })
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)

    await clock.advance(10 * 60_000)
    expect(seen.prompts).toEqual([])

    await $.tool.call({ tool: 'mcp__ctm__idle_updates', enabled: true, maxMinutes: 30 } as never)
    await clock.advance(3 * 60_000)
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('idle update')

    await $.tool.call({ tool: 'mcp__ctm__idle_updates', enabled: false } as never)
    await clock.advance(10 * 60_000)
    expect(seen.prompts.length).toBe(1)
  })
})

describe('deltas', () => {
  test('the first report says there is no change yet', async ($, on) => {
    world(on)
    mock.clock(on, { now: 0 })
    const r = await status($)
    expect(r).toContain('· first report, no change (Δ) yet]')
    expect(r).not.toContain(', Δ')
  })

  test('names the window once and puts one delta on each figure', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    await status($)

    await clock.advance(50 * 60_000)
    seen.usage.current = {
      context: { tokens: 96_000, window: 200_000, percent: 48 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 28.5, resetsAt: '2026-10-08T17:00:00.000Z' },
        { kind: 'seven_day', percentUsed: 42.2, resetsAt: '2026-10-12T09:00:00.000Z' },
      ],
    }
    const r = await status($)
    expect(r).toMatch(/· status request · Δ = change since previous report at \d\d:00, 50 min ago\]/)
    expect(r).toContain('\nContext window: 96k of 200k tokens used (48%), Δ +12k\n')
    expect(r).toMatch(/\n5-hour limit: 28\.5% used, Δ \+5 pts · resets at \d\d:00 \(in 10 h 10 min\)\n/)
    expect(r).toMatch(/\n7-day limit: 42\.2% used, Δ \+1 pt · resets Mon 10-12 at \d\d:00 \(in 4 d 2 h\)/)
  })

  test('measures only from report to report', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    await status($)
    await clock.advance(10 * 60_000)
    seen.usage.current = {
      ...USAGE,
      rateLimits: [{ kind: 'five_hour', percentUsed: 25.5, resetsAt: '2026-10-08T17:00:00.000Z' }],
    }
    await status($)
    await clock.advance(10 * 60_000)
    seen.usage.current = {
      ...USAGE,
      rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-08T17:00:00.000Z' }],
    }
    const r = await status($)
    expect(r).toMatch(/previous report at \d\d:10, 10 min ago\]/)
    expect(r).toContain('5-hour limit: 30% used, Δ +4.5 pts')
  })

  test('the span matches the shown clock times, not the raw seconds', async ($, on) => {
    world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T06:42:59.000Z') })
    await status($)
    await clock.advance(3 * 60_000 + 31_000) // 06:46:30: 3.5 min of real time
    const r = await status($)
    expect(r).toMatch(/\d\d:46 .*previous report at \d\d:42, 4 min ago\]/)
    await clock.advance(29_000) // 06:46:59, same shown minute
    expect(await status($)).toMatch(/previous report at \d\d:46, <1 min ago\]/)
  })

  test('the time until a reset matches the shown clock times', async ($, on) => {
    const seen = world(on)
    seen.usage.current = {
      ...USAGE,
      rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-08T11:00:00.000Z' }],
    }
    mock.clock(on, { now: Date.parse('2026-10-08T06:47:50.000Z') })
    expect(await status($)).toContain('(in 4 h 13 min)')
  })

  test('names a window reset instead of subtracting across it', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T16:30:00.000Z') })
    await status($)
    await clock.advance(60 * 60_000)
    seen.usage.current = {
      ...USAGE,
      rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: '2026-10-08T22:00:00.000Z' }],
    }
    expect(await status($)).toMatch(
      /5-hour limit: 3% used, Δ window reset at \d\d:00 \(was 23\.5%\) · resets at \d\d:00 \(in 4 h 30 min\)/,
    )
  })

  test('tracks each recipient separately', async ($, on) => {
    world(on)
    mock.clock(on, { now: 0 })
    await status($)
    expect(await status($)).toContain('· Δ = change since previous report')
    expect(await status($, 'sub-1')).toContain('first report, no change (Δ) yet')
  })

  test('no token totals and no cost in the block', async ($, on) => {
    world(on)
    mock.clock(on, { now: 0 })
    const r = await status($)
    expect(r.split('\n').filter(l => !l.startsWith('⚑')).length).toBe(4)
    expect(r).not.toMatch(/cache|cost|turns/i)
  })
})

describe('time', () => {
  test('the time zone is named once, in the header', { options: { timeZone: 'Europe/Berlin' } }, async ($, on) => {
    world(on)
    mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    const r = await status($)
    expect(r).toContain('[CTM · Thu 2026-10-08 08:00 Europe/Berlin (UTC+02:00) · status request ·')
    expect(r).toContain('5-hour limit: 23.5% used · resets at 19:00 (in 11 h 0 min)')
    expect(r).toContain('7-day limit: 41.2% used · resets Mon 10-12 at 11:00 (in 4 d 3 h)')
    expect(r.match(/Europe\/Berlin/g)?.length).toBe(1)
  })

  test('a time with another offset (DST) names its offset', { options: { timeZone: 'Europe/Berlin' } }, async ($, on) => {
    const seen = world(on)
    seen.usage.current = {
      ...USAGE,
      rateLimits: [{ kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-26T09:00:00.000Z' }],
    }
    mock.clock(on, { now: Date.parse('2026-10-22T06:00:00.000Z') })
    expect(await status($)).toContain('7-day limit: 41.2% used · resets Mon 10-26 at 10:00 (UTC+01:00) (in 4 d 3 h)')
  })

  test('without a setting, the system zone or UTC – always named', async ($, on) => {
    world(on)
    mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    expect(await status($)).toMatch(/^\[CTM · (Wed|Thu) 2026-10-0[78] \d\d:\d\d [A-Za-z_/+-]+ \(UTC[+-]\d\d:\d\d\)/)
  })

  test('takes the zone from TZ when nothing is configured', async ($, on) => {
    world(on)
    on('env.get', (_$, e) => ({ value: e.name === 'TZ' ? ':America/New_York' : undefined }) as never)
    mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    const r = await status($)
    expect(r).toContain('[CTM · Thu 2026-10-08 02:00 America/New_York (UTC-04:00)')
    expect(r).toContain('5-hour limit: 23.5% used · resets at 13:00 (in 11 h 0 min)')
  })

  test('takes the zone from /etc/localtime when TZ is unset', async ($, on) => {
    world(on)
    on('env.get', () => ({ value: undefined }) as never)
    on(
      'fs.stat',
      () =>
        ({
          value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: '/usr/share/zoneinfo/Asia/Tokyo' },
        }) as never,
    )
    mock.clock(on, { now: Date.parse('2026-10-08T06:00:00.000Z') })
    expect(await status($)).toContain('[CTM · Thu 2026-10-08 15:00 Asia/Tokyo (UTC+09:00)')
  })
})

test('the CTM briefing is in the system prompt', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)
  const r = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  } as never)
  const ctm = r.sections.find(s => s.id === 'ctm:info')
  expect(ctm?.scope).toBe('session')
  expect(ctm?.text).toContain('mcp__ctm__reset')
  expect(ctm?.text).toContain('account-wide')
  expect(ctm?.text).not.toMatch(/first report|cache read|session cost/i)
})

describe('settings', () => {
  test('the model changes the interval; work updates follow it', async ($, on) => {
    world(on)
    mock.store(on)
    const clock = mock.clock(on, { now: 10 * 60_000 })
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
    const set = await $.tool.call({ tool: 'mcp__ctm__settings', intervalMinutes: 10 } as never)
    expect(String(set.result)).toContain('intervalMinutes: 10')
    expect(String(set.result)).toContain('[CTM') // the answer carries a block itself
    await clock.advance(5 * 60_000)
    const second = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(second.context ?? []).toHaveLength(0)
    await clock.advance(5 * 60_000)
    const third = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(third.context?.join('')).toContain('[CTM')
    await clock.advance(5 * 60_000)
    const fourth = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(fourth.context ?? []).toHaveLength(0)
  })

  test('settings are kept in the store and shown without arguments', async ($, on) => {
    world(on)
    mock.store(on, { settings: { compactThreshold: '300k', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: 0 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings' } as never)).result)
    expect(r).toContain('compactThreshold: 300k')
    expect(r).toContain('fiveHourPauseAt: 80%')
    expect(r).toContain('sevenDayPauseAt: off')
  })

  test('rejects nonsense', async ($, on) => {
    world(on)
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = await $.tool.call({ tool: 'mcp__ctm__settings', compactThreshold: 'lots' } as never)
    expect(r.deny).toMatch(/compactThreshold/)
  })

  test('/ctm lets the person change them', async ($, on) => {
    world(on)
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = await $.command.run({ command: 'ctm', args: 'compact 30%' } as never)
    expect(r.text).toContain('compactThreshold: 30%')
    const shown = await $.command.run({ command: 'ctm', args: '' } as never)
    expect(shown.text).toContain('compactThreshold: 30%')
  })
})

describe('compact threshold', () => {
  test('unset: the block now and then nudges to ask the user', async ($, on) => {
    world(on)
    mock.store(on)
    const clock = mock.clock(on, { now: 0 })
    expect(await status($)).toMatch(/No compact threshold set.*ask the user/)
    await clock.advance(10 * 60_000)
    expect(await status($)).not.toMatch(/No compact threshold/)
    await clock.advance(25 * 60_000)
    expect(await status($)).toMatch(/No compact threshold set/)
  })

  test('"off" stops the nudging', async ($, on) => {
    world(on)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: 0 })
    expect(await status($)).not.toMatch(/compact threshold/i)
  })

  test('past the threshold the block reminds to compact if the task allows', async ($, on) => {
    world(on) // 84k of 200k
    mock.store(on, { settings: { compactThreshold: '80k' } })
    mock.clock(on, { now: 0 })
    expect(await status($)).toMatch(/Compact threshold passed \(84k ≥ 80k\): if your task allows it/)
  })

  test('a percent threshold is measured against the window', async ($, on) => {
    world(on) // 84k of 200k = 42%
    mock.store(on, { settings: { compactThreshold: '50%' } })
    mock.clock(on, { now: 0 })
    expect(await status($)).not.toMatch(/compact threshold/i)
  })

  test('subagents get no compact reminders', async ($, on) => {
    world(on)
    mock.store(on, { settings: { compactThreshold: '80k' } })
    mock.clock(on, { now: 0 })
    expect(await status($, 'agent-1')).not.toMatch(/compact threshold/i)
  })
})

describe('limit pause and wake-up', () => {
  const HIGH: Usage = {
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-08T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
  }

  test('no pause hint without a threshold', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    expect(await status($)).not.toMatch(/pause/)
  })

  test('past the threshold the block asks to pause', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    expect(await status($)).toMatch(/5-hour limit at 85% ≥ your pause threshold 80%: please pause.*mcp__ctm__limit_wakeup/)
  })

  test('wakes the model once the window has reset', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
    const r = await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Continue with step 4.' } as never)
    expect(String(r.result)).toContain('wake-up armed')
    expect(await status($)).toMatch(/wake-up armed for below 80%/)
    await clock.advance(60 * 60_000)
    expect(seen.prompts).toHaveLength(0)
    await clock.advance(61 * 60_000) // past 11:00
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/Limit wake-up: the 5-hour limit is below 80% again \(its window reset at 11:00\)/)
    expect(seen.prompts[0]).toContain('Continue with step 4.')
    await clock.advance(30 * 60_000)
    expect(seen.prompts).toHaveLength(1)
  })

  test('wakes the model once usage drops below the mark', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', belowPercent: 50 } as never)
    seen.usage.current = { ...HIGH, rateLimits: [{ ...HIGH.rateLimits[0]!, percentUsed: 40 }] }
    await clock.advance(4 * 60_000)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toContain('it is at 40%')
  })

  test('without a pause threshold it waits for the safety mark, and says when there is nothing to wait for', async ($, on) => {
    world(on)
    mock.store(on)
    mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    const r = await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour' } as never)
    expect(String(r.result)).toMatch(/below 95% already/)
    const r2 = await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', belowPercent: 50 } as never)
    expect(String(r2.result)).toMatch(/no need to wait/)
  })
})

describe('a threshold set below the current figures', () => {
  test('the model learns at once that its new compact threshold is passed', async ($, on) => {
    world(on) // 84k of 200k
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings', compactThreshold: '50k' } as never)).result)
    expect(r).toMatch(/^Saved\. ATTENTION: a threshold you just set is already passed/)
    expect(r).toMatch(/⚑ Compact threshold passed \(84k ≥ 50k\)/)
  })

  test('also for a percent threshold', async ($, on) => {
    world(on) // 42% of the window
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings', compactThreshold: '30%' } as never)).result)
    expect(r).toMatch(/ATTENTION/)
    expect(r).toMatch(/⚑ Compact threshold passed \(84k ≥ 30%\)/)
  })

  test('and for a pause threshold', async ($, on) => {
    world(on) // 5-hour limit at 23.5%
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings', fiveHourPauseAt: 20 } as never)).result)
    expect(r).toMatch(/ATTENTION/)
    expect(r).toMatch(/⚑ 5-hour limit at 23.5% ≥ your pause threshold 20%: please pause/)
  })

  test('says so when nothing is passed', async ($, on) => {
    world(on)
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings', compactThreshold: '150k' } as never)).result)
    expect(r).toMatch(/^Saved\. No threshold is passed right now\./)
    expect(r).not.toMatch(/⚑ Compact threshold passed/)
  })

  test('when the person sets it with /ctm, the model is told too', async ($, on) => {
    world(on)
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = await $.command.run({ command: 'ctm', args: 'compact 50k' } as never)
    expect(r.context?.join('\n')).toMatch(/changed the CTM settings with \/ctm[\s\S]*ATTENTION[\s\S]*⚑ Compact threshold passed/)
  })
})

describe('built-in safety threshold', () => {
  const near = (five: number, seven: number): Usage => ({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-08T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: seven, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
  })
  const NOW = Date.parse('2026-10-08T09:00:00.000Z')

  test('below 95% / 97% nothing', async ($, on) => {
    world(on, near(94.9, 96.9))
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: NOW })
    expect(await status($)).not.toMatch(/⚑/)
  })

  test('from 95% of the 5-hour and 97% of the 7-day limit it asks to pause, marked as not configurable', async ($, on) => {
    world(on, near(95, 97))
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: NOW })
    const r = await status($)
    expect(r).toMatch(/⚑ 5-hour limit at 95% ≥ the built-in safety threshold 95% \(always active, not configurable/)
    expect(r).toMatch(/⚑ 7-day limit at 97% ≥ the built-in safety threshold 97% \(always active, not configurable/)
  })

  test('an own threshold that is passed takes its place; one line per limit', async ($, on) => {
    world(on, near(96, 10))
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NOW })
    const r = await status($)
    expect(r).toMatch(/your pause threshold 80%/)
    expect(r).not.toMatch(/safety/)
  })

  test('still applies when the own threshold is higher', async ($, on) => {
    world(on, near(96, 10))
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 99 } } })
    mock.clock(on, { now: NOW })
    expect(await status($)).toMatch(/built-in safety threshold 95%/)
  })
})

describe('models', () => {
  test('shows the current model and the available ones', async ($, on) => {
    world(on)
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('Current model (main agent): claude-opus-5-5')
    expect(r).toContain('Available: default, sonnet, opus, haiku, sonnet[1m], opus[1m] – or a full model ID')
    expect(r).not.toContain('locked')
  })

  test('says when a policy locks the Model setting', async ($, on) => {
    world(on, USAGE, { lockedModel: true })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('locked by a policy')
  })

  test('both tools are registered', async ($, on) => {
    const seen = world(on)
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
    expect(seen.tools.map(t => t.name)).toEqual(expect.arrayContaining(['models', 'switch_model']))
  })
})

describe('switch_model', () => {
  const sw = (extra: Record<string, unknown>) => ({ tool: 'mcp__ctm__switch_model', resumePrompt: RESUME, ...extra }) as never

  test('refuses without a resume prompt, from subagents, and an unknown alias', async ($, on) => {
    world(on)
    expect((await $.tool.call({ tool: 'mcp__ctm__switch_model', model: 'haiku' } as never)).deny).toMatch(/resumePrompt/)
    expect((await $.tool.call(sw({ model: 'haiku', agentId: 'sub-1' }))).deny).toMatch(/main agent/)
    expect((await $.tool.call(sw({ model: 'two words' }))).deny).toMatch(/alias or a full model ID/)
    expect((await $.tool.call(sw({ model: 'haiku', reset: 'compact' }))).deny).toMatch(/instructions/)
  })

  test('checks first whether the model exists; schedules nothing if not', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    const r = await $.tool.call(sw({ model: 'claude-nonexistent-1' }))
    expect(r.deny).toContain('model "claude-nonexistent-1" is not available – nothing was scheduled.')
    expect(r.deny).toContain('Check: a one-token test request to "claude-nonexistent-1"; the API answered 404 model_not_found.')
    expect(r.deny).toContain('Available: default, sonnet, opus, haiku')
    expect(seen.checks).toEqual(['claude-nonexistent-1'])

    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect(seen.commands).toEqual([])
    expect(seen.prompts).toEqual([])
  })

  test('a model a policy blocks is refused at the check, with the engine’s reason', async ($, on) => {
    world(on, USAGE, { blockedModel: 'claude-haiku-5-5' })
    mock.clock(on, { now: 1_000_000 })
    const r = await $.tool.call(sw({ model: 'claude-haiku-5-5' }))
    expect(r.deny).toContain('nothing was scheduled')
    expect(r.deny).toMatch(/the engine refused it: .*model "claude-haiku-5-5" is not in the allowed models of your organization/)
  })

  test('a listed alias needs no test request; a full id gets one', async ($, on) => {
    const seen = world(on)
    mock.clock(on, { now: 1_000_000 })
    expect(String((await $.tool.call(sw({ model: 'haiku' }))).result)).toContain('checked (listed in the /config Model row)')
    expect(String((await $.tool.call(sw({ model: 'claude-haiku-5-5' }))).result)).toContain('checked (a one-token test request')
    expect(seen.checks).toEqual(['claude-haiku-5-5'])
  })

  test('switches after the turn through /model and sends the resume prompt with the new model', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    const r = await $.tool.call(sw({ model: 'haiku' }))
    expect(r.deny).toBeUndefined()
    expect(String(r.result)).toContain('model switch to haiku scheduled for the end of this turn (now on claude-opus-5-5)')
    expect(seen.commands).toEqual([])

    await $.turn.complete(turn)
    await clock.advance(2_000)

    expect(seen.commands).toEqual(['model haiku'])
    expect(seen.model.current).toBe('claude-haiku-5-5')
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('[CTM] Your model was switched as you scheduled: now claude-haiku-5-5 (was claude-opus-5-5).')
    expect(seen.prompts[0]).toContain('Current model: claude-haiku-5-5')
    expect(seen.prompts[0]).toContain(RESUME)
    expect(seen.prompts[0]).toContain('after model switch to haiku')

    // shares the cooldown with resets
    expect((await $.tool.call(sw({ model: 'opus' }))).deny).toMatch(/too recent/)
    expect((await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'clear', resumePrompt: RESUME } as never)).deny).toMatch(/too recent/)
  })

  test('accepts a full model id', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    expect((await $.tool.call(sw({ model: 'claude-haiku-5-5' }))).deny).toBeUndefined()
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect(seen.model.current).toBe('claude-haiku-5-5')
  })

  test('compacts first, then switches, then resumes once', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call(sw({ model: 'sonnet', reset: 'compact', instructions: INSTRUCTIONS }))
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.compacts).toEqual([INSTRUCTIONS])
    expect(seen.commands).toEqual([])
    await clock.advance(1_000)

    expect(seen.commands).toEqual(['model sonnet'])
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('[CTM] Your conversation was compacted as you scheduled.')
    expect(seen.prompts[0]).toContain('now claude-sonnet-5-5 (was claude-opus-5-5)')
    expect(seen.prompts[0]).toContain('after compact + model switch to sonnet')
  })

  test('clears first, then switches once the clear is confirmed', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call(sw({ model: 'haiku', reset: 'clear' }))
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.commands).toEqual(['clear'])

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await clock.advance(1_000)
    expect(seen.commands).toEqual(['clear', 'model haiku'])
    expect(seen.prompts[0]).toContain('[CTM] Your conversation was cleared completely as you scheduled.')
    expect(seen.prompts[0]).toContain('now claude-haiku-5-5')
    expect(seen.prompts[0]).toContain(RESUME)
  })

  test('a refused switch (policy, allowlist) keeps the model and still sends the resume prompt', async ($, on) => {
    const seen = world(on, USAGE, { refuseModel: "Model 'opus' is not allowed by your organization's policy" })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    await $.tool.call(sw({ model: 'opus' }))
    await $.turn.complete(turn)
    await clock.advance(2_000)

    expect(seen.model.current).toBe('claude-opus-5-5')
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain(
      `[CTM] The switch to model "opus" you scheduled failed. Command: /model opus – the engine answered: "Model 'opus' is not allowed by your organization's policy". You are still on claude-opus-5-5.`,
    )
    expect(seen.prompts[0]).toContain(RESUME)
  })

  test('a failed reset skips the switch', async ($, on) => {
    const seen = world(on, USAGE, { headless: true })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call(sw({ model: 'haiku', reset: 'compact', instructions: INSTRUCTIONS }))
    await $.turn.complete(turn)
    await clock.advance(11 * 60_000)
    expect(seen.commands).toEqual([`compact ${INSTRUCTIONS}`])
    expect(seen.model.current).toBe('claude-opus-5-5')
    expect(seen.prompts[0]).toContain('The model switch to "haiku" was skipped as well.')
  })

  test('an interrupted turn drops the scheduled switch', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call(sw({ model: 'haiku' }))
    await $.turn.complete({ ...(turn as object), isAborted: true } as never)
    await clock.advance(2_000)
    expect(seen.commands).toEqual([])
    expect(seen.prompts).toEqual([])
  })
})

describe('model catalog', () => {
  test('lists each model with what it is good for, its target and effort levels', async ($, on) => {
    const seen = world(on, USAGE, { catalog: true, effort: 'medium' })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('- Current effort: medium')
    expect(r).toContain('  - opus → claude-opus-5-5: Opus 5.5 · Best for everyday, complex tasks (effort low–max, fast mode)')
    expect(r).toContain('  - haiku → claude-haiku-5-5: Haiku 5.5 · Fastest for quick answers (effort low–high)')
    expect(r).toContain('  - default → claude-sonnet-5-5: Sonnet 5.5 · Efficient for routine tasks')
    expect(r).toContain('  Also accepted: sonnet, sonnet[1m], opus[1m], or a full model ID')
    expect(seen.spawns[0]).toContain('--input-format')

    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    expect(seen.spawns.length).toBe(1) // fetched once
  })

  test('without the catalog it falls back to the bare list', async ($, on) => {
    world(on)
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('- Available: default, sonnet, opus, haiku')
    expect(r).not.toContain('good for')
  })

  test('an alias only the catalog lists needs no test request', async ($, on) => {
    const seen = world(on, USAGE, { catalog: true })
    mock.clock(on, { now: 1_000_000 })
    expect((await $.tool.call({ tool: 'mcp__ctm__switch_model', model: 'haiku', resumePrompt: RESUME } as never)).deny).toBeUndefined()
    expect(seen.checks).toEqual([])
  })
})

describe('set_effort', () => {
  const ef = (extra: Record<string, unknown>) => ({ tool: 'mcp__ctm__set_effort', ...extra }) as never

  test('refuses a level that is none, subagents, and a level the model does not support', async ($, on) => {
    world(on, USAGE, { catalog: true })
    mock.clock(on, { now: 1_000_000 })
    expect((await $.tool.call(ef({ level: 'ultra' }))).deny).toMatch(/"level" must be one of low, medium, high, xhigh, max, auto/)
    expect((await $.tool.call(ef({ level: 'high', agentId: 'sub-1' }))).deny).toMatch(/main agent/)
  })

  test('sets the effort after the turn through /effort and tells the model to carry on', async ($, on) => {
    const seen = world(on, USAGE, { effort: 'medium' })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    const r = await $.tool.call(ef({ level: 'xhigh' }))
    expect(String(r.result)).toContain('effort xhigh scheduled for the end of this turn (now medium)')
    await $.turn.complete(turn)
    await clock.advance(2_000)

    expect(seen.commands).toEqual(['effort xhigh'])
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('[CTM] Your effort was set as you scheduled: now xhigh (was medium).')
    expect(seen.prompts[0]).toContain('Current model: claude-opus-5-5, effort xhigh')
    expect(seen.prompts[0]).toContain('Carry on with your task where you left off')

    // its own cooldown – a model switch is still possible
    expect((await $.tool.call(ef({ level: 'max' }))).deny).toMatch(/last effort change was too recent/)
    expect((await $.tool.call({ tool: 'mcp__ctm__switch_model', model: 'haiku', resumePrompt: RESUME } as never)).deny).toBeUndefined()
  })

  test('a refused effort keeps the level and names the command and the answer', async ($, on) => {
    const seen = world(on, USAGE, { refuseEffort: 'Invalid argument: max. Not allowed here', effort: 'medium' })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call(ef({ level: 'max', resumePrompt: 'Next step: rerun the failing test.' }))
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect(seen.prompts[0]).toContain(
      '[CTM] The effort change to "max" you scheduled failed. Command: /effort max – the engine answered: "Invalid argument: max. Not allowed here". Your effort is unchanged (medium).',
    )
    expect(seen.prompts[0]).toContain('Next step: rerun the failing test.')
  })

  test('switch_model can set the effort for the new model in the same go, model first', async ($, on) => {
    const seen = world(on, USAGE, { catalog: true, effort: 'medium' })
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)

    const bad = await $.tool.call({ tool: 'mcp__ctm__switch_model', model: 'haiku', effort: 'max', resumePrompt: RESUME } as never)
    expect(bad.deny).toContain('haiku does not support effort "max" (it supports low, medium, high)')

    await $.tool.call({ tool: 'mcp__ctm__switch_model', model: 'haiku', effort: 'low', resumePrompt: RESUME } as never)
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect(seen.commands).toEqual(['model haiku', 'effort low'])
    expect(seen.prompts[0]).toContain('now claude-haiku-5-5 (was claude-opus-5-5)')
    expect(seen.prompts[0]).toContain('now low (was medium)')
    expect(seen.prompts[0]).toContain('after model switch to haiku + effort low')
  })
})
