import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, plain, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../apps/cli/src/view/sidebar-spec"
import { rightBarCells } from "../apps/cli/src/view/right-bar"
import { fit } from "../apps/cli/src/view/deck"
import { cells, textWidth } from "../apps/cli/src/view/wrap"
import { glyphs, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import { highlightLine } from "../apps/cli/src/ui/selection"
import { buildCommentMessage, locateQuote, parseCommentMessage, replyUnits, type ReplyComment, type ReplyUnit } from "../apps/cli/src/view/reply-comments"
import { renderToastRow } from "../apps/cli/src/view/toast"
import { PROMPT_MARGIN } from "../apps/cli/src/view/prompt-chrome"
import { chipRow, COMMENT_TOAST_HINT, commentHint, commentList, composeHeader, decideHeader, hintByPassage, hintOnRule, markRows, parseDecisions, replyBar, tintRule, type ChipModel } from "../apps/cli/src/view/reply-comments-view"
import { sentRows } from "../apps/cli/src/view/reply-comments-sent"

/**
 * Reply comments: frames of the design (a mock on the real rendering, nothing here is wired into the app). Usage:
 * `render-comment-frames.ts [directory]`, default `.agents/runs/frames/comments` of the main checkout.
 *
 * What is real: the transcript rows, the prompt chrome and footer, the typed text and cursor, the toast, the right sidebar and the
 * selection highlight (a real mouse drag through `app.onKey`, with `copyOnSelect` on or off). What is drawn by the new view code
 * (`view/reply-comments-view.ts`, theme roles and glyph set only): the hint, the compose header, the chip row, the list, the reply
 * bar, the gutter marks and the folded sent message. The extra rows are put in the chat column the way the layout would place them:
 * they take the free rows above the prompt, else the transcript scrolls up by that many rows; the right sidebar does not move.
 * Plain text loses colour: each frame ends with `-- fill:` lines saying where a selection or a marked passage is filled, and
 * `ansi/` holds the same frames with the real theme colours.
 *
 * DESIGN NOTE (exploration; nothing here is reachable from the app)
 *
 * Shape. Comments are chips attached to the ONE prompt. A comment is a quoted passage (the text a selection copies today) plus
 * the user's words; Enter stores it and the main draft comes back untouched; one Enter on the prompt sends every comment and the
 * draft as one message. Code: `view/reply-comments.ts` (model, wire format, answer units, finding a quote in drawn rows) and
 * `view/reply-comments-view.ts` (rows). Tests: `test/reply-comments.test.ts`, `test/reply-comments-view.test.ts`.
 *
 * What the frames made me change in the proposal, and why
 *  1. Plain `c` is not the key outside the reply mode. With copy on select (the default) the selection is gone the moment the
 *     mouse is released, so there is no selection for a bare letter to act on, and a kept selection (copy off) is dropped by any
 *     key with that key still typed (`mouse-selection.ts` onKey). A bare `c` would steal typing. The key is `alt+c`; plain
 *     letters are used only inside the reply mode, which is entered explicitly and shows its bar.
 *  2. The hint does not sit "by the selection". After a copy nothing is selected and the highlight is gone; the offer rides the
 *     toast row that already says `copied 127 chars` (the toast's own `hint` field: `copied 127 chars · alt+c comment`, no row
 *     added). A kept selection gets a pill on the prompt's rule. See the alternatives below.
 *  3. At most 9 comments: the number fits the 2-cell margin of the transcript as a gutter mark (`1┃`) and one chip digit.
 *  4. The chip row collapses to `3 comments` as soon as a chip cannot show 14 cells of its quote (3 chips collapse at 60 columns,
 *     5 at 80); a chip whose quote reads `“Use O…”` is an anonymous number.
 *  5. A comment whose answer is no longer the newest is marked `1↑` in its chip and sent as `of="earlier answer"`.
 *
 * Interaction (the existing keymap was checked: `alt+c` and `alt+l` are bound nowhere in `keymap.ts`, `editor-actions.ts`,
 * the leader chords or the tutorial rail; `alt+q` already exists as `selection.quote`, see open questions)
 *
 *   Context                        Key / mouse                      Effect
 *   drag in the transcript         as today                         highlight; copy on release (copyOnSelect) or ctrl+c; unchanged
 *   within 5 s of a copy           alt+c, or click on the toast     compose a comment on the copied passage; any other key, a click,
 *                                                                   the wheel or a new event ends the offer and dismisses the toast
 *   kept selection (copy off)      alt+c, or click on the pill      same; the selection becomes the pending highlight
 *   no selection, prompt focused   alt+c                            reply mode on the newest finished answer
 *   composing                      type; enter; esc                 enter stores the chip and restores the draft and cursor; esc cancels
 *   chips present                  alt+l, or click on the chips     list: up/down select, e edit, d delete, J/K move, esc close
 *   reply mode                     j k / 1-9 / c / d / esc          next-previous unit; jump to option N; comment the unit; decide the
 *                                                                   option list (`1: yes, 2: no`); leave. Any other printable key
 *                                                                   leaves the mode and is typed: nothing is swallowed.
 *   reply mode, mouse              click on a passage               moves the unit there; a drag is a normal selection
 *   anywhere                       enter                            send: comments and draft in one message (queues like any message)
 *   ctrl+c                         as today, then                   clears the draft; with an empty draft it clears the comments
 *                                                                   (toast with how many) before it can quit
 *
 * Plain letters while the prompt has focus: reached only inside the reply mode (entered by `alt+c`, drawn as a bar above the
 * prompt, left by esc or by any key that is not a reply key). Vim mode: the reply mode wins while it is on and gives the keys back
 * on leaving. The offer after a copy and the pill on a kept selection react to `alt+c` only, never to a letter.
 * Terminals that send option as a character (macOS Terminal by default: `ç`, `¬`) need the CSI-u forms (`\x1b[99;3u`,
 * `\x1b[108;3u`) bound as well, like `alt+p` is today; the actions would be `selection.comment` and `comment.list`.
 *
 * Wire format (what the model receives; `buildCommentMessage`). Each quote sits in a fence longer than any backtick run in it,
 * the user's own words have the format's tags defused (`</comment>` becomes `</\comment>`), the 2000-character quote limit says
 * how much it cut, and the whole message stays under the 60 000 characters the review message keeps for itself:
 *
 *   <mendcode_comments count="2">
 *   Comments on your answer. Each <comment> has a verbatim <quote> and my comment on it: answer each by number. A <note> is general.
 *
 *   <comment n="1" of="last answer">
 *   <quote>
 *   ```
 *   Use Opus 5 for the planner and keep the executor on codex.
 *   ```
 *   </quote>
 *   too slow for a one-off, skip it
 *   </comment>
 *   <comment n="2" of="earlier answer">
 *   ...
 *   </comment>
 *   <note>
 *   go ahead with codex
 *   </note>
 *   </mendcode_comments>
 *
 * In the transcript (`sentRows`, frames 08): `3 comments`, then per comment one `┃ “quote…”` row and the words under it, the note
 * last, `ctrl+o opens the quotes`. Today the same text is drawn as a wall cut mid-tag (`08-sent-today-*`); `/copy`, `/export` and
 * other clients keep the raw envelope, which `parseCommentMessage` folds back.
 *
 * Lifecycle
 *  - Persistence: comments ride the draft system (`drafts.ts`): `DraftContent` gains `comments` and `draft.set`/`draft.get`
 *    an optional `comments` array, so the debounce, `ctrl+r`, `/drafts` and the retention days apply. Without a protocol change the
 *    envelope can be stored in the draft text and parsed back on restore (previews would show tags).
 *  - Session switch: per session like the draft (flushed before leaving, restored on return); never carried to another session,
 *    where a quote of a foreign answer would mean nothing. The start-up notice says `2 unsent drafts · 3 comments`.
 *  - A new answer arrives while comments are pending: nothing is sent or dropped; passages still on screen keep their mark,
 *    chips get `↑`, the wire says `earlier answer` (`10-*`). The reply mode walks finished answers only.
 *  - Compaction: the anchor (item id) is gone, the quote is kept, the mark is dropped, the list says `quote only` (`11-*`).
 *  - `/clear` only hides rows: chips stay, marks vanish with the rows. `/new` leaves them with the old session.
 *  - Resize: marks are found again from the quote in the drawn rows (`locateQuote`), nothing is stored by row.
 *
 * HARDEST DECISION: where the "you can comment on this" hint appears (frames `01-selection-{kept,copied}-hint-{passage,prompt}-*`).
 *  A. By the passage: a pill on the last row of the passage (`passage`). Closest to the idea and to the desktop apps, but the pill
 *     has to cover words once the last row is full (`01-selection-kept-hint-passage-80x24` hides "anything run"), it moves when the
 *     transcript scrolls, and after a copy there is no highlight left for it to belong to.
 *  B. By the prompt (`prompt`): after a copy it extends the `copied N chars` row the app already draws; with a kept selection it
 *     is a pill on the prompt's top rule, where the activity status already sits. Never covers text, same place at 60 and 160
 *     columns, goes with the toast. Costs: it is not next to the text, and the row is the only trace of the offer.
 *  Recommendation: B. The frames show A losing at the widths that matter (60 and 80) and the offer has to die by itself, which
 *  the toast already does.
 *
 * Open questions
 *  - Keep `alt+q` (`selection.quote`: puts the selection into the prompt as `> ` lines, kept selection only)? It overlaps this;
 *    retire it, or make it the key for the comment.
 *  - `draft.set` with a `comments` field, or the envelope in the draft text?
 *  - Is 5 s the right life for the offer after a copy, and should a click on the toast count?
 *  - `ctrl+c` with comments pending and an empty draft: clear them (proposed) or ask?
 *  - Should the model be told how long ago, or which turn, an earlier answer was (`of="earlier answer"` is all it gets)?
 *  - Other clients (web UI, ACP) show the raw envelope unless they learn `parseCommentMessage`.
 *
 * Where the terminal is worse than the desktop version
 *  - The comment is not under its passage: a chip row and a gutter number stand in for it, and the list (7 rows) hides the top of
 *    the answer at 24 rows (`05-list-open-60x24` loses mark 1).
 *  - At 60 columns three chips are only a count; the quotes are unreadable until the list opens.
 *  - The quote is the drawn text (tables tab-joined, code bars dropped), not the Markdown, and a mouse selection is cell-exact over
 *    wrapped lines. Tool cards, images and diagrams cannot be commented.
 *  - Reaching it takes a chord (`alt+c`) that some terminals do not deliver by default; the desktop has a button.
 *  - Composing hides the draft (kept, not shown); desktop shows both. One comment is typed at a time.
 *  - Nine comments at most, and a quote is cut at 2000 characters.
 *  - The offer after a copy is a five second line of text, not a control that stays.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/comments")
mkdirSync(path.join(target, "ansi"), { recursive: true })

type Size = { width: number; height: number; sidebar?: boolean }
const SIZES: readonly Size[] = [{ width: 60, height: 24 }, { width: 80, height: 24 }, { width: 120, height: 40 }, { width: 160, height: 40, sidebar: true }]
const tag = (size: Size) => `${size.width}x${size.height}${size.sidebar ? "-sidebar" : ""}`
const g = glyphs({})

const OPUS = "Use Opus 5 for the planner and keep the executor on codex. It starts slower, but the plan is checked once before anything runs."
const CODEX = "Use codex for both. Faster, but the plan is never reviewed."
const WARN = "Before either, tell the user the schema change cannot be undone once the first batch has run."
const CODE = "await migrate({ dryRun: true })"
const ANSWER = ["Two ways to run the migration:", "", `1. ${OPUS}`, `2. ${CODEX}`, "", WARN, "", "```ts", CODE, "```", "", "Pick one and I will start."].join("\n")
const UNITS = replyUnits(ANSWER)
const DRAFT = "go ahead with codex"
const ITEM = "item_answer_1"

const COMMENTS: ReplyComment[] = [
  { id: 1, quote: OPUS, text: "too slow for a one-off, skip it", itemId: ITEM },
  { id: 2, quote: WARN, text: "put this in the PR description too", itemId: ITEM },
  { id: 3, quote: CODE, text: "keep dryRun on in CI", itemId: ITEM },
  { id: 4, quote: CODEX, text: "this one", itemId: ITEM },
  { id: 5, quote: "Pick one and I will start.", text: "starting now", itemId: ITEM },
]
const chipsOf = (comments: readonly ReplyComment[], lastItemId = ITEM): ChipModel[] => comments.map((comment, index) => ({ n: index + 1, quote: comment.quote, ...(comment.itemId !== lastItemId ? { earlier: true } : {}) }))

// ----- the real app, a conversation and a real mouse drag ---------------------------------------------------------

type Scene = { h: Harness; size: Size; chatW: number }

async function scene(size: Size, { copyOnSelect = true, exchanges = [[ "How should I run the migration?", ANSWER ]] as ReadonlyArray<readonly [string, string]> } = {}): Promise<Scene> {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", copyOnSelect, ...(size.sidebar ? { rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.pulse) } : {}) } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width: size.width, height: size.height, mode: "full" })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  for (const [user, answer] of exchanges) talk.exchange(user, answer)
  h.app.render()
  const chatW = size.width - (size.sidebar ? rightBarCells({ columns: size.width, setting: DEFAULT_TUI_PROFILE.sidebarWidth, collapsed: false }).cells : 0)
  return { h, size, chatW }
}

const mouse = (code: number, col: number, row: number, up = false) => `\x1b[<${code};${col + 1};${row + 1}${up ? "m" : "M"}`
const lastFrame = (h: Harness) => (h.app.render(), h.frames.at(-1)!)

/** Drags over `quote` in the drawn rows: press at its first character, release after its last. The app copies it (or keeps it) as it does today. */
async function dragOver(s: Scene, quote: string) {
  // Only the chat column: with the right sidebar open the rows carry its text too.
  const rows = lastFrame(s.h).map((row) => plain(row).slice(0, s.chatW))
  const at = locateQuote({ rows, quote })
  if (!at) throw new Error(`passage not on screen at ${s.size.width}x${s.size.height}:\n${rows.join("\n")}`)
  const first = quote.replace(/\s+/g, " ").split(" ")[0]!
  const from = rows[at.from]!.indexOf(first)
  const to = rows[at.to]!.trimEnd().length - 1
  await s.h.app.onKey(mouse(0, from, at.from))
  await s.h.app.onKey(mouse(32, Math.min(from + 1, to), at.from))
  await s.h.app.onKey(mouse(32, to, at.to))
  await s.h.app.onKey(mouse(0, to, at.to, true))
}

// ----- the layout: the chat column's rows and the sidebar column's, kept apart ----------------------------------

type Layout = { chat: Line[]; side: Line[]; chatW: number; rule: number; bodyEnd: number }

function splitLine(line: Line, at: number): [Line, Line] {
  const head: Line = []
  const tail: Line = []
  let used = 0
  for (const span of line) {
    let before = ""
    let after = ""
    for (const cell of cells(span.text)) {
      if (used + cell.width <= at) before += cell.text
      else after += cell.text
      used += cell.width
    }
    if (before) head.push({ ...span, text: before })
    if (after) tail.push({ ...span, text: after })
  }
  return [head, tail]
}

function layoutOf(s: Scene): Layout {
  const rows = lastFrame(s.h)
  const split = rows.map((row) => splitLine(row, s.chatW))
  const cursor = s.h.cursors.at(-1)
  if (!cursor) throw new Error("no cursor")
  return { chat: split.map(([chat]) => fit(chat, s.chatW)), side: split.map(([, side]) => side), chatW: s.chatW, rule: cursor.row - 1, bodyEnd: cursor.row - 1 }
}

/** Rows put at `at` in the chat column: free rows just above take the room first, else the transcript scrolls up (the top bar stays). */
function insertAt(layout: Layout, at: number, rows: Line[]) {
  if (!rows.length) return
  const aboveRule = at <= layout.rule
  layout.chat.splice(at, 0, ...rows)
  let owed = rows.length
  let removed = 0
  // Free rows nearest the prompt's rule go first (rows under the rule take them from above it too).
  for (let row = Math.min(at, layout.rule) - 1; owed > 0 && row >= 1 && plain(layout.chat[row]!).trim() === ""; row--) {
    layout.chat.splice(row, 1)
    owed--
    removed++
  }
  while (owed > 0) {
    layout.chat.splice(1, 1)
    owed--
    removed++
  }
  const newAt = at - removed
  // Rows put above the rule take as many rows from above it as they add: the rule keeps its place. Rows put under it push it up.
  if (aboveRule) layout.bodyEnd = Math.min(layout.bodyEnd, newAt)
  else layout.rule -= removed
}

type Look = Partial<Span>
type Spec = {
  above?: Line[]
  below?: Line[]
  tint?: boolean
  /** The hint, and where it is laid: by the passage (falling back to the rule when there is no room) or on the prompt's rule. */
  hint?: { copied: boolean; place: "passage" | "prompt"; quote: string }
  marks?: ReadonlyArray<{ quote: string; n?: number }>
  fills?: ReadonlyArray<{ quote: string; look: Look }>
}

const extent = (text: string): [number, number] => [Math.max(0, text.search(/\S/)), text.trimEnd().length]

/** What the last `assemble` did that a plain-text frame cannot show. */
const notes: { covered: boolean } = { covered: false }

function assemble(s: Scene, spec: Spec): Line[] {
  let covered = false
  const layout = layoutOf(s)
  if (spec.above) insertAt(layout, layout.rule, spec.above)
  if (spec.below) insertAt(layout, layout.rule + 1, spec.below)
  if (spec.tint) layout.chat[layout.rule] = tintRule(layout.chat[layout.rule]!)
  const body = () => layout.chat.slice(0, layout.bodyEnd).map(plain)
  for (const fill of spec.fills ?? []) {
    const at = locateQuote({ rows: body(), quote: fill.quote })
    if (!at) continue
    for (let row = at.from; row <= at.to; row++) {
      const [from, to] = extent(plain(layout.chat[row]!))
      layout.chat[row] = highlightLine(layout.chat[row]!, from, to, fill.look)
    }
  }
  for (const mark of spec.marks ?? []) {
    const at = locateQuote({ rows: body(), quote: mark.quote })
    if (at) layout.chat = markRows({ rows: layout.chat, from: at.from, to: at.to, ...(mark.n !== undefined ? { n: mark.n } : {}), width: s.chatW }, g)
  }
  if (spec.hint) {
    const { copied, place, quote } = spec.hint
    const at = locateQuote({ rows: body(), quote })
    const notice = copied ? layout.chat.findIndex((row, index) => index < layout.rule && plain(row).trim().startsWith("copied")) : -1
    if (place === "passage") {
      // A: the pill by the passage, over its last row when nothing else has room.
      const hint = commentHint({ copied, width: s.chatW - 4 }, g)
      const by = at ? hintByPassage({ rows: layout.chat, plain: layout.chat.map(plain), from: at.from, to: at.to, width: s.chatW, hint, cover: true }) : undefined
      if (by) {
        layout.chat[by.row] = by.line
        covered = by.covers
      }
    } else if (notice >= 0) {
      // B, copied: the toast's own hint on the row that already says `copied N chars` (nothing is added, nothing moves).
      layout.chat[notice] = fit(renderToastRow({ variant: "success", message: plain(layout.chat[notice]!).trim(), hint: COMMENT_TOAST_HINT, oneLine: true }, s.chatW, PROMPT_MARGIN), s.chatW)
    } else {
      // B, kept: the pill laid on the prompt's rule, the way the activity status sits there.
      layout.chat[layout.rule] = hintOnRule({ rule: layout.chat[layout.rule]!, width: s.chatW, hint: commentHint({ copied: false, width: s.chatW - 4 }, g) }).line
    }
  }
  notes.covered = covered
  return layout.chat.map((row, index) => [...fit(row, s.chatW), ...(layout.side[index] ?? [])])
}

// ----- output ---------------------------------------------------------------------------------------------------

const written: string[] = []
function save(name: string, rows: Line[], size: Size) {
  if (rows.length !== size.height) throw new Error(`height ${rows.length} != ${size.height}: ${name}`)
  const lines = rows.map(plain)
  if (lines.some((line) => textWidth(line) > size.width)) throw new Error(`overflow: ${name}`)
  // Colour does not survive plain text: say where the fills are (a selection is the primary fill, a pending or walked passage the element fill).
  const fills = rows.flatMap((row, index) => {
    const out: string[] = []
    let col = 0
    let open: { role: string; from: number } | undefined
    const close = (to: number) => open && out.push(`row ${index} cols ${open.from}-${to - 1} ${open.role === "primary" ? "selection fill" : "element fill"}`)
    for (const span of row) {
      const role = span.bg === "primary" || span.bg === "element" ? span.bg : undefined
      if (open && open.role !== role) {
        close(col)
        open = undefined
      }
      if (role && !open) open = { role, from: col }
      col += textWidth(span.text)
    }
    close(col)
    return out
  })
  const notes_ = [...fills.map((fill) => `fill: ${fill}`), ...(notes.covered ? ["the hint covers the end of the passage's last row"] : [])]
  writeFileSync(path.join(target, `${name}.txt`), `${lines.map((line) => line.trimEnd()).join("\n")}\n${notes_.length ? `\n${notes_.map((note) => `-- ${note}`).join("\n")}\n` : ""}`)
  const ansi = rows.map((row) => `${row.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join("")}`).join("\n")
  writeFileSync(path.join(target, "ansi", `${name}.ansi`), `${ansi}\n`)
  written.push(name)
}

const widthOf = (s: Scene) => s.chatW
const unitQuote = (unit: ReplyUnit) => unit.text

// ----- the frames -----------------------------------------------------------------------------------------------

for (const size of SIZES) {
  const t = tag(size)

  // 01 A selection and its hint. `kept`: copy on select off, the highlight stays and ctrl+c copies. `copied`: today's default, the
  // highlight is gone on release, the toast says it was copied, and the offer to comment stays for a few seconds.
  // `passage` is alternative A (the pill by the passage), `prompt` is B (the toast row after a copy, the prompt's rule while kept).
  for (const place of ["passage", "prompt"] as const) {
    const kept = await scene(size, { copyOnSelect: false })
    await dragOver(kept, OPUS)
    save(`01-selection-kept-hint-${place}-${t}`, assemble(kept, { hint: { copied: false, place, quote: OPUS } }), size)
    const copied = await scene(size)
    await dragOver(copied, OPUS)
    save(`01-selection-copied-hint-${place}-${t}`, assemble(copied, { hint: { copied: true, place, quote: OPUS } }), size)
  }

  // 02 Composing: the quote on a header row, the comment typed in the one prompt; the main draft is out of sight but kept.
  {
    const s = await scene(size)
    await s.h.type("too slow for a one-off, skip it")
    save(`02-composing-${t}`, assemble(s, { below: [composeHeader({ quote: OPUS, width: widthOf(s), draftKept: true }, g)], tint: true, fills: [{ quote: OPUS, look: { bg: "element" } }], marks: [{ quote: OPUS }] }), size)
  }

  // 03 One chip, and the main draft in the prompt untouched. 04 Three chips. 05 The list open.
  for (const [name, count, list] of [["03-one-chip", 1, false], ["04-three-chips", 3, false], ["05-list-open", 3, true]] as const) {
    const s = await scene(size)
    await s.h.type(DRAFT)
    const comments = COMMENTS.slice(0, count)
    const above = list ? commentList({ comments, selected: 1, width: widthOf(s), maxRows: 8, lastItemId: ITEM }, g) : [chipRow({ chips: chipsOf(comments), width: widthOf(s), listing: false }, g)]
    save(`${name}-${t}`, assemble(s, { above, marks: comments.map((comment, index) => ({ quote: comment.quote, n: index + 1 })) }), size)
  }

  // 06 Reply mode: the unit under the cursor on a fill with a rail, the bar above the prompt; the draft is still there.
  for (const [name, index] of [["06-reply-mode-option", 1], ["06-reply-mode-code", 4]] as const) {
    const s = await scene(size)
    await s.h.type(DRAFT)
    const unit = UNITS[index]!
    save(`${name}-${t}`, assemble(s, { above: [replyBar({ index, total: UNITS.length, unit, width: widthOf(s), options: unit.kind === "option" }, g)], fills: [{ quote: unitQuote(unit), look: { bg: "element" } }], marks: [{ quote: unitQuote(unit) }] }), size)
  }

  // 07 The numbered fast path: `d` on an option takes the whole list; the answer is typed as `1: yes, 2: no`.
  {
    const s = await scene(size)
    const typed = "1: no, 2: yes"
    await s.h.type(typed)
    const options = UNITS.filter((unit) => unit.kind === "option")
    const { pairs } = parseDecisions(typed, options.map((unit) => ({ number: unit.number! })))
    save(`07-decide-${t}`, assemble(s, { above: [replyBar({ index: 1, total: UNITS.length, unit: options[0]!, width: widthOf(s), options: true }, g)], below: [decideHeader({ options: options.map((unit) => unit.number!), pairs, width: widthOf(s) }, g)], tint: true, fills: options.map((unit) => ({ quote: unit.text, look: { bg: "element" as const } })), marks: options.map((unit, i) => ({ quote: unit.text, n: i + 1 })) }), size)
    const empty = await scene(size)
    save(`07-decide-empty-${t}`, assemble(empty, { above: [replyBar({ index: 1, total: UNITS.length, unit: options[0]!, width: widthOf(empty), options: true }, g)], below: [decideHeader({ options: options.map((unit) => unit.number!), pairs: [], width: widthOf(empty) }, g)], tint: true, fills: options.map((unit) => ({ quote: unit.text, look: { bg: "element" as const } })), marks: options.map((unit, i) => ({ quote: unit.text, n: i + 1 })) }), size)
  }

  // 08 The sent message. `today`: the text the model gets, drawn by the transcript as it is now. The other: folded, drawn by `sentRows`.
  {
    const message = buildCommentMessage({ comments: COMMENTS.slice(0, 3), general: DRAFT, lastItemId: ITEM })
    const reply = "Understood. Skipping Opus, running codex for both, with the PR note and dryRun on in CI."
    const today = await scene(size, { exchanges: [["How should I run the migration?", ANSWER], [message, reply]] })
    save(`08-sent-today-${t}`, assemble(today, {}), size)
    const parsed = parseCommentMessage(message)!
    const style = { layout: "quiet", icon: DEFAULT_TUI_PROFILE.userIcon, lead: DEFAULT_TUI_PROFILE.userLead, label: "", tint: DEFAULT_TUI_PROFILE.userTint } as const
    // The transcript lays the message out; the folded message is first handed to it as plain text of the same rows, so the rows around
    // it are the real layout. Its text room is a few cells under the column's (indent, lead, the scrollbar's column): try until the
    // placeholder comes back row for row, which is what the wiring would get from the width the transcript passes to the view.
    const lead = textWidth(`${DEFAULT_TUI_PROFILE.userLead} `)
    let done = false
    for (let trim = 2; trim <= 8 && !done; trim++) {
      const mine = sentRows({ parsed, width: today.chatW - trim, style, expanded: false }, g)
      const stand = mine.map((row) => plain(row).slice(lead).trimEnd())
      const folded = await scene(size, { exchanges: [["How should I run the migration?", ANSWER], [stand.join("\n"), reply]] })
      const layout = layoutOf(folded)
      const drawn = layout.chat.map(plain)
      const at = drawn.findIndex((row) => row.includes(stand[0]!))
      if (at < 0 || drawn.slice(at, at + mine.length).some((row, i) => !row.includes(stand[i]!.slice(0, 12))) || drawn[at + mine.length]?.trim() !== "") continue
      mine.forEach((row, i) => { layout.chat[at + i] = fit([{ text: "  " }, ...row], folded.chatW) })
      save(`08-sent-folded-${t}`, layout.chat.map((row, index) => [...fit(row, folded.chatW), ...(layout.side[index] ?? [])]), size)
      done = true
    }
    if (!done) throw new Error(`the folded message does not lay out like its placeholder at ${t}`)
  }
}

// 09 Narrow collapse: the same chips at 60 and 80 columns with 2, 3 and 5 comments.
for (const size of SIZES.slice(0, 2)) {
  for (const count of [2, 3, 5]) {
    const s = await scene(size)
    await s.h.type(DRAFT)
    const comments = COMMENTS.slice(0, count)
    save(`09-chips-${count}-${tag(size)}`, assemble(s, { above: [chipRow({ chips: chipsOf(comments), width: widthOf(s), listing: false }, g)], marks: comments.map((comment, index) => ({ quote: comment.quote, n: index + 1 })) }), size)
  }
}

// 10 Lifecycle at 80x24. A new answer arrives while comments are pending: the chips say which are on an earlier answer. A compaction
// removed the answer: the quotes stay, the marks are gone.
{
  const size = SIZES[1]!
  const next = "Going with codex then. I will run the dry run first."
  const newer = await scene(size, { exchanges: [["How should I run the migration?", ANSWER], [DRAFT, next]] })
  const comments = COMMENTS.slice(0, 3)
  save(`10-new-answer-pending-${tag(size)}`, assemble(newer, { above: [chipRow({ chips: chipsOf(comments, "item_newer"), width: widthOf(newer), listing: false }, g)], marks: comments.map((comment, index) => ({ quote: comment.quote, n: index + 1 })) }), size)
  const list = await scene(size, { exchanges: [["How should I run the migration?", ANSWER], [DRAFT, next]] })
  save(`10-new-answer-list-${tag(size)}`, assemble(list, { above: commentList({ comments, selected: 0, width: widthOf(list), maxRows: 8, lastItemId: "item_newer" }, g) }), size)
  const compacted = await scene(size, { exchanges: [["Where were we?", next]] })
  const orphans = comments.map(({ itemId: _gone, ...rest }) => rest as ReplyComment)
  save(`11-compacted-chips-${tag(size)}`, assemble(compacted, { above: [chipRow({ chips: orphans.map((comment, index) => ({ n: index + 1, quote: comment.quote, earlier: true })), width: widthOf(compacted), listing: false }, g)], marks: orphans.map((comment, index) => ({ quote: comment.quote, n: index + 1 })) }), size)
  const compactedList = await scene(size, { exchanges: [["Where were we?", next]] })
  save(`11-compacted-list-${tag(size)}`, assemble(compactedList, { above: commentList({ comments: orphans, selected: 0, width: widthOf(compactedList), maxRows: 8, lastItemId: "item_newer" }, g) }), size)
}

cleanTemps()
console.log(`${written.length} frames written to ${target}`)
process.exit(0)
