# Usage dashboard

Text estimates share `estimateTokens(chars) = ceil(chars / 4)` from the protocol's zod-free constants
(`@mendcode/protocol/wire`). Length means JavaScript UTF-16 code units; images receive no guessed cost.
Context sections, tool rent, request profiles, compaction, handoffs, savings and token-budget admission use
this definition. Provider-reported usage stays authoritative: footer context and forecast samples keep those
counts, and forecast growth/turn rounding remains a separate calculation. Live sidebar speed uses the shared
estimate only when the provider has not supplied output usage.

`/usage` opens MendCode's terminal dashboard: four stat tiles, token activity and selected-day details,
per-day bars and top sessions. `C` selects optional widgets: token mix, response load, subscription
usage, peak pressure, clock, weather, status, outcome signals, tools and agents/models. Optional
widgets start off; selections persist in the terminal-local profile. Usage figures come from `usage.query`.

Hints sit on the header's right. `1`–`7` or Tab select Overview, Limits, Tokens, Models, Tools, Sessions and Waste.
On Overview, Left/Right move one day and Up/Down one week; Home/End select the range's first day/today.
The calendar pans to keep the selection visible and clamps incomplete first/last weeks.
`[`/`]` choose 30/90/365 days; `g`/`m` cycle daily, weekly and cumulative activity; PageUp/PageDown
scroll the dashboard. Selecting a day returns to its detail. Other report tabs retain their existing keys;
Sessions uses Up/Down to select and Enter to open. `r` refreshes and Esc returns.

Under 70 columns, bordered panels form one column, with activity/detail first and the remaining
dashboard reachable with PageDown. Medium screens use two-column tile rows; wide screens put selected
subscription/clock/weather/status widgets beside the calendar. The selected clock refreshes once per
minute on Overview. The existing `/customize` → Terminal → Usage clock setting also gates it.

Two additive optional report fields were added: `activity[].longestAiMs`, the longest completed
agent-message/reasoning item recorded for that completion day, and `models[].costUnknownCalls`, the
count of calls lacking a price. Peaks persist in an indexed daily projection; pre-existing days without
that projection omit the field. The dashboard labels the maximum as “longest recorded”. Costs with
missing prices are marked partial; zero is displayed as a known cost only when pricing coverage says so.

`bun scripts/render-frames.ts .agents/runs/frames/ui-5 --ui-5` writes app-harness frames for all audited
pages and Usage tabs at 60×20, 100×30, 160×45, 220×60 and 180×50. Fixtures, profiles and projects use
temporary directories, local replies and no real provider.

UI-8 centers the calendar and its legend, uses a dedicated five-row clock font, and budgets the
Overview grid against the actual page height. At 180×50 and 220×60, per-day bars, model shares,
tool/skill ranking and session details reach the last content row. Smaller pages retain scrolling.
The overview only allocates an outcomes panel when selected. Bars, shares and averages derive from
the existing report; B77 adds the optional local agent/outcome fields described below.

B41 adds scopes to every report tab. `s` cycles global/project/directory; `p` cycles known projects.
`/stats-project` opens the current project. Scope changes
reset selection/scroll and query the daemon again. The header shows the selected scope and path;
account quota windows stay account-wide. Under 70 columns, the scope is in the title.

Project IDs in v2 are canonical checkout roots. Subdirectories and linked Git worktrees share a
project; non-Git directories each form a project. Directory scope includes the canonical folder and
its descendants, excludes similarly prefixed siblings, and keeps nested Git projects separate.
The daemon discovers known projects from sessions, and returns their IDs in `usage.query.projects`.
Per-session indexed projections include tokens, models, activity, tools, skills and effort; they backfill
existing event history once, transactionally. Historical effort uses the session's saved effort because
older events do not record it. Scope-filtered lifetime/peak/streak data never include other projects.

`usage.query` also returns `savings` (per filter: calls and estimated tokens) from the command output filters
([advanced-config](advanced-config.md#command-output-filters)); the Tools tab shows it as "Tokens saved" when any ran. The
projection is `usage_scope_savings` (per session and day), not backfilled, and it counts estimates, not billed tokens.

`mendcode stats` shows all-time bordered stats, tools by calls and optional model details:
`--days N` (`0` = today), `--tools N` (`0` = all), `--models [N]` (bare = all; default hidden),
`--project [ID]` (bare or empty = current project), `--scope global|project|directory`, `--waste` (see [Waste](#waste)).
`usage` accepts the same selectors and retains its 30-day default. `--json` returns the complete
report; `--models` and `--tools` only limit human output.
Remote commands use the connected daemon's directory and project identity. Use an explicit temporary
`--dir` when testing. No external provider or network query is needed.

`bun scripts/render-frames.ts .agents-frames/B41 --b41 100x30 180x50` renders all scopes/tabs,
granularities, scrolled overview, selected project and empty project through the app harness.

B77 uses `C` → Up/Down → Enter/Space to toggle a widget; `D` resets all optional widgets off.
Esc returns without leaving Usage. Widget selection applies to Overview and survives scope changes.
Agent counts use each session's current saved agent label (or plan/build), not historical per-turn
attribution. Outcome signals count distinct session/file pairs from completed, non-reverted retained
snapshots; unchanged, failed, open and skipped snapshots are excluded. Snapshot retention bounds
these counts, so the panel says “Retained snapshots only”. No file paths or contents leave the query.

`W` edits the weather region: Enter saves and selects the weather widget, Ctrl+U clears, Esc cancels.
A blank region disables weather immediately and persistently. `usageWeatherEnabled` defaults false;
`usageWeatherRegion` defaults empty. There is no built-in external service or network listener.
An embedding host may explicitly pass `usageWeather({region, signal})` to `startDaemon`, returning
`{location, label, temperatureC, windKmh?, code?, observedAt}`. The daemon validates readings, shares
in-flight requests, caches each region for five minutes (maximum 16 regions) and aborts after two
seconds. Errors omit upstream bodies. Without an adapter, the panel says “Service unavailable”.
`usage.weather.query` is deliberately excluded from remote read-only commands.

`bun scripts/render-frames.ts .agents-frames/B77 --b77 100x30 180x50` renders the dashboard,
widget picker, region editor, all scopes, scrolled panels and weather states using local fakes.

## Waste

Tab `7` (Waste) and `mendcode stats --waste` show where a range's tokens were paid for twice and what to change, from
MendCode's own call records only: nothing is read from another program's logs. The daemon command is `usage.waste` (same
range and scopes as `usage.query`, read-only, allowed to read-only remote clients). `--waste` reads the last 30 days unless
`--days N` says otherwise; `--json` returns the report.

Every model call and every finished compaction is a row (`usage_calls`, `usage_compactions`, per session in order, written
with the event and backfilled once from the log). A call is judged against the call before it in its session, when that one
held at least 20K tokens and nothing compacted in between:

- **Cold return**: its cache read fell under half of what it could read, after a pause of at least 5 minutes (60 after a
  1-hour write). Measured from what the provider reported, not from a guessed lifetime. Claude Code, Codex and ACP agents
  report a turn's sums, so for them it is a turn that wrote at least half its context again after such a pause.
- **Break**: the same miss within the lifetime, on a native call: something in front of the conversation changed.
- **Switch**: the call ran on another model than the one before it, which had none of it cached.

The tab shows the calls, cold returns and tokens sent again; **What to change** (findings, each with its saving: `clear`,
`likely` or `up to` for an upper bound worth testing; savings overlap and are never added); **Where it goes** (re-reading,
cache writes, new input, output); **Context size** (prompt tokens by prompt size); **Cold returns** with the five largest;
**Changes**; the largest or costliest conversations; breaks, switches, compactions and the time spent waiting for summaries.

| Finding | When | Fix |
|---|---|---|
| `idle_compact` | two or more cold returns of native sessions above `idleCompactAtTokens`, feature off | `features.idle_compact` on |
| `wait_cache` | two or more cold returns on Anthropic between 5 minutes and an hour, without a 1-hour lifetime | `features.wait_cache` on |
| `compact_earlier` | 20% or more of 20+ native calls past 200K while compacting later | `compactAtTokens: 200000` |
| `prompt_cache` | five or more breaks sending 100K or more, `promptCache` not `smart` | `promptCache: smart` |
| `model_switch` | three or more switches sending 100K or more | none: switch in a new or forked session |

On the tab, Up/Down select a finding's fix or a change to put back, Enter saves it (`settings.set`, the same patch shape as
`/settings`) and reads the report again; PgUp/PgDn scroll. The CLI prints the same panels with `fix:` lines and no keys.

**Changes** compares the days after each change of a setting that decides what a request costs (`compactAtTokens`,
`idleCompactAtTokens`, `promptCache`, `promptCacheTtl`, `claudeCacheTtl`, `cacheLifetimeMinutes`, `compaction`, `modelContext`,
`tier`, `handoffTokenCap`, and features that are not chrome-only) with the days before it, from the saved settings history
(`settings.changed`) of the last 90 days. Settings saved together are one change; a value changed and set back within 10 minutes
is none. Each side covers at most 14 days and stops at the next or previous such change, so it measures one configuration:
prompt and uncached tokens per turn, the share of calls past 200K, compactions and summary waiting a day, and the cost per turn
when every call has a price. A side with fewer than 10 turns or under a day is marked too early. Sessions differ between the
sides, so it is a trend, not a controlled test. A change still in force can be put back from the tab.

Money appears only where a price is known: the provider's billed cost, the user's `budgets.prices`, else models.dev's public
API price (ChatGPT and Codex calls at OpenAI's, Claude Code's at Anthropic's: a subscription's work at API prices, said as
such). A 1-hour cache write is priced at twice the input. Unpriced calls count in tokens; when some calls have no price the
conversations are ranked by prompt tokens, never as cheap.
