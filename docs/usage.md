Open `/usage` to see four stat tiles, token activity, selected-day details, per-day bars and top sessions. Add optional widgets or narrow the report to a project or directory.

## Usage dashboard

1. Run `/usage` to open the terminal dashboard.
2. Select a report tab or a day with the keys below.
3. Press `C` to choose optional widgets. They start off; selections persist in the terminal-local profile.

Available widgets are token mix, response load, subscription usage, peak pressure, clock, weather, status, outcome signals, tools and agents/models. Usage figures come from `usage.query`.

### Navigate the dashboard

Hints sit on the header's right.

| Key | Does |
| --- | --- |
| `1`–`7` or Tab | Select Overview, Limits, Tokens, Models, Tools, Sessions or Waste |
| Left/Right on Overview | Move one day |
| Up/Down on Overview | Move one week |
| Home/End on Overview | Select the range's first day/today |
| `[`/`]` | Choose 30/90/365 days |
| `g`/`m` | Cycle daily, weekly and cumulative activity |
| PageUp/PageDown | Scroll the dashboard |
| Up/Down in Sessions | Select a session |
| Enter in Sessions | Open it |
| `r` | Refresh |
| Esc | Return |

The calendar pans to keep the selection visible and clamps incomplete first/last weeks. Selecting a day returns to its detail. Other report tabs retain their existing keys.

### Layout and clock

| Screen | Layout |
| --- | --- |
| Under 70 columns | Bordered panels form one column, activity/detail first; PageDown reaches the remaining dashboard |
| Medium | Two-column tile rows |
| Wide | Selected subscription/clock/weather/status widgets sit beside the calendar |

The selected clock refreshes once per minute on Overview. The existing `/customize` → Terminal → Usage clock setting also gates it.

UI-8 centers the calendar and legend, uses a dedicated five-row clock font, and budgets the Overview grid against the actual page height.

At 180×50 and 220×60, per-day bars, model shares, tool/skill ranking and session details reach the last content row. Smaller pages retain scrolling.

Overview allocates an outcomes panel only when selected. Bars, shares and averages derive from the existing report; B77 adds the optional local agent/outcome fields described below.

### Choose a scope

B41 adds scopes to every report tab.

| Key or command | Does |
| --- | --- |
| `s` | Cycle global/project/directory |
| `p` | Cycle known projects |
| `/stats-project` | Open the current project |

Scope changes reset selection/scroll and query the daemon again. The header shows the selected scope and path; under 70 columns, the scope is in the title. Account quota windows stay account-wide.

Project IDs in v2 are canonical checkout roots:

- Subdirectories and linked Git worktrees share a project.
- Non-Git directories each form a project.
- Directory scope includes the canonical folder and descendants, excludes similarly prefixed siblings, and keeps nested Git projects separate.

Scope-filtered lifetime/peak/streak data never include other projects.

### Tokens saved

The Tools tab shows "Tokens saved" when command output filters ran; see [advanced-config](advanced-config.md#command-output-filters).

`usage.query` returns `savings` per filter: calls and estimated tokens. These are estimates, not billed tokens; the `usage_scope_savings` projection is per session and day and is not backfilled.

### Report from the command line

Run `mendcode stats` for all-time bordered stats, tools by calls and optional model details.

| Selector | Does |
| --- | --- |
| `--days N` | Choose days; `0` = today |
| `--tools N` | Limit tools; `0` = all |
| `--models [N]` | Show models; bare = all, default hidden |
| `--project [ID]` | Choose project; bare or empty = current project |
| `--scope global|project|directory` | Choose scope |
| `--waste` | Show [Waste](#waste) |
| `--json` | Return the complete report |

`usage` accepts the same selectors and retains its 30-day default. `--models` and `--tools` limit only human output.

Remote commands use the connected daemon's directory and project identity. Use an explicit temporary `--dir` when testing. No external provider or network query is needed.

### Choose widgets

B77 adds the widget picker:

1. Press `C`, then Up/Down to select a widget.
2. Press Enter/Space to toggle it, or `D` to reset all optional widgets off.
3. Press Esc to return without leaving Usage.

Widget selection applies to Overview and survives scope changes.

Agent counts use each session's current saved agent label (or plan/build), not historical per-turn attribution.

Outcome signals count distinct session/file pairs from completed, non-reverted retained snapshots. Unchanged, failed, open and skipped snapshots are excluded.

Snapshot retention bounds these counts, so the panel says “Retained snapshots only”. No file paths or contents leave the query.

### Set a weather region

| Key | Does |
| --- | --- |
| `W` | Edit the weather region |
| Enter | Save and select the weather widget |
| Ctrl+U | Clear |
| Esc | Cancel |

A blank region disables weather immediately and persistently. `usageWeatherEnabled` defaults false; `usageWeatherRegion` defaults empty.

There is no built-in external service or network listener. Without an adapter, the panel says “Service unavailable”.

## Quota from the command line

Run `mendcode usage --quota` to print the provider quota windows the footer shows, one line each (`codex 5h  62% left (38% used)
· resets in 2h · seen 1m ago`).

`--json` prints `{ now, daemon, quota: [{ provider, window, usedPercent, leftPercent,
resetsAt?, observedAt, ageMs, stale }] }`, the same list `api.usage()` gives an extension.

This is read-only and free: it asks an already-running daemon for readings it holds, starts no daemon and sends nothing to any provider. It is local only and available in every tier.

Without a running daemon, `daemon` is `false` and the list is empty: every window is unknown. A window not listed is unknown, never 0% or 100%.

## Auxiliary calls

Some model calls are not part of any turn you sent: the daemon makes them for you. Each one is counted by role and model, with
its provider-reported input, output, reasoning and cache tokens and its cost (provider-reported, else `budgets.prices`, else
unknown), under the session or directory it was made for:

| Role | Call | Where |
|---|---|---|
| `title` | a session's generated title (first turn, turn 3, every 15 turns, a requested regeneration) | `session-metadata.ts` |
| `summary` | a session's summary, written when a reader asks for it | `session-metadata.ts` |
| `recap` | `/recap` | `session.recap` |
| `memoryExtractor` | memories extracted after a turn | `memory-extraction.ts` |
| `memoryAssistant` | the Memory page's assistant and side chat | `memory-assistant.ts` |
| `dream` / `memoryConsolidator` | a Dream run and its semantic consolidation | `startDream` |
| `permissionReviewer` | the reviewer of smart-mode approvals (only with the `permissionReviewer` role set) | `permission-reviewer.ts` |
| `hook` | a `prompt` shell hook | `shell-hooks.ts` |
| `agentGenerate` | `/agents` create with a generated definition | `agent-generate.ts` |
| `setup` | the setup helper's answers | `setup.ask` |
| `loopInterpret` | `/loop` with a schedule phrase the local parser did not read | `loop.interpret` |
| `whatsNew` | `/whatsnew` picking the changes that fit you ([what's new](whats-new.md)) | `whatsnew.ask` |
| `todayTriage` | `/today`'s `t`, grouping the page's rows ([today](today.md#triage)) | `today.triage` |
| `prReview` | the PR reviewer's own turns (review, verify, fix children), one row per day, model and directory | `pr-review/service.ts` |

### Calls already in the totals

`prReview` attributes instead of adding. The reviewer's child sessions are hidden sessions whose turns days and models already count; their per-call rows go when the session is deleted.

Its row shows how much of those totals was the reviewer's. It is marked "(in the totals above)" and excluded from the "outside turns" sum.

Its input is what the provider did not serve from cache; cached tokens are in `cacheRead`.

`/btw` is not in the list: its side session runs turns, already counted as turn usage.

### Read auxiliary totals

Auxiliary calls are not part of the report's `days` or `models`, nor the footer's today count, which stay the turns' own.

The `/usage` page and `mendcode usage`/`stats` add them to totals from `auxiliaryDays` (see [Every harness](#every-harness)), so nothing is counted twice or left out.

`usage.query` returns `auxiliary` per role and model, most tokens first; it is absent when there were none. Global shows all; project or directory scope shows those made for its directories.

The Models tab adds an "Auxiliary calls" panel. `mendcode usage` and `mendcode stats` add the same rows; `--json` returns the field:

```
auxiliary (outside turns): 99.8K tokens · 26 calls · cost $0.02 (+25 unpriced)
  summary · gpt-6-luna                     12 calls       74K in    2,100 out
  memoryExtractor · gpt-6-luna              4 calls     18.4K in    1,200 out
  title · gpt-6-luna                        9 calls     3,000 in       90 out
  hook · claude-haiku-5                      1 call     1,000 in       50 out
```

A call that fails or reports no usage counts as one call of its role with zero tokens and unknown cost.

Recording is bookkeeping in every tier: no request, token or chrome of its own. The panel appears only on /usage and only when there were such calls.

The store keeps one row per day, role, model and directory (`usage_auxiliary_daily`), like global daily sums. Every session of a project that day adds to the same row.

The budget ledger ([budgets](budgets.md)) counted these calls before and still does, once.

## Every harness

The page's totals (the header's token count, the tiles, the calendar, the Tokens tab) count every model call of the range once:

- the turns of every harness: the native engine, Claude Code, Codex, pi and ACP agents (an ACP agent counts when it reports
  `usage` in its `session/prompt` answer; its context comes from its last `usage_update`);
- child sessions (sub-agents, the PR reviewer's children): each is a session of its own, counted in its own harness and never
  again in its parent. Claude Code's own sub-agents are inside Claude Code's turn sums; the `/btw` side chat runs turns of a
  session of its own and counts like one;
- the calls outside turns ([Auxiliary calls](#auxiliary-calls)), from `auxiliaryDays`; `prReview` is left out there because its
  turns are already in the days;
- usage imported from a harness's own log (`usage recover`), already in `days`.

Tokens are input + output + cache read + cache write. Reasoning is part of output in every engine's count, so it is shown as
"of it reasoning" and never added again. Cache hit is cache read / (input + cache read + cache write).

### Read token and model breakdowns

| Tokens tab panel | Shows |
| --- | --- |
| **Totals** | Today, 7 days, 30 days and the range, each ending today |
| **By harness** | One row per harness, "Outside turns", "Imported · engine", "Deleted sessions" for calls of sessions deleted since, and a Total row equal to the page's total |
| Token mix, calls and cost | The range's breakdown |

A note says how much of a harness's row came from sub-agent sessions.

The Models tab lists each model's input, output, cache read, cache write, hit rate, cost and calls, plus a Total row. It counts turns only, like `models`; outside-turn calls have their own panel below.

### Read cost coverage

| Pricing coverage | Display |
| --- | --- |
| Every call has a price | Cost |
| Only some calls have a price | Cost with `+` |
| No call has a price | `unknown` |

Claude Code and Codex report no cost, so their rows are unknown unless `budgets.prices` prices their models. A price is never guessed and an unknown cost is never shown as $0.00.

### Harness query fields

`usage.query` adds:

| Field | Contents |
| --- | --- |
| `harnesses` | Per harness: calls, sessions, input, output, reasoning, cache read and write, cost, unpriced calls, and `subagents` |
| `auxiliaryDays` | Calls outside turns |
| `models[]` additions | `reasoning`, `cacheRead` and `cacheWrite` |

A call's harness is read when the page asks: Claude Code and Codex use their own provider ids, an ACP agent uses `acp`, and a session bound to pi counts as pi.

Nothing new is stored and nothing runs at start-up; the breakdown loads with the first `usage.query`. `mendcode usage` and `mendcode stats` print the same totals and a "By Harness" panel.

`mendcode usage` also ends with two blocks, the same figures `--json` holds:

- `by day:` one row per day with calls (the last 14): input, output, cache read, cache write and calls. A range of one day has no such block.
- `by engine:` one row per harness: tokens, cached tokens, calls and, when it ran any, its sub-agents: how many, their calls and their tokens. A sub-agent is a child session MendCode started; Claude Code's own internal agents are part of their parent's calls.

```text
by day:           input   output  cache read  cache write   calls
  2026-11-13       2.8M     927K        153M         4.5M     592
by engine:
  native             3.1M tokens (+7.7M cached) · 581 calls · 106 sub-agents (542 calls, 8.7M tokens)
```

## Waste

Open tab `7` (Waste) or run `mendcode stats --waste` to see where a range's tokens were paid for twice and what to change.

Only MendCode's own call records are used; nothing is read from another program's logs. `--waste` reads the last 30 days unless `--days N` says otherwise; `--json` returns the report.

The daemon command is `usage.waste`: the same range and scopes as `usage.query`, read-only and allowed to read-only remote clients.

### How calls are judged

Every model call and every finished compaction is a row (`usage_calls`, `usage_compactions`, per session in order, written
with the event and backfilled once from the log). A call is judged against the call before it in its session, when that one
held at least 20K tokens and nothing compacted in between:

- **Cold return**: its cache read fell under half of what it could read, after a pause of at least 5 minutes (60 after a
  1-hour write). Measured from what the provider reported, not from a guessed lifetime. Claude Code, Codex and ACP agents
  report a turn's sums, so for them it is a turn that wrote at least half its context again after such a pause.
- **Break**: the same miss within the lifetime, on a native call: something in front of the conversation changed.
- **Switch**: the call ran on another model than the one before it, which had none of it cached.

### Read the panels

The tab shows calls, cold returns and tokens sent again, plus:

| Panel | Shows |
| --- | --- |
| **What to change** | Findings with savings marked `clear`, `likely` or `up to` for an upper bound worth testing; savings overlap and are never added |
| **Where it goes** | Re-reading, cache writes, new input and output |
| **Context size** | Prompt tokens by prompt size |
| **Cold returns** | The five largest |
| **Changes** | Setting comparisons described below |
| Conversations | The largest or costliest |
| Other measures | Breaks, switches, compactions and time spent waiting for summaries |

### Apply a finding

| Finding | When | Fix |
|---|---|---|
| `idle_compact` | two or more cold returns of native sessions above `idleCompactAtTokens`, feature off | `features.idle_compact` on |
| `wait_cache` | two or more cold returns on Anthropic between 5 minutes and an hour, without a 1-hour lifetime | `features.wait_cache` on |
| `compact_earlier` | 20% or more of 20+ native calls past 200K while compacting later | `compactAtTokens: 200000` |
| `prompt_cache` | five or more breaks sending 100K or more, `promptCache` not `smart` | `promptCache: smart` |
| `model_switch` | three or more switches sending 100K or more | none: switch in a new or forked session |

On the tab, Up/Down select a finding's fix or a change to put back, Enter saves it (`settings.set`, the same patch shape as
`/settings`) and reads the report again; PgUp/PgDn scroll. The CLI prints the same panels with `fix:` lines and no keys.

### Compare changes

**Changes** compares days before and after settings that decide what a request costs, using the last 90 days of saved settings history (`settings.changed`).

These settings are `compactAtTokens`, `idleCompactAtTokens`, `promptCache`, `promptCacheTtl`, `claudeCacheTtl`, `cacheLifetimeMinutes`, `compaction`, `modelContext`, `tier`, `handoffTokenCap`, and features that are not chrome-only.

| Comparison rule | Behavior |
| --- | --- |
| Settings saved together | One change |
| Value changed and set back within 10 minutes | No change |
| Window on each side | At most 14 days, stopping at the next or previous such change to measure one configuration |
| Fewer than 10 turns or under a day on a side | Marked too early |

Each side measures:

- Prompt and uncached tokens per turn.
- Share of calls past 200K.
- Compactions and summary waiting a day.
- Cost per turn when every call has a price.

Sessions differ between sides: this is a trend, not a controlled test. A change still in force can be put back from the tab.

### Waste pricing

Money appears only where a price is known, in this order:

1. The provider's billed cost.
2. The user's `budgets.prices`.
3. models.dev's public API price.

API pricing uses OpenAI's price for ChatGPT and Codex calls, and Anthropic's for Claude Code: a subscription's work at API prices, labeled as such.

A 1-hour cache write is priced at twice the input. Unpriced calls count in tokens; when some calls have no price, conversations are ranked by prompt tokens, never as cheap.

## How it works

### Text estimates

Text estimates share `estimateTokens(chars) = ceil(chars / 4)` from the protocol's zod-free constants (`@mendcode/protocol/wire`). Length means JavaScript UTF-16 code units; images receive no guessed cost.

Context sections, tool rent, request profiles, compaction, handoffs, savings and token-budget admission use this definition.

Provider-reported usage stays authoritative. Footer context and forecast samples keep those counts; forecast growth/turn rounding remains a separate calculation. Live sidebar speed uses the shared estimate only when the provider has not supplied output usage.

### Report fields and projections

Two additive optional report fields were added:

| Field | Meaning |
| --- | --- |
| `activity[].longestAiMs` | Longest completed agent-message/reasoning item recorded for that completion day |
| `models[].costUnknownCalls` | Count of calls lacking a price |

Peaks persist in an indexed daily projection; pre-existing days without it omit the field. The dashboard labels the maximum “longest recorded”.

Costs with missing prices are marked partial. Zero is displayed as a known cost only when pricing coverage says so.

The daemon discovers known projects from sessions and returns their IDs in `usage.query.projects`.

Per-session indexed projections include tokens, models, activity, tools, skills and effort. They backfill existing event history once, transactionally. Historical effort uses the session's saved effort because older events do not record it.

### Weather adapter

An embedding host may explicitly pass `usageWeather({region, signal})` to `startDaemon`, returning `{location, label, temperatureC, windKmh?, code?, observedAt}`.

The daemon validates readings and shares in-flight requests. It caches each region for five minutes (maximum 16 regions) and aborts after two seconds. Errors omit upstream bodies.

`usage.weather.query` is deliberately excluded from remote read-only commands.

### Render frames

| Command | Frames |
| --- | --- |
| `bun scripts/render-frames.ts .agents/runs/frames/ui-5 --ui-5` | All audited pages and Usage tabs at 60×20, 100×30, 160×45, 220×60 and 180×50 through the app harness; fixtures, profiles and projects use temporary directories, local replies and no real provider |
| `bun scripts/render-frames.ts .agents-frames/B41 --b41 100x30 180x50` | All scopes/tabs, granularities, scrolled overview, selected project and empty project through the app harness |
| `bun scripts/render-frames.ts .agents-frames/B77 --b77 100x30 180x50` | Dashboard, widget picker, region editor, all scopes, scrolled panels and weather states using local fakes |
