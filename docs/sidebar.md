# Session panel

Use the right panel to follow your session's work, context and quota in cards. Run `/panel` to open the default `pulse` cards; run it again to close them. The panel starts hidden.

Its fixed header names the current preset and `/panel`, including in the narrow sheet (`panelNarrow: sheet`). `Ctrl+X, Shift+B` also toggles it (`panel.toggle`, rebindable in `/keymap`).

`/sidebar` only controls the left session list.

## Panel commands

- `/panel <preset>` switches to a curated list; `/panel next` cycles the available presets (skips galaxy outside full tier). `/panel off` hides the panel and retains its list.
- `/panel edit` opens the widget editor; its keys are below.
- `/panel reset` empties the effective spec and hides it. The next `/panel` starts with pulse again.
- `/panel width 32..80|auto` sets the bar's cells (`sidebarWidth`; automatic is 48, 56 from 150 columns).
- `/panel widget <id>` adds the built-in card of that name (`/panel widget atom`), or else a registered extension panel (8 rows maximum). Registration alone never opens the bar or renders a hidden panel; remove it with `/panel edit`. With the galaxy first in the bar, the cards after it are drawn under its own Focus, Recent and Top cards.
- `Alt+}` focuses the bar; PgUp/PgDn or arrows scroll it, Esc returns to the prompt. Mouse wheel over the bar also scrolls.
- The left session list keeps its existing `/sidebar auto|always|hidden` commands.

### Edit widgets

| Key | Does |
|---|---|
| `a` | Add |
| Arrows | Select a type or widget |
| Enter | Confirm |
| `d` | Remove |
| `J/K` | Move |
| `e` | Edit a widget's JSON |
| Esc | Return |
| Ctrl+U | Clear the JSON editor's draft |

Text and extension widgets open the JSON editor.

### One session, one screen

These commands affect the session where you type them, not every terminal:

- `/panel`: shown, hidden, a preset, `next`, an added card, the width.
- `/sidebar`, `/timestamps`, `/thinking`, `/scrollbar` and the keys bound to them.

Another terminal, or another session in the same terminal, keeps its own screen.

The session's choices are kept in `<dataDir>/tui/session-look.json` for the newest 200 sessions. It shows them again after `/restart` or in any terminal that opens it.

The defaults every terminal starts from are the config files: `/customize`, `tui/profile.json` and the panel's spec. `/panel edit` and `/panel reset` edit that spec, reaching every session that has no cards of its own.

When the spec changes (an agent built a panel), every terminal takes the new cards unless its session chose its own. The bar opens only in a terminal whose session has a turn running.

## Spec and model tool

Context distinguishes the auto-compaction budget from the model window. The footer's threshold percentage is labelled `compact`.

Quota cards show observation age. Readings older than 15 minutes show one muted row, `codex · quota stale · 11h ago`, and do not raise pressure alerts. Missing readings stay unavailable, never zero usage.

A card with nothing to show is one muted line (`No timed turns yet`, `Nothing queued`). Cards keep their height while a turn starts and ends; todos list every item, up to six.

### Preset identity and refusals

The header names the preset whenever the spec has the same cards in the same order; priorities and key order do not matter. `custom` means an edited list.

`/panel next` continues from the current preset. A custom or empty spec starts at `pulse`; it skips `galaxy` outside the full tier.

A refused preset changes nothing and says why in one line:

- Minimalist refuses every verb that would show the panel.
- Balanced refuses galaxy: `Galaxy needs full tier (/tier full) · try /panel crew`.

`/panel off` and `/panel reset` always work.

### Choose the effective spec

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

### Model tool

The native model tool `sidebar` uses zero-based indices.

| Action | Arguments |
|---|---|
| `get` | Read the spec |
| `set` | `widgets` |
| `add` | `widget` and optional `index` |
| `remove` | Remove a widget |
| `move` | `index` and `to` |
| `clear` | Clear the spec |

`scope` is `user` by default or `project`. Changes pass through ordinary write permissions; smart mode classifies this validated UI change as low risk. Sub-agents cannot change the bar.

The daemon preserves unrelated profile fields and notifies connected terminals after a change.

### Widget options and types

| Option | Accepted values |
|---|---|
| `title` | Every widget accepts it |
| `options.maxRows` | 1–100 |
| `options.priority` | `high`, `normal`, `low` |
| `options.text` | Only `text`; markdown. Use a fenced code block for ASCII to preserve its spacing. |
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

Presets need balanced/full; minimalist keeps them off. `panel` and `panel_models` declare the balanced tier and `panel_orbit` the full tier; none opens itself.

The galaxy also checks the tier when added through the editor or model tool. `usage` remains a compatibility alias for quota windows; ledger and full show only `limits`.

### Model and pace cards

`models` groups tokens by provider/model: input, output including reasoning, cache read/write, including compaction calls in the loaded history.

It shows the five largest groups plus an omitted total. Storage is capped at 64 named groups and an exact overflow bucket.

Pace stretches recent samples across the card width with a zero baseline and observed min/max labels. Interpolated cells are visual guides, not extra observations.

## The slot also shows a file

1. Click a file path to open it in this same slot ([file viewer](file-viewer.md)).
2. Press `Alt+{` to switch between the file and the panel. The first row says which is showing.
3. Close the file to restore the panel with its preset and focus exactly as it was. With no panel, the slot hides again.

A narrow terminal shows the file as a page instead.

## Galaxy

The galaxy draws the session's code graph as a disc with two spiral arms. It is built from what the tools declared, never from shell text or tool output.

1. Choose `/panel galaxy`. `/panel orbit`, the old name, still works.
2. Press `Alt+}` to focus.
3. Use the keys below to explore.

### Nodes and activity

Nodes are the files the session read or changed and the symbols its graph lookups returned: at most 96, the most recent first. Links join a symbol to its file and a caller to what it calls: at most 256.

A file lies along the arms at a place fixed by its id, with its symbols clustered around it. Nothing moves when nodes are added, sorted or filtered.

When a tool uses a node or a link, it fires:

1. A spark runs along the link (0.6 s).
2. The link and node glow in the firing colour (1.5 s).
3. They stay warm in their own colour, then rest after six seconds.

The galaxy moves only while something is that fresh, while a turn runs or while it is focused. Under reduced motion nothing fires.

The panel asks the terminal for its cell size once, when the galaxy first opens, and sizes the rows by it so the disc is round, not stretched. A terminal that does not answer is taken as a cell twice as tall as wide.

### Galaxy keys and status

| Key | Does |
|---|---|
| Arrows/hjkl | Rotate immediately with decaying inertia |
| `+`/`-` | Zoom (65–135%) |
| `f` | Cycle all/files/symbols |
| Tab | Select the next visible node |
| Enter | Open a file in `/changes session` or a symbol in the [file viewer](file-viewer.md) at its line |
| `m` | Switch to the code of the project ([code mode](#code-mode)) |

Files without a retained diff show an explicit notice.

One status row sits under the disc. At rest it counts `▣ 4 files · ◆ 9 symbols · 14 links`, with shorter forms on a narrow card.

Focused, it names the selected node and keys (`renderToolCard · hjkl · tab · enter · f type · m code`). It adds `[symbol]` ahead while a type filter is on.

### Focus, Recent and Top

On a tall bar the galaxy takes the bar's width, centred, at most 80 cells. Three cards about the same graph fill the rest, dropping from the bottom as the bar gets shorter and never overflowing.

| Card | Shows |
|---|---|
| `Focus` | Selected node with its type, a symbol's `file:line`, its uses, last activity and connections, most recent first |
| `Recent` | Latest uses, one per tool and node, as `edit → panel.ts · 12s ago` or `graph_callers → cardRows · now` |
| `Top` | Busiest nodes: label, a bar and the count |

Bars start at one column and are as wide on every row. Counts are right-aligned in a column as wide as the widest; the label is cut to what is left.

A bar fills in eighths of a cell over a `░` track, so 4 and 5 hits differ and it reads with no colour. `MENDCODE_GLYPHS=ascii` draws `#` over `-` in the same columns.

A `Recent` row keeps its age by cutting the label. `[` and `]` step through `Recent`, select the node it touched and light that link on the galaxy.

Tab and Enter work as before. The selection shows in all three lists.

### Code mode

Press `m` in the focused panel to switch between the session and the code. The focused status row names where the key goes (`m code`, `m session`); the header says `galaxy · code`.

Code mode draws the project's most connected files: 24, by the files they import, the files that import them and the calls that cross them. Links are `a → b` when `a` imports `b` or calls into it.

Files with no links fill the rest, the ones with the most symbols first. A project whose files never import each other still has a galaxy.

The card's value is `24 of 2790 files`; the status row at rest is `▣ 24 files · 51 links +2766`.

| Control | In code mode |
|---|---|
| Rotation, zoom and Tab | Same as the session; Tab walks files from the most connected |
| Enter | Opens the selected file in the [file viewer](file-viewer.md); a project file has no session diff |
| `f`, `[`, `]` | Do nothing: one kind of node, no events |

Under the galaxy, `Focus` shows the file, `41 imports · 3 imported by · 180 calls` and its most connected imports and importers (`imports · top 4 of 41`).

`Top` ranks files with the same bars as the session's. `Recent` has no code counterpart and gives its rows to the other two. A short sheet degrades as in session mode.

#### Load or refresh the graph

Pressing `m` is the explicit request the [code graph](code-graph.md) waits for.

A session that has touched no code yet, whose galaxy would be empty, also asks once while the panel shows, where the graph is on and the folder is not skipped.

The canvas turns to the project's code only when that answer is ready to draw. A build or failure leaves the empty session view.

Its first touched file brings the session view back. Pressing `m` makes the choice the user's for the rest of the session.

| State | Canvas |
|---|---|
| First build running | One muted line, `Building code graph`; the keyboard is not held |
| Home folder or above it | `Code graph is off here · not a project`; nothing is indexed |
| Graph switched off (`MENDCODE_CODEGRAPH=0`, or the `codegraph` feature off) | Says so the same way |
| Failed build | `Code graph failed · <reason>` |

Pressing `m` again from the session asks again and refreshes changed files only. The graph already shown stays until the answer arrives.

The mode lasts for the session on screen and is not saved. Another session starts in session mode.

#### Graph data limits

The data is one daemon command, `codegraph.overview {directory, limit?}` (1–30 files, default 24).

| Reply field | Limit |
|---|---|
| Files | At most 30 |
| Links | 256 |
| Imports and importers | 5 imports and 5 importers per file |
| Project-relative paths | At most 240 characters; a longer path is left out, never cut |
| Reason | At most 200 |

The terminal re-bounds the reply before drawing it and reads no graph file itself. A read-only remote peer may not send the command.

### Rendering and accessibility

Node IDs select stable positions on a fixed Fibonacci lattice. Insertion, reordering and filtering keep those positions.

Perspective enlarges near nodes; far nodes are smaller and dim. Typed glyphs/colors, a faint braille latitude/longitude grid, and dim back edges make the volume legible.

The nearest six labels that fit reserve node and label space. The focused node has priority and lights its edges.

| Edge | Source |
|---|---|
| Tool→file | Declared metadata; briefly lights for 800 ms on live touches |
| Session→file | Observed touches |
| Parent→child | Daemon's lineage |
| MCP→tool | Declared `mcp__server__tool` names |

Unknown sub-agent file relationships are never inferred. Fewer than three nodes show a quiet explanation of what will appear.

The graph is capped at 96 nodes/256 edges, with an omitted count in the legend. No frame walks disk, spawns a process, reaches a service or asks a provider.

Rotation ticks at 10 fps only while focused or the session is busy. It freezes otherwise and stops off-page.

Reduced motion and accessible mode disable automatic rotation, inertia and pulses; manual rotation remains immediate. `ascii-box`, `TERM=dumb` or `MENDCODE_GLYPHS=ascii` use ASCII marks/rules.

Projection, collision and render tests cover determinism and the warmed maximum canvas (80×32), ≤4 ms per frame.

Frame dumps use the actual TUI renderer with local fake session events, including three rotation angles and focused nodes. They are not live-provider evidence.

### Fit cards to the terminal

When the bar is shorter than its cards, `low` cards are hidden first (last first), then `normal` ones, but only while a `high` card is there to keep; `high` cards are never hidden. The first row says how many are hidden. With no priorities set nothing is hidden and the bar scrolls as before.

Rows are coloured per span (state, pressure, `✓`/`✗` per tool) and use the theme glyph set, so the plain and Nerd Font sets both draw. Alongside the cards, the footer segments `ttft`, `tps` and `spend` and the prompt status line (`/customize` > Prompt & footer > Status line) show the same facts compactly; see [customization](customize.md).

| Terminal width | Right bar |
|---|---|
| From 110 columns | 48 cells |
| From 150 columns | 56 cells |
| With `sidebarWidth` set | That width; needs that width plus 62 columns for the chat |
| Below 110 | Hides; chat keeps the whole width. Returns on its own when the terminal widens. |

A bar that gave way for lack of room comes back only 8 columns above its threshold, so a terminal on the edge does not flicker. Widgets keep their order; overflow scrolls inside the bar.

`panelNarrow: sheet` (`/customize` → Terminal → Panel when narrow) instead shows a full-width sheet above the prompt.

The sheet reserves rows instead of covering the latest output. It shrinks around approvals, limit notices and the editor while keeping six transcript rows when space permits.

An open side chat uses that sheet directly. On wide terminals it appears at its configured position, or before the widgets if the spec has no `sidechat` entry.

## Project backlog

The backlog is your own list of pending things for a project. It survives sessions and daemon restarts; the model can read it and cannot change it.

Feature `backlog` is full tier, off in the others and with no tier. Use `/tier backlog on|off` to change it.

| Feature | Purpose |
|---|---|
| Backlog | What you still mean to do in this project |
| `todos` card | Model's working checklist for one session, its `todo` tool |
| `/scratch` | Free note that never reaches a model |
| `/tasks` | Sub-agent sessions |
| Memories | Facts the model is given in its prompt |

### Add and manage items

```text
/backlog                                   the list, open items first
/backlog add [--file PATH] [--commit SHA] <text>
/backlog done <id> · reopen <id> · remove <id>
/backlog open <id>                         switch to the session it was added in and open its file
/backlog clear                             remove the finished items
```

| Item field | Meaning |
|---|---|
| Number | `#3`; never given twice in a project |
| Text | One line, 300 characters at most |
| State | Open or done |
| Time | When it was added |
| Origin | Session `/backlog add` was typed in, plus file and commit when you name them |

A project holds 200 items. Past that an add is refused until finished ones are cleared or some are removed.

### Panel card

The panel card (`/panel widget backlog`; no preset includes it, so a saved `full` list keeps matching its preset):

```text
2 open · 1 done
□ #1 fix the flaky store test
□ #3 write the migration notes for the new settings key
✓ #2 rename the --dir flag
```

Empty it reads `Nothing pending · /backlog add <text>`; with the feature off, `Backlog is off · /tier backlog on`.

Rows are cut to the card's width with `…` and keep their number. The card is read again when a turn starts or ends and after every `/backlog` change in this terminal.

### Headless commands

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

### Storage

One JSON file per project lives in the daemon data directory, `backlogs/<sha256 of the canonical project
directory>.json`, beside the scratchpads and keyed the same way. It is written whole and renamed into place, mode 600.

A file edited by hand is read item by item; what does not fit the shape is left out.

### Model access

The list is in no prompt, no tool definition and no session event. Changing it never touches the provider's [prompt cache](prompt-cache.md).

A model reads it on request with `mendcode backlog list --json` from its shell. The answer arrives as an ordinary tool result at the end of the conversation.

Every write (`backlog.change`) is refused to a session's own shell, by the command and by the daemon ([permissions](permissions.md)).

A model that leaves something undone says so in plain text, `Left undone: <text>`. You add it with `/backlog add`; nothing is added on its behalf.

A read-only remote token does not get the list either.
