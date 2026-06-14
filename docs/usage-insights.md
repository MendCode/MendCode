# Usage Insights

Usage Insights is a TUI dashboard for local MendCode activity. It helps you see how the harness is being used without turning local stats into unsupported productivity claims.

It reports:

- daily token activity
- global/project/directory scope
- sessions and active days
- user prompts and user words
- AI generation time
- tool runtime
- changed files from session summaries
- input/output/reasoning/cache token mix
- peak token pressure
- longest task time
- top tools
- top agents
- top models with token/cost totals when available
- cached stats loading
- optional Open-Meteo weather

## Open The Dashboard

From the TUI command palette:

```text
Ctrl+P -> Usage Insights
Ctrl+P -> Project Usage Insights
```

Slash aliases are also registered for the global dashboard:

```text
/stats
/usage
/insights
/activity
```

The route header shows the scope:

- `global stats`
- `project stats`
- `directory stats`

## Shortcuts

Inside the dashboard:

| Key | Action |
| --- | --- |
| `a` | Toggle detail/advanced panels when the terminal is large enough. |
| `w` | Configure optional weather. |
| `r` | Refresh insights. |
| `Esc` | Return home. |

## Dashboard Sections

The dashboard adapts to terminal size. Wider terminals show more panels; smaller terminals keep the core totals visible.

Core totals:

- `tokens`: total token activity with peak-day detail.
- `sessions`: session count and active days.
- `AI generating` / `AI time`: assistant generation duration.
- `user words`: approximate user prompt volume.
- `cache tokens`: cached read/write token activity.
- `streak`: active-day streaks.

Token mix:

- input
- output
- reasoning
- cache

Outcome and load:

- sessions with code changes
- changed files
- tool runtime
- longest task
- peak tokens

Leaderboards:

- top tools
- top agents
- top models

## Scope

Use global scope when you want a whole-machine view of MendCode activity.

Use project scope when you want to see activity for the current repository. Project scope is the right screenshot for docs because it makes the dashboard feel tied to a real workspace without exposing unrelated machine activity.

Directory scope is useful when the current directory is inside a worktree or nested project path and you want narrower attribution.

Screenshot slots:

| File | Capture |
| --- | --- |
| `docs/assets/screenshots/usage-insights.png` | Global Usage Insights dashboard with daily token activity and top lists visible. |
| `docs/assets/screenshots/project-usage-insights.png` | Project Usage Insights dashboard in a repo with recent demo sessions. |
| `docs/assets/screenshots/usage-insights-weather.png` | Optional weather configured with a generic city, only if it looks clean and does not distract. |

Do not add image links until the files exist.

## Weather

Weather is opt-in. Press `w` or click the weather panel and enter a city, region, or country. MendCode uses Open-Meteo geocoding and forecast APIs. Leave the value blank to disable the weather widget.

Weather is a dashboard accessory, not a required part of usage tracking. For public docs, include it only as optional flavor.

## Data Notes

Usage Insights is local activity visibility. It should not be described as a productivity guarantee, ROI report, billing source of truth, or management analytics product.

Current aggregation includes session/message metadata available to the TUI:

- message roles and text parts for user prompt/word counts
- assistant tokens and cost when provider metadata supplies them
- tool parts and tool timing
- session summaries for changed-file counts
- model/provider/agent labels

If a provider or session does not supply a field, that field may be zero or absent. That is better than inventing a number.

## Capture Prompt

To generate a clean demo session before taking screenshots:

```text
Search the repo for promptChrome and summarize the available prompt input presets.
```

Then open:

```text
Ctrl+P -> Usage Insights
```

For project scope:

```text
Ctrl+P -> Project Usage Insights
```

Keep terminal width wide enough that the heatmap, totals, and top lists are visible together.

## Source Map

- `src/mendcode/packages/opencode/src/cli/cmd/tui/app.tsx`: command palette entries and slash aliases.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/stats/index.tsx`: Usage Insights route, responsive layout, shortcuts, cache, scope handling, and weather integration.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/util/usage-insights.ts`: aggregation for days, totals, tools, agents, models, token mix, duration, and streaks.
- `src/mendcode/packages/opencode/test/tui/usage-insights.test.ts`: regression coverage for token aggregation, user words, response time, tools, and active-day streaks.
