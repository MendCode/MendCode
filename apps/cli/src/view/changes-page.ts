import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { keyText } from "../ui/key-labels"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { clamp, createChangesPageState, diffLength, diffLines, fileRows, placeComments, replayIndex, replaySteps, type ChangesPageState } from "./changes-state"
import { columns, panelGrid, fit } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { lineLabel, locationLabel, type ReviewComment } from "./review-comments"
import { shortenMiddle, truncateEnd } from "./session-list"
import { cells, lineWidth, textWidth, wrap } from "./wrap"

export { changesPageKey, changesReviewSent } from "./changes-keys"
export { createChangesPageState, firstChangedLine, type ChangesFocus, type ChangesMode, type ChangesPageAction, type ChangesPageState } from "./changes-state"

const HINT_WIDE = "↑↓ file · tab focus · o order/O apply · R replay · L comments · s send · r refresh · f view · esc back"
const HINT_WIDE_DIFF = "↑↓ line · c comment · f view · L comments · s send · tab focus · [/] hunk · R replay · v select · l line · esc back"
const HINT_FILES = "↑↓ file · enter diff · o order/O apply · R replay · L comments · s send · r refresh · f view · esc back"
const HINT_DIFF = "↑↓ line · c comment · f view · s send · L comments · tab tabs · v select · [/] hunk · R replay · esc back"
const HINT_REPLAY = "space next · [ back · n/p file · g/G ends · c comment · s send · R exit"
const HINT_REPLAY_READ_ONLY = "space next · [ back · n/p file · g/G ends · R exit"
const HINT_COMPOSE = "enter save · alt+enter newline · ctrl+u clear · esc cancel"
const HINT_JUMP = "0-9 line number · enter go · esc cancel"
const HINT_LIST = "↑↓ select · s send · e edit · d delete · X clear all · enter open · esc back"
const PAGE_TABS: PageTab[] = [{ key: "1", label: "Files" }, { key: "2", label: "Diff" }]
const GUTTER_MIN_PANE = 60
const CONTINUATION = "…"
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const MAX_COMMENT_ROWS = 3
const MAX_DRAFT_ROWS = 3
const COMMENT_MARK = "◆"

export function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

function spread(left: Line, right: Line, width: number): Line {
  const gap = width - lineWidth(left) - lineWidth(right)
  if (gap < 1) return clampLine(left, width)
  return [...left, { text: " ".repeat(gap) }, ...right]
}

export const STATUS: Record<ChangedFile["status"], { letter: string; fg: ColorName }> = {
  added: { letter: "A", fg: "success" },
  modified: { letter: "M", fg: "warning" },
  deleted: { letter: "D", fg: "error" },
  renamed: { letter: "R", fg: "heading" },
  untracked: { letter: "?", fg: "muted" },
}

export function countSpans(file: ChangedFile): Span[] {
  if (file.binary) return [{ text: " bin", fg: "muted" }]
  if (file.additions === 0 && file.deletions === 0) return []
  return [
    { text: ` +${file.additions}`, fg: "success" },
    { text: ` −${file.deletions}`, fg: "error" },
  ]
}

export function pathLabel(file: ChangedFile, room: number) {
  if (file.oldPath && file.status === "renamed") {
    const label = `${file.oldPath} → ${file.path}`
    if (textWidth(label) <= room) return label
  }
  return shortenMiddle(file.path, room)
}

function fileRow(input: { file: ChangedFile; selected: boolean; focused: boolean; width: number; glyphs: Glyphs; comments?: number }): Line {
  const { file, selected, focused, width, glyphs } = input
  const status = STATUS[file.status]
  const right = [...(input.comments ? [{ text: ` ${COMMENT_MARK}${input.comments}`, fg: "accent" as const }] : []), ...countSpans(file)]
  const rightWidth = lineWidth(right)
  const room = Math.max(0, width - 4 - rightWidth - 1)
  const label = pathLabel(file, room)
  const marker: Span = selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const left: Line = [
    marker,
    { text: status.letter, fg: status.fg },
    { text: " " },
    { text: label, fg: selected ? "primary" : "body", bold: selected && focused },
  ]
  return spread(left, right, width)
}

/** The first file the list shows: the selected one stays inside the `rows` rows. */
export const listOffset = (selected: number, items: number, rows: number) => Math.min(Math.max(0, selected - rows + 1), Math.max(0, items - rows))

function fileList(report: ChangesReport, selected: number, focused: boolean, width: number, rows: number, glyphs: Glyphs, comments: ReadonlyMap<string, number>): Line[] {
  const files = report.files
  const items = files.length + (report.omittedFiles > 0 ? 1 : 0)
  const offset = listOffset(selected, items, rows)
  const out: Line[] = []
  for (let index = offset; index < Math.min(items, offset + rows); index++) {
    const file = files[index]
    out.push(
      file
        ? fileRow({ file, selected: index === selected, focused, width, glyphs, comments: comments.get(file.path) ?? 0 })
        : clampLine([{ text: `+${report.omittedFiles} more files`, fg: "muted" }], width),
    )
  }
  return out
}

function diffHeading(file: ChangedFile, focused: boolean, width: number): Line {
  const status = STATUS[file.status]
  const left: Line = [
    { text: status.letter, fg: status.fg },
    { text: " " },
    { text: pathLabel(file, Math.max(0, width - 2 - lineWidth(countSpans(file)) - 1)), fg: focused ? "primary" : "muted", bold: focused },
  ]
  return spread(left, countSpans(file), width)
}

export function sanitize(text: string) {
  return text.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

export function chunk(text: string, width: number) {
  const chunks: string[] = []
  let current = ""
  let used = 0
  for (const { text: char, width: w } of cells(text)) {
    if (used + w > width && current) {
      chunks.push(current)
      current = ""
      used = 0
    }
    current += char
    used += w
  }
  chunks.push(current)
  return chunks
}

function gutterDigits(lines: string[]) {
  let max = 0
  for (const line of lines) {
    if (!line.startsWith("@@")) continue
    const match = HUNK.exec(line)
    if (!match) continue
    max = Math.max(max, Number(match[1]) + Number(match[2] ?? 1), Number(match[3]) + Number(match[4] ?? 1))
  }
  return Math.max(2, String(max).length)
}

type LineNumbers = { old?: number; new?: number }

/** Old/new line numbers for lines [from, to), derived from the @@ headers. */
function lineNumbers(lines: string[], from: number, to: number): LineNumbers[] {
  const out: LineNumbers[] = []
  let oldN = 0
  let newN = 0
  for (let index = 0; index < Math.min(to, lines.length); index++) {
    const line = lines[index]!
    let numbers: LineNumbers = {}
    const hunk = line.startsWith("@@") ? HUNK.exec(line) : null
    if (hunk) {
      oldN = Number(hunk[1])
      newN = Number(hunk[3])
    } else if (line.startsWith("+")) numbers = { new: newN++ }
    else if (line.startsWith("-")) numbers = { old: oldN++ }
    else if (!line.startsWith("\\")) numbers = { old: oldN++, new: newN++ }
    if (index >= from) out.push(numbers)
  }
  return out
}

function lineColor(line: string): ColorName {
  if (line.startsWith("@@")) return "heading"
  if (line.startsWith("+")) return "success"
  if (line.startsWith("-")) return "error"
  if (line.startsWith("\\")) return "muted"
  return "body"
}

/** What the diff pane draws besides the rows themselves: the cursor and selection, and the comments under their rows. */
type DiffView = { cursor: number; anchor: number | null; marks: ReadonlyMap<number, ReviewComment[]> }

/** A comment under its last row: the mark and up to three rows of its text, indented to line up with the code. */
function commentRows(comment: ReviewComment, width: number, indent: number): Line[] {
  const room = Math.max(1, width - indent - 2)
  const wrapped = wrap(sanitize(comment.body), room)
  const shown = wrapped.slice(0, MAX_COMMENT_ROWS)
  if (wrapped.length > MAX_COMMENT_ROWS) shown[MAX_COMMENT_ROWS - 1] = truncateEnd(`${shown[MAX_COMMENT_ROWS - 1]}…`, room)
  return shown.map((text, index): Line => clampLine([{ text: " ".repeat(indent) }, { text: index === 0 ? `${COMMENT_MARK} ${comment.author && comment.author !== "user" ? `${comment.author}: ` : ""}` : "  ", fg: "accent" }, { text, fg: "text" }], width))
}

/** A row with `bg` behind all of it: the spans get the tint and the rest of the row is filled. */
function tinted(line: Line, bg: ColorName, width: number, bold: boolean): Line {
  const spans = line.map((span) => ({ ...span, bg, ...(bold ? { bold: true } : {}) }))
  const gap = width - lineWidth(line)
  return gap > 0 ? [...spans, { text: " ".repeat(gap), bg }] : spans
}

/** `limit` stops the pane at that row of the diff (replay shows one hunk: from `scroll` to `limit`). */
function diffRows(input: { file: ChangedFile; scroll: number; rows: number; width: number; view?: DiffView; limit?: number }): Line[] {
  const { file, scroll, rows, width, view } = input
  if (rows <= 0) return []
  const notice = (text: string): Line[] => [clampLine([{ text, fg: "muted" }], width)]
  if (file.binary) return notice("binary file")
  const lines = diffLines(file)
  if (lines.length === 0 && !file.truncated) return notice("no textual changes")

  const total = input.limit !== undefined ? Math.min(input.limit, lines.length) : lines.length + (file.truncated ? 1 : 0)
  const withGutter = width >= GUTTER_MIN_PANE
  const digits = withGutter ? gutterDigits(lines) : 0
  const gutterWidth = withGutter ? digits * 2 + 2 : 0
  const contentWidth = Math.max(1, width - gutterWidth - 1)
  const blank = " ".repeat(gutterWidth)
  const pad = (n: number | undefined) => (n === undefined ? " ".repeat(digits) : String(n).padStart(digits))
  const cursor = view ? Math.min(view.cursor, lines.length - 1) : -1
  const selLo = view ? Math.min(cursor, view.anchor === null ? cursor : Math.min(view.anchor, lines.length - 1)) : -1
  const selHi = view ? Math.max(cursor, view.anchor === null ? cursor : Math.min(view.anchor, lines.length - 1)) : -1

  /** The sign and the wrapped pieces of diff line `index`, cut to what can be visible. */
  const split = (index: number) => {
    const text = Array.from(sanitize(lines[index]!).slice(0, rows * contentWidth + 1))
    return { sign: text[0] ?? " ", parts: chunk(text.slice(1).join(""), contentWidth) }
  }
  const marked = (index: number) => view?.marks.get(index) ?? []
  const heightOf = (index: number) => split(index).parts.length + marked(index).reduce((sum, comment) => sum + commentRows(comment, width, gutterWidth).length, 0)

  let start = Math.min(scroll, total - 1)
  // The cursor stays on screen even when wrapped lines and comments take more rows than the key handler counted.
  if (cursor > start) {
    let used = 0
    for (let index = cursor; index >= start; index--) {
      used += heightOf(index)
      if (used > rows) {
        start = Math.min(index + 1, cursor)
        break
      }
    }
  }
  const numbers = withGutter ? lineNumbers(lines, start, start + rows) : []

  const out: Line[] = []
  for (let index = start; index < total && out.length < rows; index++) {
    if (index >= lines.length) {
      out.push(clampLine([{ text: "diff truncated", fg: "muted" }], width))
      break
    }
    const fg = lineColor(lines[index]!)
    const { sign, parts } = split(index)
    const number = numbers[index - start]
    const inSelection = index >= selLo && index <= selHi
    parts.forEach((part, partIndex) => {
      if (out.length >= rows) return
      const gutter: Span[] = withGutter ? [{ text: partIndex === 0 && number ? `${pad(number.old)} ${pad(number.new)} ` : blank, fg: "muted" }] : []
      const row: Line = [...gutter, { text: partIndex === 0 ? sign : CONTINUATION, fg: partIndex === 0 ? fg : "muted" }, { text: part, fg }]
      out.push(inSelection ? tinted(row, "element", width, index === cursor) : row)
    })
    for (const comment of marked(index)) for (const row of commentRows(comment, width, gutterWidth)) if (out.length < rows) out.push(row)
  }
  return out
}

function centered(text: string, width: number): Line {
  const left = Math.max(0, Math.floor((width - textWidth(text)) / 2))
  return clampLine([{ text: " ".repeat(left) }, { text, fg: "muted" }], width)
}

const firstLine = (text: string) => {
  const [head = "", ...rest] = text.split("\n")
  return rest.length > 0 ? `${head}…` : head
}

/** The review's comments, one row each with the selected one in full under the list. */
function commentList(input: { state: ChangesPageState; files: ChangedFile[]; width: number; rows: number; glyphs: Glyphs }): Line[] {
  const { state, files, width, rows, glyphs } = input
  const comments = state.comments
  if (rows <= 0) return []
  if (comments.length === 0) return [clampLine([{ text: "no comments yet · c on a diff row adds one", fg: "muted" }], width)]
  const index = clamp(state.listIndex, comments.length)
  const detailRows = rows >= 9 ? 4 : 0
  const listRows = Math.max(1, rows - (detailRows > 0 ? detailRows + 1 : 0))
  const offset = Math.min(Math.max(0, index - listRows + 1), Math.max(0, comments.length - listRows))
  const out: Line[] = []
  for (let at = offset; at < Math.min(comments.length, offset + listRows); at++) {
    const comment = comments[at]!
    const on = at === index
    const outdated = placeComments(files.find((file) => file.path === comment.path), [comment]).placed.length === 0
    const where = shortenMiddle(locationLabel(comment), Math.max(8, Math.floor(width * 0.4)))
    out.push(
      clampLine(
        [
          on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
          { text: where, fg: on ? "primary" : "body", bold: on },
          { text: "  " },
          { text: firstLine(comment.body), fg: on ? "text" : "muted" },
          ...(outdated ? [{ text: "  (outdated)", fg: "warning" as const }] : []),
        ],
        width,
      ),
    )
  }
  if (detailRows > 0) {
    out.push([])
    const body = wrap(comments[index]!.body, Math.max(1, width - 2))
    for (const text of body.slice(0, detailRows)) out.push(clampLine([{ text: `  ${text}`, fg: "text" }], width))
  }
  return out
}

/** The label of what a comment in the making is about. */
function composeLabel(state: ChangesPageState): string {
  const editing = state.editing === null ? undefined : state.comments.find((comment) => comment.id === state.editing)
  if (editing) return `Edit comment · ${locationLabel(editing)}`
  return state.target ? `Comment · ${locationLabel({ ...state.target, id: "", body: "", createdAt: 0 })}` : "Comment"
}

/** Rows under the diff while typing: the comment box, the line number prompt and the last key's notice. */
function bottomPanel(state: ChangesPageState, width: number): Line[] {
  const out: Line[] = []
  if (state.mode === "compose") {
    const label = truncateEnd(composeLabel(state), Math.max(4, width - 4))
    out.push(clampLine([{ text: "─ ", fg: "muted" }, { text: label, fg: "accent", bold: true }, { text: ` ${"─".repeat(Math.max(0, width - textWidth(label) - 3))}`, fg: "muted" }], width))
    const pieces = (state.draft === "" ? [""] : state.draft.split("\n")).flatMap((text) => chunk(sanitize(text), Math.max(1, width - 3)))
    const shown = pieces.slice(-MAX_DRAFT_ROWS)
    shown.forEach((text, index) => {
      const last = index === shown.length - 1
      const empty = state.draft === ""
      out.push(clampLine([{ text: "  " }, { text: empty ? "write a comment…" : text, fg: empty ? "muted" : "text" }, ...(last ? [{ text: "█", fg: "primary" as const }] : [])], width))
    })
  } else if (state.mode === "jump") {
    out.push(clampLine([{ text: "Go to line: ", fg: "accent", bold: true }, { text: state.draft, fg: "text" }, { text: "█", fg: "primary" }], width))
  }
  if (state.notice) out.push(clampLine([{ text: state.notice, fg: "warning" }], width))
  return out
}

function hintsFor(state: ChangesPageState, wide: boolean, inDiff: boolean) {
  if (state.mode === "compose") return keyText(HINT_COMPOSE)
  if (state.replay && state.mode === "browse") return HINT_REPLAY
  if (state.mode === "jump") return HINT_JUMP
  if (state.mode === "list") return HINT_LIST
  if (wide) return inDiff ? HINT_WIDE_DIFF : HINT_WIDE
  return inDiff ? HINT_DIFF : HINT_FILES
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderChangesPage(input: { report: ChangesReport; state: ChangesPageState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { report, width, height } = input
  if (height <= 0) return []
  // Replay draws the hunk of the current step; with nothing to step through the page is the plain one.
  const steps = input.state.replay ? replaySteps(report) : []
  const step = steps[Math.max(0, replayIndex(steps, clamp(input.state.selected, report.files.length), input.state.cursor))]
  const state: ChangesPageState = step ? { ...input.state, selected: step.file, cursor: step.row, scroll: step.row } : input.state.replay ? { ...input.state, replay: false } : input.state
  const replaying = step !== undefined && state.mode === "browse"
  const stepNumber = step ? steps.indexOf(step) + 1 : 0
  const sameFile = step ? steps.filter((entry) => entry.file === step.file) : []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const files = report.files
  const total = files.length + report.omittedFiles
  const additions = files.reduce((sum, f) => sum + f.additions, 0)
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0)

  const subtitle = report.scope ? `${report.scope} changes` : report.branch ? `branch ${report.branch}` : "working tree"
  const count = state.comments.length
  const summary = `${total} ${total === 1 ? "file" : "files"} +${additions} −${deletions}${count > 0 ? ` · ${count} ${count === 1 ? "comment" : "comments"}` : ""}`

  const inner = Math.max(1, width - 2)
  const wide = width >= 70
  const inDiff = state.focus === "diff"
  const listing = state.mode === "list"
  const tabbed = !wide && files.length > 0
  const hints = replaying && report.scope ? HINT_REPLAY_READ_ONLY : report.scope ? inDiff ? "↑↓ line · tab focus · [/] hunk · l line · R replay · r refresh · esc back" : "↑↓ file · enter diff · tab focus · R replay · r refresh · esc back" : hintsFor(state, wide, inDiff)
  const title = width < 70 ? "Changes" : `Changes · ${subtitle}`
  const candidates = hints.split(" · ").filter((hint) => !hint.startsWith("esc "))
  const escape = state.mode === "compose" || state.mode === "jump" ? "esc cancel" : replaying ? "esc exit replay" : "esc back"
  const chosen: string[] = []
  const hintRoom = Math.max(8, inner - Math.min(textWidth(title), 26) - 2)
  for (const hint of candidates) if (textWidth([...chosen, hint, escape].join(" · ")) <= hintRoom) chosen.push(hint)
  const header = spread([{ text: title, fg: "primary", bold: true }], [{ text: [...chosen, escape].join(" · "), fg: "muted" }], inner)
  const room = Math.max(0, height - 4)
  const frame = (body: Line[]) => {
    const top: Line[] = [header, spread([{ text: summary, fg: "text" }, ...(report.omittedFiles || report.complete === false ? [{ text: " · Partial", fg: "warning" as const, bold: true }] : [])], tabbed ? tabsRow(PAGE_TABS, inDiff || listing ? 1 : 0, inner) : [], inner), []]
    const rows = [...top, ...body].slice(0, height)
    while (rows.length < height) rows.push([])
    return rows.map((row) => fit([{ text: " " }, ...fit(row, inner), { text: " " }], width))
  }

  if (files.length === 0) {
    const body = listing ? commentList({ state, files, width: inner - 4, rows: Math.max(0, room - 4), glyphs }) : [centered("no changes", Math.max(1, inner - 4))]
    return frame(panelGrid({ width: inner, padding: true, rows: [[{ title: listing ? "Comments" : report.scope ? `${report.scope} changes` : "Working tree", body }]], heights: [room] }))
  }

  const selected = clamp(state.selected, files.length)
  const file = files[selected]!
  const perFile = new Map<string, number>()
  for (const comment of state.comments) perFile.set(comment.path, (perFile.get(comment.path) ?? 0) + 1)

  /** The heading and body of the diff pane for `avail` rows (heading included) at `paneWidth`. */
  const pane = (paneWidth: number, avail: number): Line[] => {
    if (avail <= 0) return []
    const panel = bottomPanel(state, paneWidth)
    const above = Math.max(0, avail - panel.length)
    if (listing) {
      const title: Line = [{ text: `Review comments · ${count}`, fg: "primary", bold: true }]
      const rows = [title, ...commentList({ state, files, width: paneWidth, rows: above - 1, glyphs })]
      while (rows.length < above) rows.push([])
      return [...rows.slice(0, above), ...panel]
    }
    const { placed, outdated } = placeComments(file, state.comments)
    const marks = new Map<number, ReviewComment[]>()
    for (const entry of placed) marks.set(entry.end, [...(marks.get(entry.end) ?? []), entry.comment])
    const head: Line[] = []
    if (step) head.push(clampLine([{ text: "replay ", fg: "accent", bold: true }, { text: `step ${stepNumber}/${steps.length}`, fg: "text" }, { text: ` · hunk ${sameFile.indexOf(step) + 1}/${sameFile.length} of this file`, fg: "muted" }], paneWidth))
    head.push(diffHeading(file, inDiff, paneWidth))
    if (outdated.length > 0) head.push(clampLine([{ text: `${COMMENT_MARK} ${outdated.length} outdated ${outdated.length === 1 ? "comment" : "comments"} · L lists them`, fg: "muted" }], paneWidth))
    const view: DiffView = { cursor: inDiff && !step ? state.cursor : -1, anchor: inDiff && !step ? state.anchor : null, marks }
    const body = diffRows({ file, scroll: state.scroll, rows: Math.max(0, above - head.length), width: paneWidth, view, ...(step ? { limit: step.end } : {}) })
    const rows = [...head, ...body]
    if (panel.length === 0) return rows.slice(0, avail)
    while (rows.length < above) rows.push([])
    return [...rows.slice(0, above), ...panel]
  }

  if (wide) {
    const padding = 4
    const panels = [
      { title: "Files", weight: 1, active: !inDiff && !listing, body: (w: number) => fileList(report, selected, !inDiff && !listing, w, Math.max(0, room - padding), glyphs, perFile) },
      { title: listing ? "Comments" : "Diff", weight: 3, active: inDiff || listing, body: (w: number) => pane(w, Math.max(0, room - padding)) },
    ]
    return frame(panelGrid({ width: inner, rows: [panels], heights: [room], padding: true }))
  }
  return frame(panelGrid({ width: inner, compact: true, rows: [[{ title: listing ? "Comments" : inDiff ? "Diff" : "Files", active: true, body: (w) => !inDiff && !listing ? fileList(report, selected, true, w, Math.max(0, room - 2), glyphs, perFile) : pane(w, Math.max(0, room - 2)) }]], heights: [room] }))
}

/** A part of the page a click acts on, in screen cells: a file of the list, or the heading of the file above its diff. */
export type ChangesHit = { row: number; from: number; to: number; file: number }

/** The first row of a panel's content: the header, the summary, a blank row, then the panel's border and padding (wide) or title and rule (narrow). */
const CONTENT_TOP = 5

/**
 * Where the page answers a click: each visible file of the list and the heading of the diff pane. Only while browsing: a comment being
 * typed, the list of comments and a replay step own the page and have none. It repeats the layout of `renderChangesPage` (the test draws
 * the page and checks that every region lies on its own file).
 */
export function changesPageHits(input: { report: ChangesReport; state: ChangesPageState; width: number; height: number }): ChangesHit[] {
  const { report, state, width, height } = input
  const files = report.files
  if (files.length === 0 || state.mode !== "browse" || state.replay) return []
  const inner = Math.max(1, width - 2)
  const wide = width >= 70
  const inDiff = state.focus === "diff"
  const [listWidth = inner] = wide ? columns(inner, [1, 3], 1) : [inner]
  const selected = clamp(state.selected, files.length)
  const hits: ChangesHit[] = []
  if (wide || !inDiff) {
    const rows = Math.max(0, Math.max(0, height - 4) - (wide ? 4 : 2))
    const offset = listOffset(selected, files.length + (report.omittedFiles > 0 ? 1 : 0), rows)
    for (let index = offset; index < Math.min(files.length, offset + rows); index++) hits.push({ row: CONTENT_TOP + index - offset, from: 1, to: 1 + listWidth, file: index })
  }
  if (wide || inDiff) hits.push({ row: CONTENT_TOP, from: wide ? 2 + listWidth : 1, to: 1 + inner, file: selected })
  return hits
}
