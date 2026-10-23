# CTM – Context and Token Manager

A Claude Code mod that keeps the model informed about its context window and the account's
5-hour / 7-day rate limits, each with its change since the last report, in a short block – and
lets the model compact or clear its own conversation, switch its own model or change its own
effort, always with a resume prompt so it carries on afterwards.

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
  are account-wide, so their Δ includes every parallel session. While the model works they come
  with every model response; while something waits on them, and for your prompts and status
  requests once the newest reading is 3 minutes old, CTM reads them from the server (see
  [Readings from the server](#readings-from-the-server)). The newest reading counts; a line
  ending in `as of HH:MM` is an older server reading because a newer one failed.
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

Where an organization manages Claude Code, the hooks of plugins you installed yourself do not run
on `prompt.compose` (nor `session.compact`) – `/plugins` notes it under CTM. The system prompt
then has no CTM part, so the main agent's next block after its first model request carries the
legend instead, and again once the context started over (after a compaction or `/clear`). You get
a toast once when that happens, and `/ctm` (or the settings tool) says where the briefing is. Where
`session.compact` does not reach CTM, a `/compact` CTM runs as a command (headless hosts) is
confirmed by measuring instead: the conversation the engine holds shrinks once it ran. An
administrator can make CTM one of the organization's own plugins in managed settings; its
legend is then in the system prompt as usual.

## When the model gets it

| When | What |
|---|---|
| Always (system prompt) | A short CTM briefing: what the `[CTM …]` blocks are, the tools, how to react to fast-climbing limits. Survives compact and clear. |
| On every prompt you send | The current figures (turn off with `attachToPrompts`). |
| While it works | At most every `intervalMinutes` (default 3, changeable by the model and by you) on a tool result, tracked per agent – and at once on the next tool result when a pause threshold is newly passed. |
| While idle, if it turned that on | A wake-up prompt with the figures every `intervalMinutes` (each starts a turn). |
| After a CTM compact/clear/model switch/effort change | What happened, the model and effort it now runs on, the CTM briefing, its resume prompt and the current figures. |

## Tools for the model

- `mcp__ctm__status` `{ refresh? }` – the current figures on demand; once the newest reading of the
  limits is 3 minutes old it reads them anew from the server first, and `refresh: true` does so at
  once (a few seconds, no tokens; at most every 30 s).
- `mcp__ctm__idle_updates` `{ enabled, maxMinutes? }` – idle updates on/off for this session.
- `mcp__ctm__settings` `{ intervalMinutes?, compactThreshold?, fiveHourPauseAt?, sevenDayPauseAt? }` –
  shows (no arguments) or changes the settings; `null` puts one back to its default. From a
  subagent it sets only that subagent's own `fiveHourPauseAt` / `sevenDayPauseAt`.
- `mcp__ctm__limit_wakeup` `{ limit, belowPercent?, note?, cancel? }` – arms a wake-up for when the
  5-hour or 7-day limit is back below a mark (default: its pause threshold). From a subagent –
  whose turn ending would be its end – it waits right inside the call and returns once the limit
  is back below (or, should its hook's time run low, says so and asks to be called again).
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

- `mcp__ctm__models` – the model and effort the session runs on now, and the models it can switch
  to. Where it can, CTM shows them **as Claude Code describes them in its `/model` picker**: alias →
  model, what each is good for, its effort levels and fast mode, e.g.
  ```
  - haiku → claude-haiku-5-5: Haiku 5.5 · Fastest for quick answers (effort low–max)
  - opus → claude-opus-5-5: Opus 5.5 · Best for everyday, complex tasks (effort low–max, fast mode)
    Also accepted: best, sonnet[1m], opus[1m], fable[1m], opusplan, or a full model ID
  ```
  No plugin call hands this list out, so CTM asks a second, short-lived `claude` for it (the SDK's
  `initialize` request: about 2 seconds, nothing is sent to a model, no tokens) and keeps the
  answer for 15 minutes – a failed fetch too, so it does not wait again on every call.
  Nothing is hard-coded: the list follows your account, policy and Claude Code version. Where that
  does not work, it falls back to the bare choices of the `/config` Model row. Says so when a
  policy locks the Model setting.
- `mcp__ctm__switch_model` `{ model, resumePrompt, reset?, instructions? }` – schedules a model
  switch for the end of the current turn, e.g. to a smaller model for routine work or when the
  limits run high, or to a larger one for a hard problem. Rules:
  - Runs as `/model <name>`: **for this session only**, never written to your settings.
  - `resumePrompt` is required and written as for `reset`; afterwards the model gets it together
    with the model it now runs on.
  - `reset: "compact"` (with `instructions`) or `"clear"` runs that reset **first**, then the
    switch. A switch rebuilds the prompt cache for the whole conversation on the new model, so
    with a large context the combination is much cheaper.
  - **First it checks that the model exists**, right when the tool is called: an alias from the
    `/config` Model row counts as existing; any other name gets a one-token test request (the
    API answers `404 model_not_found` for an unknown name, the engine refuses a model a policy or
    allowlist blocks). If the check fails, nothing is scheduled and the model is told which check
    failed and why.
  - If the switch itself then fails, the model stays as it was and the resume prompt arrives with
    the command that was run (`/model <name>`) and the engine's answer verbatim. If the reset
    fails, the switch is skipped too.
  - Optional `effort`: sets the effort for the new model in the same go (after the switch;
    checked against the levels the new model supports).
  - Main agent only; shares the `resetCooldownMinutes` gap with `reset`; dropped if you
    interrupt the turn.
- `mcp__ctm__set_effort` `{ level, resumePrompt? }` – changes the model's own reasoning effort
  (`low`, `medium`, `high`, `xhigh`, `max`, or `auto` to hand the choice back to Claude Code), e.g.
  up when its solutions stay half-baked, down for routine work. Rules:
  - Runs as `/effort <level>` at the end of the turn, **for this session only**; then the model
    gets a message to carry on (its `resumePrompt`, or "carry on where you left off" – the
    conversation stays as it is).
  - Checked against the levels the current model supports; a refusal comes back with the command
    and the engine's answer verbatim, the effort unchanged.
  - If you told the model to keep a model or an effort level, it is told not to change it itself.
  - Main agent only; its own gap between two effort changes (`effortCooldownMinutes`, independent
    of the reset/switch gap); joins a reset or
    model switch scheduled in the same turn; dropped if you interrupt the turn.
  - The current effort is read from the model requests themselves (`turn.step`), so it is exact
    after any change, yours included.

You get a toast whenever the model schedules a reset, a model switch or an effort change, turns idle updates on, changes the
settings, or arms or fires a limit wake-up.

## Thresholds and wake-ups

- **Compact threshold** (`compactThreshold`: tokens like `300k`, or a percent of the window like
  `30%`): once the context passes it, every CTM block reminds the model to compact at the next
  clean point – *if its task allows it*, never in the middle of critical work. A smaller context
  makes every further request cheaper on the 5-hour and 7-day limits.
  **Default: 350k** – it applies wherever neither you nor the model set one. Set it to `off` if you
  don't want one. Left empty in the options, it is unset: CTM then nudges the model at most every
  30 minutes to ask you whether to set one.
- **Pause thresholds** (`fiveHourPauseAt`, `sevenDayPauseAt`, in percent; off by default, no
  nudging): once a limit passes its threshold, every block asks the model to pause – **a request,
  never a hard stop**: it first finishes anything that must not be left half-done (a config file
  deleted on a live server and not yet recreated, a migration midway), then at that clean point
  arms `mcp__ctm__limit_wakeup` and ends its turn. CTM never holds or blocks a tool call.
- **Built-in safety threshold** (always active, **not configurable**): from **95%** of the 5-hour
  limit and **97%** of the 7-day limit the blocks ask the model to pause, even if no pause
  threshold is set – and even if yours is higher. The line says it is this built-in fallback. If
  your own pause threshold is passed, its line is shown instead (one line per limit).
- **Limit wake-up**: while the model is idle, CTM checks every `intervalMinutes` whether the limit
  is back below the mark – because its window reset, or because it dropped – and then wakes the
  model with a message (plus its own note). The model can also arm one on its own, e.g. "wake me
  when the 5-hour window has reset". Each check goes by the newest reading: CTM reads the server
  right before it (see below); where that does not work, it goes by the last reading the session
  has and treats a window whose reset time has passed as reset – also when the limit drops out of
  the readings after its reset. Right when a known reset time passes, CTM checks at once instead of
  waiting for the next interval. A subagent's turn – a background one too – does not hold a
  wake-up back, and a wake-up the engine does not take is kept and sent again at the next check.
- **Wake-ups survive a reload**: an armed wake-up and idle updates are kept for the session in
  `$.state`. A reload of the mod, or a hooks worker Claude Code replaces (after a crash, or when a
  plugin's hooks overran their time), starts the module over without its variables and timers;
  the fresh copy takes the armed wake-ups back when Claude Code raises `session.start` in it, and
  every CTM hook makes sure the checks run. Another session in the same process (`/resume`) never
  gets them.
- **Subagents**: get the blocks like the main agent, with their own wording: they cannot end their
  turn and be woken (their turn ending is their end), so they wait inside `limit_wakeup`. To give a subagent **its own
  pause thresholds**, put e.g. `[CTM limits: 5h=70 7d=90]` into its prompt (one of the two is
  enough; `off` leaves only the safety net) – CTM takes the mark out and tells the subagent. Lower
  marks for helpers let the main agent go on a little longer than they do. A subagent can also set
  its own with the settings tool. Not possible with the plugin API today: compacting a subagent
  (Claude Code compacts it itself when it fills up) and a context figure per subagent.
- **Several accounts** ([account switcher](https://github.com/AlexCherrypi/claude-account-switcher)):
  where that plugin is installed (CTM checks for its tools at most once a minute), a block that
  asks the main agent to pause first points it to `mcp__account-switcher__accounts`. If another
  of your accounts has room and the model may switch, it moves there with
  `mcp__account-switcher__switch` and carries on instead of pausing. After a switch CTM shows the
  new account's figures, with no Δ against the old one.

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
| `compactThreshold` | 350k | `300k`, `30%`, `off`; empty = unset (the model is nudged to ask you) |
| `fiveHourPauseAt` | 0 | Pause threshold for the 5-hour limit in percent, 0 = off |
| `sevenDayPauseAt` | 0 | Pause threshold for the 7-day limit in percent, 0 = off |
| `resetCooldownMinutes` | 10 | Minimum time between two compact/clear/model switches (one shared gap), 0 = none |
| `effortCooldownMinutes` | 10 | Minimum time between two effort changes, independent of the one above, 0 = none |
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

## Readings from the server

The 5-hour / 7-day limits come from the server by default. Claude Code's own reading comes only
with the headers of model responses: while the session is idle it stays frozen, usage from other
sessions or devices on the same account stays unseen, and right after `/login` to another
account the numbers are the old account's. That reading is the fallback.

CTM asks a second, short-lived `claude` for the account's usage meter – the SDK's `get_usage`
control request, the same fetch `/usage` does (`GET /api/oauth/usage`). Nothing goes to a model
and it costs no tokens; it takes about 3 s and briefly a second `claude` process.

- **When**: only when the newest reading at hand – the last server reading or the last model
  response's – is 3 minutes old: right before a limit wake-up check or an idle update, every 3
  minutes while a subagent waits inside `mcp__ctm__limit_wakeup`, before the block on your prompts,
  on `mcp__ctm__status` and when a wake-up is armed (so such a block waits up to ~3 s), on demand
  with `mcp__ctm__status` `refresh: true` (at most every 30 s), and right after `/login` to another
  account (with your next prompt; the account comes from `oauthAccount.accountUuid` in
  `~/.claude.json`, or wherever Claude Code keeps it: `$CLAUDE_CONFIG_DIR/.claude.json` where
  that is set, an older install's `~/.claude/.config.json` – a file that cannot be read counts as
  no switch). Until there is a reading for
  the new account the block says so instead of showing the old account's numbers, and it shows no
  Δ against them – also once the response to a request sent before the switch comes in, which
  still went out under the old account (nor does any other response count while such a request is
  out). While the model works, every response brings a fresh
  reading, so the work updates on tool results never wait for the server.
- **Never at the cost of a hook's time**: a hook never waits for a reading another hook or the
  timer has in flight. Claude Code bounds each hook's own time and counts waiting for someone
  else's process against it; a hook that runs on past its time counts toward a runaway plugin,
  and after two in a row Claude Code replaces the hooks worker.
- **Only real answers**: the child runs with `--setting-sources ""` (no settings: no plugins or
  hooks of yours or the project's, so no second CTM) and with
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` empty (set, the fetch fails silently and the answer
  comes from a cache up to an hour old). An answer without `rate_limits.limits[]`, or whose
  `seven_day_breakdown.as_of` is older than 10 minutes, is such a cached one and is not used.
  `-p` takes an `ANTHROPIC_API_KEY` from the environment over the claude.ai login, so where the
  session itself does not run on that key the child gets it empty. Claude Code takes the key in a
  session with you at the prompt (terminal, VS Code) only once you approved it, and in `-p` and
  the SDK as it is. CTM tells which by the key's last 20 characters against
  `customApiKeyResponses.approved` in `~/.claude.json`, the way Claude Code does; the key itself
  is read for nothing else and goes nowhere. With an `apiKeyHelper` in your settings the session
  runs on its key, which the child (reading no settings) would not: then CTM does not ask.
- **Newest wins, with a fallback**: per limit, the server reading counts when its numbers are newer
  than the last model response (Claude Code may answer from a snapshot up to a minute old), else the
  session's own from that response. The endpoint answers 429
  when asked too often, so after a failure CTM waits 5 minutes, doubling up to an hour (an hour at
  once only for a login without rate limits; a fetch that failed with nothing cached is tried
  again after the usual back-off). Meanwhile the last server reading is shown – marked
  `as of HH:MM` – until a model response brings a newer one. Where no second `claude` can run or
  has no claude.ai login of its own (e.g. a cloud session, whose login the host manages), CTM keeps
  working with the session's own readings.

## Notes

- Settings are kept across sessions. Armed wake-ups and idle updates are kept for the session
  and survive `/clear`, a reload of the mod and a replaced hooks worker. Everything else
  (subagents' own thresholds, cooldown, the previous report for Δ) is per session and survives
  `/clear`, not a reload of the mod.
- Idle updates cost quota: each one is a turn of its own.
- Like a reset, a scheduled model switch runs after the turn has ended, so a one-shot `claude -p`
  exits before it happens; long-lived sessions (interactive, SDK, cloud) run it.
- Develop / check: `claude plugin validate ./ctm` and `claude plugin test ./ctm`.
