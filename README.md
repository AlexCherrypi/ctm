# CTM – Context and Token Manager

A Claude Code mod that keeps the model informed about its context window and the account's
5-hour / 7-day rate limits, each with its change since the last report, in a short block – and
lets the model compact or clear its own conversation or switch its own model, always with a
resume prompt so it carries on afterwards.

## What the model sees

```
[CTM · Thu 2026-10-08 08:27 Europe/Berlin (UTC+02:00) · work update · Δ = change since previous report at 08:24, 3 min ago]
Context window: 327k of 1.00M tokens used (33%), Δ +12k · auto-compact at 967k (640k left)
5-hour limit: 10% used, Δ +1 pt · resets at 13:00 (in 4 h 33 min)
7-day limit: 59% used, Δ ±0 · resets Wed 10-14 at 02:00 (in 5 d 17 h)
```

- **Header**: when the figures were taken (weekday, date, time), the time zone – named once –
  what triggered the block, and when the previous block for the same agent was. Every other
  time is local in the header's zone: `HH:MM` on the same day, with weekday and date
  otherwise, and with its own UTC offset only if that differs (DST).
- **Context window**: tokens used of the window, with the auto-compact threshold and the room
  left.
- **5-hour / 7-day limit**: the account's rate limits in percent and their reset. Claude Code
  does not expose the size of a window or the plan, and CTM does not estimate it. The limits
  are account-wide, so their Δ includes every parallel session.
- **Δ**: one per figure – context in tokens, each limit in points – always for that one window
  only, never a running total. `Δ window reset …` means the limit window reset inside it.
  Nothing is kept across sessions.

Below the figures, lines starting with `⚑` carry reminders from your settings (see
[Thresholds](#thresholds-and-wake-ups)):

```
⚑ Compact threshold passed (327k ≥ 300k): if your task allows it, compact at the next clean point …
⚑ 5-hour limit at 85% ≥ your pause threshold 80%: please pause your work at the next clean point …
```

The model gets this legend once, in the CTM part of its system prompt (cached).

## When the model gets it

| When | What |
|---|---|
| Always (system prompt) | A short CTM briefing: what the `[CTM …]` blocks are, the tools, how to react to fast-climbing limits. Survives compact and clear. |
| On every prompt you send | The current figures (turn off with `attachToPrompts`). |
| While it works | At most every `intervalMinutes` (default 3, changeable by the model and by you) on a tool result, tracked per agent. |
| While idle, if it turned that on | A wake-up prompt with the figures every `intervalMinutes` (each starts a turn). |
| After a CTM compact/clear/model switch | What happened, the model it now runs on, the CTM briefing, its resume prompt and the current figures. |

## Tools for the model

- `mcp__ctm__status` – the current figures on demand.
- `mcp__ctm__idle_updates` `{ enabled, maxMinutes? }` – idle updates on/off for this session.
- `mcp__ctm__settings` `{ intervalMinutes?, compactThreshold?, fiveHourPauseAt?, sevenDayPauseAt? }` –
  shows (no arguments) or changes the settings; `null` puts one back to its default.
- `mcp__ctm__limit_wakeup` `{ limit, belowPercent?, note?, cancel? }` – arms a wake-up for when the
  5-hour or 7-day limit is back below a mark (default: its pause threshold).
- `mcp__ctm__reset` `{ mode, instructions?, resumePrompt }` – schedules a compact or clear for
  the end of the current turn. Rules:
  - `resumePrompt` is required; `compact` also requires `instructions` for the summary. Both
    need at least 20 characters and have **no upper length limit** – the model is told to be
    complete rather than short.
  - The tool description tells the model to structure the `resumePrompt` as: **next step**,
    **key facts** (goal, state, decisions, open items, files, commands), and **every important
    rule** (verbatim where the wording matters) – because it is the one thing that reliably
    survives a compact or a clear. Alternatively the model writes these details to a file and
    gives its exact path in the `resumePrompt`, together with the next step.
  - Main agent only, not subagents.
  - At least `resetCooldownMinutes` (default 10) between two resets.
  - If you interrupt the turn (Esc), the scheduled reset is dropped.

- `mcp__ctm__models` – the model the session runs on now, and the models it can switch to: the
  choices of the `/config` Model row (aliases such as `sonnet`, `opus`, `haiku`, `[1m]` variants),
  or any full model ID. Says so when a policy locks the Model setting.
- `mcp__ctm__switch_model` `{ model, resumePrompt, reset?, instructions? }` – schedules a model
  switch for the end of the current turn, e.g. to a smaller model for routine work or when the
  limits run high, or to a larger one for a hard problem. Rules:
  - Runs as `/model <name>`: **for this session only**, never written to your settings.
  - `resumePrompt` is required and written as for `reset`; afterwards the model gets it together
    with the model it now runs on.
  - `reset: "compact"` (with `instructions`) or `"clear"` runs that reset **first**, then the
    switch. A switch rebuilds the prompt cache for the whole conversation on the new model, so
    with a large context the combination is much cheaper.
  - If the host, an allowlist or a policy refuses the model (or the name is unknown), the model
    stays as it was and the resume prompt arrives with the reason. If the reset fails, the
    switch is skipped too. An alias the host does not list is refused at once.
  - Main agent only; shares the `resetCooldownMinutes` gap with `reset`; dropped if you
    interrupt the turn.

You get a toast whenever the model schedules a reset or a model switch, turns idle updates on, changes the
settings, or arms or fires a limit wake-up.

## Thresholds and wake-ups

- **Compact threshold** (`compactThreshold`: tokens like `300k`, or a percent of the window like
  `30%`): once the context passes it, every CTM block reminds the model to compact at the next
  clean point – *if its task allows it*, never in the middle of critical work. A smaller context
  makes every further request cheaper on the 5-hour and 7-day limits.
  While it is **not set**, CTM nudges the model at most every 30 minutes to ask you whether to set
  one. Set it to `off` if you don't want one – that stops the nudging.
- **Pause thresholds** (`fiveHourPauseAt`, `sevenDayPauseAt`, in percent; off by default, no
  nudging): once a limit passes its threshold, every block asks the model to pause at the next
  clean point, arm `mcp__ctm__limit_wakeup` and end its turn.
- **Built-in safety threshold** (always active, **not configurable**): from **95%** of the 5-hour
  limit and **97%** of the 7-day limit the blocks ask the model to pause, even if no pause
  threshold is set – and even if yours is higher. The line says it is this built-in fallback. If
  your own pause threshold is passed, its line is shown instead (one line per limit).
- **Limit wake-up**: while the model is idle, CTM checks every `intervalMinutes` whether the limit
  is back below the mark – because its window reset, or because it dropped – and then wakes the
  model with a message (plus its own note). The model can also arm one on its own, e.g. "wake me
  when the 5-hour window has reset". Rate limits arrive with responses, so while the model pauses
  CTM treats a window whose reset time has passed as reset.

Whenever a setting changes, the answer carries the current figures right away: a threshold
that is **already passed** when it is set (e.g. a compact threshold of 50k with 84k in the
context, or 30% with 42% used) is flagged at once with `ATTENTION` and its `⚑` line – the
model does not have to wait for the next block. This also holds when you set it with `/ctm`.

Settings set by the model or with `/ctm` are kept across sessions (in the plugin's store) and
take precedence over the options below.

## `/ctm` – your own way to change them

```
/ctm                          show the settings
/ctm interval 5               updates every 5 minutes
/ctm compact 300k             compact threshold (also 30%, off, default)
/ctm pause5h 80               pause at 80% of the 5-hour limit (also off, default)
/ctm pause7d 90               pause at 90% of the 7-day limit
```

The model is told when you change them.

## Options (`/plugin` → ctm → configure, or `/config`)

| Option | Default | Meaning |
|---|---|---|
| `intervalMinutes` | 3 | Interval of updates while working and while idle, and of the wake-up checks (1–60) |
| `compactThreshold` | empty | `300k`, `30%`, `off`; empty = unset (the model is nudged to ask you) |
| `fiveHourPauseAt` | 0 | Pause threshold for the 5-hour limit in percent, 0 = off |
| `sevenDayPauseAt` | 0 | Pause threshold for the 7-day limit in percent, 0 = off |
| `resetCooldownMinutes` | 10 | Minimum time between two compact/clear/model switches |
| `attachToPrompts` | true | Attach the figures to your own prompts |
| `timeZone` | empty | IANA zone for every time shown, e.g. `Europe/Berlin`. Empty = automatic: `TZ`, then `/etc/localtime` or `/etc/timezone`, then the system zone, else UTC |

## Install

From a GitHub repository that holds this folder at its root:

```
/plugin install ctm --marketplace <owner>/<repo>
```

Locally, to try it:

```
claude --plugin-dir /path/to/ctm
```

Requires Claude Code v2.1.287 or later (desktop app v2.1.286). Rate limits are reported only
when signed in with a claude.ai subscription, and only after the first response in a session.

## Notes

- Settings are kept across sessions. Everything else (idle updates, armed wake-ups, cooldown, the
  previous report for Δ) is per session and survives `/clear`, not a reload of the mod.
- Idle updates cost quota: each one is a turn of its own.
- Like a reset, a scheduled model switch runs after the turn has ended, so a one-shot `claude -p`
  exits before it happens; long-lived sessions (interactive, SDK, cloud) run it.
- Develop / check: `claude plugin validate ./ctm` and `claude plugin test ./ctm`.
