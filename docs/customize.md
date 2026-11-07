# Customize, settings, status and extensions pages

Use these four in-terminal pages to change your terminal, edit daemon settings, inspect status or manage extensions. Open each with its slash command; terminal choices also have a daemon-backed automation interface.

| Command | What it does |
|---|---|
| `/customize` | Edit the terminal's look with a live preview; every change is saved at once. |
| `/settings` | Every daemon setting, grouped, plus links to `/customize` and `/extensions`. |
| `/status` | Read-only facts: daemon, engines, session, MCP, extensions, storage, versions. |
| `/extensions` | What the daemon and this terminal loaded, with errors; trust the project's extensions. |

A profile carrying a look (a theme, profile values, keys, views) overlays what `/customize` stores. The page shows the value in force.

Change a key the profile holds to make it yours from then on, kept in `<data dir>/activation.json`. Turning the profile off puts your stored values back.

In `/profiles`, press `o` to list current overrides or `p` for the precedence report. See [profiles](packages.md#how-activation-works-an-overlay-never-an-edit).

## /customize

### Restore saved settings

| Command | Does |
|---|---|
| `/customize restore` | List saved profiles with their time and number of differing keys. |
| `/customize restore <id>` | Restore one, backing up the current file first; the result includes an undo command. |
| `mendcode customize restore [id] [--dir PATH]` | Restore headlessly, without starting a daemon. |

All tiers preserve unknown customize keys and values this version cannot interpret.

Defaults are used only in memory; an explicit edit can replace a value.

At terminal startup, missing keys are recovered from the newest snapshot without overwriting present keys.

A single notice reports the recovered count and undo command.

Invalid JSON is preserved in history before recovery; ordinary saves refuse to overwrite it.

History lives in `tui/backups/`; see [storage](storage.md).

### Choose a slash-menu layout

Choose a Slash menu layout:

| Layout | Behavior |
|---|---|
| `tabs` | Default. |
| `groups` | Recent first, then collapsed group rows with counts and previews. |
| `columns` | Becomes groups below 90 columns. |
| `flat` | Compact layout inherited by minimalist until a layout is saved. |

Minimalist inherits compact `flat` until a layout is saved; applying a tier sets its default again.

Tabs open on recent: pins, the last four used, the eight most used, then essentials.

With no recents or visible pins, six useful commands appear under `suggested`.

A typed query (`/s`) lists the best matches first and, among equally good ones, the commands used before, the most used ahead (then the most recent); an exact name or alias still comes first.

Recents store only canonical names, counts and last-use times in `<dataDir>/tui/slash-recents.json` (128 entries).

Remote terminals do not access that file.

The fixed groups are `recent session context code agents setup look more`.

Tab/Shift+Tab or left/right change the tab or column; up/down select; Enter runs (commands needing arguments complete into the prompt).

Groups show recent first, then collapsed group rows with counts and previews; `▸` marks collapsed groups, right opens in place with indented commands, left closes.

Active tabs use brackets and muted group counts; whole tabs wrap at narrow widths, with the active row kept visible on short screens.

Command summaries use a verb-first phrase of at most 48 characters; effective key bindings appear muted at the right.

Columns become groups below 90 columns.

The bottom rule shows the visible range and keys.

Typing a letter searches the whole enabled catalog, with underlined matches and muted group labels; Tab completes search text.

### Edit commands in the menu

In **Slash menu → Edit commands**, up/down select; left/right regroup, `h` hides, `p` pins, `J/K` or Shift+Down/Up reorder, and `r` renames the selected command's group.

Enter saves the name; Esc cancels.

The profile stores `slashMenu`, `slashGroups: [{id,label}]`, and `slashCommands: [{name,group?,hidden?,pinned?,order?,aliases?}]`; the same validated fields work with `customize_ui` and `api.settings.set`.

Hidden commands remain searchable and runnable.

Tier-disabled features are absent from browsing and search, even when pinned.

The **minimalist** tier lists only twenty-one built-in commands ([tiers](tiers.md#slash-commands)); the rest are absent from the menu, search, `/help` and the command palette until the tier is raised, and typing one answers with the tier that has it.

`hidden` decides regardless of tier: `hidden: false` lists a command the tier would not, `hidden: true` removes a listed one from browsing.

`h` in **Edit commands** (`/settings slashCommands` reaches it without `/customize`) flips the selected command (`shown`, `hidden` or `hidden by tier`) and writes `hidden` only where it differs from the tier.

Single-setting commands (timestamps, thinking, scrollbar, prompt presentation and similar) appear only in search as a muted `setting` row.

Selecting a partial match opens `/settings <row>` on its profile control; a fully typed invocation still runs its original behavior.

`loop` and `wf` are the short names of `/loops` and `/workflows`.

`/commit push [hint]` and `/commit pr [hint]` are the two forms of one command; `/commit-push` and `/commit-pr` are not commands any more.

### Aliases of your own

`aliases` on a `slashCommands` entry gives a command more names: `{ "name": "changes", "aliases": ["d"] }` in `<data dir>/tui/profile.json` (or `customize_ui` `settings`, or `api.settings.set`) makes `/d` run `/changes`, with the arguments after it (`/d src` is `/changes src`).

Up to eight lowercase words per command (letters, digits, `-` and `_`).

The menu lists the alias next to the command and finds the command when you type it.

Rules, checked where the setting is written and again when it is read: a word is used by one command only, and is never the `name` of an entry (so an alias cannot point at another alias or at itself).

An alias that is the name or alias of a built-in command, or the name of a command of the project, is ignored (the built-in or the command file wins) and `/doctor` lists it under Slash commands, as it does an alias of a command that does not exist.

The terminal reads the profile live: a change from `/customize` or `customize_ui` applies at once, one made by editing the file by hand on the next start.

To undo, remove the word from `aliases` (or the entry).

### Replacing the slash menu view

A trusted user or profile extension can register `api.view("slashMenu", render)`; the daemon's existing customize-ui watcher reloads it after edits.

The synchronous, data-only context has `catalog` (enabled commands with name, aliases, summary, group, optional shortcut/setting/custom/ext/mcp), `query` (without slash), `selection` (index in `items`), `items` (command/group rows), `groups` (id/label/count), `group` (active id), `layout`, `width`, `height` and `ascii`.

Optional `suggested` labels the unused recent list; group rows expose `expanded`, and their child command rows expose `indented`.

These additive fields are shared with replacement views.

The four built-in layouts use this same input → `Line[]` contract.

Keyboard navigation and execution remain terminal-owned; custom views use keyboard selection, not built-in mouse geometry.

Return `undefined` to use the built-in layout.

The last registered view wins.

`slashMenu` is the old name of the `slash.menu` view slot (see [views.md](views.md)): three faults (an exception, an async return, malformed lines, a call over the 4 ms budget) open the circuit breaker, the built-in layout draws again with one notice, and the view is not called again until reset in `/customize` > Views or reloaded.

Output is sanitized and bounded to the supplied size.

Extensions retain their existing trust/approval policy and run with user privileges.

Complete example, saved as `<dataDir>/extensions/my-menu.ts`:

```ts
export default {
  name: "my-menu",
  tui(api) {
    api.view("slashMenu", (ctx) => {
      const capacity = Math.max(1, Math.min(10, ctx.height - 2))
      const first = Math.max(0, Math.min(ctx.selection - capacity + 1, ctx.items.length - capacity))
      const body = ctx.items.slice(first, first + capacity).map((item, offset) => [
        { text: first + offset === ctx.selection ? "> " : "  ", fg: "primary" },
        { text: item.label, fg: item.command?.setting ? "muted" : "text" },
        { text: item.kind === "group" ? `  ${item.count} / ${item.preview}` : `  ${item.group}`, fg: "muted" },
      ])
      return [
        [{ text: ctx.query ? `Search: ${ctx.query}` : `Commands / ${ctx.group}`, fg: "primary" }],
        ...body,
        [{ text: `${ctx.items.length ? first + 1 : 0}-${Math.min(first + capacity, ctx.items.length)} of ${ctx.items.length} / up-down select / enter run / tab group`, fg: "muted" }],
      ]
    })
  },
}
```

### Manage views and terminal extensions

Advanced > Views says in one line that views are not sandboxed (they run with your permissions) and lists every view slot that has a custom view: owner, faults, last error and average time; Enter turns one off or on, `r` resets it, and the next row writes a starter file (`mendcode view scaffold <slot>` does the same).

Every part of the terminal that can be redrawn, the input each receives and the rules are in [views.md](views.md).

Advanced > Extensions lists terminal modules with on/off toggles and load/render errors.

Left/right select a module; enter/space toggles it.

Export look writes the current profile as a new user extension and reloads it.

Every customize key is also available through `api.settings.get/set`, and the permission-gated `customize_ui` tool can apply profile values or write/edit a confined user extension.

`/extensions reload` retries loading; user extension edits reload automatically via the daemon.

See `extensions-tui.md` for the complete API and examples.

### Navigate the controls

| Key | Does |
|---|---|
| up/down | Select a row. |
| left/right or Space | Apply a choice; left/right also step a number. |
| Enter | Edit text or a number and save it. |
| `/` | Filter by name, section or what rows change; Enter goes to the picked row, Esc clears the filter. |
| Esc | Cancel an edit or close the page. |

A row that depends on something switched off is hidden with it (Top bar off hides what the bar shows, a raw chat hides Markdown, footer rows hide the one-row footer parts).

The picked row says what it changes.

Custom ASCII accepts pasted newlines or Ctrl+J.

Invalid phase JSON and border glyphs keep the editor open with an error.

### Read the live preview

The preview draws the part of the screen the row changes, with the real renderers: the home with the prompt where Input position puts it (and the pet mascot the home shows), a sample conversation with Markdown, a tool, a diff and the top bar, the prompt with its status line and the footer the chat draws (the user's own footer rows and extensions included), the activity status, the Markdown sample, the diff, the image wait; a row with nothing to draw (keys, notices, processes) shows what it does, its value, default and choices.

Choices are grouped with a live preview on the right from 90 columns (the choices take half the width up to 120 columns), stacked below on smaller terminals, where a short screen gives the choices a third of the rows and a tall one a quarter.

The label column fits the longest label when there is room; on a narrow screen a long label is cut with `…` instead of running into its value, and a row's note wraps under it.

The session section previews the actual conversation, or `No conversation yet`; activity previews use the current phase.

No sample sessions or invented model facts are displayed.

`/settings` uses a separate, labeled demonstration for theme, view, motion, pet and footer: real transcript/tool/footer renderers, with no tool execution or provider calls.

Changes update the sample immediately; other rows explain options, the current value and storage.

The detail pane stacks below the rows under 90 columns.

Pets occupy only transcript space, above requests, queues, limit bars and bottom sheets, and hide when there is no free space.

| Section | Controls |
|---|---|
| Look | Theme, glyph set, session accent, diff view; Markdown (table and heading style, copy hints, right-to-left, colors), hidden while the chat is raw or plain |
| Home | Logo: kind (`wordmark`, `mascot`, `both`, `custom`, `none`), then only what that kind draws (the letters and font for a wordmark, your own art for `custom`, the mascot with its motion and size), product name, tagline. Layout: centered/split, where the chat input sits (`homeInput`: `bottom`, `center`, `top`), the panel and what it holds, density, header, tips (listed only when there are tips), footer, the example text in the empty prompt |
| Prompt & footer | Prompt: chrome preset, border style and glyphs, lead, the status line in the top rule (`promptStatus`), where attachments show. Footer: on/off, preset, rows, texts, icons, separator, the one-row parts (agent, model, provider, effort; hidden while footer rows draw the footer), permissions, hints, today. Segments and Quota. |
| Chat | Messages (presentation, renderer, labels, icons, leads, tint, username, meta, timestamps), Tools (reasoning, tool layout, output, density, code map card, transcript images), Scrolling (submit scroll, scrollbar, jump to latest, pinned prompt) |
| Activity | Status (placement, parts, elapsed, tokens, hints, model, completion symbol), Notices, Mascot (activity mascot, phase art and text, the session pet and its size), Image wait, Compaction |
| Top & side | Top bar (on/off and what it shows), Sidebar & panel, Window title |
| Input & keys | Typing (vim, Enter, `?` overlay, paste summaries, drafts), Esc, Mouse & keys, Files & links |
| Comments | Reply comments: key, hint, chips, folding, templates |
| Notifications | Bell, desktop notice, activity sound, recap on return, idle prompt, resume prompts |
| Advanced | Extensions, Views, Slash menu, Capabilities (prompt context, catalogue, code graph index), Terminal (image protocol, alternate screen, screen reader, processes, usage clock), reset |

### Choose a home logo

The wordmark left as shipped (Logo kind `wordmark`, text `MENDCODE`, font `mendcode`) is MendCode's logo: the website's infinity mark in 38 x 8 cells of half blocks (wider than tall, like the symbol), plain ASCII under `glyphs ascii`, over the name in big letters drawn like the website's wordmark. Where the big name does not fit (under 70 columns, or too few rows) the name is plain text under the mark; a terminal too small for the mark shows the plain name.

Any other text or font draws those letters, and beside a mascot (`both`) the title stays letters.

The fonts are `mendcode` (v1 pixel wordmark with block-only crossbars), `compact` (3 rows), `solid` (5 rows of square block pixels, two cells each), `shade` (the same in shaded blocks), `outline`, `rounded` and `double` (5 rows of single, round-cornered or double lines) and `braille` (2 rows of dots).

A wordmark wider than the home shows the plain name instead.

Each covers A–Z, 0–9 and ASCII punctuation.

Retired `small`, `standard`, `shadow`, `classic`, `opencode`, and the retired staircase `slant` profiles migrate atomically to `mendcode`, preserving the other valid choices.

### Place the home input

Home > Input position (`homeInput`, every tier, default `bottom`) is where the chat input sits on the start screen: `bottom` (over the footer, as in a session), `center` (right under the logo, the logo and the input centered together, the session list under them) or `top` (under the logo at the top).

The footer stays at the bottom; a slash menu opens over the rows above the input.

The split layout, a screen too small for the logo and the minimal view keep it at the bottom; once the session has a message the input is at the bottom as always.

### Choose a home layout and session

Ctrl+P → **Home welcome mode** opens the Centered/Split picker.

The palette also links to identity, title text/font, custom ASCII and the split panel.

Ctrl+S opens sessions on an empty home; its queue behavior during chat is unchanged.

Agent View lists the waiting, looping and working sessions whose folder is the one MendCode runs in (a folder inside it is another project, whose sessions show on its own home). The user's home folder is no exception: opened in `~`, it lists the sessions started in `~`.

Sessions that already run or wait for input in other terminals are there from the start, and its spinners and clocks move while one works.

Under Completed, as in v1, come the three most recently finished conversations of the last 30 days (not archived, not sub-agents), with how long ago each ended.

Down selects (up stays the prompt's history until a row is selected), Enter opens, Esc clears.

With no session at all the empty state is one line, "No sessions yet".

Split home has one full-width bordered hero with identity on the left and the selected panel on the right.

It falls back to centered at short/narrow sizes; oversized art falls back to the product name.

Density changes home spacing without scaling art.

No built-in tips are shown.

The tips preference remains stored; explicit integration tips can still use the existing markup renderer.

Extensions' welcome/header/footer slots retain their precedence.

`/setup` uses Checks and Choices panels side by side from 110 columns, stacked below that, and a home preview underneath.

Welcome mode, split panel and logo choices apply and persist immediately.

Narrow previews reserve room for the identity and omit the duplicate prompt.

### Choose a pet

`/pet` has a bordered preview to the right from 110 columns, below the list on narrower terminals.

It lists source and available states.

Up/Down selects; Enter chooses; `o` turns pets off; Esc returns.

Bitmap previews use the same sizing as chat: every pet is cut to what its frames draw (a Codex atlas cell is mostly transparent margin), and a Codex pet is enlarged by whole pixels so it stays crisp; transparent pixels keep the background.

In chat a bitmap pet waves once when the mouse arrives over it.

`/pet` always includes **MendAscii**, the built-in mascot drawn in colored half blocks (the little robot MendGirl holds: a round head with an antenna, happy eyes, pink cheeks, ear discs and a body with a cross), even without installed bitmap pets.

Its colors follow the theme: under Ink, the default, it is black and white (a white head, a graphite body with a light cross, pink cheeks); every other theme draws it in shades of its own primary color, and the Mend theme keeps the original mint head and teal body with a mint cross.

Where the terminal draws pictures (the image protocol the pets use) it is a picture of its own pixels, at the size every pet gets: beside the prompt by Pet size, on the start screen by Mascot size, in `/pet` the same cells as the others.

Elsewhere it is half blocks, whose pixels cannot be smaller than half a cell: 13 x 7 cells beside the prompt (a smaller robot lost its antenna's stalk and its cross) and 13 x 7 cells times the Mascot size (small 1, medium 2, large 3) on the start screen.

In chat its eyes follow the session: happy at rest, up while it thinks, right while it edits or runs, left while it reads or searches, closed when blocked, wide under the mouse, and its body turns red on an error.

A 16-color palette or ASCII glyphs keep v1's text mascot: the exact five-row home art and the 19 three-row activity states with the hover face.

User phase maps replace it with text, for example `{"testing":" .-.\n(o T)\n/[+]\\"}`.

Phase text maps accept strings or v1 arrays (the first text is used); art is bounded to five rows and 24 cells.

Blank restores defaults.

`/pet` also lists **MendGirl** (`builtin:mendgirl`), MendGirl with neko ears holding her little robot, drawn by MendCode's author and shipped inside MendCode, right after MendAscii. She is drawn in Ink's black and white: silver hair, a black hoodie with white patches and a white robot.

She is never the default: choose her in `/pet`, with `/pet builtin:mendgirl`, or as the start screen's mascot with `/mascot mendgirl`.

She behaves like an imported pet: her own frames for idle, thinking, running, waiting, review, failed, waving, jumping, compacting, agents and sleeping, a picture where the terminal draws pictures and half blocks elsewhere (beside the prompt, where half blocks are too coarse for her, the chat shows the ASCII Mend, as for any detailed pet).

Her picture is read and decoded only when she is shown, then cached like any pet's; she cannot be renamed or deleted.

### A pet on the start screen

![The start screen with an imported picture above the MendCode title](assets/mascot-welcome.png)

The start screen's mascot is a pet: any pet `/pet` lists can stand above or beside the title, and `/pet import` turns a picture of yours into one.

MendCode ships no character art for it.

The girl in these pictures is a **placeholder** computed by `apps/cli/test/mascot-sample.ts` to show what an import looks like; she is not a bundled mascot and cannot be selected.

| To | Type | Customize keys |
|---|---|---|
| Choose from a list (Mend, then every pet) | `/mascot` | |
| Show a pet with the title | `/mascot <name>` (its name, id or `user:<id>`) | `logoKind: "both"`, `homeMascot: "user:<id>"` |
| Show the ASCII mascot instead | `/mascot mend` | `homeMascot: "mend"` |
| Go back to the title alone | `/mascot off` | `logoKind: "wordmark"` |
| Hold it still, or let it move | `/mascot static`, `/mascot animated` | `mascotMotion: false`, `true` |
| Change its size | `/mascot small`, `medium`, `large` | `mascotSize` |

Mascot, Mascot motion and Mascot size sit under Logo kind in `/customize` Home; `logoKind: "mascot"` shows the pet without the title.

Nothing is on by default in any tier: the start screen is the title until you choose.

A pet mascot belongs to the pet companion feature, so it needs the `full` tier (or `features.pets: true`); below it, and in screen-reader mode, the same settings show the ASCII Mend.

A terminal that never shows a pet mascot loads none of the pet code.

`homeMascot: "mendy"`, the value of a hand-drawn sprite that was removed, reads as `mend`.

#### Importing a picture

```text
/pet import ~/art/aiko.png --name Aiko
/mascot Aiko
```

`/pet import <path> [--name N] [--frames COLSxROWS] [--ms N] [--filter pixel|smooth] [--no-key]` makes no image call and costs nothing; it reads local files only.

Quote a path with spaces.

The path can be:

| Source | Becomes |
|---|---|
| One PNG | A still pet |
| One PNG with `--frames 4x2` | A sprite sheet of equal cells: each row is a state (idle, running, waiting, failed, review, waving, jumping, in that order), each column a frame |
| An animated GIF | An animation with the GIF's own frame times |
| A folder of numbered PNGs (`1.png`, `2.png`, `10.png`) or one GIF | One animation, in numeric order |
| A folder of state folders or files (`idle/`, `working/`, `error.gif`) | One animation per state; unknown names are ignored and listed |

Use these state names for folders:

| State | Accepted aliases |
|---|---|
| `idle` | `rest`, `default` |
| `running` | `working`, `typing`, `busy` |
| `waiting` | `approval`, `asking` |
| `failed` | `error`, `sad` |
| `review` | `done`, `happy`, `success` |
| `waving` | `wave`, `hello` |
| `jumping` | `jump`, `celebrate` |
| `thinking` (import only) | `think`, `reasoning` |
| `compacting` (import only) | `compact`, `packing` |
| `agents` (import only) | `agent`, `subagents`, `delegating` |
| `sleeping` (import only) | `sleep`, `asleep` |

A state the pet lacks plays idle.

Frames without a time of their own last 120 ms (`--ms` changes it, 20 to 10000).

JPEG and WebP are not read; convert them to PNG first.

What a session's pet shows, the first that holds:

| State | When | Without it |
|---|---|---|
| `failed` | The turn ended in an error | idle |
| `waiting` | An approval or a question waits | idle |
| `compacting` | The context is being compacted (`/compact`, automatic, or while idle) | `running` |
| `thinking` | The model is reasoning: no answer text or tool yet in that step | `running` |
| `running` | The main agent answers or runs a tool | idle |
| `agents` | Sub-agents work: the main agent waits on its `task` call, or they work on after its turn | `running` |
| `review` | Four seconds after a turn | idle |
| `sleeping` | Nothing ran and nothing waited for five minutes | idle |
| `idle` | Otherwise | |

`waving` (a new session) and `jumping` (a finished loop) play once on top.

`thinking`, `compacting`, `agents` and `sleeping` are never generated and are not rows of a `--frames` sheet: add them as folders or files.

A Codex pet and a pet imported before them look as they did, except that sub-agents still at work after a turn keep `running` on.

A lone `thinking` without a `running` is stored as `running`, as before.

Sleep is one timer, set only for a pet with a `sleeping` state while it may move; the next turn wakes it.

What the import does to the picture:

#### Background

A picture that already has transparency is kept as it is. One without, whose four corners share a color, has that color removed from the border inward (a hole of the same color inside the character stays). `--no-key` keeps the background.
#### Kind

Pixel art (a clean integer enlargement, or at most 64 colors) is stored at its real pixel size and always resized without mixing colors. Anything else is smooth art, resized by area average. `--filter` overrides the guess.
#### Crop

Every state is cropped to what its frames draw, so the character fills its box.
#### Import limits

Decoded frames stay within 16 MB per pet and 200 frames:

| Frame count | Longest side, at most |
|---|---|
| Up to 8 frames | 704 pixels |
| Up to 15 | 528 pixels |
| Up to 33 | 352 pixels |
| Up to 60 | 264 pixels |
| Up to 135 | 176 pixels |
| Beyond 135 | 128 pixels |

704 is the largest box (22 rows) at 16 pixels a row, doubled for dense displays. A pet of all eleven states with 30 frames keeps 352 pixels and holds about 14 MB while it shows.

A picture is never enlarged on import. The stored sheet may not exceed 25 MB, the source file 32 MB or 4096 pixels a side.

The pet is saved as `<dataDir>/pets/<uuid>/pet.json` and `spritesheet.png`.

`/pet` lists it (source `imported`); `n` renames and `d` deletes it there, or `/pet rename user:<id> Name`, `/pet delete user:<id> --confirm`.

Two pets cannot share a name.

#### How it is drawn

![Pixel art and smooth art at the same size, in half blocks and through the image protocol](assets/mascot-compare.png)

| Terminal | Picture |
|---|---|
| kitty graphics protocol (kitty, Ghostty) | The frame at the box's real pixel size, soft edges kept; animated |
| iTerm2 inline images (iTerm2, WezTerm) or sixel | The same picture, held on its first frame |
| Truecolor or 256 colors without an image protocol, and inside tmux, screen, tuios or ssh | Half blocks: two pixels a cell, from the same frames |
| 16-color theme (`terminal`), `MENDCODE_GLYPHS=ascii`, an ASCII prompt border, `TERM=dumb` | The ASCII Mend |

The detection is the prompt pet's (the Image protocol row of `/customize` Terminal).

With kitty each frame is sent once and placed again by its id; the terminal keeps up to 64 pictures, so a longer animation sends its early frames again on the next loop.

Half blocks give a medium pet 32 by 32 pixels: a face reads, fine line work does not, and pixel art whose size is not a multiple of the box loses detail.

Smooth art in half blocks is sharpened once after it is reduced.

A pet that half blocks would shrink to under a third of its own pixels (a 64-pixel character in the small box, a detailed Codex pet in a multiplexer such as tuios) is noise there, so MendAscii stands beside the prompt in its place; a larger Pet size or a terminal that draws pictures shows the pet itself. 256 colors are visibly coarser.

`mascotSize` picks the box: `small` 24 by 12 cells, `medium` 32 by 16, `large` 44 by 22; a pet that is not square gets a narrower or shorter box of the same proportions.

While the pet code and the pet's frames load (the first frames of a start), the box is kept blank and the picture appears in it once; the ASCII Mend shows only when the pet turns out not installed.

The pet never takes a row from the prompt.

When the wanted box does not fit, the next smaller one is tried, then the ASCII Mend (sizes for the default prompt and footer and no sidebar; a taller prompt area needs as many rows more):

| Terminal | Start screen |
|---|---|
| 36 rows or more | `large` above the title |
| 30 rows or more | `medium` above the title |
| 26 rows or more | `small` above the title; `medium` at the left of the title from 92 columns |
| 24 or 25 rows | `small` at the left of the title from 84 columns, else the ASCII Mend above it |
| At most 23 rows or 64 columns | The plain name |

![The same start screen in half blocks](assets/mascot-welcome-halfblocks.png)

Beside or above the pet, the title runs from the theme's `primary` color to its `info` color; without it the title keeps the text color.

The split welcome layout keeps its text identity.

A pet with more than one frame animates with its own frame times, and plays `agents` (`running` for a pet without it) while the Agent View lists a session at work, then `sleeping` after five minutes with none.

A still picture has no timer at all, unless it has a `sleeping` state to wait for.

Nothing is scheduled while the start screen is not showing, the terminal reports it lost focus, `mascotMotion` is off or motion is reduced.

The ASCII Mend, as a 16-color or ASCII terminal shows it:

```text
  ~/code/acme-api                                    MendCode v2.0.0

                               .-.
                              (o o)
                             /|[+]|\
                            /_|___|_\
                               \_/

         █▄ ▄█  █▀▀▀  █▄  █  █▀▀▄  █▀▀▀  █▀▀█  █▀▀▄  █▀▀▀
         █ ▀ █  █▀▀▀  █ ▀ █  █  █  █     █  █  █  █  █▀▀▀
         ▀   ▀  ▀▀▀▀  ▀   ▀  ▀▀▀   ▀▀▀▀  ▀▀▀▀  ▀▀▀   ▀▀▀▀

                         No sessions yet
```

The pictures come from the render code itself: `bun scripts/render-mascot-docs.ts` imports the placeholder through `/pet import`, draws the start screen through the app and writes them to `docs/assets` (add a directory and `--evidence` for every input, size, theme and color depth).

### Experimental custom pet generator

Full tier only, local terminal only, never automatic.

1. Enable `image_generation` and choose its model. Generation is blocked by `features.pet_generator: false`, safe mode, deny rules and plan permission mode.
2. Run `/pet new a blue owl --usd 0.10` (or `mendcode --dir TEMP_DATA pet new "a blue owl" --usd 0.10`) to review the plan.
3. Press lowercase `y` to authorize the complete batch. Enter cannot confirm; Escape cancels.

`/pet new a blue owl --usd 0.10` (or `mendcode --dir TEMP_DATA pet new "a blue owl" --usd 0.10`) shows the description, states, model, **six image calls** and cost before any image call.

`--usd` is optional and is your estimated USD cost per call, not a fetched provider price or billing cap; without it the plan shows `est. cost  not set` and nothing is estimated or reserved (a configured USD stop then refuses the plan, because it cannot be checked).

`--optional` adds waving and jumping (eight calls).

Plans belong to one client and expire after five minutes.

Changes to image configuration require a new plan.

One neutral reference PNG is generated first, then each state uses that reference.

Core states are idle, working (`running`), waiting/approval (`waiting`), success (`review`) and error (`failed`).

Local processing crops visible pixels, downsamples by an integer using nearest-neighbour, quantizes to RGB332 and thresholds alpha at 128 into 32×32 transparent cells.

The existing PNG codec supports bounded, non-interlaced 8-bit PNGs; unsupported/empty/opaque output fails closed.

This first version repeats a single pose in each legacy animation row, rather than generating motion frames.

Missing optional and directional states use idle.

No image library is installed.

Installed pets use `<dataDir>/pets/<uuid>/pet.json` and `spritesheet.png`, with name, description, prompt, model and date.

Original reference and state PNGs stay private for regeneration.

`/pet` previews the result; Enter selects it.

| Command | Does |
|---|---|
| `/pet regen user:<uuid> waiting --usd 0.10` | Create a separately confirmed one-call plan. |
| `/pet rename user:<uuid> Blue owl` | Rename the pet. |
| `/pet delete user:<uuid> --confirm` | Move it to `<dataDir>/Trash`. |
| `/pet export user:<uuid>` | Export a non-executable profile in `<dataDir>/exports`. |

Regeneration swaps the complete pet atomically and keeps its previous version in Trash.

Profile exports contain the atlas and manifest, not editable source/reference images; imported profiles are previewable but regeneration requires the original installed source.

In API-usage budget mode the entire rounded estimate is reserved before any call, checked against `stopUsd`, and retained after failures.

Unknown prior costs block generation.

Subscription mode follows its existing budget policy.

Set a provider-side billing cap as well: the local gate cannot enforce actual provider charges or refund failed calls.

**Owner verification (not performed against a real provider):** use an explicit fresh temporary `--dir`, configure full tier and the existing image provider credentials there through the normal secure provider setup (OpenAI API key or Codex subscription adapter; do not add plaintext secrets to the repository).

Obtain a conservative current per-call estimate from your provider/account, set an API-usage `stopUsd` if applicable, then run the CLI form above.

Verify Escape causes no provider calls; repeat and press `y`, check six calls and the bill/account cap, consistent identity in all five states, transparent preview, and saved provenance.

Regenerate one state and check one additional call and unchanged other state PNGs; rename, export/package-check/install in a second temporary data directory, preview there, then delete the original and inspect Trash.

Repeat with a too-small USD stop, image generation disabled and a remote client: calls must be refused.

Subscription edits/PNG transparency depend on the selected model/account; an unsupported response must stop without installing a partial pet.

Real billing, character consistency and subscription behaviour remain unverified.

### Profile file

`<dataDir>/tui/profile.json` is terminal-local and validated by hand, without runtime schema imports.

Every control above persists there; writes are atomic.

Theme/pet/presentation inherit existing daemon settings until overridden.

Explicit `/theme`, `/view` and setup choices keep an existing local override in sync.

Pet selection retains its existing daemon-setting update as well.

Terminal title tokens are `{product}`, `{session}`, `{route}`, `{path}`, `{dir}` (folder name), `{activity}` (`working`, `needs input`, empty when idle), `{model}` and `{branch}`.

With `Title activity` on (default) a template without `{activity}` leads with `working · ` or `needs input · ` while a turn runs or waits for an approval or answer.

Reset restores the terminal settings defaults, preserving conversations and project data.

A missing/broken file uses defaults.

Other terminals read the profile on their next start.

Text controls strip terminal escapes; custom art preserves indentation/newlines.

No data directory means session-only changes with an explicit notice.

Activity sound is opt-in: `off` (default), `pulse` (completion, failure or approval), `hum` (working hum plus pulses).

It uses v1's original charge and three rotating WAVs.

Turning it off, cancelling, switching sessions or closing the terminal stops playback immediately; completion leaves a 140ms hum tail.

Historical/replayed events stay silent.

The hum plays once per busy phase, rather than looping.

Extensions use `api.settings.set("activitySound", "hum")` through the same profile path.

The BEL preference is independent.

Playback runs in the local daemon via ephemeral `audio.play {action: start|stop|pulse, scale?: 0..1}`; client helper `activityAudio()` does not replay requests on reconnect.

Remote sockets are refused, including authenticated loopback peers; the terminal never requests playback in remote mode.

Audio commands are stateful and excluded from read-only authority.

No listener or auth policy changes.

WAV copies live under the explicit data directory's `audio-sfx/`; system players (`afplay`, `ffplay`, `mpv`, `play`, `aplay`, `paplay`, `mplayer`, `cvlc`, PowerShell) are used without installing dependencies.

A missing player reports one error per opt-in; playback failures do not affect agent work.

Processes and watchdog/tail timers are owned by the connection and cleaned on disconnect or daemon shutdown.

### Chat selectors

Advanced > Processes (`processMode`, default `auto`) chooses how many processes a terminal uses: `daemon` always starts a separate daemon, `auto` runs it inside the terminal's own process when none is running and moves it to a separate process once another terminal (or the web UI, a peer) attaches and nothing is running, so killing or losing one terminal never interrupts another's turn; `solo` keeps it in the terminal whoever attaches.

Less RAM alone; a hard-killed hosting terminal interrupts its own running turn; slower first frame ([design](design/memory-single-process.md)).

It applies at the next launch; `--process` and `MENDCODE_PROCESS` override it; every tier's bundle is `auto`.

#### Screen-reader mode

Advanced > Screen reader (`accessible`, default off) is the screen-reader mode described in [accessibility](accessibility.md): inline screen, no mouse reporting, no animation, plain text (the screen and mouse part on the next launch).

#### Choose glyphs

Look > Glyphs (`glyphs`: `auto` default, `ascii`, `unicode`, `nerd`) is the one symbol set every view draws with, also chosen in `/setup`.

`auto` asks the terminal: ASCII on `TERM=dumb`, `linux`, `ansi` and VT consoles; Nerd Font icons only where the terminal bundles them (Ghostty, WezTerm); Unicode everywhere else; a font is never guessed.

`ascii` also turns every frame into printable ASCII on its way to the screen (box lines become `+-|`, arrows `<>^v`, accents drop, anything else `?` of the same width), so an extension's rows and tool output follow it too.

`MENDCODE_GLYPHS=ascii|unicode|nerd` overrides the setting for one run.

The prompt's `ascii-box` chrome and an ASCII prompt border keep their own ASCII marks without changing the rest of the frame.

#### Keep finished output in scrollback

Advanced > Alternate screen (`altScreen`, default on) turns the full-screen mode off for the next launch so finished output lands in the terminal's scrollback; `--no-alt-screen` does it for one run.

#### Notifications

Notifications > Desktop notice (`turnNotify`: `off`, `osc9`, `osc777`) makes the terminal raise a desktop notification when a turn finishes or fails and when the agent waits for an approval or an answer (replayed events stay silent; the text has control characters stripped); the bell stays a separate toggle.

Both wait for the window to lose focus (`notifyWhen`: `unfocused` default, `always`).

Notifications > Recap on return (`autoRecap`, off), Idle prompt (`idleReturn`: `off`, `30m`, `1h`, `3h`) and Resume prompts (`resumePrompts`, on) are described in [return](return.md).

#### Images, links and scrolling

Chat > Transcript images (`transcriptImages`, default on), Hyperlinks (`hyperlinks`, default on), File opener (`fileOpener`: `file` default, `vscode`, `vscode-insiders`, `cursor`, `windsurf`, `zed`, `idea`, `none`), Wheel lines (`wheelLines`, 1..20, default 3) and Right-click paste (`rightClickPaste`, default off) are described in `layout.md` (Images in the transcript, Links, Selecting text).

`/raw` toggles plain, copy-friendly output and `/find [text]` searches the transcript.

Both are described in `layout.md`.

#### Presentation selectors

`/prompt-chrome` (`chatinput`, `prompt-style`, `tui-prompt`), `/presentation` (`chat-presentation`, `render-mode`), `/message-rendering` (`message-renderer`, `markdown-rendering`) and `/submit-scroll` (`send-scroll`, `clear-submit`) open the matching selector; an argument applies a value directly.

Raw uses plain text and expanded reasoning; minimal uses Markdown and collapsed reasoning; MendCode uses the full native renderer.

Clear-submit starts the new turn at the top while older turns remain available by scrolling.

`/timestamps`, `/thinking`, `/scrollbar`, `/username`, `/terminal-title` and `/tips` are independent toggles with corresponding bindable actions; leader+H toggles tips.

Defaults show effort and omit built-in tips.

`/timestamps bottom|top|off` picks where the time shows: `bottom` (the default) ends each turn with a dim line such as `done 5:25 PM`, which also says how long the turn worked and what still runs; `top` puts the time over each message; `off` hides both.

A bare `/timestamps` switches between `off` and `bottom`.

Text of your own under a message is a view ([views](views.md#example-your-own-text-under-each-answer)).

#### Project prompt context

`/prompt-mode` (`prompt`, `modes`, `prompt-context`) opens the daemon-backed project prompt selector; an argument applies `minimal|focus|full|custom|cycle` directly.

Setup's Prompt context and Customize's capability choice open the same selector.

Custom reads the bounded project-local `.mendcode/prompts/custom.md`; absent or unsafe files keep the small MendCode boundary and show the reason.

Prompt choices persist per project in the daemon data directory, independently of the terminal settings.

See [prompt-modes.md](prompt-modes.md).

#### Script status segments

Status orders are comma-separated builtin names: `mode,model,provider,reasoning,variant,context,permissionMode,commandsHint,agentsHint,quota` (legacy `context` remains accepted but is ignored in the footer).

Colors are JSON such as `{"mode":"#70ffaf"}`.

Script segments come from extension-layer `statusline.json` (`left`/`right` with argv `command`, `refreshMs`, `timeoutMs`, `enabled`, `prepend`); project scripts require trust and run only while watched.

Scripts opt into multiline stdout with `{"rows":[[{"text":"main","fg":"#70ffaf","bold":true},{"text":" · clean"}],[{"text":"checks passed"}]]}`.

Up to four rows, 32 segments per row and 240 characters per segment are accepted; invalid/empty rows are skipped.

Segments concatenate within each row.

Explicit left rows own the left status area, as in v1; right rows align alongside them.

Legacy JSON arrays, `{segments}`, TSV and plain text remain one row (plain-text lines join with ` · `).

Both `MENDCODE_STATUS_FORMAT` and v1's `MEND_TUI_STATUS_FORMAT` advertise `rows-v1`.

`MENDCODE_USAGE_JSON` carries the provider quota the daemon last observed, `{"now":ms,"quota":[{"provider","window","usedPercent","leftPercent","resetsAt","observedAt","ageMs","stale"}]}` (a window not listed is unknown; the same list as `api.usage().quota`).

Rows are clipped to terminal cells, reserve height below the input, and disappear in shell/minimal view or when Status is off.

`footer.replace` overrides the whole footer; side slots combine row by row.

### Remaining v1 contracts

Activity history placement/style/max-line/collapse policy, image-generation waiting surfaces and arbitrary v1 profile zones remain outside these batches.

B59's compaction panels and follow-up editor are documented in [compaction.md](compaction.md); games await the restoration decision.

Native profile proposal/projection/rollback uses the control-plane commands documented in `automation.md`.

There is no matching renderer/import contract for them.

Custom color tokens remain available through the existing theme-file format; script status, widgets and runtime behavior use the existing v2 extension/settings APIs, rather than pretending that v1 JSON or plugin APIs are compatible.

Model roles remain in `/model` and `/settings`.

### Comments

The **Comments** group holds the settings of comments on an answer: whether they are on (`auto` is on in balanced and full, off in minimal), the key and the hint after a copy, where the chips go and how they look, how many comments at most, the margin marks, the reply-mode letters, whether the sent message is folded, and the wording of the message the model gets.

Every value, its range and its default are in [editor.md](editor.md#tiers-and-settings).

The wording rows take `\n` for a line break and are refused without their required placeholders (`{comments}`; `{quote}` and `{text}`).

`/comments settings` opens the group.


## /settings

Open `/settings` to edit daemon settings in five groups: Appearance, Behavior, Models, Memory, Storage. The first rows link to `/customize` and `/extensions`.

Changes go out as `settings.set` and apply at once. Clear a value to send `null`.

The profiles list is read-only here. Use `/profiles` to manage it.

## /status

Open `/status` for read-only facts from existing queries and the session's own state:

- `daemon.info`
- `models.list`
- `mcp.status`
- `storage.report`
- `extensions.list`

Anything no query answers shows `unknown`: daemon uptime and language servers (LSP) today. A failed query shows its message instead of the facts.

Fact panels have borders from 100 cells and stack below that width.

| Key | Does |
|---|---|
| `r` | Refresh. |
| up/down | Scroll. |
| esc | Close. |

## /extensions

Open `/extensions` to inspect two lists:

| List | What it shows |
|---|---|
| What the daemon found for this project | Source, trust, daemon and tui halves, tools, commands, hooks, load errors. |
| What the terminal halves registered here | Slots, keys, commands, pages, renderers, with their errors. |

The page also shows problems no extension owns: invalid `keybindings.json` entries and key conflicts.

| Key | Action |
|---|---|
| up/down | select |
| enter | open or close the row's details |
| `t` | trust or untrust the project's extensions (`tools.trust`, same as `/tools`) |
| `r` | list again |
| `/extensions reload` | reload modules and report load errors without restarting |
| esc | close |

See `docs/extensions.md` and `docs/extensions-tui.md` for writing extensions.

## UI-7 message and prompt chrome

### Message layout and metadata

Messages default to `quiet`: a full-width subtle user tint with `›`, an assistant `•`, and no role labels or completion metadata.

`Message layout: classic` restores the prior headers.

Per-role icon, lead, labels, user tint and `Message meta: off|compact|full` preview live; metadata appears once per turn: model, `↑in ↓out`, the cost when every call of the turn had a price, the calls when there were several (a tool loop) and the duration; `full` adds the reasoning tokens and the share of the prompt read from the cache.

`full` renders Markdown, diagrams and tables; `markdown` keeps diagram source; `plain` renders unformatted text.

Legacy `rich` profiles normalize to `full`.

### Markdown controls

The `full` renderer has a Markdown group in `/customize` with a live preview: `Table style` (`auto|box|rules|grid|minimal`), `Heading style` (`auto|banner|bold|underline|uppercase`), `Copy hints` (`markdownCopyHints`: `auto|code|all|off`), `Right-to-left` (on by default) and `Markdown colors`, a JSON object that sets single slots such as `{"mdHeading1":"#ff8800","mdRule":"#444444"}` over the active theme (all 28 slots are listed in `docs/design/markdown-parity.md`; theme files may set the same names under `colors`).

`auto` means box tables, underlined headings and copy hints on code and tables in the full view, and bold headings with hints on code only in the balanced view; the minimal view and the `markdown` and `plain` renderers keep the classic look and have no hints.

Code blocks keep a header row with `copy`; a boxed table shows `copy` on its own top border (nothing when there is no room, as for narrow, `rules`, `minimal` and stacked tables).

Lists, quotes, diagrams and charts draw no button.

Click a visible `copy`, or press `ctrl+x Y` (`block.copy`) to copy any block, lists, quotes and diagrams included, nearest the middle of the screen; a mouse selection also copies them as usual.

The terminal theme keeps its own palette and ignores `Markdown colors`.

### Footer segments and telemetry

Seven more footer segments are placed through `/footer +id` (only `cache` is in a default order, the full view's: [layout.md](layout.md#footer-by-tier)): `cache` (share of prompt tokens read from the cache over the calls this terminal has seen), `tokens` (`in`, `out`, cache read `cr` and write `cw` totals), `effort` (drawn beside the model, as `showEffort` does), `jobs` (this session's running background shells and engine tasks; the chat already names them in the row over the prompt, so the built-in leading count is drawn only on other pages), `sandbox` (the configured mode, a setting and not proof of enforcement), `vim` (mode label) and `update` (a newer release was announced).

Totals cover the loaded history window plus live events.

Three more telemetry segments read the model calls this terminal has seen: `ttft` (first-token time of the last call that reported one), `tps` (output tokens per second after the first token) and `spend` (estimated session cost; nothing when no call had a known price, `<$0.01` under a cent).

`/footer stats` sets the telemetry order `state tokens cache spend ttft tps notice`.

When the footer overflows, the lowest ranked segment goes first (telemetry, then quota and today, then branch and model); `state`, `notice`, the goal and the context are the last to go.

### Place attachment chips

Prompt & footer > Attachments (`attachmentChips`, default `inline`) chooses where an attached image, PDF, external file or folder shows while the message is written.

`inline` puts a token in the text at the cursor (`[Image #1]`, `[PDF spec.pdf]`, `[codeconfig/]`) and sends the attachment at that place; `above` keeps the chip row over the prompt and sends the attachments after the text, as before tokens existed; `both` does both.

The tokens, their editing and what each provider receives are in [attachments.md](attachments.md#inline-tokens) and [editor.md](editor.md#attachment-tokens).

The setting is also reachable through `tui.change` (`{ "attachmentChips": "above" }`).

### Put status in the prompt border

Prompt & footer > Status line (`promptStatus`, default `off`) set to `border` draws `READY › model › effort › repo › branch › ctx 42%` in the prompt's top rule and leaves the row under the prompt with telemetry only (agent, permission, counters; a footer pack leaves out the folder, branch, model, effort and context).

While a turn works the activity takes `READY`'s place in that line (`⠋ Running cd … (11s · ↓ 644 tokens) › model › …`), and no activity row of its own repeats it; the parts after it give way first when the rule is short.

It applies to the rule, box and ASCII box presets, never to the minimal view or the tinted `minimal` preset.

Top & side > Right bar width (`sidebarWidth`, 0 is automatic, else 32..80) is the same setting as `/panel width`.

### Stalls, limits and cache notices

The working row adds `no response for 1m 2s` and a warning-colored spinner when a generating turn with no tool running has produced no event for 45 s (`Stalled hint`, on by default; long shell commands and approval waits never count, and neither do models run by an external harness, Claude Code, Codex, pi or ACP, which go quiet while they think and retry on their own).

A model that reasons (one with efforts, at any effort but `none`) often thinks without streaming words: its silence reads `Thinking...` with a normal spinner, and becomes `no response for` only after 5 minutes, Codex's own stream idle limit.

`Limit notices` (on by default) raise one toast per crossing when a provider quota window passes 75 % and 90 %, and when it is reached (with the reset time, `/model` and `/usage`); a window that resets re-arms them.

The context has its own line in the transcript, the [notice before a compaction](compaction.md#notice-before-a-compaction), which follows the `compact_notice` feature and the `compactNoticePercent` setting rather than this key.

`Cache notices` (off by default, opt-in) add muted transcript lines: `cache miss` (a call read under a tenth of what the previous one cached, with the reason: idle past the cache lifetime or prompt prefix changed; model switches and the call after a compaction are expected and skipped), `thinking off for this call` (Anthropic calls whose tool loop has no signed thinking from this model) and what a compaction's own model calls cost.

### Quota and today

Quota and today are opt-in footer items, both off by default.

Their Customize toggles also update an existing daemon footer list.

The quota item shows each provider window with a bar, its percentage and the reset countdown (`resets 5d11h`).

`quotaView` (`used`, the default, or `left`) chooses which number the bar and the percentage show (`92% left`), and `quotaColor` (`pressure`, the default, or `accent` for the theme's primary role) the bar's colour.

A window that has already reset shows `n/a`.

A reading older than 15 minutes inside a live window keeps its number, muted, with a compact age (`62% left ~2d`), never as current; a fresh one keeps the reset countdown.

`quota` is also a status item: `statusLeft` / `statusRight` accept it and print the windows as plain text.

The built-in footer takes any number of rows as settings, see [Footer rows](#footer-rows); script `rows` add up to four and `footer.*` slots up to twelve.

Quota refresh (`quotaRefresh`, off by default) asks the provider for the windows on a timer, see [usage-limit.md](usage-limit.md#quota-refresh).

#### Footer packs

A footer pack is a whole footer look in one data file: which segments, on which side, in what order, the separator, the glyphs, how the context reads and the theme roles each part is drawn in.

No pack runs code.

The setting `footerPack` chooses one (`/footer pack NAME`, or Prompt & footer > Footer pack in `/customize`); balanced and full draw it, the minimal view has no footer of its own.

| Pack | What it draws |
|---|---|
| `clean` (default) | one quiet row: `~/Code/app · main` on the left, `GPT-6-Luna · high · ◔ 24%` on the right; text only: `ctx 24%` |
| `powerline` | coloured segments joined by powerline arrows (U+E0B0, U+E0B2, round caps U+E0B6 and U+E0B4), the repo and branch with git's state (`+2` staged, `*3` unstaged, `?1` untracked, `↑1` ahead, `↓2` behind), model and context; needs a Nerd Font, any other glyph set draws flat blocks |
| `minimal` | `GPT-6-Luna · ◔ 24%` |
| `badges` | coloured ` BUILD ` and permission badges, then the context against its real limit (`48K/200K`) |
| `bars` | three rows: who answers; the context as a bar (`ctx ▕█▌░░░░▏ 24%`); every quota window as a bar |
| `plain` | words only, for a screen reader or a font without symbols: `[BUILD] \| dir ~/Code/app \| git main \| model GPT-6-Luna \| ctx 92% near limit`; colour is never the only signal |

Every pack has a form without symbols: `footerPackSymbols: text` (or `/footer pack clean text`) draws words only; `auto`, the default, follows the terminal's glyph set (`glyphs`: Nerd Font, Unicode or ASCII), and screen-reader mode is always words.

`footerPack: off` is the built-in footer of before (the grouped row, and in the full view the `line` rows below).

##### What shows only when it matters

| Part | When it shows |
|---|---|
| Changes (`+120 -4`) | Only when there are some. |
| Running shells, sub-agents, loops and workflows | Only while there are live ones. |
| Session cost | Only above zero. |
| Quota window | Only with less than 20% left: `5h 12% left`, `quotaBelow` in the file. `bars` shows every window. |
| Agent name | Only when not `Build`; a badge always names it. |

A permission that acts without asking and a lost connection always show, even in a pack that leaves them out.

The context turns the warning colour at 70% and the error colour at 90% of its limit (`contextWarn` in the file).

##### Keep your own footer

A pack never draws over a footer you made: `footerRows` (yours or a preset's), `/footer preset classic`, a `/footer` segment list, a `statusLeft` or `statusRight` template, a status line script, an extension's `footer.*` slot or a footer view.

Then the pack stands aside and `/footer pack` says so; `footerPackStack: true` (`/footer pack NAME stack`) draws the pack above your footer instead, and `/footer reset` gives the place back to the pack.

##### With the status line in the border

With `promptStatus: border`, the pack leaves out what that line says: folder, branch, model, effort and context. Nothing is said twice; a footer of your own is drawn as written.

##### Make a footer pack

1. Put `footer-packs/<name>.json` in your data folder, in a project's `.mendcode/` or in a profile.
2. Set `footerPack` to its name. A file wins over a built-in of the same name.

A pack whose file is broken is a startup notice and the footer stays `clean`.

The fields:

```json
{
  "label": "Mine",
  "help": "one sentence for /footer pack",
  "rows": [{ "left": ["directory", "branch", "diff", "jobs", "agents"], "right": ["permission", "quota", "cost", "model", "effort", "context"] }],
  "separator": " · ",
  "context": "percent",
  "labels": { "context": "ctx" },
  "colors": { "directory": "muted", "model": "text" },
  "backgrounds": { "mode": "primary" },
  "quotaBelow": 20,
  "contextWarn": [70, 90],
  "symbols": { "unicode": { "context": "pie", "labels": { "context": "" } }, "nerd": { "icons": { "branch": "" } } }
}
```

`rows` (1 to 6) hold `left` and `right` lists of segments: `area` (`◆ name` of a settings area other than personal; it leads the first row when a pack leaves it out), `directory`, `branch`, `git` (branch with git's state), `diff`, `model`, `effort`, `context`, `quota`, `cost`, `jobs` (shells), `agents` (sub-agents, loops, workflows), `goal`, `mode` (the agent), `permission`, `connection` and `hints` (`ctrl-p commands` and the like).

`style` is `line` or `powerline`; `context` is `percent`, `pie` (`○ ◔ ◑ ◕ ●`), `fraction` (`48K/200K`) or `bar`; `quota` is `percent` or `bar`; `chips` is `fill` or `brackets` (`[PLAN]`); `words: true` says states in words too.

`colors` are the text's theme roles, `backgrounds` make a segment a chip of that role (in `powerline` every segment is one).

`icons` and `labels` put a glyph or a word before a segment; `arrows` (`left`, `right`) and `caps` (`start`, `end`) are powerline's joins.

The file's own fields are the form without symbols; `symbols.nerd`, `symbols.unicode` and `symbols.ascii` change what they name for that glyph set, and a set the file leaves out falls back to the next one down (nerd, unicode, ascii, then the text form).

The built-in packs are the same files, in `apps/cli/src/view/footer-packs/`.

##### Ship a pack in a profile

 A profile ships `footer-packs/<name>.json` and chooses it with `activate.tuiProfile.footerPack`; turning the profile off takes both away ([profiles.md](profiles.md)).

#### Footer rows

##### Configure rows

Configure footer rows with settings; no extension is needed.

| Setting | Does |
|---|---|
| `footerRows` | List of rows, each a list of segment names. Up to 12 rows and a quarter of the terminal height; last rows drop first on a short terminal. |
| `footerIcons` | `none` by default, `glyph` or `nerd`; ASCII mode shows none. |
| `footerText` | Name to line, or a list rotating per day, for the `text:<name>` segment. |
| `statusSeparator`, `statusColors` | Set the look. |

Rows belong to the chat, so pages such as `/profiles` do not carry them. The minimal view has no footer of its own but draws rows when they are set.

##### Available row segments

Available segments include `directory`, `branch`, `model`, `effort`, `context`, `cache`, `tokens`, `quota`, `quota:<provider>`, `codegraph`, `text:<name>`, `time`, and the older ones above.

The `effort` segment adds the `:JEV` marker when adaptive reasoning is on.

| Code graph state | `codegraph` text |
|---|---|
| Off | `graph off` |
| On, not yet indexed by a code graph tool | `graph on` |
| First build | `GRAPH indexing…` |
| Indexed | `GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed`, plus `· ~N saved` when the session counts it. |

The daemon pushes counts when the index changes, not per frame. They reflect the last time a graph tool ran in that project.

A row that does not fit drops its lowest-priority segments from the right, then ends in `…`; it never wraps.

Text segments (`text:<name>`, `directory`, `branch`, `goal`) are cut with `…` to the room left before they are dropped, and go only when fewer than six cells remain.

##### Choose a row preset

Use `/footer preset NAME` to choose a preset:

| Preset | Rows |
|---|---|
| `classic` | The single row of balanced; in the full view it turns the default below off. |
| `line` | One row: directory, model, effort, cache share, quota windows, code graph. |
| `rows` | Five rows: directory and tagline, model and context, the Codex quota, the Claude quota, the code graph. |
| `compact`, `telemetry` | Additional presets. |

With `footerPack: off`, the full view starts with `line`; otherwise the default is the `clean` pack. See [Footer packs](#footer-packs).

The full view draws that preset when all these conditions hold:

- `footerRows` is empty.
- `footerDefaultRows` is on, the default.
- `/footer` placed no segment list.

It uses `quotaView: left` and `quotaColor: accent`, keeping any profile value other than the default `used` / `pressure`.

It hides items with nothing to say: no Codex or Claude quota reading, a graph not counted yet, and the cache share until the second call.

It does not repeat the context: that is the top bar's Context bar (`contextBar`), and `context` stays a segment you can place.

`footerIcons` picks the marks in front of each item: `none` (the default), `glyph` (plain symbols) or `nerd` (Nerd Font symbols, for a terminal font that has them).

When the row is too wide the quota windows lose their bars and reset times first, then the lowest-priority items give way (the code graph, the effort, the cache share, the quotas); balanced and minimalist are unchanged, and rows you set are drawn as written.

`/footer rows N` and `/footer row N …` start from the rows on screen; `/footer reset` returns to the default.

`/footer rows N`, `/footer row N a b c`, `/footer icons nerd` and `/footer reset` edit the same keys; `/customize` has the same rows under Prompt & footer.

`/footer preset rows` with `/footer icons nerd` gives a five-row footer without an extension.

Data MendCode has no source for (whether the graph is synced with the disk: the index refreshes when a graph tool runs) has no segment; an extension slot is for that only.

The source of every figure is described in [extensions-tui.md](extensions-tui.md#usage-and-provider-quota).

Context has one top-bar setting; the retired footer context field is accepted for wire compatibility but ignored.

Every prompt preset keeps the footer outside the input.

Minimal uses `promptBg` and a blank row before the footer.

ASCII box uses box-drawing glyphs unless `Prompt border: ascii` is selected.

Built-in theme borders meet 3:1 against their backgrounds; active borders are stronger.

### Session pet placement and size

`/pet off`, `o` in the picker and the Customize Pet toggle switch off immediately and persist.

Enter on that row opens the picker.

Choosing a pet in `/pet` also makes it the start screen's mascot (`/mascot` still sets the start screen alone).

`/pet` lists the built-in `Mend` and MendGirl, then the pets in `<dataDir>/pets` (and in enabled profiles) under their own names; another program's pets folder, such as Codex's, is not read.

Pixel previews use integer scaling, at most 16 terminal rows, centered.

In chat the pet's feet meet the prompt's top edge.

`petSize` (`/pet small`, `medium`, `large`, or Pet size under Pet in `/customize` Terminal) picks the session pet's box: `small` 10 by 5 cells (the default), `medium` 16 by 8, `large` 24 by 12 through an image protocol; 15 by 8, 24 by 13 and 36 by 20 in half blocks.

Every pet is the same height at rest, whatever its sheet's margins: its idle figure stands three quarters of the box (4 of the default 5 rows), and the quarter above is room for the frames that reach past it, a jump or a raised arm.

A pet whose frames reach further fits them all and stands lower.

The same rule sizes the start screen's pet mascot (`mascotSize`) and the `/pet` preview, so a pet you make with `/pet import` matches MendAscii, MendSprite and MendGirl.

An imported pet that is not square takes a narrower or shorter box of the same proportions.

A Codex-format pet grows by whole pixel steps only, so it can look the same at two sizes.

A pet whose box does not fit above the prompt is not drawn.

### Terminal palette and restored themes

UI-8 adds `terminal`: all roles use the host's ANSI 0–15 palette or default foreground/background.

Even explicit content RGB colors are quantized to ANSI 16; text never emits truecolor or 256-color SGR under this theme.

Its contrast is owned by the terminal, so RGB/F15 tests explicitly exclude it.

The missing v1 dark themes `cursor`, `lucent-orng`, `mercury` and `vesper` are available; `matrix` now carries v1's panel, diff and syntax tokens.

Ported palettes keep the existing contrast adjustments, including borders ≥3:1 and stronger active borders.

### Activity status

The current-task row has been removed in every tier and density; `/activity` controls only the working status below.

Lists remain in the transcript, Todos dock and sidebar.

Top & side > Dock jobs (`dockJobs`, default `false`) opts into the Jobs dock panel in balanced/full; it adds no chrome to minimalist and does not hide `/jobs`.

Where the working status ("⠋ Running command… (2m 53s · ↓ 4.3k tokens)") is drawn is one setting, Activity > Activity status (`activityPlacement`, `/activity`):

| Value | Where | Rows used |
|---|---|---|
| `transcript` (default) | The classic row between the transcript and the prompt | One, taken from the transcript while a turn runs: the text moves up by a row when the turn starts and down when it ends |
| `above` | Over the left of the prompt's top rule: `── ⠋ Running command... · 2m 53s ──────` | None. With `promptStatus: border` the status takes the rule while a turn runs and the status line comes back after it |
| `inside` | At the right of the prompt's first row | None. The typed text and the cursor stay where they are; the status steps down (all parts, then spinner, phase and time, then spinner and time) and leaves when the text needs the room, never cutting a character of it |
| `off` | Nothing; only a retry notice and the `[esc again to interrupt]` hint keep their row | None |

`above` and `inside` change nothing on screen when a turn starts or ends.

Reduced motion (`/reduced-motion`) draws the same still spinner glyph in every placement.

`Show activity` off still hides the status in all of them.

The default stays `transcript` because it is today's look and the golden frames protect it; `above` is the placement to try first.

What the status shows is `activityParts`, an ordered, comma separated list (Activity > Activity parts, or `/activity` with part names in the order wanted; `/activity +tps -model` adds and removes, `/activity reset` restores the default).

The parts: `spinner`, `verb` (the phase text), `elapsed`, `stalled` (the `no response for 1m 2s` hint), `model`, `tokens` (this turn's tokens, see below), `tps` (output tokens per second, off by default), `interrupt` (the Esc hint), `queue` (`1 queued`, off by default), and the session figures of the table below.

The default list is `spinner,verb,elapsed,stalled,model,tokens,interrupt`.

The older toggles (`Show elapsed`, `Show tokens`, `Interrupt hint`, `Stalled hint`) still switch their own part off.

Two settings with no row on the page (set them in the profile file, or with `customize_ui`) shape the look:

- `activityStyle` (`inline`, the default, or `classic`).

`inline` reads like Claude Code: the spinner and the verb, then every data part between parentheses, set apart by ` · `: `⠋ Running command… (2m 53s · ↓ 88.6k tokens)`.

The spinner, the verb and the Esc hint stay outside the parentheses; the order inside them is the order of `activityParts`.

`classic` is the older single run of parts with two blanks between them: `⠋ Running command...  2m 53s  ↑45.2K ↓88.6K tokens`. - `activityTokens`, a comma list of `out`, `in` and `cache` saying which figures the `tokens` part shows, in that order.

Empty (the default) is `out` for `inline` (`↓ 88.6k tokens`) and `in,cache,out` for `classic`.

`in` is what the turn's calls sent that the provider had not cached, `cache` what they resent and the provider read from its prompt cache (`+1.5M cached`; every call resends the whole context, so over a long turn this is most of the traffic), `out` what came back, reasoning included.

To show the cache as well, set `activityTokens` to `in,cache,out`.

#### When token figures update

The sent and cached figures are exact: the sum of what the provider reported for the turn's model calls. The received figure is exact too once a call reports; while a call is still streaming, it also counts what arrived since the provider's last count, estimated, and then reads with a `~` (`↓ ~4.3k tokens`). When the call reports, its exact count replaces the estimate, so a call is never counted twice.

The estimate counts the main agent's streamed answer and reasoning at about four characters a token. For thinking that streams no words, Claude Code sends its own running estimate of the thinking tokens, and MendCode shows that (whichever of the two is larger for the thinking). A sub-agent's words and tool output are not counted.

Who reports when: the native engine and Codex report per model call, so the exact figure steps up call by call and the estimate fills in between. pi also reports the message in flight, so the received figure is exact while it streams when the provider counts as it goes.

Claude Code reports the output of each call when that call ends; until then a long call, a long think included, shows the estimate. The sent and cached figures come with the turn's total when it ends.

An ACP agent reports no usage, so it shows only the estimate of what it streams.

When a model thinks without streaming anything at all (no words and no estimate), there is nothing to count: the row shows the verb and the elapsed time, `Thinking… (1m 3s)`, and no figure is guessed.

The running figure is only drawn: it is never stored, and the turn's usage record is the same as before.

### Session stats

One live value, `SessionStats`, holds the session's figures; every place that shows one reads it, so a number is the same everywhere.

It is folded from what the client already receives (`usage.recorded`, compactions, the model and its effort); it asks the daemon for nothing and runs no timer.

A figure with nothing behind it (no call yet, no known price) is absent and its part draws nothing.

| Field | Meaning |
|---|---|
| `calls`, `input`, `cacheRead`, `cacheWrite`, `output`, `reasoning` | Session totals. `input` is the prompt not served from the cache; `reasoning` is what the provider reported on top of `output` |
| `cachePercent` | `cacheRead` over the whole prompt (`input + cacheRead + cacheWrite`), 0 to 100 |
| `lastPrompt`, `lastCacheRead`, `lastCachePercent` | The last call's prompt, the part read from the cache, and its share |
| `contextTokens`, `contextLimit`, `contextPercent`, `contextApprox` | Tokens the conversation occupies after the last call, the limit (the compaction threshold, or the engine's own window), the share (may pass 100) and whether the engine's numbers had to be clamped |
| `costMicros` | Estimated spend in micro-USD, only for models with a known price |
| `tokensPerSecond`, `firstTokenMs` | Speed and time to the first token of the last call that reported timing |
| `forecastTurns` | Turns left before the compaction threshold, from the growth of recent turns |
| `model`, `effort` | The session's model as shown and its reasoning effort |

One registry names the figures (`apps/cli/src/view/stat-parts.ts`): each part has a label, a short and a long form and a colour by threshold (cache green from 60 % and amber under 25 %, context amber from 60 % and red from 85 %, first token amber over 8 s, forecast amber at 3 turns or fewer).

Where each part can be placed:

| Part | Shows | Footer (`/footer +id`) | Activity status (`/activity +id`) | Top bar (`topbarStats`) | Sidebar `stats` card |
|---|---|---|---|---|---|
| `cache` | session cache share | the full view's model row, from the second call | yes | yes | yes |
| `hit` | last call's cache share | opt-in | yes | yes | yes |
| `ctx` | context against the threshold | opt-in | yes | yes | yes |
| `tokens` | prompt, output, cache reads and writes | opt-in | this turn's numbers | yes | yes |
| `think` | reasoning tokens | opt-in | yes | yes | yes |
| `calls` | model calls | opt-in | yes | yes | yes |
| `spend` | estimated cost | opt-in | yes | yes | yes |
| `tps` | output speed | opt-in | this turn's numbers | yes | yes |
| `ttft` | time to the first token | opt-in | yes | yes | yes |
| `effort` | reasoning effort | beside the model (`showEffort`, on by default) | yes | yes | yes |
| `forecast` | turns to compaction | follows the `forecast` tier feature | yes | yes | yes |

#### Footer

each segment's place by view is in [layout.md](layout.md#footer-by-tier).

The balanced footer carries the forecast and none of the others.

The full view puts the session's cache share in its default model row from the second call: the first call of every session is cold, so `cache 0%` in amber after the first message would be noise.

`/footer +cache` places it anywhere, at once.
#### Top bar

(`topbarStats`, Session chrome, a comma list such as `cache,ctx`, empty by default): drawn at the right of the bar and only when it fits after the path; the stats give way first.
#### Activity status

add the names to `activityParts` (see above).
#### Sidebar

`{ "type": "stats", "options": { "text": "ctx,cache" } }` draws one row per part, label left and value right; `text` picks the parts and their order (the default is `cache,hit,ctx,tokens,calls,spend,forecast`).
#### Extensions

`api.stats()` and `api.onStats()` give the same value ([extensions-tui](extensions-tui.md#session-stats)).

### Scrolling

Three settings under Session chrome (each also has a command) shape what the transcript draws about its own scroll position:

#### Scrollbar

(`scrollbar`, `/scrollbar auto|always|off`; bare `/scrollbar` flips between `off` and `always`).

`off` is the default and today's look.

`auto` draws a one-cell bar at the right edge of the chat column while the view is off the bottom and for 1.2 s after any wheel, key or drag; `always` draws it whenever the transcript overflows.

The thumb is as long as the view is of the whole transcript (at least one cell) and sits where the view is.

Click the track above or below the thumb to page toward it; drag the thumb to scroll (the drag follows the pointer until release).

A legacy `scrollbar: true` profile reads as `always`.

With `auto` or `always` one column is kept free at the right of the transcript for as long as the mode is not `off`, so the bar showing or hiding never reflows the text; switching the mode is the only change.

Inline mode draws no bar.

The thumb is the theme's `primary` (bold) and the track its `border`, so both light and dark themes follow; `Scrollbar glyphs` (`scrollbarGlyphs`) takes the thumb then an optional track, for instance `█░`, and a thumb alone (`█`) draws no track.
#### Jump to latest

(`jumpHint`, `/jump-to-latest right|center|left|off`, alias `/jump`).

Whenever the view is off the bottom a pill, an accent arrow on a panel fill, is drawn on the row above the prompt's top rule: `↓ latest · End`, or `↓ 12 new · End` when rows arrived below while the reader was away (`· End` only while the prompt is empty, because only then does the key scroll).

Clicking it or pressing End follows the newest output.

`right` is the default; the pill is kept inside the chat column, off the scrollbar and any sidebar.

It never covers text: when the last line reaches it, the pill takes a row of its own and the transcript shows one row less while it is up.

`Jump text` (`jumpText`) is a template: `{n}` is the rows that arrived below, `{key}` the key while it works (`{n} below · {key}`); empty restores the default.
#### Tool layout

(Chat > Tool layout): one choice that sets the three tool card rows together.

| Layout | Result | Keys: output, density, code map |
|---|---|---|
| `quiet` | Fold every card and the code map. | `toolOutput: collapsed`, `toolDensity: calm`, `codeMapCard: folded` |
| `default` | Shipped look. | `auto`, `calm`, `auto` |
| `detailed` | Give every call a short preview and open the code map. | `auto`, `standard`, `open` |
| `everything` | Open every card in full. | `expanded`, `dense`, `open` |

It is not stored: the row shows the layout the three keys match, or `custom` after one of them is changed by hand, and left or right from `custom` start at `quiet` or `everything`.

The session preview beside it redraws at once.
#### Code map card

(Chat > Code map card, `codeMapCard`): how the engine's own code map starts in the transcript.

`auto` (the default) opens the card, the ASCII project diagram alone, in the full view and keeps one folded row in balanced; `open` and `folded` force either; the minimal view always keeps the row.

A click on the card or row opens or folds that one card and wins over the setting; `ctrl+o` opens them all.

The directory and hub lists are never drawn in the card ([code graph](code-graph.md)).
#### Tool density

(Chat > Tool density, `toolDensity`): how much of each tool card the full view prints.

`calm` (the default) keeps a short preview for the latest, running and failed calls and draws every other finished call as one row (kind, target, result count, duration) except a call that changed a file (edit, write, patch), whose diff or content always shows, and three or more looking calls in a row fold into `Read 4 files · Grep 3 patterns`; `standard` gives every call a short preview capped by kind (a read 3 lines, a grep 3 matches, a shell its last 3 lines, a JSON result as `object · 4 keys`); `dense` is the full view as it was, every call with its whole preview.

The balanced and minimal views ignore it; `toolOutput`, `ctrl+o` and a card opened by hand win over it.

See [layout](layout.md#tool-density-in-the-full-view).
#### Diff view

(Look > Diff view, `diffView`): how an edit's or patch's diff is drawn in its tool card.

`unified` (the default) is one column of removed and added lines; `split` puts the old file on the left and the new on the right, each with its own line numbers, a removed line facing the line that replaced it with the part that differs in bold, and a line too long for its half wrapping under its own indentation; `auto` splits only on a wide chat.

The width is the chat column's (the terminal less the sidebars, margins and scrollbar): `split` needs 100 columns and `auto` 160, and below that the card is unified, so a narrow terminal or an open sidebar never squeezes two halves.

A file that only gains or only loses lines (a new file, a deletion) stays unified.

`/changes` keeps its unified diff, where comments attach to rows.

Three more keys shape these cards and have no row on the page; set them in the profile file or with `customize_ui`.

`diffContext` (0 to 6, default 3) is how many unchanged lines a card shows on each side of a change, as Claude Code does; a gap between two changes is marked `⋯`.

`diffLineRows` (1 to 50, default 4) is how many rows one very long line (minified CSS) may take before it ends in `…`.

`toolRail` is a list such as `read:off,write:off,edit:off,apply_patch:off,notebook_edit:off` (the default) saying which tools draw the vertical rule beside their card: each entry is a tool name, a prefix ending in `*` or `*`, then `:on` or `:off`, and the last matching entry wins; a tool no entry names keeps its rule.

A card without its rule keeps its body in the same columns.

A Write shows the code it wrote as added lines, with the same limits and folding as an edit.

The Diff preview beside the row draws a sample edit the way the chat would now and says why: `Side by side: the chat is 160 columns` or `Unified here: split needs 100 chat columns, the chat is 80`.
#### Tool design

(Look > Tool design, `toolDesign`; balanced and full views, the minimal view draws tool rows): the whole look of the tool cards at once, as data.

`rail` (the default) is the kind's glyph, the label and target, a thin rule beside the body and tinted diff rows with line numbers.

`branch` starts every call with one bullet, writes the call as `Edit(src/a.ts)`, hangs the body from a branch mark on its first row and tints changed lines edge to edge.

`terse` keeps the kind's glyph and the target without the tool's name, has no rule, and draws a diff as coloured `+`/`-` signs without numbers or tints.

The Diff preview shows the sample edit in the chosen design.

A design is a JSON file, `tool-designs/<name>.json`, in a profile, in the data folder or in the project's `.mendcode/` (a later layer replaces the same name; the file name is the design's name).

Every field is optional and falls back to `rail`'s: `label`, `description`, `header` (`mark`: `kind` or `bullet`; `bullet`: a glyph or `[glyph, ascii glyph]`; `call`: `spaced` or `parens`; `label`: whether the tool's name shows), `rail` (`kind`: `line`, `branch` or `none`; `glyph`), `diff` (`tint`: `row`, `code` or `none`; `numbers`; `signs`), `output` (`rows`: 0 to 20 rows of a finished command's output in a collapsed card) and `colors` (theme roles such as `muted`, `success`, `diffAddedBg`, for `mark` and `rule` in the resting state, `label`, `target`, `number`, `added`, `removed`, `addedBg`, `removedBg`, `output`).

Glyphs take one cell.

A file with an unknown field or value is not used and the start-up notice names it; a `toolDesign` naming a design no layer has (a profile turned off) draws `rail`.

`toolRail` still decides per tool whether the rule shows.

Example: `{ "label": "Branch", "header": { "mark": "bullet", "call": "parens" }, "rail": { "kind": "branch", "glyph": ["╰", "`"] } }`.
#### File viewer

(Input & keys > Click on a path `pathClick`, Viewer line numbers `viewerNumbers`, Viewer wrap `viewerWrap`, Viewer takes focus `viewerFocus`; [file viewer](file-viewer.md)): `pathClick` is `auto` (a click on a path opens the file in the right slot where the `file_viewer` feature is on, balanced and full), `panel` (always) or `editor` (never: the terminal's own link, as before).

Numbers default on, wrap `auto` (`auto` wraps prose, `on` wraps everything, `off` cuts long lines), focus off (the prompt keeps the keyboard when a file opens).
#### Wheel

(`wheelLines`, default 3): rows moved by one wheel notch.

There is no acceleration; each notch is one scroll and the screen is drawn at most once per 16 ms however many notches arrive.

### Alt key label

Input & keys > Alt key label (`altLabel`, default `auto`) is how key hints write the Alt key.

`auto` follows the platform: `opt+q` on macOS, where the key is Option, and `alt+q` on Linux and Windows.

`alt`, `opt` (plain ASCII) and `symbol` (`⌥q`, `ctrl+⌥x`) force a form on any OS.

It applies at once to the footer and prompt hints, the slash menu, `?`, `/help`, `/keymap`, the tutorial and the toast after a copy.

Key names in `keybindings.json`, the docs and extensions stay `alt`, and `opt+q` or `option+q` are accepted there as the same key.

See [Option as Alt on a Mac](editor.md#option-as-alt-on-a-mac) for making a Mac terminal send Alt at all.

### Option characters

Input & keys > Option characters (`optionKeys`, default `auto`) is whether, on a Mac whose terminal types the character Option makes, a lone `œ` (Option+Q on the ABC layout) runs the alt binding it stands for instead of being typed.

`auto` does it where the binding means something (comment on a selection, the comment list with comments, the empty-prompt keys); `off` always types the character.

It is per keyboard layout and stops for the session once a real Alt key arrives.

See [The composed character](editor.md#the-composed-character) for the table and the false positives.

### Key reports

Input & keys > Key reports (`keyProtocol`, default `auto`) is whether MendCode asks the terminal for real key reports (the kitty keyboard protocol) so that Option+key arrives as Alt+key.

`auto` asks on macOS only and uses it when the terminal answers; `off` never asks.

Linux and Windows terminals are never asked.

Applies at once; `MENDCODE_KEY_PROTOCOL=0` also turns it off.

See [Real key reports](editor.md#real-key-reports-the-keyboard-protocol).

### Installed theme scopes (B65)

The [theme CLI](automation.md#theme-cli-b65) validates, installs and selects native or v1-format theme files.

A project-scoped selection takes precedence over the user's theme; `/theme` and Customize's Theme row then change only that project's selection, keeping the user's saved theme and other projects intact.

Without a project selection, existing user customization behavior is unchanged.

File changes are re-read on selection, including selecting the same name again; names remain case-preserving.

### Theme picker

`/theme` (alias `/themes`) and `ctrl+x t` open a picker listing `system`, every built-in and v1 palette and installed theme files, filtered as you type.

The whole UI repaints in the highlighted theme; Enter keeps and saves it, Esc restores the previous one.

`system` follows the terminal's light/dark mode (dark when the terminal cannot report it).

Ctrl+L, `/theme lock [dark|light]` and `/theme unlock` pin the mode `system` uses (`themeLock` in the terminal settings).

`/theme <name|system>` applies directly.

### Theme background

MendCode normally draws on the terminal's own background. When the theme's lightness does not match it (Paper, a light theme, in a dark terminal, or a dark theme in a light one), the theme's `background` is painted behind every cell instead, so the text stays readable.

The terminal's background is asked once when the full-screen chat starts (the OSC 11 colour and the DEC 996/2031 light/dark mode); later mode-change reports, theme changes (the picker's preview too) and resizes keep it in sync.

The colour is set as the terminal's default text, background and cursor colours (OSC 10/11/12), so the cells' own colours, selection, diff rows, panels and images draw as before; the terminal's colours are put back on exit, on `ctrl+z` and while an external editor runs. Those are the exact colours the terminal answered with at start (OSC 10/11/12 queries), so ones a shell or another program set survive; a colour it never answered, or one changed by a light/dark mode report, goes back to the terminal's configured default (OSC 110/111/112).

It stays off:

- when the theme matches the terminal, nothing changes;
- when the terminal never answers the OSC 11 query (`COLORFGBG` alone is a guess), or with `MENDCODE_TERMINAL_MODE=0`;
- for the `terminal` theme, which uses the terminal's own palette;
- in the inline chat (`--no-alt-screen`), whose output stays in the terminal's scrollback.

A theme file can set `"paintBackground"`: `"always"` paints its background whatever the terminal is (also one that never answered), `"never"` always keeps the terminal's; without it (`"auto"`) the rule above applies.

Usage scopes and widgets are documented in [usage.md](usage.md).

Setup also offers presets, API budget controls and a tool-less helper conversation; `/intro` replays the native mascot/wordmark sequence.

See [setup.md](setup.md) and [budgets.md](budgets.md).
