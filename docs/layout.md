# Terminal layout: breakpoints, sidebar, dock, long transcripts

How `apps/cli` adapts to the terminal's size. Spec: `specs/master-plan.md` sections 52 (responsive TUI), 54 and 55 (sidebar,
project panel); v1 reference: its session sidebar and the widgets dock (`ctrl+t`).

## Inline images

`/customize` → `images`: left/right or enter cycles `auto` (default), `kitty`, `iterm2`, `sixel`, `off`.
The terminal-local `images` field is saved in `<dataDir>/tui/profile.json`; changes apply immediately.

| Terminal / evidence in `auto` | Backend |
|---|---|
| Kitty (`KITTY_WINDOW_ID`, `TERM` containing `kitty`, or `TERM_PROGRAM=kitty`), Ghostty | Kitty graphics |
| iTerm2 (`TERM_PROGRAM=iTerm.app`), WezTerm | iTerm2 inline PNG |
| An already available primary device-attributes reply with attribute `4` | Sixel |
| Unknown terminal, tmux/screen/tuios, SSH | Half-block pet fallback |

Sixel requires an explicit selection in the CLI unless a host supplies an existing
DA1 reply through `imageAnswers`. Forced protocols bypass environment detection, SSH and color-depth guards;
tmux, screen and tuios (`TERM_PROGRAM=TUIOS` or `TUIOS_ENV`) stay disabled for every protocol, even an explicit profile mode. Only an explicit mode shows `images disabled in tmux` (or `screen`, `tuios`) once; on `auto` the fallback is silent: a multiplexer did not draw the picture, so a forced mode left a blank band of reserved rows under a message with an image.
`MENDCODE_PET_IMAGES=0` vetoes auto images; `=1` forces auto to Kitty (or keeps the profile's explicit mode), even inside tmux, screen, tuios or over SSH. Otherwise the profile's explicit mode wins, except inside a multiplexer.
Kitty keeps its existing truecolor guard in auto mode; iTerm2 and sixel do not require truecolor text support.

Kitty pets remain animated. iTerm2 and sixel use the first frame of each state (idle, working, waiting, review, etc.)
to avoid repeated full-image transfers. Unchanged images are not resent; text writes under an inline image redraw it.
Moving, resizing, replacing or removing an inline image overwrites its old rows and restores their text before placement.
Encoded payloads are cached by content and cell size (up to 64 unused/active cached frames, like Kitty).

Sixel uses a fixed RGB332 palette (up to 256 colors); alpha below 128 is transparent. All backends share
integer nearest-neighbour sizing and transparent letterboxing. The native atlas cell is retained across states,
so a greeting cannot change the source canvas dimensions. If 1× fits, only integer enlargement is allowed;
otherwise the smallest common integer divisor that fits both dimensions is used (no color averaging). A frame
with no exact fit has no raster preview. Half blocks use one pixel per column and two per row, with exact RGB colors.
Chat reserves 16×8 graphics cells, or 24×13 half-block cells; it hides a pet when that box cannot fit above the prompt. The pet otherwise stays put while the transcript scrolls: a row that reaches its cells ends in an ellipsis before it, and the jump pill stops to its left.

Before the first graphic placement, a real TTY requests CSI 16/14/18 t. A direct cell report wins over window
pixels divided by text-area cells; replies are consumed before key parsing, including split replies. After 150 ms,
a terminal without a valid reply uses the documented 8×16 default. Geometry is frozen for the graphics session,
so a delayed reply cannot produce an intermediate resize. Host-provided `imageAnswers.cellPixels` (including
ioctl-derived values) or `MENDCODE_CELL_PIXELS=10x20` bypass queries. Non-TTY harnesses use the default immediately.
Kitty uploads are transmit-only and the first placement already names the final cell box; iTerm2 receives a
pre-sized PNG, and sixel the same raster. Formats: [Kitty graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/),
[iTerm2 OSC 1337](https://iterm2.com/documentation-images.html) and
[xterm sixel / DA1](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Sixel-Graphics).

Currently only pets produce graphical placements. Generated-image cards still show the image count and saved path;
pasted images remain attachment labels. `off` disables graphics and keeps the half-block pet fallback.

## Images in the transcript

With a graphics protocol active (above), the images a session holds are drawn in the transcript: pasted or attached images in your
messages, and the images tools return (a read image, a screenshot, a generated image). The card keeps its `■ N images` line; the picture
takes rows under it, at most 72 columns by 16 rows, keeping its shape and never enlarged past its pixels. A generated image takes
the box its wait canvas held instead ([web and image tools](tools-web.md#while-an-image-is-generated)). `transcriptImages`
(`/customize` > Terminal > Transcript images, default on) turns it off; `images off` and a remote client never draw them either.

The client asks the daemon for the images of the blocks on screen with `attachment.read` (a session, a hash and an offset; chunks of
96 KB; only blobs that session's events reference, never a path; local clients only, not in the read-only set). Up to 8 MB per image is
decoded here, PNG, WebP, JPEG (baseline) and GIF (first frame), and kept at most 1280 px on its longest side (24 images are kept). A
progressive JPEG, an oversized or broken file, or a failed read leaves the text card as it was and takes no rows. A picture partly scrolled
out of view keeps the rows of it that are still on screen, cut at the edge; the rows under the pet or a label at the screen's edge are cut the same way.
No picture is drawn while a palette, card or toast covers the chat. Inline mode (`--no-alt-screen`) keeps the text cards.

## Links

URLs and file paths in the transcript are OSC 8 hyperlinks (`hyperlinks`, default on; `MENDCODE_HYPERLINKS=0` or `TERM=dumb|linux` never send them),
so ctrl or cmd click opens them in terminals that support it (a terminal that does not just shows the text). A URL in message markdown
(`[label](url)`, `<url>`, a bare address) links to `http`/`https` only; a URL cut across rows by the layout points at the whole address on
both rows. A path like `src/config/load.ts:42:7`, `./README.md`, `~/notes/todo.md` or `/etc/hosts` is linked by how it looks, without
touching the disk, so an editor opens it or reports the file missing; a word without a slash, a date or `and/or` is not a path. The link
target comes from `fileOpener` (`/customize` > Terminal > File opener): `file` (default, the system's own handler, no line number),
`vscode`, `vscode-insiders`, `cursor`, `windsurf`, `zed` (`scheme://file/abs/path:line:col`), `idea` (`idea://open?file=…&line=…`) or `none`
(addresses only). Targets are printable ASCII, at most 2048 characters, with a fixed list of schemes; message text never carries escape
sequences, only the span's own link is written. While MendCode reads the mouse the terminal never sees a click, so a plain click on a web
address opens it in the default browser itself (`url.open`: http/https only, local clients only; macOS `open`, Windows `explorer.exe`,
Linux `xdg-open`); a drag over it still selects. With the [file viewer](file-viewer.md)
(`pathClick`, on from balanced) a plain click on a path opens the file in MendCode's own right slot instead; `pathClick: editor` keeps this
behaviour, and ctrl or cmd click always reaches the terminal's link.

## Breakpoints

One module, `apps/cli/src/ui/breakpoints.ts`. Pages ask `isWide(width)` (or `isCompact`, `isXl`) instead of carrying a
`WIDE_WIDTH` of their own. Terminal extensions get the same class as `ctx.breakpoint` (and the terminal's size as `ctx.screen`) in
every slot, page and modal renderer ([extensions](extensions-tui.md#slots)).

| Class | Columns | Used for |
|---|---|---|
| compact | under 70 | the footer drops the quota bar and its reset |
| normal | 70 to 109 | pages stack their detail under the list |
| wide | 110 to 149 | pages put detail beside the list; chat shows left project sessions (`auto`) |
| xl | 150 and up | larger grids; chat keeps the left session list |

Pages on the wide breakpoint: sessions, setup, changes, loops, workflows, memory, packages, MCP servers, tools and help.
They used to switch at 120 columns (workflows at 120 columns of inner width, that is 122 of terminal width); the spec says
110, so a terminal of 110 to 119 columns now gets the side-by-side layout. Three places keep a threshold of their own that
is not a spec breakpoint: the status and memory-graph pages switch at 100, and the pet needs 80
(`PET_MIN_WIDTH`, kept in the same module).

## Panel dashboards

`view/deck.ts` owns `boxPanel` and the weighted `panelGrid`: accent titles on single-line borders,
no extra vertical padding, independently windowed bodies and exact cell widths. Below 70 terminal
columns, grid panels stack as title + rule; medium grids reflow to two columns. Right-sidebar widgets
use the same dense border-title panels, without blank spacer rows between widgets.

Usage uses the dashboard described in [usage.md](usage.md). Context, storage, agents, status, extensions,
providers, connect, secrets, timeline, model and settings use panel grids on wide terminals. Compact
flows and page actions remain the same. Existing master/detail pages and the full-screen diagram
canvas retain their established layouts.

## Sidebar

A session list (left by default, right selectable in `/customize`), 38 columns plus a one-column gap, from the top row to the bottom of chat. A 160-column terminal
gives chat 121 columns. The declarative [right sidebar](sidebar.md) is empty and hidden by default. It takes 48 cells from 110 columns and 56 from 150; when open, the left list is hidden below 150 so medium terminals keep one side column. Below 110 it hides (or, with `panelNarrow: sheet`, becomes a bottom sheet above the prompt). `/btw` always uses that sheet.

| Mode | Shows when |
|---|---|
| `auto` (default) | width of 110 or more (chat keeps at least 71 columns) |
| `always` (legacy) | same as `auto` |
| `hidden` | never |

The minimal view and a session with nothing in it (the home screen) never show it. The mode is a TUI profile setting
(`sidebar` in `<dataDir>/tui/profile.json`, like the rest of `/customize`): `/sidebar auto|always|hidden` sets it,
`/sidebar` or `ctrl+x b` (bindable as `sidebar.toggle`) toggles it: a visible sidebar is hidden, a hidden one comes back as
`auto` (under 110 columns it says there is no room and changes nothing). Existing `auto` profiles now mean left sessions
on wide terminals, with no file rewrite.

Sessions are filtered to the current project, newest first: title, relative update time, `● running`, `? waiting` or a
queue marker. `◆` marks the current session. From an empty prompt, Left focuses a left list (Right focuses a right list); Up/Down select, Enter switches,
the arrow toward the prompt or Esc returns to it. A click on a session switches immediately. Long lists keep the selection visible.
Live `session.activity` updates the list even while chat is open. Prompts, popups, pets and toasts stay in the chat column.

## Chat chrome

Messages default to a quiet `›` user row on a subtle tint and a `•` assistant marker. Role icons, labels, leads and
user tint preview in `/customize`; `classic` restores the previous headers. Completion metadata is off by default;
`compact` or `full` shows it once per turn. One blank row separates turns, including those containing tools.
Balanced and full share one footer outside the prompt: agent, model and provider on the left; live loops/workflows
and running jobs on the right. Quota and today are opt-in in `/customize`. Script status and extension `footer.*` slots
share that row. `footerRows` (or `/footer preset rows`) make it any number of rows, up to 12 and a quarter of the terminal
height ([customize.md](customize.md#footer-rows)). Explicit script `rows` expand it up to four rows, reserving height outside every prompt preset;
left/right rows align independently and clip by cell width. Legacy output stays one row. See [customize.md](customize.md).
Legacy footer context is ignored: Context bar (`top|off`, `bar|percent|both`) is the only context control.

Pending comments on an answer ([editor.md](editor.md#comments-on-an-answer)) add rows that sit with the prompt: the reply bar and the chip row (or the list) directly above the prompt, or the chips under it (`commentChips: below`); a comment being typed tints the prompt's top rule and adds one row under it. The margin marks (`1┃`) are drawn in the transcript's first two columns of the rows of a commented passage. With no comments none of this takes a row or costs a frame. The transcript's rows are never changed, only drawn over: a mouse selection still reads the text as laid out.

Hover over the topbar's context bar to replace it in place with `used / limit`, as in v1. Clicking keeps that inline
detail; `/context` opens the full page. `/context` also shows the context rent: every tool schema the request carries (chars / 4, grouped
by owner: built-in, `mcp:<server>`, `extension:<name>`) against the calls still in the history, with unused owners flagged and a
hint when a big one was never called. A tool a tier turned off is not offered, so it costs nothing and is not listed.
The `forecast` footer segment (`~9 turns to compact`, from the context at the end of the last turns; shown after three turns of
growth and hidden when the context is flat, was just compacted or is over 99 turns away) follows the tier: on in balanced and
full, off in minimalist and with no tier; `/footer +forecast` places it anywhere and `/tier forecast off` removes it.
The terminal enables mouse motion reports unless `MENDCODE_MOUSE=0`. Tab on any slash suggestion only
completes its text, with a trailing space for commands accepting arguments. Enter runs the command. Command notices
clear on navigation; `/diagram` with no diagram uses a transient toast.

`bun scripts/render-frames.ts <directory> [100x30 180x50 ...]` writes plain-text home, chat, chat-wide and chat-btw-tab
frames through the fake app harness, using temporary data directories and no provider. UI-1 evidence is in
`.agents/runs/frames/ui-1/`. Add `--ui-3` to render pet/mascot frames at the same sizes and write Greenie RGBA PNG probes,
`pixels.json` sizing metadata and `fonts.txt`. It reads Greenie from `UI3_PET_ROOT` or `~/.codex/pets`, copying sources
to a temporary directory; caches and profiles never touch real data. Standalone probes:
`bun scripts/pet-probes.ts <output-dir> <greenie-dir>`.

### Cache countdown

`warm` (feature `cache_countdown`, full tier, off until you place it: `/footer +warm` or a `footerRows` row) shows how long the
prompt cache of the session's last call has left: `cache 12m` (amber under two minutes), `· packs in 11m` when the
[compaction while idle](compaction.md) is scheduled first, and `cache cold · next sends 161K` once it expired. The lifetime
is the one the idle compaction uses (`cacheLifetimeMinutes`, else the documented one, the call's own `1h` included); for
ChatGPT nobody states it, so it reads `~12m`. A provider with no stated lifetime, a context under 20K tokens, a running turn
and a session another engine packs (Claude Code, Codex, ACP) show nothing. It asks the daemon once per call, after the turn
(`context.recent`), and redraws every 15 seconds only while it shows. Outside full it draws nothing unless
`/tier cache_countdown on`. Where the expiry costs: the Waste tab of `/usage` ([usage](usage.md#waste)).

## The dock (`ctrl+t`)

Ten bordered rows above the working row, with padding inside and a blank row above the prompt. Panels: Todos,
Questions, Subagents, Jobs, Scratchpad and Info. Questions (the session's pending approvals and questions, `!` and `?`),
Subagents and Jobs show only while there is something in them; an empty Scratchpad can still be focused. When the width
cannot hold them an empty Todos panel gives way first, then Scratchpad, Jobs, Subagents, Todos, Questions. Info stays
unless the focused Scratchpad needs the whole width. On short terminals a multiline prompt scrolls around its cursor
to reserve the tray and footer.

- **Jobs** are the session's background shell tasks (`background.list`, asked at startup, when the dock opens, on session
  activity and after turns): running ones first with their elapsed time, finished ones with `exit N` or `killed`.
  The footer counts running jobs across sessions.
- **Scratchpad** is a per-project note, persisted by `scratchpad.get/set` in the daemon's data directory (`scratchpads/<sha256 canonical project path>.txt`, at most 8,000 characters). It is excluded from model history. `/scratch`, `ctrl+x s`, or a click in the Scratchpad panel focuses its own instance of the prompt editor inside the tray. Arrows, Home/End, word motion, selection, undo and multiline paste work there; Enter inserts a newline. Changes autosave after 500 ms; Esc returns focus to the unchanged prompt and flushes pending changes. A long note scrolls around the real cursor with a mini scrollbar. Ctrl+T opens padded bordered widgets with a blank row above the prompt. Editing needs the balanced/full view and at least 18 rows.

**Left out.** Extension-provided dock widgets: extensions stay on their slots (`prompt.above` and the others); the dock
has no slot of its own.

## Long transcripts

Mermaid fences in the full renderer support 30 terminal diagram families, including the
v1 inventory and class/state/ER/Gantt/pie/mindmap/git/quadrant/requirement/kanban.
`/diagram [n]` retains pan/zoom and can lay out canvases up to 1,600 columns.
See [Mermaid diagrams](mermaid.md) for syntax, resource limits and UI-9 frame generation.

Opening or switching sessions reads only the newest `session.events` window (200 events by default), then subscribes
from its raw `lastSeq` for replay of newer events and live output. PageUp, wheel-up and the existing scroll-up bindings
fetch `loadBefore(firstSeq)` when they cross the oldest loaded line. `Home` reaches the top of loaded history and can
request one earlier page; it does not download the whole session.

Only one earlier read runs at a time: `loading earlier…` appears at the top while it waits. `start of session` appears
only at the scrolled top of an overflowing session after an earlier page was successfully loaded and history exhausted;
home and sessions fitting in one viewport never show it. Prepending keeps the same item row on screen, including live output or scrolling during the
read. Raw cursors advance even through empty pages of undone turns; loaded pages are kept and never fetched again.
Switching resets paging and ignores late replies from the session left behind. Failed reads preserve the transcript
and cursor; another scroll up retries an earlier read.

The model keeps only requested history plus live events, compacting streamed deltas per item. Layout remains bounded
to the newest 400 blocks (`WINDOW_BLOCKS`) until scrolling lays out another 200 (`WINDOW_STEP`). `Home` lays out all
already loaded blocks; `/timeline` jumps can widen layout to a loaded message. A reader scrolled up stays pinned
while new output arrives.

The transcript's own scroll chrome is drawn inside the chat column, never over a sidebar. The jump-to-latest pill sits on
the row just above the prompt's top rule whenever the view is off the bottom; the optional scrollbar is a one-cell column
at the column's right edge, reserved for as long as `scrollbar` is `auto` or `always` so showing it moves no text. With the
activity status at `above` it is laid over the prompt's top rule, and at `inside` over the right of its first row: neither
takes a row, so a turn starting or ending never moves the transcript. All of it is configured in
[customize.md](customize.md#activity-status) and measured by `bun scripts/render-activity-scroll-frames.ts <directory> [before|after]`.

A transcript shorter than the body is top-anchored: it starts under the top bar after one blank row and the free rows sit
between its last message and the prompt (a short toast lies over the prompt's top rule and takes no row, so nothing moves when it comes or goes; only the minimal view, which has no rule, gives it a row above the prompt; a command's own report (`/daemon`, `/footer`, a usage line) uses the same slot for 8 seconds, so there is one place for notices and the footer holds state only; success is silent where the result is already on screen (text copied by selecting, a draft saved or restored, a quote or queued prompt put back in the prompt, comments parked or back, a goal set): only what failed or tells something new is said, and the `confirmNotices` profile key (Customize > Confirmations) brings those confirmations back; a toast that needs several lines, such as an error with detail, takes the first empty place at its right, below the top bar and the pinned prompt, and with none falls back to that row, never over text). Once it overflows the view
follows the bottom as above. Mouse selection, the find highlights, images and the pet use the same rows as drawn.

## Inline mode (no alternate screen)

`mendcode --no-alt-screen` (or `MENDCODE_ALT_SCREEN=0`, or `altScreen` off in `/customize` Terminal, which applies on the
next launch; `--alt-screen` forces the default for one run) keeps the chat on the terminal's normal screen, like Codex
and pi. The window then has two parts:

- **Scrollback.** Once a transcript block is final it is written above the prompt exactly once and scrolls into the
  terminal's own scrollback: native scroll, search and selection work on it, and it is never repainted. A block is final
  when it is finished, another block follows it (or the turn is over) and it is not part of a run of tool rows that is
  still growing. A title line (product, version, project) is written when the chat starts. A session that opens with
  history writes the loaded window once.
- **Live region.** The unfinished blocks (a streaming answer, running tools), requests, the working row, the prompt and
  the footer are redrawn in place at the bottom. A streaming answer taller than the room shows its tail and lands in the
  scrollback whole when it ends. There is no top bar, pet, scrollbar, sidebar or mouse reporting; a toast is one row
  above the prompt.

Pages and overlays (`/customize`, `/usage`, the palette, cards, plan review, the find bar) borrow the alternate screen
while they are open and give it back, so the scrollback is untouched. On exit the live region is erased and the history
stays above the shell prompt. `/raw` toggles plain, copy-friendly output (raw presentation) in either mode.

## Find in the transcript

`ctrl+f` (also `ctrl+x /` and `/find [text]`, alias `/search`) opens a find bar above the prompt. Type to highlight every
hit in the transcript (smart case: a capital makes it case-sensitive), the current one in the warning colour, the rest
muted. The bar shows `3/17`; the newest hit is current first. `enter` or `down` is the next hit and wraps, `shift+enter`
or `up` the previous one; the viewport centres on the current hit and widens the layout to reach older blocks. `tab`
limits the search to your prompts, and with an empty query it steps from prompt to prompt. Paging keys and the wheel
keep scrolling, `backspace` edits, `ctrl+u` clears, `esc` closes the bar and leaves you where you landed. Typing in the
bar never reaches the prompt. Under 70 columns the key hints are dropped and the count stays. In inline mode the bar
opens on the alternate screen over the whole transcript, including what is already in the scrollback. The action is
`transcript.find` in `keybindings.json`.

## Selecting text and `<details>` blocks

Dragging the mouse over the transcript selects its text (releasing copies it, or `ctrl+c` with `copyOnSelect` off). Drag past
the top or bottom edge of the transcript and it scrolls toward the pointer (one to three rows every 50 ms, faster the farther
the pointer is), also while the mouse is held still; the selection stays on its text and the copy includes the rows that
scrolled off screen. Moving back inside, releasing, any key or the wheel stops it. The selection is kept in transcript rows, so
history that loads in while you drag (paging from the store) can shift it by the rows added.

A double click selects the word under the pointer (letters, digits and `_`, plus `- . / : @ ~` between them, so a path or `src/a.ts:12` stays whole)
and a triple click the whole wrapped line, in the transcript or the prompt; like a drag, releasing copies it (`copyOnSelect`) or keeps it for
`ctrl+c`. Two presses count as a double click when they land on the same cell within 450 ms. While you are scrolled up, the
`↓ new output · End` label at the bottom right is a button: pressing it follows the newest output again. The wheel scrolls
`wheelLines` rows a notch (default 3, 1..20, `/customize` > Terminal > Wheel lines). Right click is off by default; with
`rightClickPaste` on it pastes the clipboard into the prompt like `ctrl+v` (text, or an image as an attachment). That reads the
daemon machine's clipboard, so it is local only and refused for a remote client.

A `<details>` block in an assistant message shows as a `▸ Summary` row. A click on that row opens or folds that block only;
`ctrl+x f` (`details.toggle`) does the same for the block nearest the middle of the screen (it says so when none is in view).
`ctrl+o` opens every block together with the tool output and resets the blocks toggled one by one; a block can still be folded
on its own while `ctrl+o` has everything open.

### Tool cards

Tool results are display only: the model gets the whole result, and `/copy`, `/export` and the session log keep it. What a
card shows follows the `view` setting (`/view`, or Tab on an empty prompt: minimal → balanced → full; a menu or text in the prompt keeps Tab for completion, and `view.next` rebinds it in `keybindings.json`); no view prints a whole file or listing. `minimal` is unchanged (one line for a run of
tools). `balanced` and `full` share one frame, drawn by `view/tool-card.ts` from `tool-frame.ts` (header, rule, grid),
`tool-kinds.ts` (a card per kind), `tool-bodies.ts` (the bodies) and `tool-data.ts` (parsers); the rationale is in
`docs/design/tool-cards.md`.

Frame: a glyph per kind coloured by status (running primary, ok success, awaiting approval warning), the
target in bold, facts muted after it, the duration right-aligned from 1 s (a running call keeps it inline, so the pet's corner
stays clear), and a thin `│` rule under the header holding the body. `MENDCODE_GLYPHS=ascii` swaps every mark.

A failed call says so with its marker, a word and its rule, and nothing else on the card is painted with it: the marker is `✗`
(`x` in ASCII) in the error role instead of the kind's glyph, the header carries `exit 2` (a shell), `HTTP 404` (a fetch) or
`failed` / `interrupted` in the error role, and the rule at the left is the error role. The command or target keeps its normal
colour. The output under the rule is the muted output role, like a passing call's; a short error (one or two lines, such as
`[PACKAGES]: Package tree exceeds approval budget`) is the normal text colour so it reads at once. A shell's output is stdout and
stderr merged, so its lines cannot be told apart and none is tinted. A long error shows its first 3 lines (a shell its last 12,
or 4 in the `calm` and `standard` densities) and `… +N lines`, which opens the card. Without colour the state is still the `✗`
and the word.

| Tool | `balanced` (default) | `full` |
|---|---|---|
| `read` | header only: `Read README.md  123 lines`, or `L40–88` / `L1–2 of 2,000` when partial | the first 6 rows, muted line-number gutter, highlighted, then `… N more lines` |
| `ls` | `List .  25 entries (18 dirs)` and an `ls`-style grid of at most 3 rows: directories first with `/` in the accent, dotfiles muted, then `… +N` | the same, 6 rows |
| `glob` | the same grid, grouped by common directory | 6 rows |
| `grep` | `Grep "foo"  12 matches in 4 files`, at most 3 files with their match counts and one matching line each (match emphasised, line number), then `… +N more matches` | 6 files, 2 lines each |
| `shell` | `$ command` (cut in the middle; wrapped under the rail in `full`) and `exit N` only when non-zero; a passing test run or type check is summarised in the header (`241 pass · 0 fail`) and has no body; else the last 6 rows on the rule; a failure its last 12 | the last 10 rows |
| `edit`, `apply_patch` | `Edit path  +A −D`, one line-number column as Claude Code draws it (a removed line's old number, the others' new one), no `@@` header (a later hunk is a muted `⋯`), what changed inside a line in bold, at most 40 rows, `… +N lines` (a call that changes a file shows as in the full view; only minimal keeps it to its row). `apply_patch` tells the model only the file list (`M path`) and gives the card its diff, one block per file | at most 40 rows |
| `write` | `Write path  created  4.2 KB  +N` over what the call put in the file, as in the full view (only minimal keeps it to its header). A call without its content shows what the tool appended (formatter output, diagnostics) on the rule, 3 rows | what the call put in the file as added lines with their numbers, at most 40 rows, `… +N lines` (`… more lines` when the stored call kept only the start of a large file); without its content, 6 rows of what the tool appended |
| `webfetch`, `web_search` | title, host and size; the query and result count | the first lines of text; the result titles |
| `task` | one row: agent, model, calls, status, duration; running, its last activity | the result on the rule |
| graph and codegraph cards | the visual and one muted summary row (`7 dirs · 2,360 files · hubs: ids 559 · …`) | plus a compact table of at most 6 rows (not on the `graph_map` card, which is the ASCII map alone at every level) |
| MCP and unknown tools | `server · tool  target` and the shape of the result (`object · 14 keys`, `text · 2.1 KB`) | plus at most 6 rows |

An opened card (click, `ctrl+x f`, `ctrl+o`) shows the whole body, a page of 40 rows at a time, and the full lists of a
graph card (`detail` nodes of a render spec with `at: "open"`; `at: "preview"` is the `full` view's table), except the project map of `graph_map`, whose card never draws the lists ([code graph](code-graph.md)). The engine's own code map starts open in the `full` view and as one row in `balanced` (`codeMapCard` in `/customize`); a click on the card opens or folds that one.

- While a tool runs, its live tail is at most 4 rows; the card keeps its header when the call finishes. Failed calls are never
  folded away or hidden in any view and show their message on an error rule.
- The `full` view's tool density is described below.
- In `balanced`, three or more finished reading calls of one turn in a row (reasoning between them does not break the run)
  fold into one row, `◇ Read 5 files · List 2 · Grep 3`. A failed, running or approval-pending call ends the run.
- In `balanced` and `full`, more than five finished one-line calls in a row keep the last five and fold the older ones into
  `◇ N tools more` (`ctrl+o` shows them). A call that may change files never folds and ends the run: native `edit`, `write`,
  `apply_patch` and `shell`, and the free-text calls of other engines (Claude Code's `edit path`, `write path` and the whole
  command of a Bash call, pi's `bash`). Only their reading calls (`read`, `glob`, `grep`, `fetch`, `search`) fold.
- A click (press and release without a drag) on any row of a card, its head or a body row, or `ctrl+x f` at it, opens that card on
  its own; the same click on an opened card closes it, from wherever it lands, also when the head has scrolled off screen. A
  drag over the rows still selects text, and the second press of a double click on a body row selects the word and does not
  toggle the card back. A folded run opens the same way. An opened card shows one page of 40 lines; its footer row,
  `lines 1-40 of 312`, turns to the next page, and on the last page closes the card. `ctrl+o` opens every card at once (and
  stops folding runs) and resets the ones opened by hand. A card always opens on its first page (closing it forgets its page),
  and opening, closing or turning a page keeps its head row on the screen row it was on (a head that was off screen goes to
  the second row), or moves it up when the card no longer fits under it; this holds while a turn streams, which no longer moves
  a reader scrolled up. A second click within 0.6 s of the one that opened a card is ignored when it lands on the footer (a
  card at the bottom of the view has its footer where the head was).
- A row is never cut without saying so. A shell command (or a call whose engine title is the whole command, as the Claude Code
  engine sends) wraps onto continuation rows under the card's rail, aligned with the command, in the `full` view and in an
  opened card (the facts and the duration follow its last word; past eight rows the eighth ends in `…`); in `balanced`
  it is one row that ends in `…`. Long paths and patterns in other headers, queued prompts, diff hunks, the `Thought:` title
  and call arguments end in `…` too. `test/transcript-fit.test.ts` renders a long session at 60, 80, 120 and 200 columns in
  each view and fails on a row wider than the screen or a long text that stops without `…`.
- `/find` opens the runs and cards whose hidden text holds the query while the bar is up (a card at the page of its first
  hit) and puts them back when it closes. `toolOutput` in `/customize`: `collapsed` keeps one line in every view, `expanded`
  shows the capped bodies in `balanced` too.

#### Tool density in the full view

The table's `full` column is the `dense` density. A long session of it is a wall: every call prints its preview and the
assistant's sentences get lost. `toolDensity` (`/customize` > Session chrome > Tool density; `calm` by default) chooses how
much of each card the `full` view prints. The balanced and minimal views ignore it, `toolOutput: collapsed` and `expanded`
and `ctrl+o` win over it, and a card the reader opened by hand stays open in every density. Nothing the model receives, no
export and no history changes: only the rows drawn.

| | `calm` (default) | `standard` | `dense` |
|---|---|---|---|
| finished call | one row: kind, target, result count, duration (`$ wc -l docs/*.md  82 lines`) | a short preview, capped by kind | the whole `full` preview (the table above) |
| latest, running, failed call | the short preview | the short preview | the whole `full` preview |
| runs of looking calls | three or more in a row fold into one row, counts spelled: `Read 4 files · Grep 3 patterns` (click to open) | as they are | as they are |
| a target in a one-row call | muted, not bold | | |

The short preview is capped by kind: `read` 3 lines then `… N more lines`; `grep` 3 matching lines; `shell` its last 3 lines (4 for a
failure); `ls` and `glob` 2 rows; `web_search` 3 titles; a diff 8 rows; an unknown tool 3 rows. A result that is one JSON
value is its shape in the header and no rows: `object · 4 keys`, `array · 20 items`, `json · 1,155 lines`. The code map card, the
thought blocks, to-do lists, questions and plans are not part of it and draw as they always do.

Heights stay put while a session streams. A call never changes its own height when it finishes (running, its live tail; finished,
its preview). In `calm` an earlier call folds to its row when the next call is added, which is also when a run of looking calls
folds, and the assistant's answer arriving moves nothing above it. A click on a one-row call opens it like any card.

## Context report (UI-8)

`/context` shows a ten-column, 100-cell window map and a category legend: system prompt, native tools,
MCP schemas, custom agents, memory, skills, retained messages, free space and the autocompact buffer.
Each category has its own glyph and theme role. Figures are estimates from the actual report; the
last measured call is labeled separately. The full buffer stays marked when usage enters it, with
a separate count of tokens inside the buffer. Unknown windows use the compact threshold and explicitly
omit buffer estimates. The model and session id come from the report.

Wide terminals put the largest messages beside the window and resource sections. Small terminals
stack the page. `tab`, Shift+Tab and `1`/`2` retain Sections/Largest navigation; `r` refreshes, Esc/`q`
returns, and PageUp/PageDown reveals resource rows or messages. Suggestions appear only for recorded
large tool results, successful repeated file reads or actual pressure at the compact threshold.
`context.query` adds optional `sessionId`, `contextWindow`, disjoint `categories`, `mcpTools` and
`repeatedReads`; existing `sections` remain intact. MCP and agent-catalog estimates are moved out of
tool totals, never counted twice. Resource counts describe entries included in the prompt/catalog,
not every installed file. Unknown counts in older reports stay unavailable.

The scratchpad's focused and unfocused layouts now wrap at word boundaries, hard-breaking only
words wider than the editor. Grapheme offsets, whitespace, selections, autosave and stored text are
preserved across resizing; visual Home/End follows the same rows used to draw the cursor.
`bun scripts/render-ui8-frames.ts .agents/runs/frames/ui-8/` generates isolated app-harness evidence
at 60×20, 100×30, 180×50 and 220×60, plus a real-screen ANSI capture of the terminal-themed home.

## Shared view helpers

Shared cell measurement and end/tail-biased truncation live in `apps/cli/src/view/wrap.ts`;
`deck`, `panel-box` and `session-list` retain their helper exports for compatibility.
Time helpers live in `view/time.ts`: agent/loop clocks share padded remainders while loop
durations still show `<1s` below one second. Other clock styles keep their existing rounding.

## Question batches and TODO lists (B57)

The native `question` tool accepts `questions[]` with `question`, a short `header`, `options`,
optional `multiple`, and `custom` (defaults to true). Claude Code's AskUserQuestion arrives the
same way ([Claude Code](claude-code.md)).

**The question card takes the prompt's place** while a question waits: one card with the header,
the question, the numbered options with their descriptions wrapped in full (never cut), a last
"Type your own answer" row, and one line of keys. There is no second input under it, no
"waiting" header, no working row repeating that the turn waits, and the running call that asked
(`AskUserQuestion`, `question`) draws no row until it is answered. A batch adds a row of tabs.

- Up/Down select (the highlighted answer has a `›` and is where the terminal cursor sits, so a
  screen reader reads it); digits pick; Enter confirms. Esc or ctrl+c dismiss the question.
- A single choice sends at once (in a batch it moves to the next tab). A multiple choice ticks with
  space or a digit; with one question Enter sends what is ticked (the highlighted option when
  nothing is), in a batch Enter toggles. Ticked answers keep the options' order.
- **Type your own answer**: choosing that row (its digit, Enter, a click, or simply typing in the
  list) turns it into a text field inside the card. The caret is there and the text wraps there;
  Enter saves it (one question: sends it), Esc goes back to the list without it, ↑ from an empty
  field steps back into the list, and in a batch Tab keeps the text and moves to the next tab.
  A question with no options opens with its field ready. Saved text replaces the row's label.
- Tab/Shift+Tab or Left/Right switch the tabs of a batch. The Confirm tab reviews the answers in
  order, unanswered ones included; Enter there sends `request.resolve` with
  `decision.answers: string[][]` (labels containing commas stay intact).
- Whatever the prompt held when the question came stays aside and comes back once it is gone.

The client helper is `answerQuestions(sessionId, requestId, answers)`. A single question (`title`,
`detail`, `options`) is drawn as a batch of one and still answers with plain text (labels joined
with ", "). Batch limits: 32 questions, 9 options each, 4,000 chars per custom answer. On a short
terminal the question text gives way first, then the answers scroll to keep the highlighted one
(or the caret) in view.

The native `todo` tool replaces the latest session list with `items`; `[]` clears it.
Each item has `text`, `status` (`pending`, `in_progress`, `done`, `completed`, `cancelled`) and
optional `priority` (`high`, `medium`, `low`). Tool cards, the dock and an opt-in TODO sidebar
show priorities and cancellation; cancelled and finished items are excluded from the open count.
Lists and clears survive event replay. Below 70 columns the dock shows one panel.

[Async tools and questions](async-tools.md) also use these panels. Ctrl+T includes persisted
read-job states; a posted async question remains answerable after its originating turn ends.

`bun scripts/render-frames.ts .agents-frames/B57 --b57 100x30 180x50` renders batch selection,
custom editing, Review, scrolling, TODO cards, the dock, clearing and an opt-in sidebar through
the app harness, with temporary data and no provider.
