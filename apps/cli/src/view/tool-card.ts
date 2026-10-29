import { computerFact, toolSearchFact } from "./computer-session-card"
import type { RenderNode } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import type { ToolView } from "../extensions/hooks"
import { wrapSpans } from "./markdown"
import { fit } from "./deck"
import { renderSpecLines } from "./render-spec"
import { formatDuration } from "./time"
import { textWidth, truncateEnd } from "./wrap"
import { parseTodoText } from "./dock"
import { sessionRecallCard } from "./session-recall-card"
import { computerCard } from "./computer-card"
import { markFold } from "./line-meta"
import { isReadTool, type ToolCounts } from "./tool-summary"
import { asciiGlyphs, FOLD_CARD, FOLD_PAGE, FOLD_RUN, INDENT, marksOf, railPrefix, type Marks } from "./tool-frame"
import { cardContext, failure, globCard, grepCard, header, linesOf, listCard, pagedLines, readCard, searchCard, shapeCard, shellCard, SPINNER_ASCII, taskCard, webCard, type CardContext } from "./tool-kinds"
import { BRIEF_ROWS, shapeLines } from "./tool-bodies"
import { resultShape } from "./tool-data"
import { formatBytes } from "./tool-data"
import { IMAGE_TOOLS, imageWaitConfig, imageWaitDetails, imageWaitRows, type ImageWaitConfig } from "./image-wait"

/**
 * Tool calls in the transcript. `balanced` and `full` share one frame (`tool-frame`): a header row (a glyph per tool kind coloured
 * by status, the label, the target emphasised, muted facts, a duration at the right edge) over a body hanging from a thin left
 * rule; each kind (`tool-kinds`) shows its content in the form that suits it, and `full` shows more of it, never the same rows
 * again. Diffs keep v1's tinted rows with one line-number column and no `@@` headers, as Claude Code draws them. Pure: rows in, rows out.
 */

export { FOLD_CARD, FOLD_PAGE, FOLD_RUN }

/** v1's icons (`timeline/normalize.ts`), keyed by tool name. */
export const TOOL_ICONS: Readonly<Record<string, string>> = {
  read: "□",
  ls: "□",
  glob: "▦",
  grep: "⌕",
  write: "+",
  edit: "✎",
  apply_patch: "±",
  shell: "$",
  shell_output: "$",
  shell_kill: "$",
  shell_session: "$",
  shell_monitor: "$",
  notebook_edit: "✎",
  sleep: "…",
  todo: "✓",
  task: "◔",
  webfetch: "⌁",
  web_search: "⌁",
  remember: "◉",
  question: "?",
  plan_submit: "◫",
  screenshot: "▣",
  image_generation: "◧",
  diagnostics: "△",
  skill: "◇",
  tool_define: "◧",
  review: "±",
  image_gen: "◧",
  browser: "◎",
  computer_capture: "▣",
  computer_key: "⌨",
  computer_session: "▣",
  computer_observe: "▣",
  computer_code: "⌨",
}

const LABELS: Readonly<Record<string, string>> = {
  read: "Read",
  ls: "List",
  glob: "Glob",
  grep: "Grep",
  write: "Write",
  edit: "Edit",
  apply_patch: "Patch",
  webfetch: "Fetch",
  web_search: "Web search",
  task: "Task",
  todo: "Todos",
  remember: "Remember",
  question: "Question",
  screenshot: "Screenshot",
  image_generation: "Image",
  diagnostics: "Diagnostics",
  skill: "Skill",
  shell_output: "Output",
  shell_kill: "Stop",
  shell_session: "Session",
  shell_monitor: "Monitor",
  notebook_edit: "Notebook",
  sleep: "Wait",
  tool_define: "Define tool",
  review: "Review",
  image_gen: "Image",
  browser: "Browser",
  computer_capture: "Computer capture",
  computer_key: "Computer key",
  computer_session: "MendCode Computer",
  computer_observe: "Computer observation",
  computer_code: "Computer code",
  graph_map: "Code map",
  graph_find: "Graph find",
  graph_callers: "Graph callers",
  graph_file_api: "File API",
  websearch: "Web search",
}
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
/** Rows of a diff the `full` view shows before the `+N lines` row; `balanced` shows DIFF_ROWS. */
export const DIFF_PREVIEW_ROWS = 40
export const DIFF_ROWS = 16
/** Lines of shell output the `full` view shows (v1 `latestTerminalOutputPreview(output, 10)`); `balanced` shows SHELL_ROWS, a failure SHELL_FAILED_ROWS. */
export const SHELL_PREVIEW_LINES = 10
export const SHELL_ROWS = 6
export const SHELL_FAILED_ROWS = 12
/** Source lines per page of an opened (ctrl+o or click) card: a long body is paged, never printed whole. */
export const TOOL_PAGE_LINES = 40
const TODO_PREVIEW_ROWS = 8

/** How much of a finished card shows: the header and a few rows (`balanced`), a richer body (`full` view) or a page of the whole body (opened). */
export type ToolLevel = "summary" | "preview" | "full"

/** "edit: src/a.ts" → { name: "edit", detail: "src/a.ts" }; "todo 2/5" → { name: "todo", detail: "2/5" }; MCP and custom tools keep their full name. */
export function parseToolTitle(title: string | undefined): { name: string; detail: string } {
  const text = title ?? "tool"
  const colon = text.indexOf(": ")
  if (colon > 0 && !text.slice(0, colon).includes(" ")) return { name: text.slice(0, colon), detail: text.slice(colon + 2) }
  const todo = /^todo (\d+\/\d+)$/.exec(text)
  if (todo) return { name: "todo", detail: todo[1]! }
  return { name: text, detail: "" }
}

export function toolIcon(name: string) {
  return TOOL_ICONS[name] ?? (name.startsWith("mcp__") ? "⊙" : "◆")
}

function toolLabel(name: string) {
  if (LABELS[name]) return LABELS[name]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]} · ${mcp[2]}`
  return name.replace(/^custom__/, "")
}

/** Tools v1 draws as a block (a titled body) instead of a one-line timeline row; only rows fold into `◇ N tools more`. */
const BLOCK_TOOLS = new Set(["shell", "shell_output", "shell_kill", "shell_session", "notebook_edit", "write", "edit", "apply_patch", "task", "image_generation", "plan_submit", "todo", "question", "session_search", "session_read", "session_notes", "image_gen", "computer_capture", "computer_key", "computer_session", "computer_observe", "computer_code"])

/** Calls that change a file (every engine titles them with these names): their diff or content is never folded away outside `minimal`. */
const FILE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "notebook_edit"])

export function isFileEdit(title: string | undefined) {
  return FILE_EDIT_TOOLS.has(parseToolTitle(title).name)
}

export function isCompactTool(title: string | undefined) {
  return !BLOCK_TOOLS.has(parseToolTitle(title).name)
}

/** Bare names other engines give calls that change files or run commands (pi's `bash`, Claude Code's `MultiEdit`). */
const CHANGING_NAMES = new Set(["bash", "MultiEdit"])
/** Free-text titles of other engines that only read: Claude Code's `read path`, `glob pattern`, `grep pattern`, `fetch url`, `search query`. */
const FOREIGN_READING = /^(read|glob|grep|fetch|search) \S/

/**
 * Whether a finished call may fold into `◇ N tools more`: a one-line tool that changes nothing. Other engines title calls in
 * free text (Claude Code's `edit src/a.ts`, `write b.ts`, or a Bash call's whole command such as `rm -rf build`), which
 * `parseToolTitle` cannot name; such a call may have written or deleted something, so it stays in view like a native edit.
 */
export function isFoldableTool(title: string | undefined) {
  if (!isCompactTool(title)) return false
  const { name, detail } = parseToolTitle(title)
  if (detail || !/\s/.test(name)) return !CHANGING_NAMES.has(name)
  return FOREIGN_READING.test(name)
}
export type DiffRow = { kind: "add" | "remove" | "context" | "hunk" | "file"; text: string; number?: number; /** The line's number before the change (removed and context rows). */ old?: number; /** The line's number after it (added and context rows). */ new?: number }

/** Unified-diff text (edit and apply_patch output) → rows with line numbers; undefined when it is not a diff. */
export function parseDiff(text: string): { rows: DiffRow[]; added: number; removed: number } | undefined {
  const lines = text.replace(/\s+$/, "").split("\n")
  if (!lines.some((line) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line))) return undefined
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let added = 0
  let removed = 0
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      // The line numbers say where a hunk is: its `@@` header is not drawn. A later hunk of the same file is a gap, `⋯`.
      const last = rows.at(-1)
      if (last && last.kind !== "file" && last.kind !== "hunk") rows.push({ kind: "hunk", text: "⋯" })
    } else if (/^(\*\*\* (Update|Add|Delete) File: |--- |\+\+\+ )/.test(line)) rows.push({ kind: "file", text: line.replace(/^\*\*\* /, "") })
    else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), number: newLine, new: newLine })
      newLine++
      added++
    } else if (line.startsWith("-")) {
      rows.push({ kind: "remove", text: line.slice(1), number: oldLine, old: oldLine })
      oldLine++
      removed++
    } else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "context", text: line.slice(1), number: oldLine, old: oldLine, new: newLine })
      oldLine++
      newLine++
    } else rows.push({ kind: "context", text: line })
  }
  return { rows, added, removed }
}

export type PatchFile = { verb: "Added" | "Deleted" | "Patched" | "Edited" | "Wrote"; path: string; rows: DiffRow[]; added: number; removed: number; /** Facts before the counts (a write's `created · 28 B`). */ facts?: string[]; /** Lines beyond `rows` that were not kept (a long write). */ unseen?: number; /** Only the start of the file is known, not how many lines follow. */ cut?: boolean }

/** apply_patch output (`*** Add|Delete|Update File: p` sections) → one entry per file; undefined when it is not a patch preview. */
export function parsePatch(text: string): PatchFile[] | undefined {
  const lines = text.replace(/\s+$/, "").split("\n")
  const starts = lines.flatMap((line, at) => (/^\*\*\* (Add|Delete|Update) File: /.test(line) ? [at] : []))
  if (!starts.length) return undefined
  return starts.map((start, i): PatchFile => {
    const head = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[start]!)!
    const body = lines.slice(start + 1, starts[i + 1] ?? lines.length)
    const verb = head[1] === "Add" ? "Added" : head[1] === "Delete" ? "Deleted" : "Patched"
    if (verb === "Added") {
      const rows = body.filter((line) => line.startsWith("+")).map((line, n): DiffRow => ({ kind: "add", text: line.slice(1), number: n + 1, new: n + 1 }))
      return { verb, path: head[2]!.trim(), rows, added: rows.length, removed: 0 }
    }
    const diff = verb === "Patched" ? parseDiff(body.join("\n")) : undefined
    return { verb, path: head[2]!.trim(), rows: diff?.rows ?? [], added: diff?.added ?? 0, removed: diff?.removed ?? 0 }
  })
}

/**
 * The span of a removed row and of the added row that replaces it that differ: what the two share at both ends is left alone.
 * Rows pair up in order inside one run of removals followed by a run of additions; a pair that shares next to nothing is a rewrite and gets none.
 */
function changedSpans(rows: readonly DiffRow[]): Map<number, [number, number]> {
  const found = new Map<number, [number, number]>()
  for (let at = 0; at < rows.length; ) {
    if (rows[at]!.kind !== "remove") {
      at++
      continue
    }
    let split = at
    while (rows[split]?.kind === "remove") split++
    let end = split
    while (rows[end]?.kind === "add") end++
    for (let pair = 0; pair < Math.min(split - at, end - split); pair++) {
      const before = rows[at + pair]!.text
      const after = rows[split + pair]!.text
      let head = 0
      while (head < before.length && head < after.length && before[head] === after[head]) head++
      let tail = 0
      while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
      const indent = Math.min(head, before.length - before.trimStart().length)
      if (head + tail - indent < 3) continue
      found.set(at + pair, [head, before.length - tail])
      found.set(split + pair, [head, after.length - tail])
    }
    at = Math.max(end, at + 1)
  }
  return found
}

/**
 * A diff line's code as spans, the part that differs from its pair bold in `tone`, and the indentation cut off its front (at
 * most half of `room`, the columns past the number and marker): it leads every wrapped piece, so wrapped code stays under its
 * first word instead of falling back to the margin.
 */
function diffCode(line: string, mark: readonly [number, number] | undefined, room: number, tone: ColorName, bg: ColorName | undefined): { indent: number; text: Span[] } {
  const tint = bg ? { bg } : {}
  const indent = Math.min(line.length - line.trimStart().length, Math.max(0, Math.floor(room / 2)))
  const code = line.slice(indent)
  const [from, to] = mark ? [Math.max(0, mark[0] - indent), Math.max(0, mark[1] - indent)] : [0, 0]
  const text: Span[] = to > from
    ? [{ text: code.slice(0, from), fg: "body" as const, ...tint }, { text: code.slice(from, to), fg: tone, bold: true, ...tint }, { text: code.slice(to), fg: "body" as const, ...tint }].filter((span) => span.text.length > 0)
    : [{ text: code, fg: "body", ...tint }]
  return { indent, text }
}

function padTo(line: Line, width: number, bg: ColorName): Line {
  const used = line.reduce((sum, span) => sum + textWidth(span.text), 0)
  return used < width ? [...line, { text: " ".repeat(width - used), bg }] : line
}

/**
 * One number column, as Claude Code draws a diff: a removed line's old number, an added or kept line's new one, then a +/- marker
 * and full-row tints for changes. The part of a changed line that differs from its replacement is bold in the marker's colour.
 * `prefix` is what leads every row (the card's indent and rule).
 */
export function renderDiffRows(rows: DiffRow[], width: number, prefix: Span[] = [{ text: INDENT }]): Line[] {
  const lead = prefix.reduce((sum, span) => sum + textWidth(span.text), 0)
  const shownNumber = (row: DiffRow) => (row.kind === "remove" ? row.old : row.new ?? row.old)
  const digits = Math.max(1, ...rows.map((row) => String(shownNumber(row) ?? 0).length))
  const columns = digits
  const changed = changedSpans(rows)
  return rows.flatMap((row, at): Line[] => {
    // A hunk's function context or a file's path can be longer than the row: it ends in `…` rather than stopping.
    if (row.kind === "hunk") return [[...prefix, { text: `${" ".repeat(Math.max(0, digits - 1))}${truncateEnd(row.text, Math.max(0, width - lead - 1))}`, fg: "muted", dim: true }]]
    if (row.kind === "file") return [[...prefix, { text: truncateEnd(row.text, Math.max(0, width - lead - 1)), fg: "muted", bold: true }]]
    const bg: ColorName | undefined = row.kind === "add" ? "diffAddedBg" : row.kind === "remove" ? "diffRemovedBg" : undefined
    const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "
    const side = (value: number | undefined) => (value === undefined ? " ".repeat(digits) : String(value).padStart(digits))
    const markerTone: ColorName = row.kind === "add" ? "success" : row.kind === "remove" ? "error" : "muted"
    const room = Math.max(lead + columns + 4, width - 1)
    const { indent, text } = diffCode(row.text, changed.get(at), room - lead - columns - 3, markerTone, bg)
    const first: Span[] = [...prefix, { text: side(shownNumber(row)), fg: "muted", ...(bg ? { bg } : {}) }, { text: ` ${marker} ${" ".repeat(indent)}`, fg: markerTone, ...(bg ? { bg } : {}) }]
    const rest: Span[] = [...prefix, { text: " ".repeat(columns + 3 + indent), ...(bg ? { bg } : {}) }]
    const rows = lead + columns + 3 + textWidth(row.text) <= room ? [[...first, ...text]] : wrapSpans(text, room, first, rest)
    return rows.map((line) => (bg ? padTo(line, width - 1, bg) : line))
  })
}

/** The narrowest terminal `diffView: split` draws side by side in, and the one `auto` waits for: below them a diff is unified. */
export const SPLIT_DIFF_MIN_WIDTH = 100
export const SPLIT_DIFF_AUTO_WIDTH = 160
const SPLIT_GUTTER = " │ "

/** Whether the profile's `diffView` draws diffs side by side in a terminal this wide. */
export function splitDiffAt(view: "unified" | "split" | "auto", width: number): boolean {
  return view !== "unified" && width >= (view === "auto" ? SPLIT_DIFF_AUTO_WIDTH : SPLIT_DIFF_MIN_WIDTH)
}

/** What `view` draws in a chat `chatWidth` columns wide, as one line for a preview. */
export function diffViewNote(view: "unified" | "split" | "auto", chatWidth: number): string {
  const from = view === "auto" ? SPLIT_DIFF_AUTO_WIDTH : SPLIT_DIFF_MIN_WIDTH
  if (view === "unified") return "Unified: removed and added lines in one column"
  return splitDiffAt(view, chatWidth) ? `Side by side: the chat is ${chatWidth} columns; unified below ${from}` : `Unified here: ${view} needs ${from} chat columns, the chat is ${chatWidth}`
}

/** A file that only gains or only loses lines would leave one half empty: it stays unified. */
function facesBothSides(rows: readonly DiffRow[]): boolean {
  return rows.some((row) => row.kind === "remove") && rows.some((row) => row.kind === "add")
}

/** Rows as they face each other: a kept line on both sides, a run of removals beside the additions that follow it, a gap or a path across. */
function facingRows(rows: readonly DiffRow[]): Array<{ across: number } | { left?: number; right?: number }> {
  const out: Array<{ across: number } | { left?: number; right?: number }> = []
  for (let at = 0; at < rows.length; ) {
    const kind = rows[at]!.kind
    if (kind === "hunk" || kind === "file") out.push({ across: at++ })
    else if (kind === "context") {
      out.push({ left: at, right: at })
      at++
    } else {
      let split = at
      while (rows[split]?.kind === "remove") split++
      let end = split
      while (rows[end]?.kind === "add") end++
      for (let n = 0; n < Math.max(split - at, end - split); n++) out.push({ ...(at + n < split ? { left: at + n } : {}), ...(split + n < end ? { right: split + n } : {}) })
      at = end
    }
  }
  return out
}

/**
 * The old file on the left and the new on the right, each with its own line numbers, a removal facing the addition that
 * replaced it with the part that differs in bold. A long line wraps inside its half; the shorter side is padded to match.
 */
export function renderSplitDiffRows(rows: DiffRow[], width: number, prefix: Span[] = [{ text: INDENT }]): Line[] {
  const lead = prefix.reduce((sum, span) => sum + textWidth(span.text), 0)
  const inner = Math.max(2, width - 1 - lead - SPLIT_GUTTER.length)
  const leftRoom = Math.floor(inner / 2)
  const rightRoom = inner - leftRoom
  const digits = Math.max(1, ...rows.map((row) => String(Math.max(row.old ?? 0, row.new ?? 0)).length))
  const changed = changedSpans(rows)
  const half = (at: number | undefined, side: "old" | "new", room: number): Line[] => {
    if (at === undefined) return [[{ text: " ".repeat(room) }]]
    const row = rows[at]!
    const bg: ColorName | undefined = row.kind === "add" ? "diffAddedBg" : row.kind === "remove" ? "diffRemovedBg" : undefined
    const tone: ColorName = row.kind === "add" ? "success" : row.kind === "remove" ? "error" : "muted"
    const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "
    const number = side === "old" ? row.old : row.new
    const tint = bg ? { bg } : {}
    const { indent, text } = diffCode(row.text, changed.get(at), room - digits - 3, tone, bg)
    const first: Span[] = [{ text: number === undefined ? " ".repeat(digits) : String(number).padStart(digits), fg: "muted", ...tint }, { text: ` ${marker} ${" ".repeat(indent)}`, fg: tone, ...tint }]
    const rest: Span[] = [{ text: " ".repeat(digits + 3 + indent), ...tint }]
    const lines = digits + 3 + textWidth(row.text) <= room ? [[...first, ...text]] : wrapSpans(text, room, first, rest)
    return lines.map((line) => fit(bg ? padTo(line, room, bg) : line, room))
  }
  return facingRows(rows).flatMap((pair): Line[] => {
    if ("across" in pair) {
      const row = rows[pair.across]!
      return row.kind === "hunk"
        ? [[...prefix, { text: `${" ".repeat(Math.max(0, digits - 1))}${truncateEnd(row.text, Math.max(0, width - lead - 1))}`, fg: "muted", dim: true }]]
        : [[...prefix, { text: truncateEnd(row.text, Math.max(0, width - lead - 1)), fg: "muted", bold: true }]]
    }
    const left = half(pair.left, "old", leftRoom)
    const right = half(pair.right, "new", rightRoom)
    const blank = (side: Line[], room: number): Line => {
      const bg = side[0]?.find((span) => span.bg)?.bg
      return [{ text: " ".repeat(room), ...(bg ? { bg } : {}) }]
    }
    return Array.from({ length: Math.max(left.length, right.length) }, (_, n): Line => [
      ...prefix,
      ...(left[n] ?? blank(left, leftRoom)),
      { text: SPLIT_GUTTER, fg: "border" },
      ...(right[n] ?? blank(right, rightRoom)),
    ])
  })
}

export type ToolCardInput = {
  title: string | undefined
  text: string
  status: "running" | "ok" | "error" | "cancelled" | "interrupted" | "unknown" | undefined
  width: number
  /** Anything beyond one line (the `full` view, ctrl+o or an opened card); `level` says how much. */
  expanded: boolean
  /** How much of a finished card shows; without it `expanded` decides: a page of the body or one line. Running tools show their tail. */
  level?: ToolLevel
  /** The page of an opened card (`level: "full"`), from 0. */
  page?: number
  /** What the tool reported when it completed (line, entry and match counts). */
  counts?: ToolCounts
  /** The search pattern of grep and glob, when the call's arguments are known. */
  pattern?: string
  /** Spinner frame index while running. */
  frame: number
  tailLines: number
  /** Dim text after a finished, collapsed inline card (line count, or a web search's queries). */
  summary?: string
  /** The tool's declared presentation, drawn under the card instead of its text. */
  render?: RenderNode
  /** How much a call map in `render` shows per side: names and lines (`balanced`, the default) or kinds and a longer preview (`full`). */
  mapDetail?: "balanced" | "full"
  /** How long the tool has run (running) or ran (finished), in ms; shown at the header's right edge from one second on. */
  elapsedMs?: number
  /** The tool is waiting for the user's approval: its card is tinted `warning`. */
  awaiting?: boolean
  /** What the tool reported when it completed (`item.completed.meta`): a shell's exit code, a task's tool-call count. */
  exitCode?: number
  toolCalls?: number
  /** A task: what its sub-agent runs on, already coloured (the full tier); it takes the place of the model the call named. */
  run?: Span[]
  /** Everything else the tool reported (a fetched page's status and size, a search's result count). */
  meta?: Readonly<Record<string, unknown>>
  /** A sub-agent call's agent and model, from the call's arguments. */
  agent?: string
  model?: string
  /** A write's content from its call: drawn as added lines under the header, as a new file in a patch is. */
  written?: Readonly<{ lines: readonly string[]; total: number; cut?: true }>
  /** Draw the card's marks in ASCII (also on when MENDCODE_GLYPHS=ascii). */
  ascii?: boolean
  /** `toolOutput: collapsed`: looking and reaching tools keep to their header row. */
  compact?: boolean
  /**
   * The full view's `toolDensity` for this call: `line` keeps a finished call to its header row, `brief` shows a short preview capped
   * by kind (read 3 lines, grep 3 matches, a shell's last 3 lines, a JSON result as its shape). Without it the level decides.
   */
  density?: "line" | "brief"
  /** Draw an edit's rows side by side (`splitDiffAt` the transcript's width); a file that only gains or only loses lines stays unified. */
  splitDiff?: boolean
  /** An extension's card body for this tool (`renderTool`); undefined keeps the default card. */
  custom?: (view: ToolView) => Line[] | undefined
  /** The wait canvas a running image tool draws (the profile's `imageWait*` keys); undefined is the default canvas. */
  imageWait?: ImageWaitConfig
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g

/** Non-empty lines of a tool's text, terminal escapes removed. */
function outputLines(text: string) {
  return text.replace(ANSI, "").replace(/\s+$/, "").split("\n").filter((line) => line.length > 0)
}

/** One tool call as rows; see the file comment. An extension's renderer for the tool comes first. */
export function renderToolCard(input: ToolCardInput): Line[] {
  // A tool renderer of an extension comes first, for built-in tools too; it draws inside the card's own indent.
  if (input.custom) {
    const { name, detail } = parseToolTitle(input.title)
    const room = Math.max(1, input.width - INDENT.length)
    const body = input.custom({ tool: name, detail, output: input.text, status: input.status, width: room, expanded: input.expanded })
    if (body) return body.map((row): Line => [{ text: INDENT }, ...row])
  }
  return cardRows(input)
}

/** The card's level: what the caller asked for, else the whole `expanded` flag meant (a page of the body, or one line). */
function levelOf(input: ToolCardInput): ToolLevel {
  return input.level ?? (input.expanded ? "full" : "summary")
}

/** Tools whose results are for the model to read; the card says what shape they have and shows rows only in `full`. */
const KNOWN_TOOLS = new Set([...Object.keys(TOOL_ICONS), ...Object.keys(LABELS)])
const isForeign = (name: string) => !KNOWN_TOOLS.has(name)

function cardRows(input: ToolCardInput): Line[] {
  const { name, detail } = parseToolTitle(input.title)
  const level = levelOf(input)
  const ascii = input.ascii ?? asciiGlyphs()
  const c = cardContext({ input, name, detail, level, ascii })
  const { running, failed, cancelled } = c
  const output = outputLines(input.text)
  const tone: ColorName = failed ? "error" : input.awaiting ? "warning" : "text"
  const icon: Span = running
    ? { text: `${(ascii ? SPINNER_ASCII : SPINNER_FRAMES)[input.frame % (ascii ? SPINNER_ASCII : SPINNER_FRAMES).length]} `, fg: input.awaiting ? "warning" : "text" }
    : { text: `${toolIcon(name)} `, fg: failed ? "error" : "muted" }

  // A call still waiting for its approval is not generating anything yet: it keeps the plain header.
  if (running && !input.awaiting && IMAGE_TOOLS.has(name)) return imageWaitCard(c)
  if (name === "shell") return shellCard(c, { summary: SHELL_ROWS, preview: SHELL_PREVIEW_LINES, failed: SHELL_FAILED_ROWS })
  if (name === "shell_output" || name === "shell_session") return shapeCard(c, toolLabel(name), `${output.length} line${output.length === 1 ? "" : "s"}`)

  if (!running && name === "edit") {
    const diff = parseDiff(input.text)
    if (diff) return diffBlocks({ files: [{ verb: "Edited", path: detail, rows: diff.rows, added: diff.added, removed: diff.removed }], c })
  }
  if (!running && name === "apply_patch") {
    const files = parsePatch(input.text) ?? (() => {
      const diff = parseDiff(input.text)
      return diff ? [{ verb: "Patched" as const, path: detail, rows: diff.rows, added: diff.added, removed: diff.removed }] : undefined
    })()
    if (files) return diffBlocks({ files, c })
  }
  if (!running && !failed && !cancelled && name === "write") return writeCard(c)

  if (name === "todo" && !failed) return todoCard({ input, detail, icon, tone, output, running })
  if (name === "question" && !running && !failed && !cancelled && output.length) return questionCard({ input, detail, icon, tone, output })

  if (!running && !cancelled) {
    const recall = sessionRecallCard({ name, text: input.text, width: input.width - INDENT.length, expanded: input.expanded, failed })
    if (recall) return recall.map((row): Line => [{ text: INDENT }, ...row])
    // A computer tool is one row until it is opened: its panels (target, nodes, capture) are for when someone asks to see them.
    const fact = failed ? undefined : name === "tool_search" ? toolSearchFact(input.text) : computerFact(name, input.text)
    if (fact && !input.expanded) return shapeCard({ ...c, level: "summary" }, toolLabel(name), fact)
    const computer = computerCard({ name, text: input.text, width: input.width - INDENT.length, expanded: input.expanded, failed })
    if (computer) return computer.map((row): Line => [{ text: INDENT }, ...row])
  }

  if (input.render && !running && !failed) return specCard(c)
  // `toolOutput: collapsed` keeps every looking and reaching tool to its header, in any view; an opened card still shows its body.
  const oneRow = (rows: Line[]) => (input.compact && level !== "full" ? rows.slice(0, 1) : rows)
  const kind = kindCard(c)
  if (kind) return oneRow(kind)
  return oneRow(shapeCard(c, toolLabel(name), isForeign(name) ? resultShape(input.text) : input.summary))
}

/** The kinds that have a card of their own; undefined when this call's text is not what its kind expects. */
function kindCard(c: CardContext): Line[] | undefined {
  switch (c.name) {
    case "read":
      return readCard(c)
    case "ls":
      return listCard(c)
    case "glob":
      return globCard(c, c.input.pattern)
    case "grep":
      return grepCard(c, c.input.pattern)
    case "webfetch":
      return webCard(c)
    case "web_search":
    case "websearch":
      return searchCard(c)
    case "task":
      return taskCard(c)
    default:
      return undefined
  }
}

/**
 * Where the finished picture of a card starts (the transcript places attachments two cells in from the card's edge) and the
 * columns it leaves free on the right.
 */
const PICTURE_INSET = "  "
const PICTURE_MARGIN = 2

/**
 * A running image tool: v1's "Generating image" over the wait canvas, its prompt as the target and its time among the facts. The
 * canvas sits in the cells the finished picture will take, so the picture replaces it without moving.
 */
function imageWaitCard(c: CardContext): Line[] {
  const head = header(c, { label: "Generating image", target: c.detail }, false)
  const config = c.input.imageWait ?? imageWaitConfig({})
  const maxCols = c.input.width - PICTURE_INSET.length - PICTURE_MARGIN
  return [head, ...imageWaitRows({ config, prefix: [{ text: PICTURE_INSET }], maxCols, elapsedMs: c.input.elapsedMs ?? 0, details: imageWaitDetails(c.input.text, c.input.meta), ascii: c.ascii })]
}

/**
 * A write is its header over the content its call put in the file, as added lines (as many as an edit's diff shows at each
 * level, paged when opened). Without the call's content (a result saved before it was kept), what the tool appended after the
 * first line (formatter output, diagnostics) follows on the rule: 3 rows, 6 in the full view, paged when opened.
 */
function writeCard(c: CardContext): Line[] {
  const written = c.input.written
  if (written?.lines.length) {
    const rows = written.lines.map((text, n): DiffRow => ({ kind: "add", text, number: n + 1, new: n + 1 }))
    const counted = written.cut ? { added: 0, cut: true } : { added: written.total, unseen: written.total - rows.length }
    // `balanced` keeps a write to its header, which opens to the content; the full view always shows it.
    return diffBlocks({ files: [{ verb: "Wrote", path: c.detail, rows, removed: 0, facts: writeFacts(c.input.text), ...counted }], c: c.level === "summary" ? { ...c, line: true } : c })
  }
  const notes = linesOf(c.input.text).slice(1).filter((line) => line.trim().length > 0)
  const head = header(c, { label: "Write", target: c.detail, facts: writeFacts(c.input.text) }, notes.length > 0)
  if (!notes.length || c.line) return [head]
  if (c.level === "full") return [head, ...pagedLines({ lines: notes, c, tone: "muted" })]
  return [head, ...shapeLines({ lines: notes, ctx: c.body, rows: c.brief ? BRIEF_ROWS.notes : c.level === "preview" ? 6 : 3 })]
}

/** `created · 4.2 KB` from a write's `Created path (4231 bytes)` (Claude Code's says `File created successfully at: path`). */
function writeFacts(text: string): string[] {
  const bytes = /\((\d[\d,]*) bytes\)/.exec(text)?.[1]
  return [/^(Created |File created )/.test(text) ? "created" : "replaced", ...(bytes ? [formatBytes(Number(bytes.replace(/,/g, "")))] : [])]
}

/** Results saved before `detail` existed put their lists next to the map; they open with the card like new ones. */
function foldLegacyLists(node: RenderNode): RenderNode {
  if (node.type !== "stack" || node.children.some((child) => child.type === "detail")) return node
  const visual = node.children.findIndex((child) => child.type === "graph" || child.type === "codemap")
  if (visual < 0) return node
  const isList = (child: RenderNode) => child.type === "list" || child.type === "table" || (child.type === "text" && child.bold === true)
  const lists = node.children.filter((child, index) => index > visual && isList(child))
  if (!lists.some((child) => child.type === "list" || child.type === "table")) return node
  return { ...node, children: [...node.children.filter((child, index) => index <= visual || !isList(child)), { type: "detail", at: "open", children: lists }] }
}

/**
 * The project map card is its diagram and one summary row at every level, the row cut with `…` rather than wrapped. The directory and
 * hub lists (and the hub table) are the tool's text for the model, kept in the result and the export, not rows of the card: the
 * `detail` nodes are left out here, so a result saved with them draws the same.
 */
function projectMapLines(node: RenderNode, width: number, options: Parameters<typeof renderSpecLines>[2]): Line[] {
  if (node.type !== "stack") return renderSpecLines(node, width, options)
  // The card is the ASCII map alone: its summary row and lists stay in the result, and the folded row already counts dirs and files.
  return node.children.flatMap((child): Line[] => (child.type === "detail" || child.type === "text" ? [] : renderSpecLines(child, width, options)))
}

/** A tool's declared presentation (a call map, a table) under its header; the spec decides what each density shows. */
function specCard(c: CardContext): Line[] {
  const { input } = c
  if (c.line) return [header(c, { label: toolLabel(c.name), target: c.detail })]
  const room = input.width - INDENT.length - 2
  const options = { expanded: c.level === "full", level: c.level, detail: input.mapDetail ?? "balanced", ascii: c.ascii }
  const render = foldLegacyLists(input.render!)
  const spec = c.name === "graph_map" ? projectMapLines(render, room, options) : renderSpecLines(render, room, options)
  return [header(c, { label: toolLabel(c.name), target: c.detail }), ...spec.map((row): Line => [{ text: `${INDENT}  ` }, ...row])]
}

/** A dim row that opens (or pages) its card when clicked; `fold` is one of the FOLD_* marks. */
function foldRow(prefix: Span[], text: string, fold: number): Line {
  const row: Line = [...prefix, { text, fg: "muted", dim: true }]
  markFold(row, fold)
  return row
}

/** One header per file (`Edit path  +3 −1`) over its rows; at most DIFF_PREVIEW_ROWS rows in all before the hint. */
function diffBlocks({ files, c }: { files: PatchFile[]; c: CardContext }): Line[] {
  const { input, level, marks } = c
  const out: Line[] = []
  const total = files.reduce((sum, file) => sum + file.rows.length, 0)
  const pages = Math.max(1, Math.ceil(total / TOOL_PAGE_LINES))
  const at = Math.min(Math.max(0, input.page ?? 0), pages - 1)
  // `full` shows one page of the rows of all files together; the other levels the first rows up to their cap.
  let skip = level === "full" ? at * TOOL_PAGE_LINES : 0
  let budget = level === "full" ? TOOL_PAGE_LINES : c.brief ? BRIEF_ROWS.diff : level === "preview" ? DIFF_PREVIEW_ROWS : DIFF_ROWS
  let hidden = 0
  const verbs = { Edited: "Edit", Added: "Add", Deleted: "Delete", Patched: "Patch", Wrote: "Write" } as const
  const statsOf = (file: PatchFile): Span[] => [...(file.added ? [{ text: `+${file.added}`, fg: "success" as const }] : []), ...(file.added && file.removed ? [{ text: " " }] : []), ...(file.removed ? [{ text: `${marks.minus}${file.removed}`, fg: "error" as const }] : [])]
  const factsOf = (file: PatchFile) => [...(file.facts ?? []), ...(statsOf(file).length ? [statsOf(file)] : [])]
  // A call kept to a row is one header per file with its counts, no rows.
  if (c.line) return files.map((file, index) => header(c, { label: verbs[file.verb], target: file.path, facts: factsOf(file), quiet: index > 0 }, index === 0))
  for (const file of files) {
    const from = Math.min(skip, file.rows.length)
    skip -= from
    if (budget <= 0 && file.rows.length > 0) {
      hidden += file.rows.length - from + (file.unseen ?? 0)
      continue
    }
    out.push(header(c, { label: verbs[file.verb], target: file.path, facts: factsOf(file), quiet: out.length > 0 }, !out.length))
    const shown = Math.min(budget, file.rows.length - from)
    const draw = input.splitDiff && facesBothSides(file.rows) ? renderSplitDiffRows : renderDiffRows
    out.push(...draw(file.rows.slice(from, from + shown), input.width, c.body.prefix))
    hidden += file.rows.length - from - shown + (file.unseen ?? 0)
    budget -= shown
  }
  if (level === "full") {
    if (pages > 1) out.push(foldRow(c.body.prefix, `lines ${at * TOOL_PAGE_LINES + 1}-${Math.min(total, (at + 1) * TOOL_PAGE_LINES)} of ${total} ${marks.dot} ${at < pages - 1 ? "click or ctrl+x f for the next page" : "click or ctrl+o to close"}`, at < pages - 1 ? FOLD_PAGE : FOLD_CARD))
  } else if (files.some((file) => file.cut)) out.push(foldRow(c.body.prefix, `${marks.ellipsis} more lines`, FOLD_CARD))
  else if (hidden > 0) out.push(foldRow(c.body.prefix, `${marks.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`, FOLD_CARD))
  return out
}

const TODO_MARKS: Readonly<Record<string, { glyph: string; fg: ColorName; dim?: true }>> = {
  "[x]": { glyph: "✓", fg: "success", dim: true },
  "[~]": { glyph: "▸", fg: "warning" },
  "[ ]": { glyph: "□", fg: "text" },
  "[-]": { glyph: "×", fg: "error", dim: true },
}

/** v1's todo checklist: `✓ done` (muted), `▸ in progress` (warning), `□ pending` (text). */
function todoCard(context: { input: ToolCardInput; detail: string; icon: Span; tone: ColorName; output: string[]; running: boolean }): Line[] {
  const { input, detail, icon, tone, output, running } = context
  const marks = { done: "[x]", in_progress: "[~]", pending: "[ ]", cancelled: "[-]" } as const
  const items = parseTodoText(output.join("\n")).map((item) => ({ mark: TODO_MARKS[marks[item.status]]!, text: `${item.priority ? `${item.priority} · ` : ""}${item.text}` }))
  const done = items.filter((item) => item.mark.glyph === "✓").length
  const count = detail || (items.length ? `${done}/${items.length}` : "")
  const head: Line = [{ text: INDENT }, icon, { text: "Todos", fg: tone }, ...(count ? [{ text: ` ${count}`, fg: "muted" as const }] : [])]
  if (running || !items.length) return [head]
  const limit = input.expanded ? items.length : TODO_PREVIEW_ROWS
  const rows = items.slice(0, limit).flatMap((item) => wrapSpans([{ text: item.text, fg: item.mark.dim ? "muted" : item.mark.fg === "warning" ? "warning" : "text", ...(item.mark.dim ? { dim: true } : {}) }], input.width, [{ text: `${INDENT}  ` }, { text: `${item.mark.glyph} `, fg: item.mark.fg }]))
  const more: Line[] = items.length > limit ? [[{ text: `${INDENT}  … ${items.length - limit} more`, fg: "muted", dim: true }]] : []
  return [head, ...rows, ...more]
}

/** An answered question: `? <question>` then the answer, indented. */
function questionCard(context: { input: ToolCardInput; detail: string; icon: Span; tone: ColorName; output: string[] }): Line[] {
  const { input, detail, icon, tone, output } = context
  const head = wrapSpans([{ text: detail || "Question", fg: tone }], input.width, [{ text: INDENT }, icon])
  const answer = output.flatMap((text) => wrapSpans([{ text, fg: "accent" }], input.width, [{ text: `${INDENT}  ` }]))
  return [...head, ...answer]
}
