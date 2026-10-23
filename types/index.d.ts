export type LimitKind = 'five_hour' | 'seven_day'

// An armed limit wake-up. resetsAt: the window's last known reset (ms) – the host can
// drop a limit from its readings once that window has ended, and no new reading comes
// while the model pauses.
export type LimitWatch = { kind: LimitKind; below: number; note: string; resetsAt: number | null }

// Idle updates while they are on; until: when they turn themselves off (ms), or null.
export type IdleWatch = { until: number | null }

// Kept in $.state, so a reload of the mod or a hooks worker the engine replaces does not
// lose them: both start the module over, its variables and timers gone. `session` is the
// id of the session they belong to: another session in the same process never takes them.
export type KeptWakeups = { session: string; watches: LimitWatch[] }
export type KeptIdleUpdates = { session: string; idle: IdleWatch | null }
// Whether CTM's prompt.compose hook ran in this session: where an organization that manages
// Claude Code keeps plugins out of the system prompt it never does, and the blocks carry the
// briefing instead. Kept so a fresh copy of the module does not take a quiet spell for that.
export type KeptBriefing = { session: string; composed: boolean }

declare module 'claude-code' {
  interface PluginState {
    ctm: {
      wakeups: KeptWakeups
      idleUpdates: KeptIdleUpdates
      briefing: KeptBriefing
    }
  }
}
