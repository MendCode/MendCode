Edit prompts, comment on answers and recover text you have not sent. The prompt also supports undo and redo, a stash, your own editor, answer copying and a turn-end bell.

## Prompt editor

To comment on a passage, select it or copy it with the mouse, then press `ctrl+g` (`alt+q` does the same). See [Comments on an answer](#comments-on-an-answer).

Quote + comment is also in message actions (Shift+Q). A bounded Markdown quote is inserted above your existing draft/comment and attachments. Nothing is submitted until you send it.

### Use the older quote action

The older quote puts the selection into the prompt as `> ` lines. Bind `selection.quote` in `keybindings.json`, or use `commentKey: quote` to give `alt+q` back to it.

In the minimal view, comments are off by default and `alt+q` still quotes. `ctrl+g` never quotes.

What the prompt does beyond typing, ported from v1: undo and redo, a stash for prompts you are not ready to send, your own editor for long ones, copying an answer, and a bell when a turn ends. Every action below can be bound or unbound in [`keybindings.json`](extensions-tui.md#keys) by its name (`"alt+z": "edit.undo"`); the keys shown are the defaults.

| action | default key | does |
|---|---|---|
| `edit.undo` | `ctrl+_` (also `ctrl+/` in most terminals) | step back one edit (v1's `input_undo`) |
| `edit.redo` | `ctrl+y` | step forward again (v1's `input_redo`) |
| `stash.push` | `ctrl+x p` | park the prompt and clear it |
| `stash.pop` | `ctrl+x o` | bring the newest stash back |
| `editor.open` | `ctrl+x e` | edit the prompt in `$VISUAL` / `$EDITOR` (v1's `editor_open`) |
| `message.copy` | `ctrl+x y` | copy the last answer to the clipboard (v1's `messages_copy`) |
| `drafts.restore` | `ctrl+r` | bring back the newest unsent draft of an earlier session |
| `history.search` | `alt+r` | search the project's earlier prompts ([below](#search-earlier-prompts)) |
| `queue.edit` | `alt+up` | pull the newest queued prompt back into the prompt ([below](#queued-prompts-and-esc-esc)) |
| `backtrack.open` | `esc esc` (idle, empty prompt) | pick an earlier prompt to edit and resend |
| `effort.previous` / `effort.next` | `alt+,` / `alt+.` (`f3` also steps forward) | step the reasoning effort or variant down or up |
| `shortcuts.toggle` | `?` (empty prompt) | the shortcut overlay |
| `edit.yank` / `edit.yank-pop` | `alt+y` / `alt+shift+y` | paste the last kill, then swap it for an older one |
| `edit.jump-forward` / `edit.jump-backward` | `alt+j` / `alt+shift+j` | wait for a character and jump to its next or previous occurrence on the line |

## Comments on an answer

You comment on specific passages of the assistant's answer, and everything goes out as **one** message with your general text. No new page: the passages become chips on the one prompt.

1. Select a passage with the mouse (copy-on-select copies it; the toast then says `copied N chars · ctrl+g comment`), or keep a selection (copy-on-select off; a pill, `ctrl+g comment`, appears on the prompt's top rule).
2. Press `ctrl+g` (or `alt+q`, or click the pill). The prompt becomes the comment: its rule is tinted, a row under it says `comment on “…”` and `draft kept` when you had typed something, and the passage in the transcript is filled. `Enter` stores the comment, `esc` drops it; your own draft and cursor come back untouched either way.
3. The comment is a chip above the prompt, `[1 “Use Opus 5 for the planner…”]  alt+l list`, and the passage gets a mark in its margin, `1┃`. Select more passages the same way, up to nine.
4. `Enter` sends the chips and whatever is in the prompt as one message; with an empty prompt it sends only the comments.

Pending comments are saved with the draft. A session switch keeps each session's own, and a restart brings them back with their marks.

### Keys

| action | default key | does |
|---|---|---|
| `selection.comment` | `ctrl+g`, `alt+q`, `ctrl+x w` | comment on the selection, or on the passage you just copied; with neither, walk the newest answer (the reply mode); pressed in the reply mode, leave it |
| `comment.list` | `alt+l`, `ctrl+x W` | open the list of pending comments (bring parked ones back); again, close it |
| `comment.reply` | none (bind it) | the reply mode without a selection |
| `comment.clear` | none (bind it) | drop every pending comment |
| `selection.quote` | none (bind it) | the old quote into the prompt |

`ctrl+g` is the key the hints name (the toast, the pill, `/help`, `/keymap`), on every OS: it is one control byte, so it works in every terminal, with no Option-as-Alt setting on a Mac and no keyboard protocol. `alt+q` and the `ctrl+x w` chord stay as they were. `ctrl+g` always comments: `commentKey: quote` changes what `alt+q` and `ctrl+x w` do, never `ctrl+g`, and with comments off it says `comments are off · /comments on` instead of quoting. In the reply mode and while a comment is typed it does what `alt+q` does there (leaves the mode; nothing). A page with its own `ctrl+g` keeps it while it is open (`/keymap` resets every binding with it).

`alt+c` is not bound by default and is free to bind: `{ "alt+c": "selection.comment" }`. A hint names the first key still bound to the action, so it keeps saying `ctrl+g` until that is unbound or bound to something else (`"ctrl+g": null`); a key bound in `keybindings.json` wins over the default, so a `ctrl+g` of your own stays yours and the hints fall back to `alt+q` (the chord on a Mac). A terminal that reports keys with the kitty protocol sends `alt+q` as `\u001b[113;3u` too, so to move the comment off `alt+q` unbind both names (`"alt+q": null, "\u001b[113;3u": null`). An extension that registers `ctrl+g` with `api.key` takes it, as for any key, and `/keymap` and `/extensions` report what it replaced.

`ctrl+g` sends the BEL byte, which also ends the replies a terminal sends back (a colour, the clipboard). Those replies are removed from the input whole, terminator included, also when a read cuts one in two, so a reply is never a comment key.

### Walk the newest answer

Press `ctrl+g` or `alt+q` with nothing selected to enter reply mode. A bar above the prompt reads `reply 6/6 · paragraph · j k move · c comment · d decide · esc exit`.

Reply mode walks paragraphs, list items, numbered options and code blocks of the newest finished answer, scrolling the transcript to each.

| Key | Does |
| --- | --- |
| `j k` or `↓ ↑` | Move |
| `c` | Comment on the unit |
| A digit | Jump to that numbered option |
| `d` | Write a decision for all numbered options at once; `1: yes, 2: no` makes one comment per option, and a wrong number is refused |
| `esc` | Leave |

The letter keys come from `commentReplyKeys`, default `jkcd`: next, previous, comment, decide.

Plain letters are taken only while reply mode or the list is open and its bar says so. Any other printable key closes the mode and is typed.

### Edit the comment list

Open the list with `alt+l`:

| Key | Does |
| --- | --- |
| `↑ ↓` | Select |
| `e` or `Enter` | Edit; the words return to the prompt |
| `d` | Delete |
| `J` `K` | Move down and up; chip numbers follow |
| `esc` | Close |

Like reply mode, any other printable key closes the list and is typed.

**`ctrl+c`** closes an open mode first. With an empty prompt and comments pending it does *not* ask: the comments are kept as a draft (saved with the draft system), the chip row becomes `draft 2 comments · alt+l brings them back · /comments clear discards`, and nothing is sent until you bring them back. A second `ctrl+c` is the ordinary one. With text in the prompt it clears the text and the comments stay.

**Mouse**: a click on the chip row opens the list; a click on the hint pill (the prompt's rule, or by the passage) comments; a click on a margin mark focuses that chip (with the count style it opens the list). Dragging, copy-on-select and clicking a tool card to fold it are as before: only the pill, the chip row and the margin marks are controls.

### The hint

`commentHint` says where the offer to comment shows, and it lasts `commentHintSeconds` (default 5) or until another key or click:

| value | after a copy | with a kept selection |
|---|---|---|
| `prompt` (default) | the `copied N chars` toast adds `ctrl+g comment` | a pill on the prompt's top rule |
| `passage` | a pill on the passage's last row | the same pill |
| `off` | nothing shown; the key still takes the copied passage | nothing shown |

The key shown is the one bound now: rebind it and the copy follows.

### Chips and marks

`commentChips` puts the chips `above` the prompt (default), `below` it, or as a count pill on the prompt's `rule`. `commentChipStyle` is `chips` (number and quote), `numbers` (`[1] [2] [3]`) or `count` (`3 comments`); `commentCollapse` (default 14) is how many cells a quote keeps before a row collapses to numbers, then to a count. A number with `↑` after it is on an answer older than the newest. `commentMarks` turns the margin marks off; `commentMarkGlyph` replaces the `┃` (one or two single-cell glyphs). Marks are found again from the quote in the drawn rows, so a resize moves them and a compaction drops them.

### What is sent

The wire is plain text with fenced quotes, so it reads the same to any model and any client:

````
<mendcode_comments count="2">
Comments on your answer. Each <comment> has a verbatim <quote> and my comment on it: answer each by number. A <note> is general.

<comment n="1" of="last answer">
<quote>
```
Use Opus 5 for the planner and keep the executor on codex.
```
</quote>
too slow for a one-off
</comment>
<comment n="2" of="earlier answer">
...
</comment>
<note>
go with codex
</note>
</mendcode_comments>
````

The quote is verbatim inside a fence one backtick longer than any run inside it, so no quote can end its block. Tags typed in a comment or the note are defused (`</comment>` becomes `</\comment>`); the transcript turns that back. `of` says whether the passage is in the newest answer, an earlier one, or `context` (added by an extension). A quote is cut at 2000 characters (`cut="N"` says by how much), a comment's words at 2000, the whole message at 60,000. The wording is yours: see `commentTemplate` and `commentEntry` below.

In the transcript the sent message is folded. What you typed comes first, as an ordinary message; under it each quote and its comment are one numbered pair (the numbers of the chips and the margin marks, with `↑` after one on an older answer), the quote on one dim line and the comment readable under it. `commentSentLayout` picks the form (below). When a quote is cut to its line, `ctrl+o` opens them and a muted `ctrl+o quotes` says so at the right; with nothing to open, or once opened, the hint is not drawn. `commentFolded: off` shows the text as sent. History, the timeline, the drafts list and session search show `2 comments · too slow…`, never the tags. `/export` keeps the message as sent.

### Other clients

Nothing needs to parse the envelope for a model to use it: it is the text of an ordinary user message, so headless `run`/`--json`, the web UI and the Claude Code, Codex and ACP engines carry it unchanged and show it as text (a client that knows it can fold it with `parseCommentMessage` in `apps/cli/src/view/reply-comments.ts`). A client that sends comments builds the same text; see [`automation.md`](automation.md#comments-envelope).

The saved draft is the same envelope with `draft="1"` (and `parked="1"` when set aside) on the root tag and an `item="…"` on each comment, so an older daemon stores it as the draft text it is, and an older terminal that restores it can send it as it is.

### Tiers and settings

Comments are on in the `balanced` and `full` views and off in `minimal` (no hint, no chip row; `alt+q` keeps quoting and `ctrl+g` says comments are off): `comments` is `auto`, `on` or `off`, and `/comments on` turns them on in minimal. Every setting is in `/customize` under Comments and in `profile.json`:

| setting | default | does |
|---|---|---|
| `comments` | `auto` | `auto` (on except in minimal), `on`, `off` |
| `commentKey` | `comment` | `quote` gives `alt+q` (and `ctrl+x w`) back to the old quote; `ctrl+g` still comments |
| `commentHint` | `prompt` | `prompt`, `passage`, `off` |
| `commentHintSeconds` | `5` | 1..60 |
| `commentChips` | `above` | `above`, `below`, `rule` |
| `commentChipStyle` | `chips` | `chips`, `numbers`, `count` |
| `commentCollapse` | `14` | 6..40 cells of quote before a chip collapses |
| `commentMax` | `9` | 1..9 |
| `commentMarks` | on | the margin marks |
| `commentMarkGlyph` | `┃` | one or two single-cell glyphs |
| `commentReplyKeys` | `jkcd` | four different letters: next, previous, comment, decide |
| `commentFolded` | on | fold the sent message in the transcript |
| `commentSentLayout` | `rail` | the folded form: `rail`, `stack`, `inline` |
| `commentTemplate` | built in | the envelope: needs `{comments}`; `{count}`, `{note}` (the note as a block) and `{note_text}` are optional; write line breaks as `\n` |
| `commentEntry` | built in | one comment: needs `{quote}` and `{text}`; `{n}`, `{of}`, `{cut}` optional; line breaks as `\n` |

Placeholders are filled in one pass, so nothing typed can add one, and `{quote}` is always the fenced block. A template that breaks these rules is refused in the settings page and ignored (the built-in one is used) in `profile.json`.

### `/comments`

| Command | Does |
| --- | --- |
| `/comments` | List pending comments |
| `/comments reply` | Walk the newest answer |
| `clear` | Drop pending comments |
| `on`, `off`, `auto` | Set `comments` |
| `settings` | Open the rows |

### Extending

A terminal extension ([extensions-tui.md](extensions-tui.md#comments-on-an-answer)) can read the pending comments and add one (`actions.comments.list()`, `actions.comments.add({ quote, text })`, for example "comment on this diff hunk") and reshape the message just before it is sent (`api.comments.beforeSend`). `examples/extensions/comment-hunk.ts` does both.

### Where the terminal is worse than a desktop app

The comment is not under its passage: a chip row and a margin number stand in for it, and at 60 columns three chips are a count. The quote is the drawn text (a table's cells are tab-joined, code bars dropped), tool cards, images and diagrams cannot be commented, and one comment is typed at a time. The hint after a copy is a few seconds of text, not a control that stays.

## Unsent drafts and copy on select

The daemon saves the prompt per session while you type: after a 0.4 s pause, at once for a paste, and on quit or terminal close.

A prompt containing only spaces and line breaks, with no attachment, is no draft. It saves nothing and clears any draft saved before.

### Restore an unsent draft

1. Start in a project with an unsent draft in another session. The notice reads `Unsent draft saved (1.2k chars) · ctrl+r restore`.
2. Press `ctrl+r` to move the newest draft into the prompt. Anything you had typed goes to the stash.

Use `/drafts` for a list with previews. Enter restores; two Ctrl+D presses delete.

The size counts typed text, not an attachment's `[Image #1]` token. The notice also names attachments:

| Notice detail | Contents |
| --- | --- |
| `(340 chars, 1 image)` | Text and an image |
| `(1 image)` | Attachments-only draft with one image |
| `(2 attachments)` | Attachments that are not all images |

A draft over 64 KB is kept truncated. At terminal start, drafts older than `draftRetentionDays` are deleted: default 14, `0` keeps them. `/customize` has the row.

### Switch sessions

The prompt belongs to its session. Switching session (sidebar, `/sessions`, the palette, a fork) saves what is in the prompt as the session you leave's draft and empties the prompt; the session you open puts its own draft back by itself, with no key and no notice: text, the cursor at its end, attachment tokens with their attachments and pending comments. If you have already typed something when the draft arrives, your text stays and the draft is parked in the stash (`Unsent draft kept in the stash (340 chars) · ctrl+x o restore`); the prompt is never overwritten. Sending the message, or deleting all the text, clears the draft.

A session with no title but a saved draft is listed as a draft, not as untitled: `Draft · fix the retry loop` (a muted `Draft` and the first line you typed, cut to the row; `Draft · 1 image` when only attachments are in it) in the left list, `/sessions` (`draft · fix the retry loop`, with the draft's size in the detail column, found by its words or by `draft`), the palette, `@thread`, `mendcode session list`, the top bar and the terminal title. The time shown is that of the draft when it is newer than the session. Once the first message is sent the title replaces the label. The label comes from the daemon (`session.list` and the `session.activity` push carry the draft's head: first line, typed size, attachment count), so every terminal reads the same; a read-only remote token, which cannot read drafts, is not told of them.

Dragging with the mouse in the transcript or the prompt highlights the text and, on release, copies it through OSC 52 (`copyOnSelect`, default on, in `/customize`). The copy is plain text: no bars, gutters or table borders, wrapped lines joined again. A click without a drag copies nothing (in the prompt it puts the cursor there, see [Moving in the prompt](#moving-in-the-prompt)); a double click copies the word and a triple click the line (see [layout.md](layout.md#selecting-text-and-details-blocks)). With `copyOnSelect` off the selection stays highlighted and `ctrl+c` copies it; any other key drops it. The wheel never drops a transcript selection: it stays on its text, and with the button held the selection grows to where the pointer now is, so a drag can cover more than one screen. Dragging past the transcript's top or bottom edge scrolls it and keeps selecting (see [layout.md](layout.md#selecting-text-and-details-blocks)). The footer under the prompt is text too: a drag, a double click or a triple click there selects and copies it the same way, while a single click still reaches its controls.

## Attachment tokens

A paste of 1,000 characters or more goes in as `[Pasted Content 4210 chars]`, as in Codex. The text around it stays editable; a second paste of the same size is `[Pasted Content 4210 chars #2]`.

Enter sends the whole pasted text in its place, and the saved draft keeps it whole too. Deleting or editing the label drops that paste.

Set the threshold with `pasteSummaryMinChars` in `/customize`, Paste threshold. With `pasteSummary` off, everything pastes as text.

### Move and edit tokens

A pasted or dropped image, PDF, external file or folder, `/attach` and the clipboard-image key put a token in the text at the cursor (`[Image #1]`, `[PDF spec.pdf]`, `[codeconfig/]`; see [attachments.md](attachments.md#inline-tokens)). The editor treats a token as one character, wherever the label stands in the text:

- The cursor never rests inside it. `←` and `→` step over it whole, `↑` and `↓` land beside it, a click inside it goes to the nearer edge, and typing with the cursor somewhere in it lands after it.
- Backspace right after it, `delete` right before it, `ctrl+w`, `alt+d`, `ctrl+k`, `ctrl+u` and a selection take all of it, and never half. A selection that ends inside a token is made whole. `shift`+arrows select it in one step.
- Word motion (`alt+b`, `alt+f`, `ctrl+←`/`→`, and `w` `b` `e` `dw` in vim) treats it as one word, spaces inside it included. A kill that took a token yanks it back whole.
- Wrapping never breaks it: a token that does not fit on the row moves to the next one, with word wrap on or off, at any width. A token wider than the row has to break; it is the only case.
- Cut, paste, undo and redo, the stash and a restored draft keep tokens working because a token is its label in the text: deleting the label drops the attachment (undo brings both back), and a label typed by hand with no attachment behind it is plain text.
- Pasting a path places the token with a space only where one is needed: before it after a word character, after it before the next word. In the middle of a word the word is split by spaces. A path with nothing behind it (not a file, over the limit) inserts nothing.
- A token is drawn as a chip in the colour of its kind (image accent, PDF primary, text and folder secondary), in the prompt and in the sent message. Backspace on an empty prompt still removes the last attachment with no token (an older draft or the `above` setting); with `attachmentChips: above` nothing enters the text at all.

## Moving in the prompt

Use `↑` and `↓` to move one drawn row. A wrapped line is several rows; a line break starts another. History takes over only when there is no row to move to.

The column stays where it was, even across a shorter row. Columns count terminal cells: a wide character such as `漢` takes two, and a cell inside one lands before it.

The same motion is bound to `edit.move-up` / `edit.move-down`; `shift` selects. The scratchpad, goal and memory editors, and plan draft share this component and behavior.

In vim normal and visual mode, `j` and `k` and the arrows follow the same drawn rows. `dj` and `dk` still act on whole lines.

### Click to move or select

A left click in the prompt puts the cursor at that cell: before the character under the pointer (either half of a wide one), at the start of the row over its margin, lead or border, at the end of the row past its text, and at the end of the text on the prompt's closing border. It follows wrapped rows, a scrolled prompt and every chrome preset. A click moves the cursor only: nothing is selected or copied unless the mouse is dragged (a drag, a double click for the word and a triple click for the line work as described in [layout.md](layout.md#selecting-text-and-details-blocks)). `shift`+click selects from the cursor to the clicked cell, like `shift` and the arrows (terminals that keep `shift`+click for their own selection never report it). In vim mode a click ends visual mode and rests on a character. A click in the transcript does not move the prompt cursor; with mouse reporting off nothing changes.

## Status and scroll button around the prompt

| Placement | Working status location |
| --- | --- |
| `activityPlacement: inside` (`/activity inside`) | Right of the prompt's first row |
| `above` | Over the prompt's top rule |

The status never takes a cell the text needs. The cursor and text stay put; the status shrinks and leaves when the line fills. An empty prompt keeps its placeholder. See [customize.md](customize.md#activity-status).

While the transcript is scrolled up, the `↓ latest · End` button sits on the row above the prompt's top rule. The `End` key follows the newest output only while the prompt is empty (with text, End moves the cursor), so the button names the key only then; clicking it works either way.

## Prompt history and shell commands

Press `↑` on the prompt's first drawn row, or `↓` on its last while browsing, to recall earlier entries newest first. All sessions of the project (the directory) share one list, which survives restarts.

| History entry | Kept as |
| --- | --- |
| Sent messages | Entered text |
| Slash commands | Arguments as typed, such as `/panel next` and `/btw question`; a menu selection counts as `/name` |
| `!` shell lines | Recalled in shell mode, `!!cmd` included |
| Discarded drafts | Draft entries |

The list keeps 2,000 entries per project, oldest removed first. Text entered again moves to the top instead of repeating.

Nothing is recorded for `/connect <name>`, since a pasted key could follow it. Lines containing only secret markers are not stored; pasted secrets remain markers, as in sent prompts ([secrets.md](secrets.md)).

### Browse and edit a recalled entry

Recalling puts your unsent text aside as the bottom entry. `↓` returns to it untouched, with its original cursor. A recalled entry starts with the cursor at its end.

Until you edit it, moving the cursor does not count as an edit:

- `↑` walks its rows, then from the first row goes to the next older entry.
- `↓` walks its rows, then from the last row goes to the next newer entry or your original text.

The first edit makes the recalled entry your current text. `↑`/`↓` then move only inside it; `↑` on its first row restarts history from the newest entry and puts the edited text aside as a draft.

An empty prompt recalls with `↑` as ever, including in vim mode on the first row.

| Key or condition | Behavior |
| --- | --- |
| `alt+p`, `alt+n` | `history.previous`, `history.next` from any row; `ctrl+p` stays the palette |
| Open slash menu, mention popup, palette, queue (`alt+up`), approval or question card | Keeps `↑`/`↓` |
| Recalled slash command | No slash-menu completion; `Enter` runs it as entered, and the first edit brings the menu back |

Remote or peer connections cannot read or change this history. `prompt.history`, `prompt.record` and `prompt.history.delete` answer `forbidden`; a remote terminal keeps only its own entries, in memory.

### Long entries

A prompt over 16,000 characters is kept as a capped entry: its first 15,920 characters plus a closing note `… [truncated: N chars, first M kept]`, so recall stays bounded and the entry still exists (the full text stays in the session's own events). Recalling one shows a `truncated prompt, N chars originally` toast; the note is part of the text if you send it.

`!` on an empty prompt switches to shell mode and runs the line as your own shell command, without a model call; its output joins the conversation for the next answer. `!!command` (a second `!` at the start of the line) runs it the same way but keeps the command and its output out of the model's history: the card in the transcript reads `$ command  local · not sent to the model`. Native engine only, like `!`; the output still sits in the session's event log and exports. `user.shell` takes `local: true` for it.

`ctrl+z` suspends the client on Unix: raw mode and the alternate screen are restored after `fg`. It is rebindable as `terminal.suspend`.

Shift+arrows select graphemes; typing or deletion replaces the selection in one undo step. Home/End reach the buffer ends; Shift+Home/End select to them. Ctrl+A/E reach logical line boundaries, Ctrl+Shift+A/E select to them. Alt+A/E use wrapped visual lines; Alt+Shift+A/E select. Alt+B/F and Alt/Control+Left/Right move by word; Alt+Shift+B/F or Left/Right select words. Ctrl+Shift+D deletes the logical line, Ctrl+K/U delete to its end/start, Ctrl+D/Delete/Shift+Delete delete forward, Alt+D or Alt/Control+Delete delete the next word, Ctrl+W deletes the previous word. Shift/Control/Alt+Enter and Ctrl+J insert newlines when the terminal sends distinct encodings.

`alt+backspace` (option on macOS, however the terminal encodes it) and `ctrl+backspace` delete the word before the cursor, like `ctrl+w`.

Kill ring: `ctrl+w` (and those two), `ctrl+k`, `ctrl+u`, `alt+d` and `ctrl+shift+d` keep what they delete (30 entries, per terminal). Kills in a row, with no other edit or cursor move between them, grow one entry (backwards kills in front, forward ones behind). `alt+y` puts the newest entry at the cursor; right after it `alt+shift+y` swaps it for the next older one, and again, cycling. `ctrl+y` stays redo. Deleting a selection, backspace and delete are not kills. `alt+j` then a character moves to that character's next occurrence on the line (`alt+shift+j`: previous); any other key cancels. `ctrl+]` stays the side-chat key.

All editing actions are named `edit.<action>` (for example `edit.select-word-forward`, `edit.buffer-home`, `edit.delete-line`). The `leader` field in `keybindings.json` changes Ctrl+X. `null` unbinds a key, including editor defaults. F2/Shift+F2 cycle recent models; `model.favorite.next`/`previous` cycle favorites. Primary agents expose `agent.next`, `agent.previous`, `agent.picker`; the conflicting Tab/Shift+Tab/leader+A/S defaults remain unchanged. Completion takes priority over a bound Tab agent action.

## Search earlier prompts

1. Press `alt+r` or run `/prompt-history [text]`. A search bar opens over the project's newest 500 entries, the same list `↑`/`↓` walk, without repeats.
2. Type to narrow matches. Search is case-insensitive unless the query has a capital.
3. Press `Enter` to keep the match without sending it, or `Esc` to put back what you had. A shell match returns in shell mode.

The newest match appears in the prompt as you type, with its kind on the bar: `sent`, `command`, `shell` or `draft`.

| Key or command | Does |
| --- | --- |
| `ctrl+r` or `↑` | Older match |
| `↓` | Newer match |
| `ctrl+d` twice | Delete the shown entry from history |
| `/prompt-history clear-drafts` | Delete every draft entry of the project |

Outside search, `ctrl+r` stays the draft restore.

## Discarded drafts

Text that leaves the prompt unsent becomes a `draft` history entry when it has 12 or more characters or spans several lines. A shorter one-liner is never kept.

This happens when:

- `ctrl+c`, `ctrl+u` or another key empties the prompt; `esc` does not clear it.
- A key opens another page, such as the sessions picker, while text remains in the prompt.
- `↑` replaces it with an older entry; `↓` still returns to it.
- `Enter` in search replaces it with a match.
- A session switch finds text in the prompt.
- The terminal quits or closes.

`draft saved · ↑ to restore` appears once per clear; other cases are silent. A stashed (`ctrl+x p`) or sent prompt is not a discard.

Press `↑` to reach a draft like any entry. It shows a muted `draft · not sent` line; sent unchanged, it moves to the top as a sent message. The same text is never stored twice.

These history drafts are separate from per-session unsent drafts, still handled by `ctrl+r` and `/drafts`. The minimalist tier keeps all this with no chrome beyond that line.

## Queued prompts and Esc Esc

While a turn runs, prompts you send are queued (see the panel above the prompt). `↑` on an empty prompt (or `alt+up` from anywhere) removes the newest queued prompt and puts its text and attachments in the prompt, in front of what is already typed, so pressing it again rebuilds the order you queued them in. A message sent with comments comes back as your text plus its comment chips (as readable lines when other comments are pending), and `/queue` sends it here to be edited. A queued `!command` comes back in shell mode when the prompt is empty. Notices and compactions are not prompts and are only dropped (`ctrl+k`). A message that already started is reported, not pulled. With the queue empty, `↑` recalls earlier prompts as usual.

### Interrupt with queued messages

Press `Esc` twice on a running turn to stop it and send what is queued, as Codex and OpenCode do. The first queued message goes next (`interrupted · sending the queued message`); the rest follow in order.

Set `queueRestore` in `/customize` (off by default) to move queued messages back into the prompt instead, in order. Interrupting and rewriting become one gesture; shell lines and notices stay queued.

### Backtrack while idle

With the session idle and an empty prompt, `Esc` shows `esc again to edit an earlier prompt` and a second `Esc` within two seconds opens the Backtrack picker (also `/backtrack`, or bind `backtrack.open`): the user's prompts, newest selected. `Enter` reverts the session to that prompt (as Revert in `/messages` does, including the file-conflict card) and puts its text and attachments in the prompt to edit and send again; `f` forks from it instead and leaves this session as it is; `Esc` leaves. `escBacktrack` (default on) turns the gesture off.

While a turn runs, the second `Esc` normally cancels it. When the model has not answered yet (only thinking, tool calls and at most a line of narration, 280 characters, such as the sentence GPT models write before their first tool call), it takes the message back instead, as Claude Code and Codex do with a typo caught in time: the turn stops, the message and what the turn did are undone (files included, as `/undo` does; a Claude Code session forgets it too), and its text and attachments wait in the prompt with `message back in the prompt`. They appear at once, before the daemon has stopped the turn; messages queued behind it, then a draft you were typing, follow the message in that order. If the undo is refused the prompt goes back to how it was. When the model already answered, the second `Esc` cancels and says `already answered · esc esc to edit`. `escRetract` (default on) turns this off, so the second `Esc` only cancels.

## Shortcut overlay, multiline and paste bursts

### Show shortcuts

Press `?` on an empty prompt, or run `/shortcuts`, to show the prompt's current bindings, including `keybindings.json`.

| Key | Does |
| --- | --- |
| Any other key | Close the panel and act as usual |
| `Esc` | Just close it |
| A second `?` | Type a literal `?` |

`shortcutOverlay` (default on) turns the `?` key off.

### Use multiline input

`/multiline [on|off|toggle]` (or the `multiline` row, off by default) makes `Enter` insert a newline; `alt+enter`, `shift+enter` and `ctrl+enter` (where the terminal tells them apart) send. A slash command, a shell line and the answer to a pending question still send on `Enter`.

Terminals without bracketed paste deliver a paste as plain text with raw newlines, and each newline would send what came before it. A single terminal read made only of plain text and holding two or more line breaks (or one line break and 48 or more characters) is inserted as a paste instead; so is a plain read with a line break within 40 ms after such a one. A line and its `Enter`, a bare `Enter` and a slash command typed ahead are left alone, and bracketed pastes are unchanged. `pasteBurst` (default on) turns detection off.

## Undo and redo

Each edit is a step, with the cursor where it was. Up to 200 steps are kept; sending a prompt starts a clean history.

| Edit | Undo step |
| --- | --- |
| Consecutive word characters | One step; a space starts the next |
| Run of backspaces | One step |
| Paste, newline, `ctrl+u`, `ctrl+w`, completion, `ctrl+c` (clear) | One step each |
| Key that changes nothing, such as backspace on an empty prompt | No step |

For example, `write the tests` undoes as `write the`, `write`, then nothing. A prompt cleared by mistake comes back with undo.

Moving the cursor ends a run. A new edit forgets what was undone.

## Stash

1. Press `ctrl+x p` to park the prompt and clear it. The list holds 20 entries, oldest removed first.
2. Press `ctrl+x o` to restore the newest. If you are typing, that text is stashed in its place: nothing is lost and the two keys swap.

Text, mention tokens and attachment references travel together. Restoring swaps the current draft and its attachments into the stash; a failed write preserves both drafts.

The list lives in `<data dir>/tui/stash.json` (mode 600, written whole and renamed). It survives the terminal and is shared by terminals on the same data dir.

Because a slash command is itself the text in the prompt, `/stash` cannot stash the prompt. It manages the list:

| command | does |
|---|---|
| `/stash`, `/stash list` | bordered picker/preview; arrows select, Enter restores, two Ctrl+D presses delete, Esc closes |
| `/stash pop [n]` | restore the newest, or number `n` |
| `/stash drop [n]` | delete the newest, or number `n` |
| `/stash clear` | delete them all |

Ctrl+V asks the daemon for text first, falling back to image attachments. Bracketed pastes and clipboard text at the configured threshold display a compact summary while preserving the full submitted text; any editing key expands it.

## External editor

1. Press `ctrl+x e` or run `/editor`. MendCode writes the prompt to a private temporary file, `prompt.md`, and runs `$VISUAL`, otherwise `$EDITOR`, on it.
2. Edit and close the file. MendCode waits, reads it back and drops the editor's final newline.

Words in the variable precede the file (`VISUAL="code --wait"`). Quotes keep a path with spaces together.

While the editor runs, the client hands over the terminal by leaving the alternate screen and raw mode. It restores both and repaints afterwards, even if the editor fails.

| Result | Prompt behavior |
| --- | --- |
| File unchanged | Prompt and undo history stay untouched |
| File changed | Text replaces the prompt in one undo step |
| Neither variable set | Toast explains; prompt stays |
| Non-zero exit | Prompt stays as it was |

This is the one place the client runs another program, so it lives in `packages/editor-launch` and is loaded with a dynamic import the first time you use it; a terminal that never does pays nothing.

## Copy

| Command or key | Copies |
| --- | --- |
| `/copy` | Session transcript, including thinking, tools and assistant metadata according to current display settings |
| `ctrl+x y` | Last assistant answer |
| `/copy n` | nth answer from the end; `/copy 2` is the one before last |
| `/copy pick` | Opens a response picker with preview and history paging; Enter copies the selection |

If the session exceeds the export bound or one clipboard sequence, `/copy` copies the last answer instead and says so. `/export` saves it all and offers file and editor destinations for longer transcripts.

### Message actions

Open Copy / Revert / Fork through `/messages` or a click on a chat message. In `/timeline`, press `a` for the selected message's actions.

Revert restores its prompt after rewinding. Fork switches sessions and prepares that prompt for editing.

### Clipboard limits

The client emits OSC 52, including tmux passthrough when `$TMUX` is set. Terminals that disable OSC 52 ignore it; clipboard success cannot be detected.

One sequence carries about 55 KB. Oversized or truncated responses are refused.

## Vim mode

Run `/vim`, `/vim on` or `/vim off` to switch modal editing. `/customize` has the same `vimMode` row, off by default and saved in `profile.json`.

The prompt starts in insert mode. A row above it shows `-- INSERT --`, `-- NORMAL --`, `-- VISUAL --` or `-- VISUAL LINE --`, followed by a half-typed command such as `2d`.

On terminals that support it, the cursor becomes a block outside insert mode. Sending a prompt returns to insert mode.

| mode | keys |
|---|---|
| any | `Esc` leaves insert and visual mode; in normal mode it drops a half-typed command, and with nothing pending it behaves as before (cancel the turn, dismiss a question) |
| normal motions | `h j k l`, `w b e`, `0 ^ $`, `gg G` (`3G` goes to line 3), `f t F T` plus a character; arrows work as `h j k l`, and `j k` move by drawn rows with a sticky column; counts before any motion (`3w`) |
| normal operators | `d` delete, `c` change, `y` yank, with a motion (`dw`, `d$`, `c2w`, `dgg`), doubled for the line (`dd cc yy`, `3dd`), or with a text object (`diw daw ciw`); `cw` stops before the space like vim |
| normal shortcuts | `x X D C s S Y`, `r<char>`, `p P` (lines paste below/above, text after/before the cursor), `u` undo, `Ctrl+R` redo, `.` repeat the last change including the text typed in insert mode |
| enter insert | `i a I A o O`; a count repeats the typed text (`3ihi <Esc>`) |
| visual | `v` characters, `V` lines; motions extend the selection, `o` swaps its ends, `d x` delete, `y` yank, `c s` change, `D X Y C S` act on whole lines |

Enter sends the prompt from normal mode too. Letters with no meaning in normal mode are ignored, never typed. `Ctrl+R` is redo in normal and visual mode and still restores a draft in insert mode. Counts and dot repeat cover the commands above; registers other than the unnamed one, macros, marks, search and `:` commands are not included. Undo steps follow the editor's own (a word typed in insert mode is one step), not vim's whole-insert step.

## Keymap editor

`/keymap` (alias `/keybindings`) lists every action with its keys, the defaults beside them, and rebinds by pressing a key. Type to filter by action or key name.

| key | does |
|---|---|
| `↑ ↓ PgUp PgDn Home End` | select an action |
| `Enter` | set key: press the new key and it replaces the action's keys |
| `Ctrl+A` | add key: the new key is added to the existing ones |
| `Ctrl+D` | unbind every key of the action |
| `Ctrl+R` | reset the action to its defaults (drops its entries and any that took one of its default keys) |
| `Ctrl+G`, twice | reset every binding (empties `keybindings.json`) |
| `Ctrl+X`, then a character | while waiting for a key, makes a leader chord (`ctrl+x w`) |
| `Esc` | cancel, clear the filter, close |

If another action holds the key, the page names it and waits. Press `Enter` to replace it or `Esc` to keep things as they are.

- Reserved keys (`Ctrl+C`, `Enter`, `Esc`, `Tab`, `Backspace`) and unnamed terminal keys are refused with the reason.
- `!` marks an action sharing a key with another action that hides it.
- Extension keys are listed but read-only.

Changes go to [`keybindings.json`](extensions-tui.md#keys) in the data dir: the file is edited as JSON (entries the editor does not know are kept), written whole through a temporary file, and read again at once, so the new keys work without a restart. A file that is not valid JSON is left untouched and the page says so.

## Terminal setup

1. Run `/terminal-setup`. It detects your terminal from its environment and prints the setting and location for Shift+Enter to send the understood newline sequence, `ESC [ 13 ; 2 u`.
2. Use `↑ ↓` to see other terminals. Under tmux, the instructions add `extended-keys` lines.
3. Press a key to inspect its report in the bottom panel, for example whether Shift+Enter arrives as a newline or plain Enter.

Detection covers kitty, WezTerm, Ghostty, Alacritty, iTerm2, Terminal.app, VS Code, Windows Terminal, Zed, JetBrains, Konsole and GNOME Terminal; tmux and screen are noted.

It prints instructions, and nothing is written to tmux's configuration or to any terminal's other than the three below. For kitty, Ghostty and Alacritty, whose setting is a plain config line, `a` adds the line the page shows to the terminal's own config file (see "Adding the setting from the page", below). Alt+Enter and Ctrl+J insert a newline everywhere with no setup (on a Mac Alt+Enter needs Option as Alt, below). On a Mac it asks the terminal for the kitty keyboard protocol itself (below); on Linux and Windows it never does, and it does not use modifyOtherKeys anywhere.

### Option as Alt on a Mac

A Mac keyboard has Option, not Alt, and most macOS terminals type the character Option makes (`œ` for Option+Q, `¬` for Option+L on a US layout) instead of sending the Alt key, so none of the `alt+` keys fire until the terminal is told to send Alt. On a Mac `/terminal-setup` opens on this topic (`tab` switches to the Shift+Enter setup); its key check says whether Option sent Alt (`opt+q: Option sends Alt, the alt+key bindings work`) or typed a character (`œ: Option typed a character, not Alt (opt+q does not fire)`). The setting per terminal:

| Terminal | Setting |
|---|---|
| Ghostty | `macos-option-as-alt = true` in `~/.config/ghostty/config`; `left` or `right` keeps the other Option key for accents. Ghostty turns it on by itself for US keyboard layouts only |
| kitty | `macos_option_as_alt both` in `kitty.conf` (restart kitty) |
| WezTerm | `config.send_composed_key_when_left_alt_is_pressed = false` and `..._right_alt_is_pressed = false`; the left Option key already sends Alt by default |
| Alacritty | `option_as_alt = "Both"` under `[window]` in `alacritty.toml` |
| iTerm2 | Settings > Profiles > Keys > General: Left Option key (and Right) set to `Esc+` |
| Terminal.app | Settings > Profiles > Keyboard: tick "Use Option as Meta key" |
| VS Code | `"terminal.integrated.macOptionIsMeta": true` |
| Zed | `"terminal": { "option_as_meta": true }` |
| JetBrains | Settings > Tools > Terminal: "Use Option as Meta key" |

#### Adding the setting from the page

On the Option topic (a Mac) and the Shift+Enter topic:

1. Select kitty, Ghostty or Alacritty and press `a`. This is offered only for those terminals and only when MendCode knows your home folder.
2. Review the config file and lines named by the page after it reads the file.
3. Press `y` to write. Any other key, including `esc`, cancels without writing.

WezTerm (a Lua file), iTerm2, Terminal.app, VS Code, Zed and JetBrains keep instructions only.

The file is only appended to, or created, under a `# added by MendCode (/terminal-setup)` line; nothing already in it is rewritten, and a file that is not writable or not readable is left as it is. It refuses, and says why, when a line for the same setting is already there with another value (`macos-option-as-alt = left`, `macos_option_as_alt no`, `option_as_alt = "OnlyLeft"`, another action on Shift+Enter) or, for Alacritty, when the TOML cannot take the lines at its end because the `[window]` table or an inline `bindings` list exists already; the reason shows the line to add by hand. When the setting is already there it says so. The file is read again just before the write, and a file that changed meanwhile is not written.

| Terminal | Files looked at (the first that exists, unless merged) | New file | After writing | Source |
|---|---|---|---|---|
| Ghostty | `$XDG_CONFIG_HOME/ghostty/config` and `config.ghostty` (default `~/.config`), and on macOS `~/Library/Application Support/com.mitchellh.ghostty/config` and `config.ghostty`; all are merged, so any one takes the line | `~/.config/ghostty/config` | cmd+shift+, ; quit and reopen if Option still types | `ghostty +edit-config` help and strings of Ghostty 1.3.1 (the names and the macOS folder); that the older name `config` is still read in 1.3 is inferred from the same strings |
| kitty | `$KITTY_CONFIG_DIRECTORY/kitty.conf` if set, else `$XDG_CONFIG_HOME/kitty/kitty.conf`, then `~/.config/kitty/kitty.conf` | the first of those | restart for the Option setting (kitty does not apply it on a reload); ctrl+shift+f5 for the key | kitty's `--config` documentation and `macos_option_as_alt` entry, read from the installed kitty |
| Alacritty | `$XDG_CONFIG_HOME/alacritty/alacritty.toml`, `$XDG_CONFIG_HOME/alacritty.toml`, `~/.config/alacritty/alacritty.toml`, `~/.alacritty.toml` | `$XDG_CONFIG_HOME/alacritty/alacritty.toml` | saved files are reloaded; restart if Option still types | Alacritty's documentation, from memory: not installed here, untested |

An `include`, `config-file` or `import` of another file is not followed: a key set only there is not seen, so the line can be added and then overridden (Ghostty reads `config-file` entries after the main file). The tests run against temporary home folders; nothing in them reads or writes the real ones.

#### Real key reports (the keyboard protocol)

On a Mac, MendCode asks the terminal on start whether it speaks the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) (`CSI ? u`, followed by a device attributes request every terminal answers). A terminal that answers gets the protocol switched on (flags 1, 4, 8 and 16, pushed on its flag stack); one that does not is left alone and sees nothing but those two ignored queries, with no wait: the answer is read when it arrives. The flags are popped when MendCode leaves, suspends for an editor or Ctrl+Z, and when the process ends, also on a plain `kill`.

With it on, Option+Q arrives as Alt+Q with the text it composed, so the alt bindings work without the terminal setting. When the Alt key has a binding in MendCode it is that binding, as Alt is on Linux; when it has none (`@` on Option+2 of a Spanish keyboard) the composed text is typed. Typing, pastes (always bracketed), Ctrl keys, Enter, Tab and Esc are translated back to the keys MendCode already binds, so nothing else changes. Option+N (a dead key) and the other dead keys are not reported by terminals until the character is complete, so Option+N still does not work; use `ctrl+x`.

Proven by the protocol's documentation and the terminals' sources: Ghostty and kitty send the Alt modifier for Option+key when "report all keys" is on, even with Option as Alt off (Ghostty `src/input/key_encode.zig`, kitty `kitty/key_encoding.c` and `glfw/cocoa_window.m`). Alacritty never sends Alt for a key that types text when `option_as_alt` is off (`alacritty/src/input/keyboard.rs`), so there the setting below is still the fix. iTerm2 (3.5 and later implement the protocol; what it sends for Option is not verified here), WezTerm (answers only with `enable_kitty_keyboard = true`, off by default) and Terminal.app (no protocol) are not proven; there the composed character below still applies. The Settings row `keyProtocol` (`/customize` > Input & keys > Key reports, `auto` or `off`) and `MENDCODE_KEY_PROTOCOL=0` turn it off.

`bun scripts/key-probe.ts` prints what a terminal sends for each key with these modes on (`--legacy` without them).

#### The composed character

When the terminal cannot report Option as Alt (Terminal.app, Alacritty and iTerm2 as they ship, the right Option key of WezTerm, anything that did not answer the query above), a lone character that Option typed for a default alt binding runs that binding instead of being typed. `œ` is Option+Q on the ABC, US, British and most other layouts, and it opens the comment on a kept selection. The characters are read per keyboard layout (the Mac's current layout is read from `~/Library/Preferences/com.apple.HIToolbox.plist` when a candidate arrives, so a switch is seen at the next key; a layout the table does not have, or an unreadable file, reads as ABC for the first and changes nothing for the second):

| Binding | ABC / US / British / USInternational / Dutch / Australian / Brazilian legacy | Other layouts |
|---|---|---|
| `alt+q` comment (selection, or the offer after a copy; an empty prompt walks the newest answer) | `œ` | `œ` Spanish, Spanish legacy, Portuguese |
| `alt+l` comment list (only with comments to list) | `¬` | `¬` Spanish legacy, French, Brazilian legacy; `λ` Latin American; `ł` Brazilian ABNT2 |
| `alt+r` prompt history search (empty prompt) | `®` | `®` on all |
| `alt+p` earlier prompt (empty prompt) | `π` | `π` on all but Brazilian ABNT2 (`þ`) |
| `alt+,` `alt+.` effort down and up (empty prompt) | `≤` `≥` | `≤` `≥` Brazilian; `∞` German, French `alt+,`; `Ÿ` Spanish legacy `alt+,` |
| `alt+}` right panel (empty prompt, panel on) | `’` | `º` Brazilian ABNT2 |
| the tutorial's rail `alt+q` `alt+b` `alt+s` `alt+m` | `œ` `∫` `ß` `µ` | per layout |

Every character in the table was read from the layout's own data with `UCKeyTranslate` on macOS (Option held, on the key that types the letter on that layout); nothing is written from memory. Left out on purpose: dead keys (Option+N is a tilde that waits for a letter, so `alt+n` cannot be reached this way), anything ASCII (Option+L is `@` on German, Option+Q is `@` on Latin American), and punctuation people write prose with (`«`, `“`, `‘`, `…`, `„`, `‚`); a layout where the key types such a character has no character for that binding, and it still needs the terminal setting or the `ctrl+x` chord.

The fallback avoids taking ordinary typing under these conditions:

- macOS only.
- One character alone in its read. A word, typing burst or paste (bracketed or not, to the prompt) never matches.
- The character is the layout's own for that key, and the keymap still binds it.
- The binding is meaningful right then, as above; never inside existing text, a comment being written or the list.
- It stops for the session as soon as a key arrives as real Alt.

The first use shows a toast explaining what happened and the terminal's fix: `Option typed œ: ran opt+q`.

False positives remain when a prompt's first character, typed alone into an empty prompt, is the layout's Option character: `œ` for French on an ABC keyboard, or `π` and `®` typed deliberately.

Turn it off in `/customize` > Input & keys > Option characters (`optionKeys`, `auto` or `off`).

#### Chords for the alt keys

Option+N is a dead key (a tilde that waits for a letter), so no terminal setting and no table can make `alt+n` reachable on every Mac. Every default alt key that had no other way in has a `ctrl+x` chord that does the same, in every terminal and on every OS:

| Alt key | Before | Chord now | Does |
|---|---|---|---|
| `alt+q` | none (`ctrl+g` since) | `ctrl+x w` | comment on the selection, the offer after a copy, or walk the newest answer |
| `alt+l` | none | `ctrl+x W` | comment list |
| `alt+r` | none | `ctrl+x ?` | search the project's earlier prompts |
| `alt+p` | none | `ctrl+x [` | earlier prompt |
| `alt+n` | none | `ctrl+x ]` | later prompt |
| `alt+,` | none | `ctrl+x ,` | effort down |
| `alt+.` | `f3` | `ctrl+x .` | effort up |
| `alt+up` | none | `ctrl+x ^` | edit the queued prompt |
| `ctrl+\`, `alt+}` | none | `ctrl+x }` | focus the right panel (action `panel.focus`; esc gives the keyboard back). A click on the panel does the same, and a click on the chat gives the keyboard back |
| `alt+j` `alt+J` | none | `ctrl+x j` `ctrl+x J` | jump forward and back to a character |
| `alt+y` `alt+Y` | none | `ctrl+x '` `ctrl+x "` | yank and yank-pop |

The chords that existed (`n l m t c q a U d e y p o z r g G h x b B s i k u / v f Y` and `down`) did not move. A new letter never answers to the lowercase of an old chord (the leader tries the key as typed, then lowercase), so `W` and `J` take over nothing. The alt keys of the editing actions that have a plain key (`alt+f` and `alt+b` have `ctrl+left` and `ctrl+right`, `alt+d` has `ctrl+delete`, `alt+enter` has `ctrl+j`) and `alt+a`, `alt+e` and their selecting forms, which no free chord letter is left for, have no chord. The tutorial's `alt+n` has Enter once a lesson is done, and `alt+s` skips.

The chords are bound like any other: `keybindings.json` can move or remove them, and a hint names the chord only while it is still bound. `ctrl+x w` also keeps the kept selection and the offer after a copy, which any other key would drop. While the right panel's Galaxy view has the focus, its own letters (`h j k l f m [ ]`) answer first, so the chords on those letters need the focus left first (esc).

### Key names in hints

On a Mac a hint with room for one key names the chord (`ctrl+x W list`, `ctrl+x ?`, `ctrl+x ^ edit` in the queue) until MendCode has seen a real Alt key or the terminal reports keys through the protocol above; then it says `opt+l` again. That is the form known to work in the session. The comment key needs none of this: its hint is `ctrl+g` on every OS, and the chord (`ctrl+x w`) or `opt+q` only when `ctrl+g` is no longer bound to it. Windows and Linux hints are the Alt keys they always were, and so is a Mac whose `altLabel` is not `auto`. The keymap page, `/help` and the tutorial list the Alt keys.

Hints name the Alt key by the platform: `opt+q` on macOS, `alt+q` elsewhere (the footer and prompt hints, the slash menu's key column, `?`, `/help`, `/keymap`, the tutorial, the toast after a copy). `/customize` > Input & keys > Alt key label (`altLabel`: `auto`, `alt`, `opt`, `symbol`) forces a form on any OS; `symbol` writes `⌥q` and `ctrl+⌥x`. Only what is displayed changes: `keybindings.json`, the docs and extensions keep the canonical `alt+q`, and `opt+q` or `option+q` are accepted there as the same key.

## Bell

Enable the `bell` row in `/customize` to ring when a current-session turn completes or fails. It is off by default and saved as `turnBell` in `<data dir>/tui/profile.json`.

The bell stays silent for:

- Turns replayed from before the terminal opened.
- Cancelled turns.
- A focused terminal window with the default `notifyWhen: unfocused`, when the terminal reports focus; see [return](return.md).

`/doctor` checks what this terminal supports (colors, keys, clipboard, images, focus, tmux) and says how to fix each gap.

## Left out from v1

- **`super+z` / `super+shift+z`**, which terminals do not send.
- **A turn-end sound.** v1 has none to port: its sound player (`sound.ts`) only plays the animated logo's hum and pulse. There is no audio here; the terminal bell is this version's own addition.

## IDE context (Zed)

1. Run `/ide` to open the project bridge and selection preview. It is off by default.
2. Run `/ide on` to enable it for this project, or `/ide on /absolute/path/db.sqlite` to choose a Zed database.
3. Run `/ide off` to disable it immediately. The choice persists in private `<data dir>/ide/` configuration; existing ACP sessions are unchanged.

The daemon also accepts `MENDCODE_ZED_DB`, otherwise Zed's stable macOS/Linux database path.

### Selection and limits

IDE discovery starts after daemon settings arrive. An off bridge schedules no background redraws; incidental renders before startup do not query the editor.

The daemon reads active panes from a read-only SQLite transaction, preferring the most
specific matching workspace, then the most recent. Multiple/reversed UTF-8 ranges and
unsaved buffer text are supported. An editor cursor includes the open-file context.
Only files inside the active project are included. Missing/incompatible databases show
`unavailable`; a transient failure retains the preview but never submits stale text.
Buffers over 1 MiB or selections over 32 KiB/64 ranges are refused explicitly.

A pending selection appears above the prompt and is attached once to the next successful
submission, without changing the displayed user message. Changes make it pending again.
`/ide clear` dismisses that exact selection until it changes. Failed sends keep it pending.
Selection text is never written to the IDE configuration or diagnostic logs.

### Preview keys and opening files

| Key | Does |
| --- | --- |
| `e` | Enable/disable |
| `c` | Clear |
| `o` | Open the current file/range |
| `r` | Refresh |
| Arrows/PageUp/PageDown | Scroll the preview |
| Esc | Return |

Use `/ide open path:line:column` to open a project file with the daemon's `zed` executable, using one-based positions.

Paths with spaces are accepted as the remaining argument, optionally quoted. Opening is refused while off or for a missing, external or escaping symlink path.

### Protocol

The additive protocol commands are `ide.query`, `ide.configure`, `ide.open`; typed client
helpers are `ideContext`, `configureIde`, `openIdeFile`. All are local-only and excluded
from remote read-only authority because context contains user content. No additional
network listener, provider or dependency is required. Verification with an installed
editor remains manual.

## VS Code, Cursor and other forks

`editors/vscode` is a plain-JavaScript extension (no build step, no dependencies) for VS Code, Cursor, VSCodium and Windsurf; install steps are in its `README.md`. It runs `mendcode` in an editor terminal at the workspace folder and has a status bar Control Center (quick pick of the commands below).

| command | does |
|---|---|
| Open / New Session | show or start the terminal client (`mendcode.command`, `mendcode.args`, `mendcode.dataDir`; run without a shell) |
| Add Selection to Prompt (`cmd/ctrl+alt+m`) | types `@path?start=10&end=20` into the prompt, without sending |
| Add File to Prompt (explorer menu) | types `@path` (quoted when the path has spaces) |
| Fix Problems in File | types the file's errors and warnings (at most 20) into the prompt |
| Connect Editor Context | sets `mendcode.shareContext` and types `/ide on vscode`; press Enter |

### Share the live selection

Sharing requires two opt-ins:

1. Enable `mendcode.shareContext`, off by default and machine-scoped so a workspace cannot flip it. The extension publishes the active file and selection to `<data dir>/ide/vscode/<hash>.json`.
2. Run `/ide on vscode` so the daemon reads it for this project.

The record uses mode 600, is replaced whole on every change and every 30 s, and is removed on close. The terminal keeps the last text editor as active.

The daemon applies the Zed rules:

- Only files inside the project, using real paths so outward symlinks are refused.
- At most 64 ranges and 32 KiB per range.
- One pending selection attached to the next prompt.

A record not refreshed for 90 s reads as `unavailable`, so a crashed window leaves no old context behind.

Run `/ide on zed` to return to Zed. The choice is stored per project in private IDE configuration (`editor`); a database path applies only to Zed.

### Open a file

`/ide open path:line:column` runs the daemon's `code --goto` (`cursor`, `codium`, `windsurf` or `code-insiders` according to the editor the extension reports; `MENDCODE_VSCODE_BIN` overrides) with an argument array, only while the bridge is on and for project files. The extension never starts a process or opens a connection; the data it writes stays in the data dir.

## JetBrains and other ACP editors

There is no JetBrains plugin. ACP-hosting IDEs embed v2 through `mendcode acp`, a stdio agent. Sessions, approvals and history stay in the daemon; see [`automation.md`](automation.md).

| IDE | Setup |
| --- | --- |
| JetBrains AI Assistant | Add a custom agent with command `mendcode` and arguments `acp`; use `--cwd PROJECT` for a fallback project and `--dir DATA` for a separate data dir |
| Zed | Put the same command under `agent_servers` in settings |

Check the IDE's ACP documentation for the exact file or dialog; it changes between releases.

Selection context through `/ide` is available only for Zed and VS Code. ACP hosts send their own context as prompt blocks.

## Scratchpad editor

Open the tray Scratchpad with `/scratch` or `ctrl+x s`. It shares the prompt's editor component and inline editing bindings, but has its own cursor, selection and undo history.

| Key | Does |
| --- | --- |
| Enter | Add a newline |
| Esc | Flush outstanding changes and return to the prompt |

Changes autosave after 500 ms through the daemon's per-project `scratchpad.set`. The note never becomes a prompt draft or model message.

Long text wraps and scrolls within the panel, with a mini scrollbar.
