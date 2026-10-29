import type { ChangesReport } from "@mendcode/protocol"
import { clamp, diffLength, fileRows, firstChangedLine, placeComments, replayIndex, replaySteps, type ChangesPageAction, type ChangesPageState } from "./changes-state"
import { createComment, MAX_BODY, MAX_COMMENTS, reviewTarget } from "./review-comments"
import { reviewMessage } from "./review-message"

const NONE: ChangesPageAction = { type: "none" }
const KEY_UP = new Set(["\x1b[A", "\x1bOA", "k"])
const KEY_DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const SHIFT_UP = "\x1b[1;2A"
const SHIFT_DOWN = "\x1b[1;2B"
const MAX_LINE_DIGITS = 7
/** The keys that step replay forward and back (`R` toggles it); outside replay `[` `]` stay the in-file hunk keys. */
const REPLAY_NEXT = new Set(["]", ".", " ", "\r", "\x1b[C", "\x1bOC", "\x1b[B", "\x1bOB", "j"])
const REPLAY_BACK = new Set(["[", ",", "\x7f", "\x1b[D", "\x1bOD", "\x1b[A", "\x1bOA", "k"])

/** The draft after one key: typed text (a paste too), backspace, ctrl+u, ctrl+w and alt+enter for a new line; undefined for any other key. */
function editDraft(draft: string, key: string, max: number): string | undefined {
  switch (key) {
    case "\x7f":
    case "\b":
      return Array.from(draft).slice(0, -1).join("")
    case "\x15":
      return ""
    case "\x17":
      return draft.replace(/\S+\s*$/, "")
    case "\x1b\r":
    case "\n":
      return draft.length < max ? `${draft}\n` : draft
  }
  if (key.startsWith("\x1b") || key < " ") return undefined
  const printable = key.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
  return printable ? `${draft}${printable}`.slice(0, max) : undefined
}

const follow = (cursor: number, scroll: number, rows: number) => (cursor < scroll ? cursor : cursor >= scroll + rows ? cursor - rows + 1 : scroll)

/** The state after the review was sent: no comments left, nothing half typed. */
export function changesReviewSent(state: ChangesPageState): ChangesPageState {
  return { ...state, comments: [], mode: "browse", draft: "", target: null, editing: null, anchor: null, listIndex: 0, confirmClear: false, notice: "review sent" }
}

/**
 * Handles one raw key. Returns the same state object for keys that change nothing. `page` is the diff pane height in rows;
 * `now` stamps new comments.
 *
 * Browse: ↑↓ move the row cursor (files when the file list has focus), shift+↑↓ or `v` select rows, `c` comments the row or
 * selection, `C` the whole hunk, `e`/`d` edit or delete the comment under the cursor, `[` `]` hunks, `n` `p` files, `l` jump to a
 * line, `L` the comment list, `f` opens the file in the viewer at its first change, `s` sends the review. `R` toggles replay: one hunk at a time across all files, `]`/space and
 * `[` step, `n` `p` jump files, `g` `G` the ends, `esc` leaves it.
 */
export function changesPageKey(
  state: ChangesPageState,
  key: string,
  report: ChangesReport,
  page = 10,
  now: number = Date.now(),
): { state: ChangesPageState; action: ChangesPageAction } {
  const files = report.files
  const selected = clamp(state.selected, files.length)
  const file = files[selected]
  const rows = fileRows(file)
  const lastRow = Math.max(0, rows.length - 1)
  const size = Math.max(1, page)
  const cursor = Math.min(state.cursor, lastRow)
  const anchor = state.anchor === null ? null : Math.min(state.anchor, lastRow)
  const maxScroll = file ? diffLength(file) - 1 : 0

  const finish = (next: Partial<ChangesPageState> = {}) => {
    const merged: ChangesPageState = { ...state, selected, cursor, anchor, notice: "", confirmClear: false, ...next }
    const same = (Object.keys(merged) as Array<keyof ChangesPageState>).every((name) => merged[name] === state[name])
    return { state: same ? state : merged, action: NONE }
  }
  const moveTo = (target: number, extend = false) => {
    const next = clamp(target, rows.length)
    return finish({ cursor: next, anchor: extend ? (anchor ?? cursor) : anchor, scroll: follow(next, state.scroll, size), focus: "diff" })
  }
  const scrollTo = (value: number) => {
    const scroll = Math.max(0, Math.min(value, maxScroll))
    return finish({ scroll, cursor: Math.min(lastRow, Math.max(scroll, Math.min(cursor, scroll + size - 1))) })
  }
  const toFile = (index: number) => {
    const next = clamp(index, files.length)
    return next === selected ? finish() : finish({ selected: next, scroll: 0, cursor: 0, anchor: null })
  }
  const send = () => {
    if (state.comments.length === 0) return finish({ notice: "no comments to send" })
    const text = reviewMessage({ comments: state.comments, ...(report.branch ? { branch: report.branch } : {}) })
    return { state: finish().state, action: { type: "send", text, count: state.comments.length } as ChangesPageAction }
  }
  const commentAtCursor = () => placeComments(file, state.comments).placed.filter((entry) => entry.start <= cursor && cursor <= entry.end).at(-1)?.comment

  if (state.mode === "compose") {
    if (key === "\x1b") return finish({ mode: "browse", draft: "", target: null, editing: null })
    if (key === "\r") {
      const body = state.draft.trim()
      if (!body) return finish({ notice: "comment is empty · esc cancels" })
      if (state.editing !== null) {
        const comments = state.comments.map((comment) => (comment.id === state.editing ? { ...comment, body: body.slice(0, MAX_BODY) } : comment))
        return finish({ comments, mode: "browse", draft: "", target: null, editing: null, anchor: null, notice: "comment updated" })
      }
      if (!state.target) return finish({ mode: "browse", draft: "" })
      const comments = [...state.comments, createComment({ target: state.target, body, now, existing: state.comments })]
      return finish({ comments, mode: "browse", draft: "", target: null, anchor: null, notice: "comment added" })
    }
    const draft = editDraft(state.draft, key, MAX_BODY)
    return draft === undefined || draft === state.draft ? finish() : finish({ draft })
  }

  if (state.mode === "jump") {
    if (key === "\x1b") return finish({ mode: "browse", draft: "" })
    if (key === "\r") {
      const wanted = Number(state.draft)
      if (!state.draft || !Number.isInteger(wanted)) return finish({ mode: "browse", draft: "" })
      const row = rows.findIndex((entry) => entry.new === wanted)
      const at = row >= 0 ? row : rows.findIndex((entry) => entry.old === wanted)
      if (at < 0) return finish({ mode: "browse", draft: "", notice: `line ${wanted} is not in this diff` })
      return finish({ mode: "browse", draft: "", cursor: at, anchor: null, scroll: Math.max(0, Math.min(at - 2, maxScroll)), focus: "diff" })
    }
    const draft = editDraft(state.draft, key, MAX_LINE_DIGITS)
    if (draft === undefined || /\D/.test(draft)) return finish()
    return draft === state.draft ? finish() : finish({ draft })
  }

  if (state.mode === "list") {
    const count = state.comments.length
    const index = clamp(state.listIndex, count)
    const current = state.comments[index]
    if (key === "\x1b" || key === "q" || key === "L") return finish({ mode: "browse" })
    if (KEY_UP.has(key)) return finish({ listIndex: clamp(index - 1, count) })
    if (KEY_DOWN.has(key)) return finish({ listIndex: clamp(index + 1, count) })
    if (key === "s") return send()
    if (key === "X") {
      if (!state.confirmClear) return finish({ confirmClear: true, notice: "press X again to clear the whole review" })
      return finish({ comments: [], mode: "browse", listIndex: 0, notice: "review cleared" })
    }
    if (!current) return finish()
    if (key === "e") return finish({ mode: "compose", editing: current.id, draft: current.body, target: null, listIndex: index })
    if (key === "d" || key === "x") {
      const comments = state.comments.filter((comment) => comment.id !== current.id)
      return finish({ comments, listIndex: clamp(index, comments.length), mode: comments.length === 0 ? "browse" : "list", notice: "comment deleted" })
    }
    if (key === "\r") {
      const target = files.findIndex((entry) => entry.path === current.path)
      if (target < 0) return finish({ notice: "that file has no changes now" })
      const start = placeComments(files[target], state.comments).placed.find((entry) => entry.comment.id === current.id)?.start ?? 0
      return finish({ mode: "browse", selected: target, cursor: start, anchor: null, scroll: Math.max(0, start - 2), focus: "diff", listIndex: index })
    }
    return finish({ listIndex: index })
  }

  const steps = replaySteps(report)
  const toStep = (index: number, extra: Partial<ChangesPageState> = {}) => {
    const step = steps[index]!
    return finish({ replay: true, selected: step.file, cursor: step.row, scroll: step.row, anchor: null, focus: "diff", ...extra })
  }
  if (key === "R") {
    if (state.replay) return finish({ replay: false })
    return steps.length === 0 ? finish({ notice: "no hunks to replay" }) : toStep(Math.max(0, replayIndex(steps, selected, cursor)))
  }
  if (state.replay && steps.length > 0) {
    const at = Math.max(0, replayIndex(steps, selected, cursor))
    const current = steps[at]!
    if (key === "\x1b") return finish({ replay: false })
    if (REPLAY_NEXT.has(key)) return at + 1 < steps.length ? toStep(at + 1) : finish({ notice: "last step" })
    if (REPLAY_BACK.has(key)) return at > 0 ? toStep(at - 1) : finish({ notice: "first step" })
    if (key === "g") return toStep(0)
    if (key === "G") return toStep(steps.length - 1)
    if (key === "n") {
      const next = steps.findIndex((step) => step.file > current.file)
      return next < 0 ? finish({ notice: "last file" }) : toStep(next)
    }
    if (key === "p") {
      const before = steps.findLast((step) => step.file < current.file)
      return before === undefined ? finish({ notice: "first file" }) : toStep(steps.findIndex((step) => step.file === before.file))
    }
  }
  if (key === "\x1b") return anchor !== null ? finish({ anchor: null }) : { state, action: { type: "close" } }
  if (key === "q") return { state, action: { type: "close" } }
  if (key === "r") return { state, action: { type: "refresh" } }
  if (key === "f") {
    if (!file) return finish()
    if (file.status === "deleted") return finish({ notice: "deleted: no file to open" })
    const line = firstChangedLine(file)
    return { state: finish().state, action: { type: "view", path: file.path, ...(line !== undefined ? { line } : {}) } }
  }
  if (key === "s") return send()
  if (key === "\t" || key === "\x1b[Z") return finish({ focus: state.focus === "files" ? "diff" : "files" })
  if (key === "\x1b[C" || key === "\r" || key === "2") return finish({ focus: "diff" })
  if (key === "\x1b[D" || key === "1") return finish({ focus: "files" })
  if (key === "\x1b[5~") return scrollTo(state.scroll - size)
  if (key === "\x1b[6~") return scrollTo(state.scroll + size)
  if (key === "g") return finish({ scroll: 0, cursor: 0 })
  if (key === "G") return finish({ scroll: Math.max(0, Math.min(maxScroll + 1 - size, maxScroll)), cursor: lastRow })
  if (key === "n") return toFile(selected + 1)
  if (key === "p") return toFile(selected - 1)
  if (key === "L") return state.comments.length === 0 ? finish({ notice: "no comments yet · c adds one" }) : finish({ mode: "list", listIndex: 0 })
  if (key === "l") return file && rows.length > 0 ? finish({ mode: "jump", draft: "" }) : finish({ notice: "no lines to jump to" })
  if (key === "]" || key === "[") {
    const headers = rows.flatMap((row, at) => (row.kind === "hunk" ? [at] : []))
    const next = key === "]" ? headers.find((at) => at > cursor) : headers.filter((at) => at < cursor).at(-1)
    return next === undefined ? finish({ notice: key === "]" ? "last hunk" : "first hunk" }) : moveTo(next)
  }
  if (key === "v") return rows.length === 0 ? finish() : finish({ anchor: anchor === null ? cursor : null, focus: "diff" })
  if (key === "c" || key === "C") {
    if (!file) return finish()
    if (state.comments.length >= MAX_COMMENTS) return finish({ notice: `review is full (${MAX_COMMENTS} comments) · send or clear it` })
    const target = reviewTarget({ path: file.path, rows, from: key === "C" ? cursor : (anchor ?? cursor), to: cursor, ...(key === "C" ? { hunk: true } : {}) })
    return finish({ mode: "compose", draft: "", target, editing: null, focus: "diff" })
  }
  if (key === "e" || key === "d") {
    const comment = commentAtCursor()
    if (!comment) return finish({ notice: "no comment on this row" })
    if (key === "e") return finish({ mode: "compose", editing: comment.id, draft: comment.body, target: null, focus: "diff" })
    return finish({ comments: state.comments.filter((entry) => entry.id !== comment.id), notice: "comment deleted" })
  }
  const shifted = key === SHIFT_UP ? -1 : key === SHIFT_DOWN ? 1 : 0
  if (shifted !== 0) return state.focus === "diff" && rows.length > 0 ? moveTo(cursor + shifted, true) : finish()
  const direction = KEY_UP.has(key) ? -1 : KEY_DOWN.has(key) ? 1 : 0
  if (direction === 0) return { state, action: NONE }
  if (state.focus === "diff") return moveTo(cursor + direction)
  return toFile(selected + direction)
}
