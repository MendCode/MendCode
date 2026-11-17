# Session panel

Use the right panel to follow your session's work, context and quota in cards. Run `/panel` to open the default `pulse` cards; run it again to close them. The panel starts hidden.

Its fixed header names the current preset and `/panel`, including in the narrow sheet (`panelNarrow: sheet`). `Ctrl+X, Shift+B` also toggles it (`panel.toggle`, rebindable in `/keymap`).

`/sidebar` only controls the left session list.

## The left list: every project, and bots

`sidebarProjects` (`/customize` › Top & side › Sidebar projects) picks whose sessions the left list shows. The default, `auto`, shows every project while experimental bots are on and the sessions of the folder you opened otherwise; `folder` always shows the opened folder and `all` always shows every project. These rows stay in `/customize` even when `sidebar` is `hidden`, because the toggle key still shows the list. Every project means projects, not every folder a session ever ran in. A folder is a project when it is the root of a git work tree (it holds `.git`, a folder or the file of a linked worktree) or it is the folder you opened. The home folder, any folder with a hidden part in its path (`.ssh`, `.config/...`) and anything under a temp folder (`/tmp`, `/var/folders`, the system temp dir) are never projects; their sessions stay in `/sessions`. Each folder is asked once per run (one `stat`, off the draw path), so a folder shows up a moment after the list first draws. A linked worktree is listed under its main repo's name, with its sessions among the repo's. A folder with a session used in the last 24 hours is also a project, git root or not (home, hidden and temp folders still never are), and it shows past the cap as a busy project does, so a new folder you used stays after you switch to a session elsewhere.

Whose projects: `sidebarProjectsFrom` (`/customize` › Top & side › Projects from) is `you` by default. A project then lists only when a session in it has a message you typed in the terminal or the web UI (`lastHumanAt`, [sessions.md](sessions.md)), or has no recorded origin (made before origins were kept, so nothing is hidden the day this lands), or when a session there works or waits now, or it is the open folder. A folder used today only by tools (a bridged Claude Code session, `mendcode session send` from a script, the PR reviewer, loops, workflows) waits behind `+ N more projects` like any other cut project, in the same ranking. `all` lists every project as before. The list follows a `session.list` refresh, so a project you just typed in shows within a minute unless it is open or working.

To hide a project by hand, put the list in focus, pick its group row (the header then reads `↵ fold  x hide  → prompt`) and press `x`. The folder is saved in `sidebarHiddenProjects` (the canonical folder, at most 200, the oldest dropping out) and a notice says `hid <name> · /customize to bring it back`. A hidden project is never listed, not even behind `+ N more projects`, unless it is the open folder (`x` on that one says so and does nothing). `/customize` › Top & side › Hidden projects lists them: `←` `→` pick one, Enter brings it back.

The list is ranked by the latest message activity of each project's sessions (then the number of sessions in the last 14 days), newest first. Opening or selecting a chat, subscribing to it, reading it or typing a draft in it never moves a group: only a session that gets new messages does, and a project already ranked keeps its place until its latest activity moves by a minute or more, so a streaming turn does not shuffle the list. The opened project and the projects with a session that works or waits always show, wherever they rank. By default (`sidebarProjectCount` 0, `/customize` › Top & side › Projects shown, auto) the list fills the sidebar's height, at least six projects; a number from 1 to 30 caps it instead (the opened and busy projects count toward it). The rest sit behind one row, `+ N more projects`; Enter or a click on it reveals the next eight in the same ranking (the cursor moves to the first one that appeared and the row keeps counting the rest), and once every project shows the row reads `show fewer` and folds them away again. Every shown group starts open; Space or a click on its arrow folds or opens it (kept in memory only), and a folded group shows how many of its sessions work or wait. Enter or a click on the project's name starts a new chat in that folder (a blank chat is reused) and the folder becomes this terminal's.

The list follows other terminals live and cheaply. Every `session.activity` push is applied in place to the list of the other folders and to the bots' states, with no request. Only a session no list holds (a possible new chat of a bot) asks for the bot list again, once per second at most for any number of pushes, after a random 0 to 1.5 s so many terminals do not ask together. The full lists (`session.list`, `bot.list`) are asked on the first show, on the first show after pushes came while the list was hidden, after a reconnect, and every 60 s (jittered) only while the list shows; a hidden list does nothing but note that pushes came and has no timer.

An open project shows its latest `sidebarPreviewCount` sessions if it is the opened one, and at most three if it is another (`/customize` › Top & side › Sessions per project, 1 to 50, default 5), in the usual order: pinned first, then the latest activity. The open session and any session that works or waits stay in the list even past that count, without repeating. Only sessions active in the last `sidebarRecentDays` days list at all (`/customize` › Top & side › Recent days, 0 to 365, default 7, 0 lists every age; a profile that never set it gets 7); the open, working, waiting and pinned sessions show at any age. A project with nothing recent still lists as a group: its header and a `+ N older` row, so it stays where its activity ranks it. Under the preview a `+ N more` row counts the hidden sessions (`+ N older` when only old ones are hidden); Enter or a click on it reveals the next eight sessions (the cursor lands on the first new one), and once the whole list shows, the `show less` row that replaces it folds it back. Which projects are opened this way is kept in memory only, so a restart shows the previews again. A chat nobody used (no title, no draft, nothing queued, only its first events) is left out of the list and the count unless it is the open one or one this terminal opened in the last day and that has taken part since; `/sessions` still lists it. The classic one-folder list (flag off, `sidebarProjects: folder`) is unchanged and has no preview.

With `/experimental bots on` the list can also hold the bots. A bot is one row: its icon (a glyph per shape in its theme color, `()` `[]` `<>` `/\` `{}` in ASCII), its name, where it comes from, and its state as a symbol and a word (`● working`, `◌ idle`, `… waiting`, `! problem`). The icon is followed by exactly one space, a picture included (two cells and the space), so the names line up. A bot's chats are not in the project lists or their counts: under each bot that has chats a `▸ chats` row (Space or a click on its arrow folds and opens it, Enter or a click on its name starts a chat with the bot; closed by default, open while the open chat is one of them and when you start a chat with the bot) lists its newest chats from every folder, three and a `+ N more` row (`show less` once opened). `/sessions` still lists everything. Enter or a click on a bot starts a new chat with it, right away, in the folder MendCode is opened in (the open session's folder). `o` on the bot row opens its page, which is drawn like the other list pages (the shared header, a summary line, panels, the wheel, Esc back): identity, model, permission, its chats by folder, newest first, and `n` new chat in a folder, `e` edit, `m` memory, `d` delete. From a chat, `/bot open [name]` opens the page of that bot (no name: the open chat's bot). These keys choose the layout (`/customize` › Top & side), and none of them does anything with the flag off:

| Key | Values |
|---|---|
| `sidebarLayout` | `bots-first` (the default; a profile that never chose a layout gets it, a saved choice is kept), `projects-first`, `icons-only` (a narrow column of icons; the picked row's name shows under it) and `scratch` (no section until you add them) |
| `sidebarSections` | the sections shown and their order, a comma list of `projects`, `bots`, `sessions` (the opened folder's sessions with no bot, shown when `projects` is not); `none` hides all; empty takes the layout's own. Choosing a layout clears it |

### Row marks

A session row starts with a symbol: a spinner while it works, `?` while it waits for you to approve a tool, `◎` while it asks you a question, `◈` when a plan waits for your review, `✗` after a failed turn, `●` for a reply you have not read, `…` when messages are queued. The header counts every kind that waits for you. A daemon that does not say what it waits on shows `?`.

On the right, a working row shows how long its turn has run (`42s`, `2m14s`, `12m`, `1h05m`), counting on the same tick that moves its spinner and only while it works; every other row shows its age. A linked PR shows its number and state, `#812 open`, `#812 merged` or `#812 closed`, in the state's colour. A long title gives way first, and when it would keep under ten cells the number goes and the state stays.

The selected row's detail line adds the PR's branch (or, for the open session, the folder's branch) and, in a linked worktree, `worktree <name>`. Other rows never show them.

A session whose PR is merged or closed settles by itself, unless it is the open session, pinned, working, waiting or has queued messages, and unless it had activity after the PR was last checked; a new message brings it back. In the classic one-folder list the Settled row folds these away. Opened, it lists 10, and its `+ N more` row (Enter or a click) adds 25 each time; the count is kept in memory only.

### Keyboard

With the prompt empty, `←` focuses the list (`→` when the list is on the right); the header then reads `→ prompt`. In the list `↑` and `↓` move over every row: group rows, session rows, `+ N more` and `show less` rows, the `+ N more projects` row and bot rows, and the selected row is marked with `›` and a fill. `Enter` opens a session, starts a new chat in a project (its header) or with a bot (its row or its `chats` row), reveals a page on a `more` row, and folds an origin's bots row; `Space` folds or opens any header (a project, a bot's `chats`, a bot, an origin's bots, Settled). On a header, `←` folds it when it is open and `→` opens it when it is folded (swapped when the list is on the right); otherwise `→` or `Esc` returns to the prompt as before. A click on a header's ▸/▾ arrow folds it and a click on its name does what Enter does. The header reads `↵ new  spc fold  x hide` on a project, `↵ chat spc fold → prompt` on a `chats` row and `↵ chat  o page  → prompt` on a bot (`o` opens its page). A bot's chat wears the bot's colour on the prompt's rules and lead glyph, and the footer row leads with the bot's glyph and name. `↑` on the first row wraps to the last row and `↓` on the last wraps to the first. In the sections list (all projects, or bots on) `Tab` jumps to the first row of the next section (Projects, Bots, Sessions), `Shift+Tab` to the first row of the current section and then of the previous ones, both wrapping, and `b` jumps to the first bot; the header then reads `tab section  → prompt`. `Tab` does nothing to the list while the prompt has focus. The mouse works as before. A terminal in application-cursor mode (arrows sent as `ESC O A..D`) is read the same.

`←` and `→` are also the keys between sub-agent chats. When the open session has a sub-agent (its own, or a sibling's) that is still working or waiting, the plain arrows stay sub-agent navigation and `Alt+←` (`Alt+→` for a list on the right) focuses the list instead; otherwise `←` focuses the list. A finished sub-agent does not hold the arrows. On a fresh session the home screen's list does not take `↓` while the sidebar has focus.

### Wheel

The mouse wheel or a trackpad over the list's columns moves the list's window by `wheelLines` rows (`/customize` › Input & keys › Wheel lines), in the projects and bots list and in the classic list, on either side; the chat does not move. The picked row stays where it is and may leave the view; the next arrow key, or opening another session, brings the window back to the picked row. A list that fits needs no scrolling and ignores the wheel. While the search is open the wheel does nothing over the list. Over the chat the wheel scrolls the chat as before.

A sideways swipe or wheel does nothing on the chat page; the list opens and closes with `/sidebar`.

### Search

`/` in the focused list, or `ctrl+x <` from the chat (`sidebar.search` in `keybindings.json`), opens a search field at the top of the list. It finds sessions by title, projects by folder name or path, and bots by name, and draws them in place of the list:

```text
 / side▌                     4 │
   ↑↓ move  ↵ open  esc back   │
                               │
 › · Fix the sidebar search 2m │
   ▸ sidebar-lane      project │
   ⬢ sidekick           ◌ idle │
   · Notes on side effects  3d │

   app · 2m                    │
```

- Typing filters at once. A lowercase query ignores case; a query with a capital letter matches case exactly.
- The order: the start of the name, then the start of a word in it (a camelCase hump counts), then the letters together anywhere, then the letters in order with gaps (`fsb` finds `Fix the sidebar`). A project's path matches below its name. The most recent activity breaks ties. The matched letters are underlined in the accent colour.
- `↑` `↓` move, `Enter` or a click opens the match: a session opens, a project starts a new chat in its folder, a bot starts a chat with it as Enter on its row does. The last row says where the picked match is.
- `Esc` (or Backspace on an empty field) closes the search and gives back the list as it was, with the same row picked; opened from the chat, the prompt gets the keyboard back. `ctrl+u` clears the field, `ctrl+w` deletes a word.
- The search runs over what the terminal already holds, with no request per key. When the typing stops for a moment, one `session.list` with `find` (50 at most) adds the sessions it does not hold, whose title or folder holds the text as typed. The list shows the best 64 matches and counts the rest.
- Nothing of it loads until the first `/`; closed, it keeps no timer. It needs the list on screen: where the list does not show (a narrow terminal, the home screen, `/sidebar hidden`), `ctrl+x <` says so.

With bots on and a terminal from 70 to 109 columns, the list is the icons column; below 70 it does not show. With the flag off and `sidebarProjects` on `auto` or `folder` the list is the one described above and nothing else loads.

## Panel commands

- `/panel <preset>` switches to a curated list; `/panel next` cycles the available presets (skips galaxy outside full tier). `/panel off` hides the panel and retains its list. When your saved panel is a preset with your own changes (see [Your version of a preset](#your-version-of-a-preset)), `/panel <preset>` shows yours; `/panel <preset> default` shows the built-in one.
- `/panel profile` drops this session's choice and shows your saved panel again.
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

The session's choices are kept in `<dataDir>/tui/session-look.json` for the newest 200 sessions. It shows them again after `/restart` or in any terminal that opens it. A preset chosen in a session is kept as its name only (`"panelPreset": "galaxy"`, or `"galaxy:default"` for the built-in one), never as a copy of its cards, so it always shows the current version of your panel. A session that an older build left holding a built-in preset's cards is read as that preset's name.

The defaults every terminal starts from are the config files: `/customize`, `tui/profile.json` and the panel's spec. `/panel edit` and `/panel reset` edit that spec, reaching every session that has no cards of its own.

When the spec changes (an agent built a panel), every terminal takes the new cards unless its session chose its own. The bar opens only in a terminal whose session has a turn running.

## Spec and model tool

Context distinguishes the auto-compaction budget from the model window. The footer's threshold percentage is labelled `compact`.

Quota cards show observation age. Readings older than 15 minutes show one muted row, `codex · quota stale · 11h ago`, and do not raise pressure alerts. Missing readings stay unavailable, never zero usage.

A card with nothing to show is one muted line (`No timed turns yet`, `Nothing queued`). Cards keep their height while a turn starts and ends; todos list every item, up to six.

### Your version of a preset

A saved panel that starts with a preset's cards is your version of that preset: the galaxy followed by your own cards is your galaxy. Choosing that preset in any session shows your version, and editing the saved panel changes it there too.

The `/panel` menu says which one you get: `Show galaxy · custom (profile)` for yours, `Show pulse · default` for a built-in one. Typing a space after a preset offers `default`, the built-in list. The line after a choice names it as well (`panel: galaxy (4 cards) · custom (profile) · this session`).

If a session shows the built-in one where you expected yours, run `/panel galaxy` or `/panel profile` in it. If the saved panel itself lost your cards, `/customize restore` brings back an earlier copy of the profile.

### Preset identity and refusals

The header names the preset whenever the spec has the same cards in the same order; priorities and key order do not matter. `custom` means an edited list.

`/panel next` continues from the current preset, or from the preset your version is built on. Any other custom or empty spec starts at `pulse`; it skips `galaxy` outside the full tier.

A refused preset changes nothing and says why in one line:

- Minimalist refuses every verb that would show the panel.
- Balanced refuses galaxy: `Galaxy needs full tier (/tier full) · try /panel crew`.

`/panel off` and `/panel reset` always work.

### Choose the effective spec

`sidebarWidgets` is an ordered list in `<dataDir>/tui/profile.json`. `rightSidebar` is the default visibility; a session's own goes in `session-look.json`.
`panelStart` (`/customize` → Sidebar & panel → Panel at start) decides how a new terminal and a new chat open: `remember` (the default) uses `rightSidebar` as saved, `shown` always opens the panel, `hidden` never does. `/panel` still toggles it in the chat, and a chat keeps its own choice.
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
