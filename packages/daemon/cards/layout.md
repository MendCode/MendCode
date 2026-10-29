---
summary: terminal layout: session list, right panel, widths, breakpoints, density
docs: layout, sidebar, customize
aliases: panel, sidebar, panels, breakpoints, widths, dock
---
What sits where in the terminal and what moves it. Every row is a command or a profile key; none needs code.

Breakpoints, in columns: compact under 70, normal 70-109, wide 110-149, xl 150 and up. Under 70 the footer drops the quota bar and its reset. From 110 pages put detail beside the list and the session list can show.

Left session list (this project's sessions): /sidebar auto|always|hidden, or ctrl+x b to toggle. 38 columns, left by default (profile key sidebarSide, left or right). Auto shows it from 110 columns; never in the minimal view or on the home screen.

Right panel, hidden until asked: /panel opens it with the default cards and closes it again.
  /panel <preset>   pulse (default), crew, ledger, focus, full; galaxy needs the full tier
  galaxy: ctrl+\ focuses it (a click does not, so its letter keys never eat typing); hjkl rotate, tab selects, enter opens, m switches session and code (the project's most connected files; that key builds the code graph, {{program}} docs codegraph)
  /panel next | off | reset | edit   cycle presets, hide, empty the list, open the card editor
  /panel width 32..80|auto   cells (auto is 48, 56 from 150 columns); profile key sidebarWidth, 0 is auto
These commands (and /sidebar, /timestamps, /thinking, /scrollbar) change only the session they are typed in, kept in <data dir>/tui/session-look.json so it comes back after a restart; other terminals and sessions keep their screen. Defaults for every terminal: /customize and tui/profile.json; /panel edit and reset edit the shared card list.
Rows that go: showTopbar false (above the session), panelHeader false (the panel's first row), sidebarHeader false (the list's title); set them yourself with customize_ui. showProject, showSessionTitle, showContext only empty parts of the top row. Every part and its key: {{program}} docs screen-parts.
Under 110 columns it is a full-width sheet above the prompt. Open, it hides the left list below 150 columns.
Its cards are the list sidebarWidgets in <data dir>/tui/profile.json; a project's .mendcode/tui/profile.json overrides it, even when empty. The model tool sidebar (get, set, add, remove, move, clear) edits the same list. Card types include context, tokens, limits (provider quota windows with the age of each reading), todos, files, changes, git, jobs, agents, text and extension:<id>. A card with no data says so.

Density: profile key density, compact | comfortable | spacious, also in /customize.
Footer: rows are settings, up to 12 and a quarter of the height (footerRows, /footer preset, footerIcons); scripts and slots add rows to them ({{program}} docs footer).
Dock: ctrl+t opens todos, questions, sub-agents, jobs, scratchpad and info above the working row.

Change keys: customize_ui {"action":"settings","values":{"sidebar":"hidden","sidebarWidth":56,"density":"compact"}}; find one with customize_ui {"action":"keys","query":"<words>"}. Look and colours: {{program}} docs customize.
