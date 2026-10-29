import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { locateComment, parseDiffRows, type DiffRow, type ReviewComment, type ReviewTarget } from "./review-comments"

/** On narrow pages the focus is also the tab: `files` is Files and `diff` is Diff. Wide pages show both side by side. */
export type ChangesFocus = "files" | "diff"
/** `browse` moves around; `compose` types a comment; `jump` asks for a line number; `list` shows the review's comments. */
export type ChangesMode = "browse" | "compose" | "jump" | "list"

export type ChangesPageState = {
  selected: number
  /** First visible row of the selected file's diff. */
  scroll: number
  focus: ChangesFocus
  /** The diff row under the cursor; a comment is about it (or about the selection from `anchor` to it). */
  cursor: number
  /** Where a multi-row selection started (`v` or shift+arrows); null when nothing is selected. */
  anchor: number | null
  /** The review: client-side comments of this session, kept in `<dataDir>/tui/reviews/<sessionId>.json` until sent or cleared. */
  comments: ReviewComment[]
  mode: ChangesMode
  /** The text being typed in `compose` and `jump`. */
  draft: string
  /** What the comment being composed is about. */
  target: ReviewTarget | null
  /** The comment being edited (its body is the draft); null for a new one. */
  editing: string | null
  listIndex: number
  /** `X` was pressed once in the list: the next `X` clears the whole review. */
  confirmClear: boolean
  /** A one-row message for the last key (cleared by the next one). */
  notice: string
  /** Replay: the diff pane shows one hunk at a time, stepping through every hunk of every file (`R`). */
  replay: boolean
}

/** `view`: open the file in the file viewer, at `line` (its first changed line) when the diff has one. */
export type ChangesPageAction = { type: "none" } | { type: "close" } | { type: "refresh" } | { type: "send"; text: string; count: number } | { type: "view"; path: string; line?: number }

export function createChangesPageState(comments: readonly ReviewComment[] = []): ChangesPageState {
  return { selected: 0, scroll: 0, focus: "files", cursor: 0, anchor: null, comments: [...comments], mode: "browse", draft: "", target: null, editing: null, listIndex: 0, confirmClear: false, notice: "", replay: false }
}

export function clamp(value: number, length: number) {
  return Math.max(0, Math.min(value, length - 1))
}

export function diffLines(file: ChangedFile) {
  if (file.diff === "") return []
  const lines = file.diff.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Logical (unwrapped) rows in the diff pane for a file, including the notice rows. */
export function diffLength(file: ChangedFile) {
  if (file.binary) return 1
  return Math.max(1, diffLines(file).length + (file.truncated ? 1 : 0))
}

let lastRows: { diff: string; rows: DiffRow[] } | undefined

/** The parsed rows of a file's diff (none for a binary file); the last file is remembered, so a key press on a big diff parses it once. */
export function fileRows(file: ChangedFile | undefined): DiffRow[] {
  if (!file || file.binary) return []
  if (lastRows?.diff === file.diff) return lastRows.rows
  const rows = parseDiffRows(diffLines(file))
  lastRows = { diff: file.diff, rows }
  return rows
}

/**
 * The line of the working-tree file where its first change is: the first added line, or for a change that only deletes, the line the
 * deleted text sat before (the next line of the new side). Undefined for a binary file or a diff without a change (the file opens at its top).
 */
export function firstChangedLine(file: ChangedFile | undefined): number | undefined {
  const rows = fileRows(file)
  const at = rows.findIndex((row) => row.kind === "add" || row.kind === "del")
  if (at < 0) return undefined
  const row = rows[at]!
  if (row.kind === "add") return row.new
  const next = rows.slice(at + 1).find((entry) => entry.new !== undefined)
  return next?.new ?? (rows.slice(0, at).findLast((entry) => entry.new !== undefined)?.new ?? 0) + 1
}

/** One replay step: a hunk of file `file` (index in the report), from its `@@` row to `end` (exclusive). */
export type ReplayStep = { file: number; row: number; end: number }

const stepCache = new WeakMap<ChangesReport, ReplayStep[]>()

/** Every hunk of every file in the report's order: what replay steps through. Files without hunks (binary, rename only) have no step. */
export function replaySteps(report: ChangesReport): ReplayStep[] {
  const cached = stepCache.get(report)
  if (cached) return cached
  const steps: ReplayStep[] = []
  report.files.forEach((file, index) => {
    const rows = fileRows(file)
    const headers = rows.flatMap((row, at) => (row.kind === "hunk" ? [at] : []))
    headers.forEach((row, at) => steps.push({ file: index, row, end: headers[at + 1] ?? rows.length }))
  })
  stepCache.set(report, steps)
  return steps
}

/** The step the cursor is in (the last header at or before it), 0 before the first one; -1 when there are no steps. */
export function replayIndex(steps: readonly ReplayStep[], selected: number, cursor: number): number {
  if (steps.length === 0) return -1
  let found = 0
  steps.forEach((step, at) => {
    if (step.file < selected || (step.file === selected && step.row <= cursor)) found = at
  })
  return found
}

export type PlacedComment ={ comment: ReviewComment; start: number; end: number }

/** The comments of `file` with their rows in its current diff; `outdated` are the ones whose code is gone. */
export function placeComments(file: ChangedFile | undefined, comments: readonly ReviewComment[]): { placed: PlacedComment[]; outdated: ReviewComment[] } {
  const placed: PlacedComment[] = []
  const outdated: ReviewComment[] = []
  if (!file) return { placed, outdated }
  const rows = fileRows(file)
  for (const comment of comments) {
    if (comment.path !== file.path) continue
    const at = locateComment(comment, rows)
    if (at) placed.push({ comment, ...at })
    else outdated.push(comment)
  }
  return { placed, outdated }
}
