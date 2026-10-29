import type { ChangedFile, ChangesReport, GitCommitPlan } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { STATUS, clampLine, countSpans, listOffset, pathLabel, sanitize } from "./changes-page"
import { fit, panelGrid, spread } from "./deck"
import { type Editor, type EditorRow, graphemes, rowIndexAt } from "./editor"
import type { EditAction } from "./editor-actions"
import { fitHints } from "./git-page"
import { tabsRow, type PageTab } from "./page"
import { lineWidth, wrap } from "./wrap"

/**
 * The Commit tab of the Git page (docs/git.md): the changed files with a box each, a message editor, and a confirmation card that shows the
 * exact command before anything runs. The keys and rows here are pure; the page controller (`ui/app/git.ts`) talks to the daemon.
 */

export type GitCommitStage = "edit" | "review" | "running"
export type GitCommitNotice = { tone: "warning" | "error" | "success"; text: string; detail?: string[] }
export type GitCommitState = {
  report: ChangesReport | undefined
  error: string
  /** Ticked files by path (a renamed file by its new path). */
  ticked: ReadonlySet<string>
  cursor: number
  focus: "files" | "message"
  editor: Editor
  stage: GitCommitStage
  /** The daemon's plan for the ticked files, while the confirmation card is up. */
  plan: GitCommitPlan | undefined
  notice: GitCommitNotice | undefined
}
export type GitCommitAction = { type: "none" } | { type: "typed" } | { type: "close" } | { type: "refresh" } | { type: "review" } | { type: "commit" } | { type: "ask" }

const NONE: GitCommitAction = { type: "none" }
const KEY_UP = new Set(["\x1b[A", "\x1bOA", "k"])
const KEY_DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const NARROW = 70
const HINT_FILES = "↑↓ file · space tick · a all/none · tab message · enter review · w ask the agent · r refresh · esc back"
const HINT_MESSAGE = "type the message · enter newline · tab files · esc files"
const HINT_REVIEW = "enter commit · esc cancel"
const HINT_RUNNING = "committing…"
const NARROW_TABS: PageTab[] = [{ key: "", label: "Files" }, { key: "", label: "Message" }]
const MAX_PATH_ROWS = 12
/** Words of the `git add` the card quotes (the command and `--` count): the paths after them are counted. */
const ADD_WORDS = 13
const OUTPUT_ROWS = 7

/** The paths a file brings to a commit: a rename is both its old and its new path. */
export const commitPaths = (file: ChangedFile) => (file.status === "renamed" && file.oldPath ? [file.oldPath, file.path] : [file.path])

export function createGitCommitState(editor: Editor): GitCommitState {
  return { report: undefined, error: "", ticked: new Set(), cursor: 0, focus: "files", editor, stage: "edit", plan: undefined, notice: undefined }
}

/** The state after a new report: ticks of files that are gone drop out, the cursor stays in range. */
export function gitCommitReport(state: GitCommitState, report: ChangesReport): GitCommitState {
  const paths = new Set(report.files.map((file) => file.path))
  return { ...state, report, error: "", ticked: new Set([...state.ticked].filter((path) => paths.has(path))), cursor: Math.max(0, Math.min(state.cursor, report.files.length - 1)) }
}

/** The files to commit, in the list's order, and every path they bring. */
export function gitCommitSelection(state: GitCommitState) {
  const files = (state.report?.files ?? []).filter((file) => state.ticked.has(file.path))
  return { files, paths: files.flatMap(commitPaths) }
}

/**
 * Handles one raw key. Files: `↑↓` move, `space` ticks, `a` ticks all or none, `tab` goes to the message, `enter` asks for the confirmation card, `w`
 * asks the agent (`/commit`), `r` refreshes. Message: the app's multi-line editor; `tab` or `esc` return to the files. Review: `enter` commits, `esc` cancels.
 * `edit` is the editor action the user's key bindings give this key, `blocked` a key they switched off.
 */
export function gitCommitKey(state: GitCommitState, key: string, input: { edit?: string | undefined; blocked?: boolean; page?: number } = {}): { state: GitCommitState; action: GitCommitAction } {
  const files = state.report?.files ?? []
  const move = (patch: Partial<GitCommitState>, action: GitCommitAction = NONE) => ({ state: { ...state, notice: undefined, ...patch }, action })
  if (state.stage === "running") return { state, action: NONE }
  if (state.stage === "review") {
    if (key === "\r") return move({}, { type: "commit" })
    if (key === "\x1b" || key === "q") return move({ stage: "edit", plan: undefined })
    return { state, action: NONE }
  }
  if (state.focus === "message") {
    if (key === "\t" || key === "\x1b[Z" || key === "\x1b") return move({ focus: "files" })
    if (key === "\x1f") state.editor.undo()
    else if (key === "\x1b[90;6u") state.editor.redo()
    else if (input.edit) state.editor.action(input.edit as EditAction)
    else if (!input.blocked) state.editor.key(key === "\r" || key === "\x1b\r" ? "\n" : key)
    return move({}, { type: "typed" })
  }
  const last = Math.max(0, files.length - 1)
  const go = (cursor: number) => move({ cursor: Math.max(0, Math.min(cursor, last)) })
  const file = files[Math.min(state.cursor, last)]
  if (key === "\x1b" || key === "q") return move({}, { type: "close" })
  if (key === "r") return move({}, { type: "refresh" })
  if (key === "w") return move({}, { type: "ask" })
  if (key === "\t" || key === "\x1b[Z" || key === "\x1b[C") return move({ focus: "message" })
  if (key === "\r") {
    if (state.ticked.size === 0) return move({ notice: { tone: "warning", text: "nothing selected · space ticks a file" } })
    if (state.editor.text.trim() === "") return move({ notice: { tone: "warning", text: "empty message · tab writes it" } })
    return move({}, { type: "review" })
  }
  if (key === " ") {
    if (!file) return move({})
    const ticked = new Set(state.ticked)
    if (!ticked.delete(file.path)) ticked.add(file.path)
    return move({ ticked })
  }
  if (key === "a") return move({ ticked: state.ticked.size === files.length ? new Set() : new Set(files.map((entry) => entry.path)) })
  if (key === "g") return go(0)
  if (key === "G") return go(last)
  if (key === "\x1b[5~") return go(state.cursor - Math.max(1, input.page ?? 10))
  if (key === "\x1b[6~") return go(state.cursor + Math.max(1, input.page ?? 10))
  if (KEY_UP.has(key)) return go(state.cursor - 1)
  if (KEY_DOWN.has(key)) return go(state.cursor + 1)
  return { state, action: NONE }
}

const TONE: Record<GitCommitNotice["tone"], ColorName> = { warning: "warning", error: "error", success: "success" }

function fileRow(input: { file: ChangedFile; cursor: boolean; focused: boolean; ticked: boolean; width: number; glyphs: Glyphs }): Line {
  const { file, width } = input
  const status = STATUS[file.status]
  const right = countSpans(file)
  const room = Math.max(0, width - 2 - 4 - 2 - lineWidth(right) - 1)
  const left: Line = [
    input.cursor ? { text: `${input.glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    input.ticked ? { text: "[x]", fg: "primary" } : { text: "[ ]", fg: "muted" },
    { text: " " },
    { text: status.letter, fg: status.fg },
    { text: " " },
    { text: pathLabel(file, room), fg: input.cursor ? "primary" : "text", bold: input.cursor && input.focused },
  ]
  const gap = width - lineWidth(left) - lineWidth(right)
  return gap < 1 ? clampLine(left, width) : [...left, { text: " ".repeat(gap) }, ...right]
}

function fileList(state: GitCommitState, width: number, rows: number, glyphs: Glyphs): Line[] {
  const report = state.report!
  const items = report.files.length + (report.omittedFiles > 0 ? 1 : 0)
  const offset = listOffset(state.cursor, items, rows)
  const out: Line[] = []
  for (let index = offset; index < Math.min(items, offset + rows); index++) {
    const file = report.files[index]
    out.push(file ? fileRow({ file, cursor: index === state.cursor, focused: state.focus === "files", ticked: state.ticked.has(file.path), width, glyphs }) : clampLine([{ text: `+${report.omittedFiles} more files, not listed`, fg: "muted" }], width))
  }
  return out
}

/** The message as the editor holds it, wrapped to `width`, with the cursor as a block while the message has the keys. */
export function messageRows(editor: Editor, width: number, rows: number, focused: boolean, placeholder: string): Line[] {
  const room = Math.max(1, width - 1)
  editor.setVisualWidth(room)
  if (editor.text === "") return [[...(focused ? [{ text: "█", fg: "primary" } as Span] : []), { text: placeholder, fg: "muted" }]]
  const visual: readonly EditorRow[] = editor.visualLines()
  const at = rowIndexAt(visual, editor.cursorOffset)
  const first = focused && at >= rows ? at - rows + 1 : 0
  return visual.slice(first, first + rows).map((row, index): Line => {
    const text = sanitize(row.text)
    if (!focused || first + index !== at) return [{ text, fg: "text" }]
    const chars = graphemes(row.text)
    const column = Math.max(0, Math.min(chars.length, editor.cursorOffset - row.start))
    return clampLine([{ text: sanitize(chars.slice(0, column).join("")), fg: "text" }, { text: "█", fg: "primary" }, { text: sanitize(chars.slice(column).join("")), fg: "text" }], width)
  })
}

/** What the confirmation card quotes of the message: the subject as written, and how many more lines follow. */
function quotedMessage(message: string) {
  const [subject = "", ...rest] = message.split("\n")
  const more = rest.filter((line) => line.trim()).length
  return `"${subject.replace(/["\\$`]/g, (char) => `\\${char}`)}${more ? ` …(+${more} ${more === 1 ? "line" : "lines"})` : ""}"`
}

/** The exact command, the files it names and what comes with it: nothing here is a summary of something else. */
function reviewRows(input: { plan: GitCommitPlan; message: string; width: number; rows: number }): Line[] {
  const { plan, width } = input
  const quoted = (argv: string[]) => argv.map((word) => (/^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(" ")
  const out: Line[] = []
  if (plan.add) {
    const words = plan.add.slice(0, ADD_WORDS)
    out.push(...wrap(`${quoted(words)}${plan.add.length > words.length ? ` … ${plan.add.length - words.length} more` : ""}`, width).map((text): Line => [{ text, fg: "text" }]))
  }
  out.push(...wrap(`git commit -m ${quotedMessage(input.message)} --`, width).map((text): Line => [{ text, fg: "text", bold: true }]))
  const room = Math.max(1, Math.min(MAX_PATH_ROWS, input.rows - out.length - 5))
  const shown = plan.paths.slice(0, plan.paths.length > room ? room - 1 : room)
  for (const path of shown) out.push(clampLine([{ text: `  ${path}`, fg: "text" }, ...(plan.untracked.includes(path) ? [{ text: "  new", fg: "muted" } as Span] : [])], width))
  if (shown.length < plan.paths.length) out.push([{ text: `  +${plan.paths.length - shown.length} more paths`, fg: "muted" }])
  out.push([])
  out.push(...wrap(`branch ${plan.branch} · ${plan.hooks.length ? `repository hooks run: ${plan.hooks.join(", ")}` : "no repository hooks"}`, width).map((text): Line => [{ text, fg: "muted" }]))
  if (plan.stagedElsewhereTotal > 0) {
    const names = plan.stagedElsewhere.join(", ") + (plan.stagedElsewhereTotal > plan.stagedElsewhere.length ? ` +${plan.stagedElsewhereTotal - plan.stagedElsewhere.length} more` : "")
    out.push(...wrap(`${plan.stagedElsewhereTotal} other staged ${plan.stagedElsewhereTotal === 1 ? "file stays" : "files stay"} staged and out of this commit: ${names}`, width).map((text): Line => [{ text, fg: "warning" }]))
  }
  return out
}

/** The page's rows: exactly `height` lines of `width` cells. The caller puts the Git tabs row above it and gives it one row less. */
export function renderGitCommitPage(input: { state: GitCommitState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { state, width, height } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const pad = (rows: Line[]) => {
    const out = rows.slice(0, height)
    while (out.length < height) out.push([])
    return out.map((row) => fit([{ text: " " }, ...fit(row, inner), { text: " " }], width))
  }
  const report = state.report
  if (!report) return pad([[{ text: state.error || "loading changes…", fg: state.error ? "warning" : "muted" }]])

  const wide = width >= NARROW
  const files = report.files
  const { files: chosen } = gitCommitSelection(state)
  const additions = chosen.reduce((sum, file) => sum + file.additions, 0)
  const deletions = chosen.reduce((sum, file) => sum + file.deletions, 0)
  const total = files.length + report.omittedFiles
  const reviewing = state.stage !== "edit"
  const messaging = state.focus === "message" && !reviewing
  const hints = state.stage === "running" ? HINT_RUNNING : reviewing ? HINT_REVIEW : messaging ? HINT_MESSAGE : HINT_FILES
  const escape = reviewing ? "esc cancel" : messaging ? "esc files" : "esc back"
  const title = "Commit"
  const header = spread([{ text: title, fg: "primary", bold: true }], [{ text: fitHints({ title, hints, escape, inner }), fg: "muted" }], inner)
  const summary = spread(
    total === 0 ? [{ text: "no changes", fg: "muted" }] : [{ text: `${chosen.length} of ${total} ${total === 1 ? "file" : "files"} ticked`, fg: "text" }, ...(chosen.length ? [{ text: ` +${additions}`, fg: "success" } as Span, { text: ` −${deletions}`, fg: "error" } as Span] : [])],
    wide || reviewing ? [] : tabsRow(NARROW_TABS, messaging ? 1 : 0, inner),
    inner,
  )
  const room = Math.max(0, height - 4)
  const notice: Line = state.notice ? clampLine([{ text: state.notice.text, fg: TONE[state.notice.tone] }], inner) : []
  const top: Line[] = [header, summary, []]
  const frame = (body: Line[]) => pad([...top, ...body.slice(0, room), ...Array.from({ length: Math.max(0, room - body.length) }, (): Line => []), notice])

  if (reviewing && state.plan) {
    const message = state.editor.text.replace(/\r\n?/g, "\n").trim()
    const title = state.stage === "running" ? "Committing…" : "Confirm · local only, nothing leaves this machine"
    return frame(panelGrid({ width: inner, padding: true, rows: [[{ title, active: true, body: (w: number) => reviewRows({ plan: state.plan!, message, width: w, rows: Math.max(1, room - 4) }) }]], heights: [room] }))
  }
  if (files.length === 0) return frame(panelGrid({ width: inner, padding: true, rows: [[{ title: "Files", body: [[{ text: "no changes to commit", fg: "muted" }]] }]], heights: [room] }))

  const output = state.notice?.detail ?? []
  const withOutput = output.length > 0 && room >= 16
  const gridRoom = withOutput ? room - OUTPUT_ROWS - 1 : room
  const contentRows = Math.max(0, gridRoom - 4)
  const filesPanel = { title: `Files · ${files.length}`, weight: 1, active: !messaging, body: (w: number) => fileList(state, w, contentRows, glyphs) }
  const messagePanel = { title: "Message", weight: 1, active: messaging, body: (w: number) => messageRows(state.editor, w, contentRows, messaging, "write the commit message") }
  const rows = wide ? [[filesPanel, messagePanel]] : [[messaging ? messagePanel : filesPanel]]
  const body = wide
    ? panelGrid({ width: inner, padding: true, rows, heights: [gridRoom] })
    : panelGrid({ width: inner, compact: true, rows: [[{ ...rows[0]![0]!, active: true, body: (w: number) => (messaging ? messageRows(state.editor, w, Math.max(0, gridRoom - 2), true, "write the commit message") : fileList(state, w, Math.max(0, gridRoom - 2), glyphs)) }]], heights: [gridRoom] })
  if (!withOutput) return frame(body)
  const out = panelGrid({ width: inner, padding: true, rows: [[{ title: "Output", body: (w: number) => output.slice(-(OUTPUT_ROWS - 4)).map((text): Line => clampLine([{ text: sanitize(text), fg: "text" }], w)) }]], heights: [OUTPUT_ROWS] })
  return frame([...body, [], ...out])
}
