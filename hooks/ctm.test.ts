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

// The account's usage meter as a second `claude` answers the SDK's get_usage request;
// `rateLimits` null: a login without rate limits; 'unreached': the fetch failed (429,
// network) with nothing cached – rate_limits null on a login that has them.
function usageStdout(rateLimits: unknown): string {
  const unreached = rateLimits === 'unreached'
  const response = {
    session: { total_cost_usd: 0 },
    rate_limits_available: unreached || rateLimits !== null,
    rate_limits: unreached ? null : rateLimits,
  }
  return [
    JSON.stringify({ type: 'system', subtype: 'ui_status', text: 'x' }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'ctm', response } }),
    '',
  ].join('\n')
}

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
    // What the usage meter answers (its rate_limits); undefined: the call fails.
    server: { current: undefined as unknown },
    usageFetches: [] as { argv: string[]; init: { stdin?: string; env?: Record<string, string> } }[],
    // While on, the engine takes no prompt (its queue is closed).
    refusePrompts: { on: false },
    // While set, the engine drops each prompt with this reason (it resolves { drop }).
    dropPrompts: { reason: null as string | null },
  }
  on('process.run', (_$, e) => {
    const { argv, init } = e as unknown as { argv: string[]; init?: { stdin?: string } }
    if (init?.stdin?.includes('"get_usage"')) {
      seen.usageFetches.push({ argv, init })
      const answer = seen.server.current
      return {
        value: answer === undefined ? { exitCode: 1, stdout: '', stderr: 'failed' } : { exitCode: 0, stdout: usageStdout(answer), stderr: '' },
      } as never
    }
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
    if (seen.refusePrompts.on) throw new Error('the prompt queue is closed')
    if (seen.dropPrompts.reason) return { drop: seen.dropPrompts.reason } as never
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

  test('where session.compact does not reach CTM, the shrunk conversation confirms the /compact', async ($, on) => {
    const seen = world(on, USAGE, { headless: true })
    const held = { count: 12 }
    on('session.messages', () => ({ value: Array.from({ length: held.count }, () => ({ role: 'user', text: 'x', toolUses: [] })) }) as never)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call({ tool: 'mcp__ctm__reset', mode: 'compact', instructions: INSTRUCTIONS, resumePrompt: RESUME } as never)
    await $.turn.complete(turn)
    await clock.advance(1_000)
    expect(seen.commands).toEqual([`compact ${INSTRUCTIONS}`])
    await clock.advance(10_000)
    expect(seen.prompts).toEqual([]) // not compacted yet
    held.count = 2 // the engine ran it; its session.compact event passed CTM by
    await clock.advance(6_000)
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

describe('where an organization keeps plugins out of the system prompt', () => {
  const answer = async function* (_$: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null } as never
  }
  const step = async ($: Engine) => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  }
  const read = async ($: Engine) => (await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('\n')

  test('the briefing comes with the next block after a model request, once', async ($, on) => {
    world(on)
    on('turn.step', answer as never)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'content' }) as never)
    mock.clock(on, { now: 10 * 60_000 })
    expect(await status($)).not.toContain('CTM briefing') // no model request yet: prompt.compose may still come
    await step($) // it went out, and prompt.compose did not reach CTM
    const first = (await read($)) ?? ''
    expect(first).toMatch(/^CTM briefing – it is not in your system prompt here/)
    expect(first).toContain('mcp__ctm__limit_wakeup')
    expect(first).toMatch(/\n\[CTM · .* · work update · /)
    expect(await read($)).toBeUndefined() // once, then the interval as before
    expect(await status($)).not.toContain('CTM briefing')
  })

  test('and again once the context started over', async ($, on) => {
    const seen = world(on)
    on('turn.step', answer as never)
    mock.clock(on, { now: 10 * 60_000 })
    await step($)
    expect(await status($)).toContain('CTM briefing')
    seen.usage.current = { ...USAGE, context: { tokens: 30_000, window: 200_000, percent: 15 } } // compacted: 84k -> 30k
    expect(await status($)).toContain('CTM briefing')
    expect(await status($)).not.toContain('CTM briefing')
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await status($)).toContain('CTM briefing')
  })

  test('the settings say where the briefing is', async ($, on) => {
    world(on)
    on('turn.step', answer as never)
    mock.clock(on, { now: 10 * 60_000 })
    const settings = async () => String((await $.tool.call({ tool: 'mcp__ctm__settings' } as never)).result)
    expect(await settings()).toContain('- briefing: not known yet')
    await step($)
    expect(await settings()).toContain('- briefing: in the blocks – prompt.compose does not reach CTM here')
  })

  test('a fresh copy of the module trusts what an earlier one saw: prompt.compose did reach CTM', async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 'sess-1' }) as never)
    on('state.get', (_$, e, next) => {
      if ((e as unknown as { key: string }).key !== 'briefing') return next(e)
      return { value: { value: { session: 'sess-1', composed: true }, version: 1 } } as never
    })
    on('turn.step', answer as never)
    mock.clock(on, { now: 10 * 60_000 })
    await step($) // no prompt.compose reaches this copy (the engine need not render anew)
    expect(await status($)).not.toContain('CTM briefing')
  })

  test('where prompt.compose reaches CTM, no block carries it', async ($, on) => {
    world(on)
    on('prompt.compose', () => ({ sections: [] }) as never)
    on('turn.step', answer as never)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'content' }) as never)
    mock.clock(on, { now: 10 * 60_000 })
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    await step($)
    expect((await read($)) ?? '').not.toContain('CTM briefing')
    expect(await status($)).not.toContain('CTM briefing')
  })
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
  test('without any setting it is 350k', async ($, on) => {
    world(on, { ...USAGE, context: { tokens: 360_000, window: 1_000_000, percent: 36 } })
    mock.store(on)
    mock.clock(on, { now: 0 })
    const r = await status($)
    expect(r).toMatch(/Compact threshold passed \(360k ≥ 350k\)/)
    expect(r).not.toMatch(/No compact threshold set/)
    expect(String((await $.tool.call({ tool: 'mcp__ctm__settings' } as never)).result)).toContain('compactThreshold: 350k (default)')
  })

  test('unset: the block now and then nudges to ask the user', { options: { compactThreshold: '' } }, async ($, on) => {
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

  test('wakes the model when the limit vanishes from the readings after its window reset', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 50 } } })
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T09:00:00.000Z') })
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Go on.' } as never)
    seen.usage.current = { ...HIGH, rateLimits: [HIGH.rateLimits[1]!] } // the host drops the 5-hour limit
    await clock.advance(60 * 60_000)
    expect(seen.prompts).toHaveLength(0)
    expect(await status($)).toMatch(/Wake-up armed: 5-hour limit below 50% \(no current reading; its window resets at 11:00\)/)
    await clock.advance(61 * 60_000) // past 11:00
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/Limit wake-up: the 5-hour limit is below 50% again \(its window reset at 11:00\)/)
    expect(seen.prompts[0]).toContain('Go on.')
  })

  test('checks right at the window reset, not only on the interval', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', intervalMinutes: 60, pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T09:20:00.000Z') })
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour' } as never)
    await clock.advance(99 * 60_000) // 10:59
    expect(seen.prompts).toHaveLength(0)
    await clock.advance(60_000) // 11:00, 40 min after the last interval check
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/its window reset at 11:00/)
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
    mock.clock(on, { now: 1_000_000 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('Current model (main agent): claude-opus-5-5')
    expect(r).toContain('Available: default, sonnet, opus, haiku, sonnet[1m], opus[1m] – or a full model ID')
    expect(r).not.toContain('locked')
  })

  test('says when a policy locks the Model setting', async ($, on) => {
    world(on, USAGE, { lockedModel: true })
    mock.clock(on, { now: 1_000_000 })
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
    mock.clock(on, { now: 1_000_000 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('- Current effort: medium')
    expect(r).toContain('  - opus → claude-opus-5-5: Opus 5.5 · Best for everyday, complex tasks (effort low–max, fast mode)')
    expect(r).toContain('  - haiku → claude-haiku-5-5: Haiku 5.5 · Fastest for quick answers (effort low–high)')
    expect(r).toContain('  - default → claude-sonnet-5-5: Sonnet 5.5 · Efficient for routine tasks')
    expect(r).toContain('  Also accepted: sonnet, sonnet[1m], opus[1m], or a full model ID')
    expect(seen.spawns[0]).toContain('--input-format')

    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    expect(seen.spawns.length).toBe(1) // cached
  })

  test('is kept for 15 minutes, then fetched again', async ($, on) => {
    const seen = world(on, USAGE, { catalog: true })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    await clock.advance(14 * 60_000)
    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    expect(seen.spawns.length).toBe(1)
    await clock.advance(60_000)
    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    expect(seen.spawns.length).toBe(2)
  })

  test('without the catalog it falls back to the bare list, and does not retry on every call', async ($, on) => {
    const seen = world(on)
    mock.clock(on, { now: 1_000_000 })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__models' } as never)).result)
    expect(r).toContain('- Available: default, sonnet, opus, haiku')
    expect(r).not.toContain('good for')
    await $.tool.call({ tool: 'mcp__ctm__models' } as never)
    expect(seen.spawns.length).toBe(1)
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

describe('cooldowns', () => {
  test('the effort gap is its own option, independent of the reset gap', { options: { effortCooldownMinutes: 2, resetCooldownMinutes: 30 } }, async ($, on) => {
    world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call({ tool: 'mcp__ctm__set_effort', level: 'high' } as never)
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect((await $.tool.call({ tool: 'mcp__ctm__set_effort', level: 'max' } as never)).deny).toMatch(/too recent/)
    await clock.advance(2 * 60_000)
    expect((await $.tool.call({ tool: 'mcp__ctm__set_effort', level: 'max' } as never)).deny).toBeUndefined()
  })

  test('0 turns the effort gap off', { options: { effortCooldownMinutes: 0 } }, async ($, on) => {
    world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    on('turn.complete', () => ({ text: '' }) as never)
    await $.tool.call({ tool: 'mcp__ctm__set_effort', level: 'high' } as never)
    await $.turn.complete(turn)
    await clock.advance(2_000)
    expect((await $.tool.call({ tool: 'mcp__ctm__set_effort', level: 'max' } as never)).deny).toBeUndefined()
  })
})

describe('subagents and soft pauses', () => {
  const HIGH: Usage = {
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-08T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
  }
  const NINE = Date.parse('2026-10-08T09:00:00.000Z')

  test('the pause is a request: finish what must not be left half-done first', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NINE })
    expect(await status($)).toMatch(/please pause your work at the next clean point – first finish anything that must not be left half-done, then call mcp__ctm__limit_wakeup/)
  })

  test('with the account switcher installed, the pause points to another account first', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NINE })
    on('tool.list', () => ({ value: [{ name: 'mcp__account-switcher__switch' }, { name: 'mcp__account-switcher__accounts' }] }) as never)
    expect(await status($)).toMatch(/Before that: mcp__account-switcher__accounts shows whether another of the user's accounts has room – if one has and you may switch, switch to it \(mcp__account-switcher__switch\)/)
    // A subagent cannot switch: it is told to wait as before.
    expect(await status($, 'sub-1')).not.toMatch(/account-switcher/)
  })

  test('without the account switcher, no word of it', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NINE })
    on('tool.list', () => ({ value: [{ name: 'Bash' }] }) as never)
    expect(await status($)).not.toMatch(/account-switcher/)
  })

  test('a tool call is never held, even past the mark', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NINE })
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
    expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' } as never)).result).toBe('ran')
  })

  test('a subagent is told to wait inside limit_wakeup, not to end its turn', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    mock.clock(on, { now: NINE })
    const s = await status($, 'sub-1')
    expect(s).toMatch(/please pause – a request, not a hard stop.*for a subagent it waits inside the call until the limit is back below \(the window resets at 11:00\)/)
    expect(s).not.toMatch(/end your turn/)
  })

  test('[CTM limits: …] in a subagent prompt gives it its own pause thresholds', async ($, on) => {
    world(on, HIGH) // 5-hour at 85%: below the safety net, no common threshold
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: NINE })
    let prompt = ''
    on('agent.spawn', (_$, e) => {
      prompt = e.prompt
      return { model: 'claude-haiku-5-5', agentId: 'sub-7' } as never
    })
    await $.agent.spawn({ prompt: 'Review the diff. [CTM limits: 5h=80 7d=off]', description: 'review' } as never)
    expect(prompt).not.toContain('[CTM limits')
    expect(prompt).toMatch(/^Review the diff\.\n\n\(CTM: your own pause thresholds are 5-hour limit 80%, 7-day limit off/)
    expect(await status($, 'sub-7')).toMatch(/5-hour limit at 85% ≥ your own pause threshold 80%: please pause/)
    expect(await status($)).not.toMatch(/pause/)
    expect(await status($, 'sub-8')).not.toMatch(/pause/)
  })

  test('a subagent sets only its own pause thresholds', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    mock.clock(on, { now: NINE })
    const r = String((await $.tool.call({ tool: 'mcp__ctm__settings', fiveHourPauseAt: 80, agentId: 'sub-1' } as never)).result)
    expect(r).toMatch(/^Your own pause thresholds: 5-hour limit 80%\./)
    expect(r).toMatch(/your own pause threshold 80%/)
    expect(await status($)).not.toMatch(/pause/)
    const r2 = String((await $.tool.call({ tool: 'mcp__ctm__settings', intervalMinutes: 5, agentId: 'sub-1' } as never)).result)
    expect(r2).toMatch(/intervalMinutes is the main agent's to set/)
  })

  test('limit_wakeup from a subagent waits inside the call', async ($, on) => {
    world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    await clock.set(Date.parse('2026-10-08T10:58:00.000Z'))
    let done = false
    const call = $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Go on.', agentId: 'sub-1' } as never).then(
      r => ((done = true), r),
    )
    await clock.advance(60_000)
    expect(done).toBe(false)
    await clock.advance(70_000)
    const r = await call
    expect(String(r.result)).toMatch(/the 5-hour limit is below 80% again \(its window reset at 11:00\)\. Carry on/)
    expect(String(r.result)).toContain('Go on.')
  })
})

describe('server readings', () => {
  const NINE = Date.parse('2026-10-08T09:00:00.000Z')
  const HIGH: Usage = {
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-08T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
  }
  // rate_limits as the meter answers when it reached the server (limits[] is there).
  const meter = (five: number, extra: Record<string, unknown> = {}) => ({
    five_hour: { utilization: five, resets_at: '2026-10-08T11:00:00.000Z' },
    seven_day: { utilization: 41.2, resets_at: '2026-10-12T09:00:00.000Z' },
    limits: [{ kind: 'five_hour' }, { kind: 'seven_day' }],
    ...extra,
  })
  const refresh = async ($: Engine) => String((await $.tool.call({ tool: 'mcp__ctm__status', refresh: true } as never)).result)
  const start = async ($: Engine, on: On) => {
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
  }

  test('a wake-up goes by the real server value, read without a model request', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', intervalMinutes: 60, pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    seen.server.current = meter(85)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Go on.' } as never)
    await clock.advance(119 * 60_000) // 10:59
    expect(seen.prompts).toHaveLength(0)
    expect(seen.usageFetches.length).toBe(2) // arming at 09:00, the interval check at 10:00
    seen.server.current = meter(3, { five_hour: { utilization: 3, resets_at: '2026-10-08T16:00:00.000Z' } })
    await clock.advance(60_000) // 11:00: the new window, as the server counts it
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/the 5-hour limit is below 80% again \(it is at 3%\)/)
    expect(seen.prompts[0]).toMatch(/5-hour limit: 3% used[^\n]* · resets at \d\d:\d\d \(in 5 h 0 min\)\n/)
    expect(seen.prompts[0]).not.toContain('as of')
    expect(seen.prompts[0]).toContain('Go on.')

    const { argv, init } = seen.usageFetches[0]!
    expect(argv).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '']))
    expect(JSON.parse(init.stdin!).request).toEqual({ subtype: 'get_usage', skip_behaviors: true })
    expect(init.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' })
  })

  test('status refresh=true reads the server on demand, at most every 30 s', async ($, on) => {
    const seen = world(on)
    const clock = mock.clock(on, { now: NINE })
    seen.server.current = meter(30)
    const r = await refresh($)
    expect(r).toMatch(/5-hour limit: 30% used · resets at \d\d:\d\d \(in 2 h 0 min\)\n/)
    expect(await status($)).toContain('5-hour limit: 30% used, Δ ±0')
    const again = await refresh($)
    expect(again).toContain('No fresh reading from the server: the last one was asked for <1 min ago (at most every 30 s).')
    expect(seen.usageFetches.length).toBe(1)

    seen.server.current = null // a login without rate limits
    await clock.advance(31_000)
    const none = await refresh($)
    expect(none).toContain('No fresh reading from the server: this login has no rate limits to read.')
    expect(none).toContain('5-hour limit: 30% used') // the last good reading stays
  })

  test('a cached answer does not pass as fresh', async ($, on) => {
    const seen = world(on, HIGH)
    const clock = mock.clock(on, { now: NINE })
    seen.server.current = meter(10, { limits: undefined }) // no limits[]: the engine's cache
    const r = await refresh($)
    expect(r).toContain('5-hour limit: 85% used')
    expect(r).toContain('No fresh reading from the server: only a cached answer')

    await clock.advance(6 * 60_000) // past the first back-off
    seen.server.current = meter(10, { seven_day_breakdown: { as_of: '2026-10-08T08:00:00.000Z' } }) // an hour old
    expect(await refresh($)).toContain('only a cached answer')

    await clock.advance(11 * 60_000) // 09:17, past the second back-off
    seen.server.current = meter(10, { seven_day_breakdown: { as_of: '2026-10-08T09:17:00.000Z' } })
    expect(await refresh($)).toContain('5-hour limit: 10% used')
  })

  test('while idle it asks at most every 3 minutes', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', intervalMinutes: 1 } })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    seen.server.current = meter(85)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', belowPercent: 50 } as never)
    await clock.advance(10 * 60_000)
    expect(seen.prompts).toHaveLength(0)
    expect(seen.usageFetches.length).toBeGreaterThanOrEqual(3)
    expect(seen.usageFetches.length).toBeLessThanOrEqual(4)
  })

  test('after a failure it backs off, doubling', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', intervalMinutes: 1 } })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', belowPercent: 50 } as never)
    await clock.advance(20 * 60_000) // tries at 09:00 (arming), 09:05 (+5 min), 09:15 (+10 min)
    expect(seen.usageFetches.length).toBe(3)
    const r = await refresh($)
    expect(r).toContain(
      'No fresh reading from the server: the last attempt failed (the second claude exited with 1: failed); next try possible in 15 min.',
    )
    expect(r).toContain('5-hour limit: 85% used') // the session's own, as the fallback
  })

  test('the newest reading counts: each response\'s while the model works, the server\'s when none is newer', async ($, on) => {
    const seen = world(on) // the session's own reading: 23.5%
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
    })
    const clock = mock.clock(on, { now: NINE })
    let step = 0
    const respond = async () => {
      for await (const _ of $.turn.step({ turnId: 't1', index: step++, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
    }
    seen.server.current = meter(30)
    expect(await status($)).toContain('5-hour limit: 30% used') // no response yet: the server's
    await clock.advance(60_000)
    await respond() // 09:01: a model response brings the session's own, newer
    seen.server.current = meter(31)
    await clock.advance(60_000) // 09:02
    expect(await status($)).toContain('5-hour limit: 23.5% used, Δ -6.5 pts') // the response's
    expect(seen.usageFetches.length).toBe(1) // a reading a minute old is not taken again
    await clock.advance(3 * 60_000) // 09:05: the newest reading is 4 min old
    expect(await status($)).toContain('5-hour limit: 31% used, Δ +7.5 pts')
    expect(seen.usageFetches.length).toBe(2)

    seen.server.current = undefined // the server cannot be read any more
    await clock.advance(4 * 60_000) // 09:09
    expect(await status($)).toMatch(/5-hour limit: 31% used[^\n]* · as of 09:05\n/)
    await respond() // 09:09: newer than the last server reading
    const r = await status($)
    expect(r).toContain('5-hour limit: 23.5% used')
    expect(r).not.toContain('as of')
  })

  test('after /login to another account: fresh numbers for it, no deltas against the old one', async ($, on) => {
    const seen = world(on)
    const who = { current: 'acct-1' }
    on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/u' : undefined }) as never)
    on('fs.read', (_$, e) => {
      if ((e as unknown as { path: string }).path !== '/home/u/.claude.json') throw new Error('ENOENT')
      return { value: JSON.stringify({ oauthAccount: { accountUuid: who.current, emailAddress: 'x' } }) } as never
    })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    seen.server.current = meter(20)
    const r0 = (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    expect(r0).toContain('5-hour limit: 20% used')
    expect(seen.usageFetches.length).toBe(1)

    who.current = 'acct-2'
    seen.server.current = meter(5)
    await clock.advance(60_000) // not due yet for the same account – but this is another one
    const r = (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    expect(seen.usageFetches.length).toBe(2)
    expect(r).toMatch(/5-hour limit: 5% used · resets/) // no Δ against acct-1

    who.current = 'acct-3'
    seen.server.current = undefined
    await clock.advance(60_000)
    const r2 = (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    expect(r2).toContain('Rate limits: account switched – no reading for the new account yet')
    expect(r2).not.toContain('5-hour limit')
  })

  test('the response to a request sent before an account switch is still the old account\'s', async ($, on) => {
    const seen = world(on) // the session's own reading: 23.5%
    const who = { current: 'acct-1' }
    on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/u' : undefined }) as never)
    on('fs.read', () => ({ value: JSON.stringify({ oauthAccount: { accountUuid: who.current } }) }) as never)
    const held = { release: () => {} }
    on('turn.step', async function* (_$, e) {
      await new Promise<void>(r => (held.release = r))
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    const prompt = async () => (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    let step = 0
    const respond = async () => {
      for await (const _ of $.turn.step({ turnId: 't1', index: step++, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
    }
    expect(await prompt()).toContain('5-hour limit: 23.5% used') // the server cannot be read: the session's own

    const inFlight = respond() // goes out under acct-1
    await clock.advance(1_000)
    who.current = 'acct-2'
    expect(await prompt()).toContain('Rate limits: account switched – no reading for the new account yet')
    held.release()
    await inFlight
    await clock.advance(1_000)
    expect(await prompt()).toContain('Rate limits: account switched – no reading for the new account yet')

    const next = respond() // goes out under acct-2
    await clock.advance(1_000)
    held.release()
    await next
    expect(await prompt()).toContain('5-hour limit: 23.5% used')
  })

  test('while a request from before the switch is out, no response counts for the new account', async ($, on) => {
    world(on) // the session's own reading: 23.5%
    const who = { current: 'acct-1' }
    on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/u' : undefined }) as never)
    on('fs.read', () => ({ value: JSON.stringify({ oauthAccount: { accountUuid: who.current } }) }) as never)
    const holds = new Map<number, () => void>()
    on('turn.step', async function* (_$, e) {
      await new Promise<void>(r => holds.set(e.index, r))
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    const prompt = async () => (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    const send = (index: number, agentId?: string) =>
      (async () => {
        for await (const _ of $.turn.step({ turnId: 't1', index, agentId, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
      })()
    const land = async (index: number, sent: Promise<void>) => {
      holds.get(index)!()
      await sent
      await clock.advance(1_000)
    }
    const SWITCHED = 'Rate limits: account switched – no reading for the new account yet'

    const a = send(0, 'sub-1') // a subagent's request under acct-1
    await clock.advance(1_000)
    who.current = 'acct-2'
    expect(await prompt()).toContain(SWITCHED)
    await clock.advance(1_000)
    const b = send(1) // under acct-2 – while sub-1's is still out
    await clock.advance(1_000)
    await land(1, b)
    expect(await prompt()).toContain(SWITCHED) // sub-1's headers may still come and overwrite these
    await land(0, a)
    expect(await prompt()).toContain(SWITCHED)

    // The old one comes back while the new one is out.
    const c = send(2, 'sub-2')
    await clock.advance(1_000)
    who.current = 'acct-3'
    expect(await prompt()).toContain(SWITCHED)
    const d = send(3)
    await clock.advance(1_000)
    await land(2, c)
    await land(3, d)
    expect(await prompt()).toContain(SWITCHED)

    const f = send(4) // nothing from before the switch is out any more
    await clock.advance(1_000)
    await land(4, f)
    expect(await prompt()).toContain('5-hour limit: 23.5% used')
  })

  test('the second claude leaves out an API key the session does not run on', async ($, on) => {
    const seen = world(on)
    const KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb'
    const env: Record<string, string | undefined> = { HOME: '/home/u', ANTHROPIC_API_KEY: KEY }
    on('env.get', (_$, e) => ({ value: env[(e as unknown as { name: string }).name] }) as never)
    const responses = { current: { approved: [] as string[], rejected: [KEY.slice(-20)] } }
    const unreadable = { current: false }
    on('fs.read', () => {
      if (unreadable.current) throw new Error('EBUSY')
      return { value: JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' }, customApiKeyResponses: responses.current }) } as never
    })
    const clock = mock.clock(on, { now: NINE })
    on('session.start', () => ({ cwd: '/' }) as never)
    seen.server.current = meter(20)
    const fetchEnv = async (isInteractive: boolean) => {
      await $.session.start({ cwd: '/', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
      await clock.advance(31_000)
      await refresh($)
      return seen.usageFetches.at(-1)!.init.env
    }
    const kept = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' }
    const dropped = { ...kept, ANTHROPIC_API_KEY: '' }

    expect(await fetchEnv(true)).toEqual(dropped) // declined at the prompt: the session runs on the claude.ai login
    responses.current = { approved: [KEY.slice(-20)], rejected: [] }
    expect(await fetchEnv(true)).toEqual(kept) // approved: the session runs on the key, and has no rate limits
    responses.current = { approved: [], rejected: [] }
    expect(await fetchEnv(false)).toEqual(kept) // -p and the SDK take the key as it is
    env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode'
    expect(await fetchEnv(false)).toEqual(dropped) // VS Code asks first, as the terminal does
    unreadable.current = true
    expect(await fetchEnv(true)).toEqual(kept) // what was approved cannot be read: as before
    unreadable.current = false
    env.ANTHROPIC_API_KEY = undefined
    expect(await fetchEnv(true)).toEqual(kept) // no key, nothing to leave out
    expect(seen.usageFetches).toHaveLength(6)
  })
})

describe('wake-ups that must not get lost', () => {
  const NINE = Date.parse('2026-10-08T09:00:00.000Z')
  const ELEVEN = Date.parse('2026-10-08T11:00:00.000Z')
  const HIGH: Usage = {
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-08T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 41.2, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
  }
  const meter = (five: number) => ({
    five_hour: { utilization: five, resets_at: '2026-10-08T11:00:00.000Z' },
    seven_day: { utilization: 41.2, resets_at: '2026-10-12T09:00:00.000Z' },
    limits: [{ kind: 'five_hour' }, { kind: 'seven_day' }],
  })
  const start = async ($: Engine, on: On) => {
    on('session.start', () => ({ cwd: '/' }) as never)
    await $.session.start({ cwd: '/' } as never)
  }
  const refresh = async ($: Engine) => String((await $.tool.call({ tool: 'mcp__ctm__status', refresh: true } as never)).result)

  test('the checks start from any hook, session.start or not', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    // No session.start: the timer is not running; arming the wake-up starts it.
    const r = await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Go on.' } as never)
    expect(String(r.result)).toContain('wake-up armed')
    await clock.advance(121 * 60_000) // past 11:00
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/Limit wake-up: the 5-hour limit is below 80% again \(its window reset at 11:00\)/)
    expect(seen.prompts[0]).toContain('Go on.')
  })

  test('an armed wake-up is kept in $.state and comes back after a reload', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    const clock = mock.clock(on, { now: NINE })
    on('session.id', () => ({ value: 'sess-1' }) as never)
    const writes: unknown[] = []
    on('state.set', (_$, e, next) => {
      if ((e as unknown as { key: string }).key === 'wakeups') writes.push((e as unknown as { value: unknown }).value)
      return next(e)
    })
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', belowPercent: 50, note: 'n' } as never)
    expect(writes.at(-1)).toEqual({ session: 'sess-1', watches: [{ kind: 'five_hour', below: 50, note: 'n', resetsAt: ELEVEN }] })
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', cancel: true } as never)
    expect(writes.at(-1)).toEqual({ session: 'sess-1', watches: [] })
    expect(seen.prompts).toHaveLength(0)
    void clock
  })

  test('a fresh copy of the module takes the wake-ups the previous one kept', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    const clock = mock.clock(on, { now: NINE })
    on('session.id', () => ({ value: 'sess-1' }) as never)
    // What the module's previous copy kept for this session before the hooks worker was replaced.
    on('state.get', (_$, e, next) => {
      if ((e as unknown as { key: string }).key !== 'wakeups') return next(e)
      const watches = [{ kind: 'five_hour', below: 80, note: 'Go on with step 4.', resetsAt: ELEVEN }]
      return { value: { value: { session: 'sess-1', watches }, version: 1 } } as never
    })
    await start($, on) // the engine raises session.start again in the fresh copy
    expect(await status($)).toContain('Wake-up armed: 5-hour limit below 80%')
    await clock.advance(121 * 60_000)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/the 5-hour limit is below 80% again \(its window reset at 11:00\)/)
    expect(seen.prompts[0]).toContain('Go on with step 4.')
  })

  test("a subagent's turn holds no wake-up back, a background one after the main turn included", async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
    on('turn.complete', () => ({ text: '' }) as never)
    await start($, on)
    await $.turn.start({ text: 'go on', turnId: 't1' } as never)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour' } as never)
    await $.turn.complete(turn)
    await $.turn.start({ text: '', turnId: 't2', agentId: 'bg-1' } as never) // a background subagent goes on
    await clock.advance(121 * 60_000)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/its window reset at 11:00/)
  })

  test('a wake-up the engine does not take is kept and sent again', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour' } as never)
    seen.refusePrompts.on = true
    await clock.advance(121 * 60_000) // 11:01: the wake-up is due, the prompt refused
    expect(seen.prompts).toHaveLength(0)
    seen.refusePrompts.on = false
    await clock.advance(3 * 60_000) // the next check sends it
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/its window reset at 11:00/)
  })

  test('a fetch that failed with nothing cached is tried again after the usual back-off, not after an hour', async ($, on) => {
    const seen = world(on, HIGH)
    const clock = mock.clock(on, { now: NINE })
    seen.server.current = 'unreached'
    expect(await refresh($)).toContain(
      'No fresh reading from the server: the server was not reached (or answered 429), and nothing was cached.',
    )
    await clock.advance(5 * 60_000 + 1_000)
    seen.server.current = meter(40)
    expect(await refresh($)).toContain('5-hour limit: 40% used')
  })

  test('a subagent waiting inside limit_wakeup goes by the server readings the ticker takes', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    seen.server.current = meter(85)
    let done = false
    const call = $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', agentId: 'sub-1' } as never).then(
      r => ((done = true), r),
    )
    await clock.advance(2 * 60_000)
    expect(done).toBe(false)
    seen.server.current = meter(40) // other work on the account is done: the server counts less now
    await clock.advance(4 * 60_000)
    const r = await call
    expect(String(r.result)).toMatch(/the 5-hour limit is below 80% again \(it is at 40%\)\. Carry on/)
  })

  test('a newly passed pause mark comes with the next tool result, not only at the interval', async ($, on) => {
    const seen = world(on, { ...HIGH, rateLimits: [{ ...HIGH.rateLimits[0]!, percentUsed: 70 }, HIGH.rateLimits[1]!] })
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    on('tool.call', { tool: 'Read' }, () => ({ result: 'content' }) as never)
    const read = async () => (await $.tool.call({ tool: 'Read', file_path: '/a' } as never)).context?.join('\n')
    expect(await read()).toContain('5-hour limit: 70% used')
    await clock.advance(60_000)
    expect(await read()).toBeUndefined() // within the interval and nothing new
    seen.usage.current = HIGH // 85%: past the mark
    expect(await read()).toMatch(/limit update[\s\S]*5-hour limit at 85% ≥ your pause threshold 80%: please pause/)
    expect(await read()).toBeUndefined() // told once; the interval goes on as before
  })

  test('an unreadable ~/.claude.json is no account switch', async ($, on) => {
    const seen = world(on)
    const unreadable = { current: false }
    on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/u' : undefined }) as never)
    on('fs.read', (_$, e) => {
      if (unreadable.current || (e as unknown as { path: string }).path !== '/home/u/.claude.json') throw new Error('EBUSY')
      return { value: JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }) } as never
    })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    seen.server.current = meter(20)
    const prompt = async () => (await $.prompt.submit({ text: 'go on' } as never)).context?.join('\n') ?? ''
    expect(await prompt()).toContain('5-hour limit: 20% used')
    unreadable.current = true
    await clock.advance(60_000)
    const r = await prompt()
    expect(r).not.toContain('account switched')
    expect(r).toContain('5-hour limit: 20% used, Δ ±0')
    unreadable.current = false
    await clock.advance(60_000)
    expect(await prompt()).toContain('5-hour limit: 20% used, Δ ±0')
  })

  test("another session's kept wake-ups are not taken", async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off' } })
    const clock = mock.clock(on, { now: NINE })
    on('session.id', () => ({ value: 'sess-2' }) as never)
    on('state.get', (_$, e, next) => {
      if ((e as unknown as { key: string }).key !== 'wakeups') return next(e)
      const watches = [{ kind: 'five_hour', below: 80, note: 'from sess-1', resetsAt: ELEVEN }]
      return { value: { value: { session: 'sess-1', watches }, version: 1 } } as never
    })
    await start($, on)
    expect(await status($)).not.toContain('Wake-up armed')
    await clock.advance(121 * 60_000)
    expect(seen.prompts).toHaveLength(0)
  })

  test("after /resume into another session, the ended one's wake-ups do not fire there", async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    const sid = { current: 'sess-a' }
    on('session.id', () => ({ value: sid.current }) as never)
    await start($, on)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Step 4 of conversation A.' } as never)
    await $.session.end({ reason: 'resume', sessionId: 'sess-a' } as never)
    sid.current = 'sess-b'
    const r = (await $.prompt.submit({ text: 'hello B' } as never)).context?.join('\n') ?? ''
    expect(r).not.toContain('wake-up armed')
    await clock.advance(121 * 60_000)
    expect(seen.prompts.some(p => p.includes('Step 4 of conversation A.'))).toBe(false)
  })

  test('a wake-up the engine drops (a stop holds back plugin prompts) is kept and sent once it takes them', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    const clock = mock.clock(on, { now: NINE })
    await start($, on)
    await $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', note: 'Go on.' } as never)
    seen.dropPrompts.reason = 'the session was stopped and nobody has sent input since'
    await clock.advance(121 * 60_000) // 11:01: due, dropped
    expect(seen.prompts).toHaveLength(0)
    expect(await status($)).toContain('Wake-up armed: 5-hour limit below 80%') // still armed, not lost
    seen.dropPrompts.reason = null
    await clock.advance(3 * 60_000)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toContain('Go on.')
  })

  test('a model request that brought no response is no reading', async ($, on) => {
    const seen = world(on, { ...HIGH, rateLimits: [{ ...HIGH.rateLimits[0]!, percentUsed: 70 }, HIGH.rateLimits[1]!] })
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
    })
    const clock = mock.clock(on, { now: NINE })
    seen.server.current = meter(92)
    expect(await status($)).toContain('5-hour limit: 92% used')
    await clock.advance(60_000)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
    await clock.advance(60_000)
    expect(await status($)).toContain('5-hour limit: 92% used') // not the 70% of an older response
  })

  test('on Windows a waiting subagent sleeps in ping, there being no sleep', async ($, on) => {
    const seen = world(on, HIGH)
    mock.store(on, { settings: { compactThreshold: 'off', pauseAt: { five_hour: 80 } } })
    on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'OS' ? 'Windows_NT' : undefined }) as never)
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T10:58:00.000Z') })
    const call = $.tool.call({ tool: 'mcp__ctm__limit_wakeup', limit: 'five_hour', agentId: 'sub-1' } as never)
    await clock.advance(3 * 60_000) // past 11:00
    expect(String((await call).result)).toMatch(/below 80% again \(its window reset at 11:00\)/)
    expect(seen.spawns).toContainEqual(['ping', '-n', '4', '127.0.0.1'])
  })
})
