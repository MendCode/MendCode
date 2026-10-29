# File viewer

Click a file path in the conversation and the file opens beside it. The chat stays on the left; the file takes the right slot (the one
the [panel](sidebar.md) uses) with a header, line numbers, syntax colors, the cited lines selected, Git change marks in the margin and a
search. It is read-only: it never edits a file.

```
 ‹ AGENTS.md · 157 lines                         o open · a ask · y copy
 ▎   1 # Agents
     2
     3 Rules for this repository.
   ...
   ctrl+\ focus · opt+{ panel                                   1-40/157
```

One header row: the way back, the file's name (bold) and what it holds (muted) on the left, the actions on the right as hints, in the
same muted colors as every other hint row of the app. They are still clicks. The language is named only when the file's name does not
say it (a `Dockerfile`). The last row is the footer: the keys that bring the keyboard here, and where the window is in the file.

## Opening a file

| How | What happens |
|---|---|
| Click a path in the transcript | Assistant and user text, tool card titles (`read src/app.rs`): anywhere a path is drawn in the conversation. One plain click. |
| `alt+o` (leader `;`) | The first path in the selection (or the passage you just copied), else in the item in view. Several paths are listed in the picker; none says so. |
| `/open <path>[:line[-line]]` | The same, from the prompt. `@` completes the path with the mention picker. `/open` or `/open close` closes the file. |
| A file on the [Changes page](#from-the-changes-page) | A click on the file in the list or above its diff, or `f`. |
| An extension | `actions.openFile(path, { from, to })` in a command or key (see [extensions](extensions-tui.md)). |

A reference is read the way people write it: `src/app.rs:120`, `src/ui.rs:300:5`, `src/files/link.rs:56-79`, `DESIGN.md#L10-L20`,
`./AGENTS.md`, `AGENTS.md`, an absolute path inside the workspace, `~/x` when it is inside, in backticks or before a full stop. A path cut
over two rows opens from either row. A drag that starts on a path selects text and opens nothing; ctrl and alt clicks stay with the
terminal's own link; a double click opens once and still selects the word. A click on a tool card's title opens the file, a click
anywhere else on the header still folds the card.

What never opens: a URL, `std::collections::HashMap`, a date. A path outside the workspace says `not opened: <path> is outside the
workspace` and is never asked for or read. The workspace is the session's directory and the directories added with `/add-dir`. A missing
file is one line (a bare name such as `Node.js` that is not a file stays quiet).

### The open-path key

`alt+o` (`ctrl+x ;` on a Mac where Option is not known to send Alt) looks in what you are pointing at: the kept mouse selection, or the
passage a selection just copied (for eight seconds; copy on select drops the selection itself), else the item nearest the middle of the
screen, the rule `ctrl+x f` and `ctrl+x Y` use. One path opens at once. Several are listed in the picker (`Open file`, the palette's list:
type to narrow, enter opens, esc closes). `alt+x` (`ctrl+x -`) closes the open file. Both are key actions: rebind them in `/keymap` or
`keybindings.json` (`file.open`, `file.close`), and every hint of the viewer names the key you chose.

## Folders

A folder path (`/open src`, a click on `./src/files` in the conversation) lists the folder in the viewer: folders first, then files, each
group by name, with the size of each file on the right.

```
 ‹ src/ · 2 entries                                  a ask · y copy
 ▎ ..
   files/
   app.rs                                                    2.8 KB
```

A click on a row enters the folder or opens the file; `j` `k` move, `enter` opens, `backspace` goes up (from a file opened out of a
listing it comes back to that listing). `..` goes to the parent and is not offered at the workspace root: the listing follows the same
containment as a file (a path outside the workspace, or a symlink out of it, is `outside` and never listed). `.git` is never listed. A
listing shows at most 500 entries and says `showing the first 500 of 600`; the daemon stops counting at 20,000.

## Reading what is there

- **Large files**: the viewer asks the daemon for a window of lines (at most 400 per request), so opening line 11,000 of an 11,000
  line file reads one window. A file over 4 MB is `too large to view`; one line, nothing read.
- **Binary files** show `binary file · image/png · 12 KB` and nothing else. A device, pipe or socket inside the workspace is
  `device, pipe or socket · not opened`, found with `stat` and never opened. A symlink to anything outside the workspace is outside.
- Lines longer than 2,000 characters are cut. A tab is four columns, other control characters are a dot.
- **Secrets** are masked the way diffs and tool output are (`redactSecrets`); the footer says how many.
- **Git marks** (a bar in the margin: green added, yellow modified, red where lines were removed) come from the changes report, the one
  the Changes page draws. No report, no marks. A changed file also reads like its diff: an added or modified line has the diff's green
  fill, and the lines HEAD had are drawn in red above the line that follows them, with `-` in the margin and no number (at most 8 per
  run, then `… N more removed`). A file opened without a line (a click on an edit's path) lands on its first change; a cited line wins.
- **Reload**: when the terminal window gets focus, when a turn ends or any item completes, and on `r`, the viewer asks the daemon
  whether the file changed (a cheap `known` version check, one `stat`) and redraws only if it did. There is no watcher and no timer.
- **Search**: `/` then Enter finds lines holding the text (smart case); `n` and `N` step through them. `:` and a number jumps to a line.

### Colors

Prose (Markdown, text) is the normal text color: headings are bold with the `#` marker in the accent, code spans use the code role, a
link's address is muted. Code uses the same roles as a fenced block in the chat (the one tokenizer, `packages/protocol/src/syntax.ts`,
used by the chat, the tool cards and the viewer). A language the highlighter does not know is drawn the way the read card draws it.

### A window below something opened above it

A block comment, a triple-quoted string or a fenced block opened above the window is drawn right without the client reading the file. The
client sends the language with each `file.view`; the daemon runs the same tokenizer over the lines above the window (a pass over the
file's bytes, no more, bounded by the 4 MB limit) and answers `lex`: the tokenizer's state at the first row (`block`, `triple` or
`fence`; absent when nothing is open). The client carries it through the rows it received. A window at the top, or after the comment
closed, has no `lex`.

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

On `/changes`, a click on a file of the list, or on the file's heading above its diff, opens it in the viewer at its first changed line
(the first added line, or for a change that only deletes, the line the deleted text sat before). `f` does the same for the selected file.
The chat takes the page's place with the viewer in the slot (or as a page on a narrow terminal). A deleted file says so and opens
nothing; the list of a past message or session snapshot (`/changes message 3`) does not open files, since the working tree may differ.

## One slot, several occupants

The viewer shares the slot with the panel (and the side chat). Opening a file replaces what the slot shows; closing it puts back exactly
what was there before, the panel with its preset and focus, or nothing when the slot was hidden. While both exist, the `panel` hint of the
footer (`alt+{`) switches between them.

Below the width where the slot fits (the right bar's own breakpoint, about 110 columns) the file opens as a full page with the same
header and keys; `esc` returns to the conversation at the same scroll position. Widen the terminal and it moves into the slot.

## Settings

All in `/customize` > Terminal (profile keys), all switchable.

| Setting | Values | Default |
|---|---|---|
| `pathClick` | `auto`, `panel`, `editor` | `auto`: `panel` where the `file_viewer` feature is on (balanced and full), `editor` elsewhere. `editor` is today's behaviour: the terminal's own link. `panel` turns it on in minimalist too. |
| `viewerNumbers` | on, off | on |
| `viewerWrap` | `auto`, `on`, `off` | `auto`: prose (md, mdx, txt, rst, a README or LICENSE without an extension) wraps at its spaces with a hanging indent under the number column; code is cut and `←` `→` scroll. A saved `false` is `auto`, a saved `true` is `on`. |
| `viewerFocus` | on, off | off: the prompt keeps the keyboard when a file opens |

`file_viewer` is a [tier](tiers.md) feature (balanced and above, `features.file_viewer` overrides). Minimalist never shows the right slot
unless `pathClick: panel` is set or the tier is raised; the `/open` command is listed from balanced. `pathClick` and `viewerFocus` cannot be
set by a package.

## What it reads, and where

The viewer is a thin client: it never reads the disk itself, so it works against a remote daemon. One command,
`file.view` (`packages/daemon/src/file-view.ts`, schema in `packages/protocol/src/file-view.ts`):

| Input | Result |
|---|---|
| `directory`, `path`, `from?`, `count?` (1..400), `search?`, `known?`, `lang?` | `kind` (`text`, `binary`, `special`, `directory`, `missing`, `outside`, `large`), `size`, `version`, for text `lines`, `from`, `rows`, `redacted`, `hits`, `lex`; for a directory `entries` (at most 500) and `entriesTotal` |

It resolves the path with the daemon's project-path containment (symlinks resolved, `..` and escapes refused, `outside` instead of an
error), checks the file type with `stat` before opening, reads at most 4 MB and 400 lines, and redacts secrets. A folder is listed with
`opendir` (never more than 20,000 names read, `.git` skipped, one `lstat` per listed file for its size). It is not a read-only peer's
command: a token marked read-only gets `forbidden` for `file.view`, file or folder, since a read-only peer must not read project files.
Git marks use the existing `changes.query` / `changes.file`. `file.rest.read` was not used because it fails above 120,000 bytes, trims
content (which breaks line numbers), has no redaction, windowing or special-file report, and read-only peers cannot call it.

## Extending

The viewer is the view slot `file.viewer` ([views](views.md#fileviewer)): an extension can replace or wrap its drawing, and open a file
in it with `actions.openFile`. Users can already change the colors (theme), turn it off, restyle or replace the whole viewer as a view,
and add keys that call `openFile`. Not possible: new actions inside the viewer beyond the closed set (`close`, `switch`, `open`, `ask`,
`copy`, `line`, `entry`), a second viewer at once, or editing.
