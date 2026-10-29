# View slots

A user file or a package can replace how any named part of the terminal is drawn: messages, tool cards, the
approval box, the prompt frame, the bars, the home screen and more. Every slot follows one contract, and the
built-in look is drawn through the same contract, so what a custom view receives is exactly what the default
receives.

Views are off until installed, work in every tier and cost nothing when absent (a terminal without extensions never
loads the machinery). Types for authors live in `@mendcode/extension-api/views` (types and one small constant table;
no zod, nothing that grows the terminal's startup).

```ts
import type { ViewRenderer } from "@mendcode/extension-api/views"
```

## The contract in three lines

1. A slot has a typed, serialisable **input**: the plain data the built-in renderer receives, plus `width`, `height`,
   `theme` (`{ name, colors }`), `ascii` (plain glyphs wanted) and `now`. Never app internals, never functions.
2. A renderer is a pure, synchronous function `input -> lines | undefined`. A line is an array of spans
   `{ text, fg?, bg?, bold?, dim?, italic?, underline?, action?, arg? }`; `fg`/`bg` are theme roles (`primary`, `muted`,
   `success`, `error`... see `input.theme.colors`) or `#rrggbb`. `undefined` falls through to the built-in.
   (`prompt.frame` returns `{ top, bottom, left?, right? }`.)
3. The terminal keeps all input handling. A span with `action` (an id from the slot's closed set, with `arg`) only asks
   the terminal to run that action when clicked; keys, answers and permissions are never decided by a view.

```ts
export default {
  name: "my-views",
  tui(api) {
    api.view("footer", (input) => [[{ text: ` ${input.agent ?? ""} ${input.model ?? ""}`, fg: "muted" }]])
  },
}
```

`api.view("slashMenu", ...)` still works as the old name of `slash.menu`. The last view registered for a slot wins.

## Installing, finding and managing views

- **User file**: `<data dir>/extensions/<name>.ts`. A session's own model may write the starter too (it is MendCode's template in a new file); `--force`, which replaces a view you already have, is refused from a session, and the code it then writes goes through `customize_ui`, which asks you. `mendcode view scaffold <slot>` (or `/customize` > Views >
  New view file) writes a commented starter, `view-<slot>.ts`, and never overwrites a file (`--force` does).
  `mendcode view list` prints every slot. Both work on files only and never start a daemon.
- **Package**: a package's `extensions/` folder, like any terminal extension. A package that wants to own the look lists its views in `activate.views` (slot to module) and they load only while it owns the look ([packages](packages.md#make-your-own-mendcode-in-10-minutes)); `mendcode package new` writes two to start from, and `examples/packages/retro/` is a full reskin. A view that never returns cannot be interrupted from inside the process: the 4 ms budget and three strikes bound a view across frames, not inside one call; use `--safe-mode` to start without it.
- **Project files** load only where the project is trusted, the same rule as every project extension. Remote terminals
  and pure (`--safe-mode`) terminals never load extensions, so a peer or a remote session cannot install a view in
  another terminal.
- **Hot reload**: edits are picked up by the daemon's existing watcher (`extensions.changed`); finished transcript
  rows are laid out again.
- **`/customize` > Views** states above its rows that views are not sandboxed, and lists the slots that have a custom view (and the one you are on) with the owner
  (`user <name>`, `project <name>`, `package <name>`, or built-in), the number of faults, the last error and the
  average time per call. Left/right pick a slot, Enter turns its custom view off or on (`disabledViews` in the
  profile), `r` resets it (clears faults and the off switch), and the next row writes a starter for the picked slot.

## How custom code is isolated

**What was verified, plainly:** view code runs in this process, with your permissions. It is **not sandboxed**. Installing a
view is trusting its author, exactly as installing an extension is. `/customize` > Views says the same above its rows.
The contract below limits how a faulty view can hurt the screen; it does not limit what a hostile one can do.

Be clear about what this is not: a view is ordinary extension code. It is imported into the terminal process and runs
with the user's privileges. There is **no operating-system sandbox**, and a view can do whatever any extension can do.
That is why project views need project trust and why remote or pure terminals do not load extensions at all. What
the contract adds is that a view's faults never reach the screen:

- The input is a structured clone, deep-frozen. A view cannot mutate the app's data, cannot reach a function, a
  session or the daemon through it.
- Every call is wrapped: a throw, a returned promise (views are synchronous), a malformed result or a call slower than
  **4 ms** counts as a strike and that frame is drawn by the built-in. The first call of a view is not timed (it pays
  for compiling). The budget is measured after the call returns: a loop cannot be interrupted while it runs, so the
  budget bounds a view across frames, not inside one.
- **Three strikes** open the circuit breaker: the view is not called again until it is reset (`/customize` > Views, `r`)
  or the file is reloaded, the built-in draws instead, and one notice tells the user.
- Output is validated and then clipped: at most `height` rows (and the slot's row cap), each cut to `width` with the
  terminal's own width helpers, with control characters and escape sequences removed. An unknown `action`, an `arg`
  that names nothing real (an option index out of range, a session that is not listed), a click region on a slot that
  has none, or spans that are not objects are invalid output (a strike).

## Safety rules for approvals and questions

A custom `approval` or `question` view restyles; it cannot change what a decision means.

- **The terminal owns the options.** Keys, option order, what each option does, and the rows that list them (number,
  label, key, and the click on each) are drawn by the terminal's built-in renderer in a block of its own, whatever the
  view returns. A view restyles everything around the block and chooses where it goes: a row that holds only the text
  `{options}` (exported as `HOST_OPTIONS_ROW`) is replaced by the block; without one the block goes under the view's
  rows. The input's `optionRows` says how many rows the block takes, so a view can plan its layout.
- A view **cannot make a click region for a permission**: `approval` and `question` have no actions, so a span with an
  `action` there is invalid output (a strike) and the built-in draws. It cannot draw on the block's rows either, and
  it cannot make "Reject" look like "Allow": text it writes outside the block is just text, and only the block's rows
  answer a click (a click calls the same code path as the built-in one). When the screen is short the view's rows are
  cut, never the block's.
- The text being approved (`approval.subject`: the shell command, or the file and change) must be visible. If the
  output does not contain that exact text (whitespace may differ, a view may wrap or indent it), the terminal puts the
  built-in's warning line with the full text (up to 400 characters, with a count of the rest) above the view. Click
  regions of every other slot follow their rows when the terminal inserts rows like this one.
- The same holds for `question`: the question text stays visible and the answers are the terminal's block. A **batch**
  of questions is one interactive panel (tabs, answers, review): the terminal draws all of it as the block, and a
  view may add rows around it.
- Other slots with actions (`sessions.sidebar` and `home` open a listed session, `slash.menu` selects an item,
  `tool.card` folds, `notice` resumes, schedules, snoozes, cancels or dismisses a limit pause and sends a queued
  message) are the view's own and do not grant a permission; their `arg` must still name something real.

## Performance

- Transcript slots (`message.*`, `tool.card`) are drawn once per finished item and layout: the transcript's own row cache
  holds them, and the registry also remembers a finished item's result on its whole input. A streaming item is not
  remembered. A view that depends on `now` in a transcript slot will not see it update on finished items.
- Chrome slots are memoised on their input (the same input within the same clock tick is one call).
- With no custom view the built-in table is called directly: the frame cost is the same as before views existed.

## Slot reference

`maxRows` caps the output; the input's `height` is never larger. Hit regions: `action` (and `arg`) on a span.

### message.user, message.assistant, message.reasoning

Drawn once per finished item. `message.user` input: `itemId`, `turnId`, `text`, `at?`, `time` (formatted, or `""` when
timestamps are off; a `!command` always has it), `mode` (`minimal | balanced | full`), `style` (`layout`, `icon`,
`lead`, `label`, `tint`), `variant` (`message | shell | notice`), `local?`, `attachments?`, `images`, `username`,
`expanded`, and for a sent set of comments on an answer (docs/editor.md) `comments?`: the `comments` (`n`, `of`, `quote`, `cut`, `text`), the `note`, `head?` and `tail?`, with the `layout?` and `collapse?` settings the built-in draws them by. `message.assistant` adds `renderer`, `details`, `detailsAll` and `body`: the message as rows (Markdown as the
renderer allows, no lead or time), laid out 4 cells narrower than `width` so a rail or an indent fits. `message.reasoning`:
`text`, `running`, `ms?`, `rows`, `oneLine`, `hidden`. Actions: none.

A custom view of `message.user` or `message.assistant` (and of `turn.status`) also gets `builtin`: the built-in's own rows of
that item. Return `[...input.builtin, footer]` to add your own text under a message (or above it) and keep everything else as
it is; the example [message-footer](#example-your-own-text-under-each-answer) does that.

### tool.card

A tool call card. Return `undefined` for kinds you do not draw; the built-in card (with the legacy `renderTool` hook)
draws them. Input: `kind` (`read`, `shell`, `edit`, `grep`, `mcp__server__tool`...), `detail` (path, command, pattern),
`title?`, `status` (`running | ok | error | cancelled | interrupted | unknown`), `text`, `output` (non-empty lines, at most
400), `summary?`, `level` (`summary | preview | full`), `expanded`, `page`, `counts` (`lines`, `entries`, `matches`),
`pattern?`, `elapsedMs?`, `exitCode?`, `toolCalls?`, `agent?`, `model?`, `awaiting?`, `compact?`, `density?` (the full view's `toolDensity` for this call: `line` keeps a finished call to its header row, `brief` a short preview capped by kind; absent, the level decides), `meta?`, `frame`
(spinner), `tailLines`, `mode`, `render?`. A running card is not remembered between frames. Actions: `toggle` (fold or
open the card, as clicking its fold row does), `page` (next page of a `full` card). The minimal view draws one-line
tool rows instead of cards, so this slot is not called there; saved-memory notes and submitted plans are not cards.

### approval

The box above the prompt while a request waits. Input: `requestId`, `variant` (`panel`, or `inline` in the minimal
view), `title`, `tool?`, `permission?`, `subject` (the text being approved), `detail` (the built-in's rows, already
wrapped: head, diff, reviewer verdict), `explain?` (the rows of `?`), `options` (`{ label, key, choice }` in order),
`choice` (highlighted index), `hint`, `plan`, `optionRows` (rows of the terminal's option block). Actions: none; the
options are the terminal's block, placed with a `{options}` row. Rules above apply.

### question

Input: `requestId`, `variant` (`single | batch`), `title`, `detail`, `multiple`, `options` (`{ label, description? }`), `choice`,
`picked`, `typing` (the reader is typing in the card's "Type your own answer" field), `optionRows`; `questions` (`header`, `question`,
`context?`, `options`, `multiple?`, `custom?`; a single question is a batch of one) and `draft` (`tab`, `choice`, `answers`, `custom`,
`editing`, `scroll`). Actions: none; the answers with that field (and, for a batch, the tabs) are the terminal's block, placed with a
`{options}` row, and the terminal puts its cursor in the field. The built-in card stands where the prompt is ([layout](layout.md#question-batches-and-todo-lists-b57)).

### prompt.frame

The rules or box around the input. Input: `preset` (`box | top-bottom | minimal | ascii-box`), `border`, `lead`,
`borders`. Return `{ top, bottom, left?, right? }`: at most 3 rows above and below, and the cells before and after each
input row (at most a quarter of the width each). The input row itself, its cursor and the status-in-border line stay the
terminal's. Not called in the minimal view's bare mode. Actions: none.

### topbar

The session bar (one row). Input: `path`, `home?`, `branch?`, `hideProject`, `files?`, `title`, `diff?`, `context?`
(`tokens`, `limit`), `tick?`, `contextHover`, `contextStyle`, `navigation?`. The legacy `header.replace` slot keeps priority
for the whole header. Actions: none.

### sessions.sidebar

The left session list, `height` rows by 38 cells. Input: `sessions` (`sessionId`, `title`, `state`, `queued`,
`updatedAt`, `archivedAt?`, `lifecycle?`, `draft?`: `preview`, `chars`, `attachments`, `images`, `updatedAt` of the unsent
draft; an untitled session with one reads `Draft · preview`), `current`, `selected?`, `focused`. Actions: `open` with `arg` = a listed
`sessionId` (switches to it, like a click).

### notice

Three kinds, one slot. `kind: "toast"`: `variant`, `title?`, `message` (return rows of equal width; they float at the top right).
`kind: "limit"`: `view` (`state`, `provider?`, `message`, `resetsAt?`) and `chips` (`action`, `label`). `kind: "queue"`:
`previews`, `delivery`, `held`, `paused`, `mode?`, `shell`. Actions: `send` (queue: send the queued message now) and, for
a limit bar, the actions of `chips` (`resume`, `schedule`, `cancel`, `snooze`, `dismiss`). Return `undefined` for kinds you
do not draw. For `kind: "toast"`, `inline: true` asks for the one-row form the inline live region uses (the message in the
variant's color, `width` cells); a floating box does not fit there.

### footer

The row or rows under the prompt (at most 4). Input: `leftItems?`, `rightItems?`, `separator?`, `agent?`, `agentColor?`,
`model?`, `effort?`, `provider?`, `counters?`, `permission?`, `permissionLabel?`, `profile?`, `pr?`, `loops`, `goal?`,
`workflows?`, `notice?`, `connection?`, `shell?`, script segments, and `extraRows`. The legacy `footer.*` slots add to or
replace the built-in row inside the built-in only. Actions: none.

### home

The new-chat screen. Input: `screenHeight?`, `version?`, `root`, `bare`, `sessions` (`id?`, `title`, `state`, `updatedAt`,
`startedAt?`, `detail?`), `selectedId?`, `spinner`, `look` (the `/customize` home profile), `tip?`, `footer?`. The home's
keyboard selection stays the terminal's. Actions: `open` with `arg` = the `id` of a listed session (switches to it, like a
click on the built-in Agent View row; an `arg` that names no listed session is invalid output). The legacy `welcome.replace`
slot takes priority.

### panel.widget

One widget body of the right panel (`/panel`). Input: `widget` (the widget id: `agent`, `context`, `text`...), `options`,
`body` (the built-in's rows). Restyle `body` or draw your own; the panel keeps the title, frame and `maxRows`. Actions:
none.

### file.viewer

The [file viewer](file-viewer.md): the open file in the right slot (`variant: slot`) or as a full page on a narrow terminal (`page`).
Input: `path`, `name`, `language`, `kind` (`text`, `binary`, `special`, `large`, `directory`, `missing`, `loading`, `error`), `size`,
`lines`, `mime?`, `note?` (the one line a file that is not text gets), `top`, `rows` (the visible lines: `line`, `text`, the highlighted
`spans`, `mark?` = `added` / `modified` / `deleted` from Git, `selected`, `hit`, `pending?`), `selection?`, `search?`, `focused`, `panel`
(the right panel exists in the same slot), `options` (`lineNumbers`, `wrap` as resolved for this file, `left`, `prose?` for Markdown and
text, which wrap at spaces), `notice?`, `openLink?` (the editor link for the file; the built-in header does not attach it to `o open`,
which would let a terminal underline the hint), `redacted`, `keys?` (`focus`, `switch`, `close`: the keys of the hints as the user has
them bound and labelled, `opt+}` or `ctrl+x }`; a key that is not bound is absent, so leave its hint out: never write a key by hand),
and for a `directory` `entries` (`name`, `kind` = `up` / `dir` / `file` / `link` / `other`, `size?`), `cursor` and `entriesTotal`.
Actions: `close`, `switch` (only while `panel`), `open`, `ask`, `copy` (no `arg`), `line` with `arg` = a line number among `rows` (a
press selects it; a drag extends), `entry` with `arg` = an index of `entries` (a press enters the folder or opens the file). The terminal
keeps the keyboard, the reads and the selection; the view only draws.

### slash.menu

The slash command menu. Input: `catalog`, `query`, `selection`, `group`, `groups`, `suggested?`, `items`, `layout`. See
[the menu contract](customize.md#replacing-the-slash-menu-view). Actions: `select` with `arg` = index in `items`. Keyboard
navigation always works.

### tool.row, compaction.card, turn.status

The transcript rows that are not message or tool cards. All three are blocks: they are laid out once when they finish and
cached, and have no clickable regions (actions: none). Return `undefined` for a variant you do not draw.

- `tool.row`: a tool call drawn as a row, not a card. `variant`: `minimal` (the minimal view's one-line row: `title`,
  `status`, `run` = how many successful tools this row stands for, `folded` = a later row already stands for it, `reason`
  = the last line of a failure), `memory` (a saved-memory note: `text`, `hint` = the muted `/memory undo` at the row's right edge, `detail` = the whole memory text and `open` = the reader opened it), `orientation` (the engine's injected code map folded to one row: `text`, `hint`; open, the block draws as a `tool.card`, which `codeMapCard` makes the default in the full view), `plan` (a submitted plan, `text` is Markdown) or
  `images` (the image line under a tool that made pictures, `images` and `where`).
- `compaction.card`: the card of a turn that packed the conversation. `state`, `reason`, `idle?` (it ran while idle, before the prompt cache expired), `summary`, `followUp`, `method?`,
  `tailTurns?`, `tailTokens?`, `fallbackReason?`, `cachedPrefix?` (the summary request repeated the session's last request), the resolved `style`/`presentation`, `progress`, `scratchpad`, and
  `expanded` (the reader opened it). `summaryRows` is the summary already rendered as Markdown rows.
- `turn.status`: the rows between turns. `variant`: `end` (the outcome with `end { outcome, input, output, reasoning?, ms?,
  reason?, error? }`, drawn as the status line or the error box), `goal` (`goal`), `limit` (`limit`), `note` (`note`, a cache
  note), `undone` (`undone` = messages removed by a rewind) or `checkpoint`. `meta` is the profile's message-meta level and
  `mode` the presentation mode. `at` is when the row was made (a turn end: when the turn ended) and `time` that time
  formatted, or `""` while timestamps are off; with them on the built-in ends the line with `done 5:25 PM`.

### page, overlay, bar (the envelope slots)

These three wrap everything on screen that is not a transcript block or one of the slots above. In each, the terminal draws
the built-in first and hands its rows to the view in the model (`body` for a page, `rows` for the others): return them
restyled, reordered, framed or replaced, or `undefined` to keep them. The model is only built while a custom view exists.

**`page`**: every full-screen page goes through this ONE shape. Input: `page` (the id: `settings`, `customize`, `usage`,
`sessions`, `agents`, `memory`, `model`, `mcps`, `permissions`, `workflows`, `loops`, `changes`, `help`, `intro`, `setup`,
`theme`... all pages of the terminal, see `PAGE_TITLES` in `apps/cli/src/view/page-views.ts`), `title`, `hints?` (the
built-in's `esc ...` hint line), `selected?` (the row the built-in highlighted, read from what it drew), `scroll?` (the
scroll offset, for the pages that keep one: `help`), `body` (the built-in rows of the page, `height` of them at most) and
`status` (the status rows the terminal appends under every page). Selection, scroll, typing and every key stay the
terminal's: the view only draws, so a view cannot trap the user. A page always shows how to leave it: if the rows you return
contain no `esc` hint the terminal adds `esc back` (replacing the last row only when the page is full). Actions: none, and
pages have no mouse regions (the terminal ignores the mouse on pages).

What the shape does **not** give you: a per-page typed model (rows of a settings page as `{label, value}`, the tabs of the
usage page as a list). The page modules own their layout, so `body` carries the drawn rows and `selected`/`hints` are read
from them. A view that wants the data of a page can match on `page` and parse `body`; a typed model per page needs that
page's state split from its renderer and is not done. `/status` has one (`page.status`, below) and goes through both: its
view draws the body, then `page` wraps it.

**`overlay`**: the command palette, the theme and model pickers opened as palettes, and the floating cards (fetch, rewind,
goal and return prompts, and the quick model switch `/model` opens over the chat, `variant: "card"` with `title: "Model"`). Input: `variant` (`palette`, `picker` or `card`), `title`, `query`, `selected`, `matches` and the
built-in card as `rows`. A custom palette is drawn from the top left; typing, selection and running an item stay the
terminal's. Cards keep their place.

**`bar`**: the rows around the prompt that are not a card: `variant` is `working` (the working row), `find`, `search`,
`attachments`, `ide`, `voice`, `vim`, `daemon`, `shortcuts`, `mention` (the `@` popup) or `agents` (the live sub-agents strip). A bar is drawn only while the
terminal shows it; the view restyles its rows, it cannot make one appear.

The first-run screen (`setup`, drawn by `onboarding-page.ts`, the Import picker inside it by `onboarding-import.ts`,
previews by `onboarding-sample.ts`) and `/tutorial`
(`tutorial`, `tutorial-page.ts`) are pages like the rest: their rows reach a custom `page` view as `body`. Their previews
are not mock-ups: the chat preview replays a transcript through the real `createTranscript`, the approval preview is the
real `renderApprovalPanel`, and the tutorial's practice chat is the real terminal app drawing into the page's rectangle
(see [setup](setup.md)). Inside the practice chat no extension or custom view is loaded, so it shows the built-in look.

### page.status (pages)

A page slot returns the whole page body (`height` rows). `page.status` is wired: the `/status` page draws through it
(`connected`, `session`, `info`, `models`, `mcps`, `extensions`, `storage`, `scroll`...); its keys (scroll, refresh,
back) stay the terminal's.

## What is not a slot, and why

Everything that draws in `apps/cli/src/view` is either a slot above or listed here. `test/views-coverage.test.ts` scans
that folder for draw entry points (`render*`, `*Row(s)`, `*Line(s)`, `draw*`) and **fails** when a file is neither
registered against a slot nor on the allowlist with a reason, so new UI cannot bypass the contract. Not slots:

- **The prompt editor** (`editor.ts`) and the **tasks and scratchpad dock** (`dock.ts`), and the **live compaction panel**
  (`compaction-live.ts`) hold editable text with a cursor and click geometry the terminal measures from the rows it draws.
  Their chrome is `prompt.frame`, `bar` and `compaction.card`; the text areas themselves are not replaceable.
- **Mermaid and diagrams**: a diagram inside an answer is part of the `message.assistant` body (`body` has its rows); the
  diagram viewer page (`/diagram`) is a `page`.
- **Helpers with no pixels of their own**: box drawing, row layout, hyperlink post-processing and overlay compositing.
- **Headless output**: the `/loop` monitor of the automation mode prints to stdout.
- **Unused**: the old slash and `@` suggestion renderers; the menu and popup draw through `slash.menu` and `bar`.
- **Typed per-page models** (see `page` above) are not provided.

## Example: a compact `read` card

Draws `read` calls as one line; every other tool keeps the built-in card. Save as `<data dir>/extensions/compact-read.ts`.

<!-- example: compact-read -->
```ts
export default {
  name: "compact-read",
  tui(api) {
    api.view("tool.card", (card) => {
      if (card.kind !== "read") return undefined
      const lines = card.counts.lines ?? card.output?.length ?? 0
      const mark = card.ascii ? "-" : "◇"
      return [[
        { text: `  ${mark} read `, fg: card.status === "error" ? "error" : "muted" },
        { text: card.detail, fg: "text" },
        { text: ` · ${lines} line${lines === 1 ? "" : "s"}`, fg: "muted", dim: true },
        ...(card.status === "running" ? [{ text: " ...", fg: "warning" }] : []),
      ]]
    })
  },
}
```

## Example: a restyled assistant message

Keeps the built-in Markdown (code blocks, lists, links) and puts it behind a rail with a small header. `body` is already
laid out 4 cells narrower than `width`, so the rail fits. Save as `<data dir>/extensions/rail-assistant.ts`.

<!-- example: rail-assistant -->
```ts
export default {
  name: "rail-assistant",
  tui(api) {
    api.view("message.assistant", (message) => {
      const rail = { text: message.ascii ? "| " : "┃ ", fg: "primary" }
      return [
        [{ ...rail, text: `${rail.text}assistant`, bold: true }, ...(message.time ? [{ text: `  ${message.time}`, fg: "muted" }] : [])],
        ...message.body.map((row) => [rail, ...row]),
      ]
    })
  },
}
```

## Example: your own text under each answer

Adds a muted line under every answer with when it was sent and how long it is, and leaves the built-in message as it was:
`builtin` holds its rows. `at` is known even while timestamps are off, so this line does not depend on that setting. Save as
`<data dir>/extensions/message-footer.ts`.

<!-- example: message-footer -->
```ts
export default {
  name: "message-footer",
  tui(api) {
    api.view("message.assistant", (message) => {
      if (!message.builtin) return undefined
      const sent = message.at ? new Date(message.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "now"
      const words = message.text.split(/\s+/).filter(Boolean).length
      return [...message.builtin, [{ text: `  sent ${sent} · ${words} words`, fg: "muted", dim: true }]]
    })
  },
}
```

## Where the pieces are

The input and output types, `VIEW_SLOTS` (every slot with its action set and row cap), the budget and the strike limit are in
`packages/extension-api/src/views.ts`. The host and built-in table are `apps/cli/src/view/views.ts` and `view-builtins.ts`;
the registry (breaker, budget, validation, memo) is `apps/cli/src/extensions/views.ts`; the safety rules are
`apps/cli/src/view/view-safety.ts`. Tests: `apps/cli/test/views-golden.test.ts` (the default look is unchanged through the
contract), `views-custom.test.ts`, `views-manage.test.ts` and `views-docs.test.ts` (the two examples above run as written).
