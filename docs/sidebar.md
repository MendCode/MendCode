# Session panel

The right panel starts hidden. `/panel` opens the default `pulse` cards; the same command closes it. Its fixed header names the current preset and `/panel`, including in the narrow sheet (`panelNarrow: sheet`). `Ctrl+X, Shift+B` toggles it (`panel.toggle`, rebindable in `/keymap`). `/sidebar` only controls the left session list.

- `/panel <preset>` switches to a curated list; `/panel next` cycles the available presets (skips galaxy outside full tier). `/panel off` hides the panel and retains its list.
- `/panel edit` opens the widget editor: `a` adds, arrows select a type or widget, Enter confirms, `d` removes, `J/K` moves, `e` edits a widget's JSON, Esc returns. Text and extension widgets open the JSON editor; Ctrl+U clears its draft.
- `/panel reset` empties the effective spec and hides it. The next `/panel` starts with pulse again.
- `/panel width 32..80|auto` sets the bar's cells (`sidebarWidth`; automatic is 48, 56 from 150 columns).
- `/panel widget <id>` adds the built-in card of that name (`/panel widget atom`), or else a registered extension panel (8 rows maximum). Registration alone never opens the bar or renders a hidden panel; remove it with `/panel edit`. With the galaxy first in the bar, the cards after it are drawn under its own Focus, Recent and Top cards.
- `Alt+}` focuses the bar; PgUp/PgDn or arrows scroll it, Esc returns to the prompt. Mouse wheel over the bar also scrolls.
- The left session list keeps its existing `/sidebar auto|always|hidden` commands.

### One session, one screen

What these commands show or hide is the session's where they were typed, not every terminal's: `/panel` (shown, hidden, a preset, `next`, an added card, the width), `/sidebar`, `/timestamps`, `/thinking`, `/scrollbar` and the keys bound to them. Another terminal, or another session in the same terminal, keeps its own screen. The session's choices are kept in `<dataDir>/tui/session-look.json` (the newest 200 sessions), so the session shows them again after `/restart` or in any terminal that opens it. The defaults every terminal starts from are the config files: `/customize`, `tui/profile.json` and the panel's spec; `/panel edit` and `/panel reset` edit that spec, so they reach every session that has no cards of its own. When the spec changes (an agent built a panel), every terminal takes the new cards unless its session chose its own, and the bar opens only in a terminal whose session has a turn running.

## Spec and model tool

Context distinguishes the auto-compaction budget from the model window; the footer's threshold percentage is labelled `compact`. Quota cards show observation age; readings older than 15 minutes show one muted row, `codex · quota stale · 11h ago`, and do not raise pressure alerts. Missing readings stay unavailable, never zero usage. A card with nothing to show is one muted line (`No timed turns yet`, `Nothing queued`), and cards keep their height while a turn starts and ends (todos list every item, up to six).

The header names the preset whenever the spec has the same cards in the same order (priorities and key order do not matter); `custom` means an edited list. `/panel next` continues from the current preset (a custom or empty spec starts at `pulse`) and skips `galaxy` outside the full tier. A refused preset changes nothing and says why in one line: minimalist for every verb that would show the panel, and balanced for galaxy (`Galaxy needs full tier (/tier full) · try /panel crew`). `/panel off` and `/panel reset` always work.

`sidebarWidgets` is an ordered list in `<dataDir>/tui/profile.json`. `rightSidebar` is the default visibility; a session's own goes in `session-look.json`.
`<project>/.mendcode/tui/profile.json` can override `sidebarWidgets`; even an empty project list overrides the user list.
The manual editor and `/panel reset` edit the effective spec: the project override when present, otherwise the user profile. An empty project override stays empty; edit or remove that override explicitly to inherit the user spec again. Existing right-panel subcommands under `/sidebar` remain hidden compatibility aliases; completion and help only advertise `/panel`.

```json
{
  "sidebarWidgets": [
    { "type": "context", "options": {} },
    { "type": "usage", "title": "Quota", "options": {} },
    { "type": "text", "title": "Review", "options": { "text": "Run local checks before delivery." } },
    { "type": "sidechat", "options": {} }
  ],
  "rightSidebar": true
}
```

The native model tool `sidebar` supports `get`, `set`, `add`, `remove`, `move`, `clear`.
Indices are zero-based. `set` takes `widgets`; `add` takes `widget` and optional `index`; `move` takes `index` and `to`.
`scope` is `user` by default or `project`. Changes pass through ordinary write permissions; smart mode classifies this validated UI change as low risk. Sub-agents cannot change the bar.
The daemon preserves unrelated profile fields and notifies connected terminals after a change.

Every widget accepts `title`, `options.maxRows` (1–100) and `options.priority` (`high`, `normal`, `low`). Only `text` accepts `options.text` (markdown; use a fenced code block for ASCII to preserve its spacing).
There are at most 32 widgets. Unsupported types, fields, options and out-of-range actions are rejected before writing.

| Type | Data |
|---|---|
| `pace` | Output + reasoning tokens/min of recent timed calls, turns-to-compaction forecast, token-rate and time-per-turn sparklines; unavailable when timing or growth is unknown |
| `savings` | Persisted session-wide estimated tokens saved by graph and output filters, including earlier event pages; local-only `session.savings`, not a provider call |
| `queue` | Current queued and steering message counts with bounded previews; `/queue` holds the complete list |
| `lineage` | Compact fork/sub-agent tree, bounded to five descendants; `/tree` for the full family |
| `files` | Files touched by declared tool metadata or retained session snapshots, most recent first, with snapshot +/- counts when available; read-only files have no invented diff counts. Shell coverage depends on snapshot scope |
| `limits` | Fresh subscription windows and reset countdowns (missing or stale readings remain explicit) |
| `models` | Token breakdown per provider/model in loaded history, including compaction; balanced/full |
| `rent` | Top five tools by estimated schema tokens, with observed use counts; fetched through the existing context query |
| `orbit` | The galaxy: full-tier opt-in interactive disc of the session's code graph (files and symbols it used, lit as they are used); see below. The card keeps its first name |
| `context` | Current context tokens and compaction limit, with a bar that turns warning at 75% and error at 90%, the model's window when known and a cache-miss hint while `Cache notices` is on |
| `usage` | Provider quota windows and known reset times; `Limited · resets 2:10 AM (in 3h 12m)` first while a turn is paused by a usage limit ([usage-limit](usage-limit.md)) |
| `todos` | Latest todo tool result |
| `changes` | Working-tree files and added/removed line totals |
| `jobs` | This session's background shell tasks |
| `atom` | What is running now, drawn as an atom: the nucleus is the session and each orbit carries one kind of work (tool calls, sub-agents, background jobs) with one electron per running item, at most eight per orbit. Under it, the counts and up to three names. It moves only while something runs and stands still under reduced motion; in no preset, add it with `/panel widget atom` |
| `backlog` | The [project backlog](#project-backlog): the count of open items, then one row per item with its number, open ones first; past six rows finished items leave first and a last line says how many are not shown. In no preset, add it with `/panel widget backlog` |
| `loops` | Project loops and their current states |
| `workflows` | Project workflows and their current states |
| `agents` | The sub-agents and forks below the open session as a tree: state glyph, agent · model · state, result line of a finished sub-agent, running count (`maxRows` / 3 nodes, then `+N more`); falls back to the `task:` tool cards until the daemon answers (see [sessions](sessions.md#lineage-tree)) |
| `mcp` | Enabled servers, state and tool counts |
| `git` | Local branch, upstream ahead/behind and dirty count; no fetch |
| `session` | Title, model, creation time and number of loaded turns |
| `clock` | Local time, updated once per second while visible |
| `agent` | State (`Limited · resets 2:10 AM` while a usage limit pauses the turn), model, provider, effort, billing (`Subscription` unless the budget mode is `api-usage`) and permission mode |
| `activity` | Run time of this or the last turn, first-token time and output speed (exact from the last call's timing, `~` estimated while streaming) and the latest turn's tools with state, time and a done/failed count |
| `workspace` | Repo, branch, Clean/Modified/Conflicts, remote divergence, changed files with `+/-`, untracked count, turns loaded and session storage when `/status` already fetched a report that lists it |
| `tokens` | Input, output, cache read, cache hit and estimated cost (`(sub)` on a subscription); nothing is guessed when no call was priced |
| `tools` | `Enabled n / m` for the active agent (the local `agent.debug` listing, no provider call); names in two columns when `maxRows` is set |
| `alerts` | Connection trouble, the footer notice, context from 75%, quota windows from 70%, failed MCP servers and failed background jobs |
| `text` | User-written static markdown or ASCII |
| `sidechat` | The persistent `/btw` conversation |
| `extension:<id>` | The terminal slot `sidebar:<id>` |

Missing data says unavailable; empty lists say what is empty. Custom widgets belong in a terminal extension, not an invented built-in type. See [terminal extensions](extensions-tui.md).

## Presets and short terminals

Cards use open rules with a live value at the right, a one-cell state rail, compact facts and block sparklines. Colors use the current theme. Presets are editable specs and the native `sidebar` tool keeps working.

| Preset | Cards |
|---|---|
| `pulse` (default) | agent, context, pace, workspace, tokens, limits |
| `crew` | agents, lineage, queue, jobs, loops |
| `ledger` | tokens, savings, limits, models, rent (top 5) |
| `focus` | context, todos, files |
| `full` | Every data card, reachable by scrolling; user text, side chat and the galaxy remain explicit choices |
| `galaxy` | Interactive session graph only |

Presets need balanced/full; minimalist keeps them off. `panel` and `panel_models` declare the balanced tier and `panel_orbit` the full tier; none opens itself. The galaxy also checks the tier when added through the editor or model tool. `usage` remains a compatibility alias for quota windows; ledger and full show only `limits`. `models` groups tokens by provider/model (input, output including reasoning, cache read/write), including compaction calls in the loaded history. It shows the five largest groups plus an omitted total; storage is capped at 64 named groups and an exact overflow bucket. Pace stretches recent samples across the card width with a zero baseline and observed min/max labels; interpolated cells are visual guides, not extra observations.

## The slot also shows a file

Clicking a file path opens it in this same slot ([file viewer](file-viewer.md)). While a file is open the slot shows the file or the panel,
`Alt+{` switches (the first row says which), and closing the file puts the panel back with its preset and focus exactly as it was; with no
panel the slot hides again. A narrow terminal shows the file as a page instead.

## Galaxy

The session's code graph drawn as a galaxy: a disc with two spiral arms. The nodes are the files the session read or changed and the symbols its graph lookups returned (at most 96, the most recent first); the links join a symbol to its file and a caller to what it calls (at most 256). A file lies along the arms at a place fixed by its id and its symbols cluster around it, so nothing moves when nodes are added, sorted or filtered. When a tool uses a node or a link it fires: a spark runs along the link (0.6 s), the link and the node glow in the firing colour (1.5 s), stay warm in their own colour, and rest after six seconds; the galaxy moves only while something is that fresh, while a turn runs or while it is focused, and under reduced motion nothing fires. Built from what the tools declared, never from shell text or tool output. The panel asks the terminal for its cell size once, when the galaxy first opens, and sizes the rows by it, so the disc is round and not stretched; a terminal that does not answer is taken as a cell twice as tall as wide.

Choose `/panel galaxy`, then `Alt+}` to focus. `/panel orbit`, the old name, still works. Arrows/hjkl rotate immediately with decaying inertia; `+`/`-` zoom (65–135%), `f` cycles all/files/symbols, Tab selects the next visible node, and Enter opens a file in `/changes session` or a symbol in the [file viewer](file-viewer.md) at its line. Files without a retained diff show an explicit notice. One status row sits under the disc: at rest it counts `▣ 4 files · ◆ 9 symbols · 14 links` (shorter forms on a narrow card); focused it names the selected node and the keys (`renderToolCard · hjkl · tab · enter · f type · m code`), with `[symbol]` ahead while a type filter is on. `m` switches to the code of the project ([code mode](#code-mode)).

On a tall bar the galaxy takes the bar's width (centred, at most 80 cells) and three cards about the same graph fill the rest, dropping from the bottom as the bar gets shorter and never overflowing: `Focus` (the selected node with its type, a symbol's `file:line`, its uses, last activity and its connections, most recent first), `Recent` (the latest uses, one per tool and node, as `edit → panel.ts · 12s ago` or `graph_callers → cardRows · now`) and `Top` (the busiest nodes: label, a bar and the count). The bars start at one column and are as wide on every row, the counts are right-aligned in a column as wide as the widest, and the label is cut to what is left. A bar fills in eighths of a cell over a `░` track, so 4 and 5 hits differ and a bar reads with no colour; `MENDCODE_GLYPHS=ascii` draws `#` over `-` in the same columns. A `Recent` row keeps its age by cutting the label. `[` and `]` step through `Recent`, select the node it touched and light that link on the galaxy; Tab and Enter work as before and the selection shows in all three lists.

### Code mode

`m` in the focused panel switches the galaxy between the session and the code; the focused status row names where the key goes (`m code`, `m session`) and the header says `galaxy · code`. Code mode draws the project's most connected files (24, by the files they import, the files that import them and the calls that cross them) as file nodes, with the links among them: `a → b` when `a` imports `b` or calls into it. Files with no links fill the rest, the ones with the most symbols first, so a project whose files never import each other still has a galaxy. The card's value is `24 of 2790 files` and the status row at rest `▣ 24 files · 51 links +2766`. Rotation, zoom and Tab are the session's; Tab walks the files from the most connected. Enter opens the selected file in the [file viewer](file-viewer.md): a project file has no session diff to show. `f`, `[` and `]` do nothing here (one kind of node, no events). Under the galaxy, `Focus` shows the file, `41 imports · 3 imported by · 180 calls` and its most connected imports and importers (`imports · top 4 of 41`); `Top` ranks the files with the same bars as the session's. `Recent` has no code counterpart and gives its rows to the other two. A short sheet degrades as in session mode.

Pressing `m` is the explicit request the [code graph](code-graph.md) waits for. One other request comes by itself: a session that has touched no code yet (its galaxy would be empty) asks once, while the panel shows, where the graph is on and the folder is not skipped, and the canvas turns to the project's code only when that answer is ready to draw (a build or failure leaves the empty session view); its first touched file brings the session view back, and `m` makes the choice the user's for the rest of the session. While the first build runs the canvas is one muted line, `Building code graph`; the keyboard is not held. In the home folder or above it the line is `Code graph is off here · not a project` and nothing is indexed; with the graph switched off (`MENDCODE_CODEGRAPH=0`, or the `codegraph` feature off) it says so the same way. A failed build is `Code graph failed · <reason>`. Pressing `m` again from the session asks again, which refreshes changed files only; the graph already shown stays until the answer arrives. The mode lasts for the session on screen and is not saved: another session starts in session mode.

The data is one daemon command, `codegraph.overview {directory, limit?}` (1–30 files, default 24). Its reply is bounded: at most 30 files, 256 links, 5 imports and 5 importers per file, paths of at most 240 characters relative to the project (a longer path is left out, never cut) and a reason of at most 200. The terminal re-bounds the reply before drawing it and reads no graph file itself. A read-only remote peer may not send the command.

Node IDs select stable positions on a fixed Fibonacci lattice; insertion, reordering and filtering keep those positions. Perspective enlarges near nodes; far nodes are smaller and dim. Typed glyphs/colors, a faint braille latitude/longitude grid, and dim back edges make the volume legible. The nearest six labels that fit reserve node and label space; the focused node has priority and lights its edges. Tool→file edges use declared metadata and briefly light for 800 ms on live touches; session→file edges use observed touches, parent→child edges use the daemon's lineage, and MCP→tool edges use the declared `mcp__server__tool` names. Unknown sub-agent file relationships are never inferred. Fewer than three nodes show a quiet explanation of what will appear. The graph is capped at 96 nodes/256 edges, with an omitted count in the legend. No frame walks disk, spawns a process, reaches a service or asks a provider.

Rotation ticks at 10 fps only while focused or the session is busy, freezes otherwise, and stops off-page. Reduced motion and accessible mode disable automatic rotation, inertia and pulses; manual rotation remains immediate. `ascii-box`, `TERM=dumb` or `MENDCODE_GLYPHS=ascii` use ASCII marks/rules. Projection, collision and render tests cover determinism and the warmed maximum canvas (80×32), ≤4 ms per frame. Frame dumps use the actual TUI renderer with local fake session events, including three rotation angles and focused nodes, not live-provider evidence.

When the bar is shorter than its cards, `low` cards are hidden first (last first), then `normal` ones, but only while a `high` card is there to keep; `high` cards are never hidden. The first row says how many are hidden. With no priorities set nothing is hidden and the bar scrolls as before.

Rows are coloured per span (state, pressure, `✓`/`✗` per tool) and use the theme glyph set, so the plain and Nerd Font sets both draw. Alongside the cards, the footer segments `ttft`, `tps` and `spend` and the prompt status line (`/customize` > Prompt & footer > Status line) show the same facts compactly; see [customization](customize.md).

From 110 columns the right bar takes 48 cells; from 150 it takes 56, or the `sidebarWidth` setting (the bar then needs that width plus 62 columns for the chat). A bar that gave way for lack of room comes back only 8 columns above its threshold, so a terminal on the edge does not flicker. Widgets keep their order and overflow scrolls inside the bar. Below 110 the bar hides and the chat keeps the whole width; it comes back on its own when the terminal widens again. `panelNarrow: sheet` (`/customize` → Terminal → Panel when narrow) shows it instead as a full-width sheet above the prompt. The sheet reserves rows instead of covering the latest output, and shrinks around approvals, limit notices and the editor while keeping six transcript rows when space permits. An open side chat uses that sheet directly; on wide terminals it appears at its configured position, or before the widgets if the spec has no `sidechat` entry.

## Project backlog

Feature `backlog` (full tier; off in the others and with no tier; `/tier backlog on|off`). Your own list of pending things for a
project. It survives sessions and daemon restarts, and it is yours: the model can read it and cannot change it.

It is a different thing from its neighbours. The `todos` card is the model's working checklist for one session (its `todo`
tool). `/scratch` is a free note that never reaches a model. `/tasks` lists sub-agent sessions. Memories are facts the model is
given in its prompt. The backlog is what you still mean to do in this project.

```text
/backlog                                   the list, open items first
/backlog add [--file PATH] [--commit SHA] <text>
/backlog done <id> · reopen <id> · remove <id>
/backlog open <id>                         switch to the session it was added in and open its file
/backlog clear                             remove the finished items
```

An item has a number (`#3`; never given twice in a project), its text on one line (300 characters at most), open or done, the
time it was added, and where it was born: the session `/backlog add` was typed in, plus the file and the commit when you name
them. A project holds 200 items; past that an add is refused until finished ones are cleared or some are removed.

The panel card (`/panel widget backlog`; no preset includes it, so a saved `full` list keeps matching its preset):

```text
2 open · 1 done
□ #1 fix the flaky store test
□ #3 write the migration notes for the new settings key
✓ #2 rename the --dir flag
```

Empty it reads `Nothing pending · /backlog add <text>`; with the feature off, `Backlog is off · /tier backlog on`. Rows are cut
to the card's width with `…` and keep their number. The card is read again when a turn starts or ends and after every `/backlog`
change in this terminal.

Headless, for the directory the command runs in ([automation](automation.md)):

```bash
mendcode backlog list [--json]
mendcode backlog add [--file PATH] [--commit SHA] [--session ID] "text"
mendcode backlog done|reopen|remove <id>
mendcode backlog clear
```

```text
2 open · 1 done
#1 [ ] fix the flaky store test  (packages/store/src/store.ts · a1b2c3d · session ses_a1)
#3 [ ] write the migration notes for the new settings key
#2 [x] rename the --dir flag
```

`--json` prints `{ directory, items: [{ id, text, done, createdAt, doneAt?, origin?: { sessionId?, path?, commit? } }] }`; an
`add` also carries `added`, the new number.

**Where it is kept.** One JSON file per project in the daemon data directory, `backlogs/<sha256 of the canonical project
directory>.json`, written whole and renamed into place (mode 600), beside the scratchpads and keyed the same way. A file edited
by hand is read item by item; what does not fit the shape is left out.

**The model.** The list is in no prompt, no tool definition and no session event, so changing it never touches the provider's
[prompt cache](prompt-cache.md): a model reads it on request with `mendcode backlog list --json` from its shell, and the answer
arrives as an ordinary tool result at the end of the conversation. Every write (`backlog.change`) is refused to a session's own
shell, by the command and by the daemon ([permissions](permissions.md)). A model that leaves something undone says so in plain
text, `Left undone: <text>`, and you add it with `/backlog add`; nothing is added on its behalf. A read-only remote token does
not get the list either.
