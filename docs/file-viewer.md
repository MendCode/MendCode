# File viewer

Click a file path in the conversation to read it beside the chat, with cited lines selected, syntax colors, line numbers, Git change marks and search. The viewer is read-only: it never edits a file.

The chat stays on the left; the file takes the right slot, the one the [panel](sidebar.md) uses.

```
 ‹ AGENTS.md · 157 lines                         o open · a ask · y copy
 ▎   1 # Agents
     2
     3 Rules for this repository.
   ...
   ctrl+\ focus · opt+{ panel                                   1-40/157
```

The header is one row: the way back, the file's bold name and muted contents on the left; clickable action hints on the right. Hints use the same muted colors as the app's other hint rows.

The language is named only when the file's name does not say it (a `Dockerfile`). The footer is the last row: keys that bring the keyboard here, and the window's position in the file.

## Opening a file

| How | What happens |
|---|---|
| Click a path in the transcript | Assistant and user text, tool card titles (`read src/app.rs`): anywhere a path is drawn in the conversation. One plain click. |
| `alt+o` (leader `;`) | The first path in the selection (or the passage you just copied), else in the item in view. Several paths are listed in the picker; none says so. |
| `/open <path>[:line[-line]]` | The same, from the prompt. `@` completes the path with the mention picker. `/open` or `/open close` closes the file. |
| A file on the [Changes page](#from-the-changes-page) | A click on the file in the list or above its diff, or `f`. |
| An extension | `actions.openFile(path, { from, to })` in a command or key (see [extensions](extensions-tui.md)). |

### Recognized paths

References are read the way people write them, in backticks or before a full stop:

| Reference | Examples |
|---|---|
| Line, column or range | `src/app.rs:120`, `src/ui.rs:300:5`, `src/files/link.rs:56-79`, `DESIGN.md#L10-L20` |
| Relative or bare path | `./AGENTS.md`, `AGENTS.md` |
| Absolute or home path | An absolute path inside the workspace, `~/x` when it is inside. |

A path cut over two rows opens from either row.

| Mouse action | Result |
|---|---|
| Drag starting on a path | Selects text and opens nothing. |
| Ctrl or alt click | Stays with the terminal's own link. |
| Double click | Opens once and still selects the word. |
| Click a tool card's title | Opens the file. |
| Click elsewhere on the card header | Still folds the card. |

### Workspace boundaries

The workspace is the session's directory and the directories added with `/add-dir`. A path outside it says `not opened: <path> is outside the workspace` and is never asked for or read.

A URL, `std::collections::HashMap` or a date never opens. A missing file is one line; a bare name such as `Node.js` that is not a file stays quiet.

### The open-path key

Press `alt+o`, or `ctrl+x ;` on a Mac where Option is not known to send Alt. It uses the same rule as `ctrl+x f` and `ctrl+x Y`, looking in this order:

1. The kept mouse selection.
2. The passage a selection just copied, for eight seconds; copy on select drops the selection itself.
3. The item nearest the middle of the screen.

One path opens at once. Several appear in `Open file`, the palette's list: type to narrow, enter opens, esc closes.

`alt+x` (`ctrl+x -`) closes the open file. Rebind both key actions in `/keymap` or `keybindings.json` (`file.open`, `file.close`); every viewer hint names the key you chose.

## Folders

A folder path (`/open src`, a click on `./src/files` in the conversation) lists the folder in the viewer: folders first, then files, each
group by name, with the size of each file on the right.

```
 ‹ src/ · 2 entries                                  a ask · y copy
 ▎ ..
   files/
   app.rs                                                    2.8 KB
```

| Action | Does |
|---|---|
| Click a row | Enters the folder or opens the file. |
| `j` `k` | Move. |
| `enter` | Opens. |
| `backspace` | Goes up; from a file opened out of a listing, returns to that listing. |
| `..` | Goes to the parent; not offered at the workspace root. |

The listing follows the same containment as a file. A path outside the workspace, or a symlink out of it, is `outside` and never listed. `.git` is never listed.

A listing shows at most 500 entries and says `showing the first 500 of 600`; the daemon stops counting at 20,000.

## Reading what is there

### File limits and secrets

| Content | What you see |
|---|---|
| Large files | A window of at most 400 lines per request; opening line 11,000 of an 11,000 line file reads one window. |
| Files over 4 MB | `too large to view`: one line, nothing read. |
| Binary files | `binary file · image/png · 12 KB` and nothing else. |
| Device, pipe or socket inside the workspace | `device, pipe or socket · not opened`; found with `stat` and never opened. |
| Symlink outside the workspace | Outside. |
| Lines longer than 2,000 characters | Cut. |
| Tabs and other control characters | A tab is four columns; other control characters are a dot. |
| Secrets | Masked the way diffs and tool output are (`redactSecrets`); the footer says how many. |

### Git marks and changed lines

Git marks come from the changes report, the one the Changes page draws. No report, no marks. The margin bar is green for added lines, yellow for modified lines, red where lines were removed.

A changed file also reads like its diff:

- Added or modified lines have the diff's green fill.
- Lines HEAD had appear in red above the line that follows them, with `-` in the margin and no number: at most 8 per run, then `… N more removed`.
- A file opened without a line, such as a click on an edit's path, lands on its first change. A cited line wins.

### Reload and search

The viewer checks for changes when the terminal window gets focus, when a turn ends or any item completes, and on `r`. It asks the daemon with a cheap `known` version check, one `stat`, and redraws only if changed.

There is no watcher and no timer.

1. Press `/`, then Enter to find lines holding the text (smart case).
2. Use `n` and `N` to step through them.

Use `:` and a number to jump to a line.

### Colors

Prose (Markdown, text) uses the normal text color:

- Headings are bold with the `#` marker in the accent.
- Code spans use the code role.
- A link's address is muted.

Code uses the same roles as a fenced block in chat. The chat, tool cards and viewer share one tokenizer, `packages/protocol/src/syntax.ts`. An unknown language is drawn the way the read card draws it.

### A window below something opened above it

A block comment, triple-quoted string or fenced block opened above the window is drawn correctly without the client reading the file.

1. The client sends the language with each `file.view`.
2. The daemon runs the same tokenizer over the lines above the window: a pass over the file's bytes, no more, bounded by the 4 MB limit.
3. It answers `lex`, the tokenizer's state at the first row: `block`, `triple` or `fence`; absent when nothing is open.
4. The client carries that state through the rows it received.

A window at the top, or after the comment closed, has no `lex`.

## Keys

The prompt keeps the keyboard by default; the file scrolls with the mouse wheel. The footer names the key that gives the keyboard to the
file and back, as you have it bound; on a Mac where Option is not known to send Alt it shows the `ctrl+x` chord (`ctrl+x } focus ·
ctrl+x { panel`) until an Alt key arrives or the terminal reports keys for real.

| Key | Action |
|---|---|
| `ctrl+\`, `alt+}` (leader `}`), or a click on the file | focus the viewer / give the keyboard back (a click outside it also gives it back) |
| `alt+{` (leader `{`) | the slot shows the file or the panel |
| `alt+o` (leader `;`) | open the first path of the selection or the item in view |
| `alt+x` (leader `-`), `esc` or `q` when focused, the `‹`, `/open close` | close |
| `j` `k` `↑` `↓`, `space` `b`, `ctrl+d` `ctrl+u`, `g` `G` | scroll |
| `←` `→` or `h` `l` | scroll sideways (no wrap) |
| `/` `n` `N`, `:` | search, step, go to a line |
| `r` | reload |
| `o` | open in your editor |
| `a` | ask agent |
| `y`, `c` | copy the selection (or the path), clear the selection |
| `w`, `#` | wrap, line numbers (this file only) |

The mouse: the wheel scrolls, a click on a line selects it (a drag selects a range, a second click on one selected line clears it),
the header's `‹`, `o open`, `a ask` and `y copy` are clickable, and so is the `panel` hint of the footer.

- **open** hands the file and line to your editor through the IDE bridge (`/ide on`, local only).
- **ask** puts `@path:from-to` into the prompt (the same `@` mention the picker inserts), so the agent reads the lines. It sends
  nothing by itself.
- **copy** copies the selected lines, or the path when nothing is selected.

On a narrow header the actions drop from the right (`o open` first), then the name is cut with an ellipsis.

## From the Changes page

1. On `/changes`, click a file in the list or its heading above the diff. Or press `f` for the selected file.
2. The viewer opens at the first changed line: the first added line, or for a change that only deletes, the line the deleted text sat before.
3. The chat takes the page's place with the viewer in the slot, or as a page on a narrow terminal.

- A deleted file says so and opens nothing.
- A past message or session snapshot (`/changes message 3`) does not open files, since the working tree may differ.

## One slot, several occupants

The viewer shares the slot with the panel (and the side chat). Opening a file replaces what the slot shows; closing it puts back exactly
what was there before, the panel with its preset and focus, or nothing when the slot was hidden. While both exist, the `panel` hint of the
footer (`alt+{`) switches between them.

Below the width where the slot fits (the right bar's own breakpoint, about 110 columns) the file opens as a full page with the same
header and keys; `esc` returns to the conversation at the same scroll position. Widen the terminal and it moves into the slot.

## Settings

All in `/customize` > Terminal (customize keys), all switchable.

| Setting | Values | Default |
|---|---|---|
| `pathClick` | `auto`, `panel`, `editor` | `auto`: `panel` where the `file_viewer` feature is on (balanced and full), `editor` elsewhere. `editor` is today's behaviour: the terminal's own link. `panel` turns it on in minimalist too. |
| `viewerNumbers` | on, off | on |
| `viewerWrap` | `auto`, `on`, `off` | `auto`: prose (md, mdx, txt, rst, a README or LICENSE without an extension) wraps at its spaces with a hanging indent under the number column; code is cut and `←` `→` scroll. A saved `false` is `auto`, a saved `true` is `on`. |
| `viewerFocus` | on, off | off: the prompt keeps the keyboard when a file opens |

`file_viewer` is a [tier](tiers.md) feature (balanced and above, `features.file_viewer` overrides). Minimalist never shows the right slot
unless `pathClick: panel` is set or the tier is raised; the `/open` command is listed from balanced. `pathClick` and `viewerFocus` cannot be
set by a profile.

## What it reads, and where

The viewer is a thin client: it never reads the disk itself, so it works against a remote daemon. One command,
`file.view` (`packages/daemon/src/file-view.ts`, schema in `packages/protocol/src/file-view.ts`):

| Input | Result |
|---|---|
| `directory`, `path`, `from?`, `count?` (1..400), `search?`, `known?`, `lang?` | `kind` (`text`, `binary`, `special`, `directory`, `missing`, `outside`, `large`), `size`, `version`, for text `lines`, `from`, `rows`, `redacted`, `hits`, `lex`; for a directory `entries` (at most 500) and `entriesTotal` |

### Path and read limits

1. The daemon resolves the path with project-path containment: symlinks resolved, `..` and escapes refused, `outside` instead of an error.
2. It checks the file type with `stat` before opening.
3. It reads at most 4 MB and 400 lines, and redacts secrets.

A folder is listed with `opendir`: never more than 20,000 names read, `.git` skipped, one `lstat` per listed file for its size.

A token marked read-only gets `forbidden` for `file.view`, file or folder. It is not a read-only peer's command, since a read-only peer must not read project files.

### Existing commands

Git marks use the existing `changes.query` / `changes.file`.

`file.rest.read` was not used because it:

- Fails above 120,000 bytes.
- Trims content, which breaks line numbers.
- Has no redaction, windowing or special-file report.
- Cannot be called by read-only peers.

## Extending

The viewer is the view slot `file.viewer` ([views](views.md#fileviewer)). An extension can replace or wrap its drawing, and open a file in it with `actions.openFile`.

You can change the colors through the theme, turn the viewer off, restyle or replace the whole viewer as a view, and add keys that call `openFile`.

Not possible:

- New actions inside the viewer beyond the closed set: `close`, `switch`, `open`, `ask`, `copy`, `line`, `entry`.
- A second viewer at once.
- Editing.
