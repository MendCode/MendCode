import type { Line, Span } from "./theme"
import { cells, textWidth } from "../view/wrap"
import { graphemes, rowLimit } from "../view/editor"

/**
 * Mouse selection over the chat screen: pure helpers, no state of their own. The app keeps one `Selection`, redraws it as a
 * highlight while it is dragged and, on release, copies `selectedText` (the drawn text without its chrome) through OSC 52.
 */

export type Point = { row: number; col: number }

/** A transcript row as the selection reads it: its text, how many leading cells are chrome and how a wrap joined it to the row above. */
export type BodyLine = { text: string; gutter: number; /** The message the row belongs to (comments on passages, docs/editor.md). */ itemId?: string; soft?: "space" | "none"; fold?: { itemId: string; ordinal: number }; /** `copy` buttons in the row: the cells `[from, to)` put `text` on the clipboard. */ copy?: ReadonlyArray<{ from: number; to: number; text: string; label: string; open?: "image" | "folder" }> }

/** Where the last frame put the transcript and the prompt, so a screen position can be turned into text. */
export type SelectionMap = {
  width: number
  bodyTop: number
  /** One entry per transcript row on screen; undefined where nothing is drawn (padding, the home screen). */
  body: ReadonlyArray<BodyLine | undefined>
  /**
   * The transcript row `body[0]` shows, counted from the top of the laid-out window (negative where blank rows pad the top).
   * A body selection is kept in these rows, so it follows the text when the transcript scrolls under a drag.
   */
  bodyBase?: number
  /** Total rows of the laid-out window and a reader of any of them, on screen or not; absent when the body is not a scrolling transcript. */
  bodyRows?: number
  lineAt?: (row: number) => BodyLine | undefined
  /** Where the "jump to latest" label is drawn (screen row and `[from, to)` cells in the chat column); absent when it is not on screen. */
  jump?: { row: number; from: number; to: number }
  /** The scrollbar's track when it is drawn: its column in the chat column, its first screen row and length, and the thumb and the transcript it stands for. */
  scrollbar?: { col: number; top: number; rows: number; thumb: { top: number; length: number }; total: number; viewport: number }
  promptTop: number
  promptRows: number
  /** Rows of the prompt's closing border right under its last row; a press there is a press below the text. */
  promptBelow?: number
  /** Index in `promptLines` of the first prompt row on screen. */
  promptFirst: number
  /** Cells before the first typed character of a prompt row. */
  promptInset: number
  /** The prompt's wrapped rows: `start`/`end` are grapheme offsets in the prompt text. */
  promptLines: ReadonlyArray<{ text: string; start: number; end: number }>
  /** The rows under the prompt (the footer) as plain text, from screen row `top`: selected and copied like a terminal's own text. */
  footer?: { top: number; rows: readonly string[] }
}

/**
 * For the prompt, `anchor` and `focus` are screen positions. For the transcript their rows are transcript rows (see `bodyBase`),
 * and `pointer` is the last screen position of the drag: the focus follows it while the view scrolls under it.
 */
export type Selection = { anchor: Point; focus: Point; area: "body" | "prompt" | "footer"; moved: boolean; pointer?: Point }

/** The transcript row drawn at screen row `row`. */
export const contentRow = (map: SelectionMap, row: number) => (map.bodyBase ?? map.bodyTop) + row - map.bodyTop

/** A screen position as a transcript point: the row held inside the body, the column inside the screen. */
export function bodyPoint(map: SelectionMap, point: Point): Point {
  const row = clamp(point.row, map.bodyTop, Math.max(map.bodyTop, map.bodyTop + map.body.length - 1))
  return { row: contentRow(map, row), col: clamp(point.col, 0, map.width - 1) }
}

/** Which way a drag at `point` pushes the transcript (-1 up, 1 down) and how many rows past the edge it is; undefined inside the body. */
export function dragEdge(map: SelectionMap, point: Point): { direction: -1 | 1; distance: number } | undefined {
  if (point.row < map.bodyTop || (map.bodyTop === 0 && point.row === 0)) return { direction: -1, distance: Math.max(1, map.bodyTop - point.row) }
  const end = map.bodyTop + map.body.length
  return point.row >= end ? { direction: 1, distance: point.row - end + 1 } : undefined
}

/** The shift modifier bit of an SGR mouse report's button code. */
const MOUSE_SHIFT = 4

/**
 * `press`, `drag` or `release` of the left button from an SGR mouse report, with `shift` when that key was held; undefined for
 * anything else (wheel, motion, other buttons, other modifiers).
 */
export function mouseEvent(key: string): { kind: "press" | "drag" | "release"; point: Point; shift?: true } | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key)
  if (!match) return undefined
  const code = Number(match[1])
  const button = code & ~MOUSE_SHIFT
  const point = { col: Number(match[2]) - 1, row: Number(match[3]) - 1 }
  const shift = code & MOUSE_SHIFT ? { shift: true as const } : {}
  if (match[4] === "m") return button === 0 ? { kind: "release", point, ...shift } : undefined
  return button === 0 ? { kind: "press", point, ...shift } : button === 32 ? { kind: "drag", point, ...shift } : undefined
}

/** A right-button press from an SGR mouse report (no modifiers); undefined for anything else. */
export function rightClick(key: string): Point | undefined {
  const match = /^\x1b\[<2;(\d+);(\d+)M$/.exec(key)
  return match ? { col: Number(match[1]) - 1, row: Number(match[2]) - 1 } : undefined
}

const isWordCell = (text: string) => /^[\p{L}\p{N}_]$/u.test(text)
/** Characters that stay inside a word when a word character follows them: paths, hyphenated names, addresses. */
const isJoinCell = (text: string) => /^[-./:@~]$/.test(text)

/** The word under cell `col` of `text` as `[from, to)` cells (a double click); undefined on a space or a lone symbol. */
export function wordSpan(text: string, col: number): [number, number] | undefined {
  const all = cellsOf(text)
  const at = all.findIndex((cell) => cell.from <= col && col < cell.to)
  if (at < 0 || !isWordCell(all[at]!.text)) return undefined
  let first = at
  while (first > 0 && (isWordCell(all[first - 1]!.text) || (isJoinCell(all[first - 1]!.text) && first > 1 && isWordCell(all[first - 2]!.text)))) first--
  let last = at
  while (last < all.length - 1 && (isWordCell(all[last + 1]!.text) || (isJoinCell(all[last + 1]!.text) && last + 2 < all.length && isWordCell(all[last + 2]!.text)))) last++
  return [all[first]!.from, all[last]!.to]
}

/** The cells of a prompt or transcript row that hold text, as `[0, end)`; undefined for a blank row. */
export function lineSpan(text: string): [number, number] | undefined {
  const end = textEnd(text.trimEnd())
  return end > 0 ? [0, end] : undefined
}

/** The first and last transcript rows of the wrapped line that contains transcript row `row` (a triple click). */
export function wrappedRows(map: SelectionMap, row: number): [number, number] {
  let top = row
  while (lineOf(map, top)?.soft && lineOf(map, top - 1)) top--
  let bottom = row
  while (lineOf(map, bottom + 1)?.soft) bottom++
  return [top, bottom]
}

/** The text of transcript row `row`, as drawn; empty when nothing is drawn there. */
export const rowText = (map: SelectionMap, row: number) => lineOf(map, row)?.text ?? ""

/**
 * The text of the wrapped line under screen position `point` (its rows joined the way the wrap split them, the chrome cells left out)
 * and the string index of the cell pressed, so something that spans two rows is read whole; undefined where no text is drawn.
 */
export function wrappedTextAt(map: SelectionMap, point: Point): { text: string; at: number } | undefined {
  const pressed = bodyPoint(map, point)
  const [top, bottom] = wrappedRows(map, pressed.row)
  let text = ""
  let at: number | undefined
  for (let row = top; row <= bottom; row++) {
    const line = lineOf(map, row)
    if (!line) continue
    if (row > top && line.soft === "space") text += " "
    let piece = ""
    let hit: number | undefined
    for (const cell of cellsOf(line.text)) {
      if (cell.from < line.gutter) continue
      if (row === pressed.row && pressed.col >= cell.from && pressed.col < cell.to) hit = piece.length
      piece += cell.text
    }
    const kept = row < bottom ? piece.trimEnd() : piece
    if (hit !== undefined && hit < kept.length) at = text.length + hit
    text += kept
  }
  return at === undefined ? undefined : { text, at }
}

/** The area a press at `point` starts a selection in. */
export function areaAt(map: SelectionMap, point: Point): Selection["area"] | undefined {
  if (point.col < 0 || point.col >= map.width) return undefined
  if (map.footer && point.row >= map.footer.top && point.row < map.footer.top + map.footer.rows.length) return "footer"
  if (point.row >= map.bodyTop && point.row < map.bodyTop + map.body.length) return "body"
  if (point.row >= map.promptTop && point.row < map.promptTop + map.promptRows + (map.promptRows > 0 ? map.promptBelow ?? 0 : 0)) return "prompt"
  return undefined
}

/** Whether `point` is on the prompt's closing border, under its last row (a press there puts the cursor at the end of the text). */
export const belowPrompt = (map: SelectionMap, point: Point) => map.promptRows > 0 && point.row >= map.promptTop + map.promptRows

/**
 * The grapheme offset in the prompt text a press at `point` puts the cursor at: before the character drawn under that cell (either
 * cell of a wide one), the start of the row over its margin and lead, the end of the row past its text, the end of the text below
 * the last row. A row that wraps into the next one ends before its last character, which is drawn on the next row.
 */
export function promptOffsetAt(map: SelectionMap, point: Point): number {
  const last = map.promptLines.at(-1)
  if (!last) return 0
  const index = map.promptFirst + point.row - map.promptTop
  if (index >= map.promptFirst + map.promptRows) return last.end
  const row = clamp(index, 0, map.promptLines.length - 1)
  const line = map.promptLines[row]!
  const col = point.col - map.promptInset
  let used = 0
  let at = line.start
  const limit = rowLimit({ rows: map.promptLines, index: row })
  for (const grapheme of graphemes(line.text)) {
    if (at >= limit || used + textWidth(grapheme) > col) break
    used += textWidth(grapheme)
    at++
  }
  return at
}

/** Rows drawn only with box-drawing characters (at least one rule): the borders of a table, never text. */
const BOX_RULE = /^[\s│┃║]*[─━═┌┐└┘├┤┬┴┼╭╮╯╰╔╗╚╝╠╣╦╩╬][─━═│┃║┌┐└┘├┤┬┴┼╭╮╯╰╔╗╚╝╠╣╦╩╬\s]*$/

const clamp =(value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** The two ends in reading order, with the focus held inside the area the selection began in. */
function ordered(map: SelectionMap, selection: Selection): [Point, Point] {
  const [top, rows] = selection.area === "body" ? (map.bodyRows !== undefined ? [0, map.bodyRows] : [map.bodyBase ?? map.bodyTop, map.body.length]) : [map.promptTop, map.promptRows]
  const focus = { row: clamp(selection.focus.row, top, top + rows - 1), col: clamp(selection.focus.col, 0, map.width - 1) }
  const anchor = selection.anchor
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col) ? [anchor, focus] : [focus, anchor]
}

type Cell = { text: string; from: number; to: number }
const cellsOf = (text: string): Cell[] => {
  const out: Cell[] = []
  let col = 0
  for (const cell of cells(text)) {
    out.push({ text: cell.text, from: col, to: col + cell.width })
    col += cell.width
  }
  return out
}
const textEnd = (text: string) => cellsOf(text).at(-1)?.to ?? 0

/** The transcript row `row`: from the screen's rows when it is drawn, else from the whole window. */
function lineOf(map: SelectionMap, row: number): BodyLine | undefined {
  const index = row - (map.bodyBase ?? map.bodyTop)
  return index >= 0 && index < map.body.length ? map.body[index] : map.lineAt?.(row)
}

/** The cells of transcript row `row` the selection covers, as `[from, to)`; undefined when it covers none. */
function bodyCovered(line: BodyLine | undefined, row: number, start: Point, end: Point): [number, number] | undefined {
  if (!line || row < start.row || row > end.row) return undefined
  const from = row === start.row ? start.col : 0
  const to = row === end.row ? Math.min(end.col + 1, textEnd(line.text)) : textEnd(line.text)
  return to > from ? [from, to] : undefined
}

/** The highlight of the transcript: screen row → `[from, to)` cells. */
export function bodyHighlight(map: SelectionMap, selection: Selection): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  if (selection.area !== "body" || !selection.moved) return out
  const [start, end] = ordered(map, selection)
  const base = map.bodyBase ?? map.bodyTop
  map.body.forEach((line, index) => {
    const covered = bodyCovered(line, base + index, start, end)
    if (covered) out.set(map.bodyTop + index, covered)
  })
  return out
}

/**
 * The plain text of the selected transcript rows: no chrome cells, wrapped lines rejoined, blank rows between messages kept,
 * trailing spaces dropped.
 */
export function bodyText(map: SelectionMap, selection: Selection): string {
  if (selection.area !== "body") return ""
  const [start, end] = ordered(map, selection)
  let text = ""
  let pendingBlank = 0
  let any = false
  for (let row = start.row; row <= end.row; row++) {
    const line = lineOf(map, row)
    if (!line) continue
    const covered = bodyCovered(line, row, start, end)
    const drawn = covered ? cellsOf(line.text).filter((cell) => cell.to > Math.max(covered[0], line.gutter) && cell.from < covered[1]).map((cell) => cell.text).join("").trimEnd() : ""
    // A table row loses its bars: the cells come out tab-separated.
    const slice = /^│.*│$/.test(drawn) ? drawn.slice(1, -1).trim().split(/\s*│\s*/).join("\t") : drawn
    // A row of nothing is the gap between paragraphs; a row of only chrome (a table rule, a code block's label) is not there at all.
    if (!slice || BOX_RULE.test(line.text)) {
      if (any && line.text.trim() === "") pendingBlank++
      continue
    }
    if (!any) text = slice
    else if (line.soft && !pendingBlank) text += `${line.soft === "space" ? " " : ""}${slice}`
    else text += `${"\n".repeat(pendingBlank + 1)}${slice}`
    pendingBlank = 0
    any = true
  }
  return text
}

/** The selected span of the prompt as grapheme offsets in its text; undefined when it is empty. */
export function promptRange(map: SelectionMap, selection: Selection): { start: number; end: number } | undefined {
  if (selection.area !== "prompt" || !selection.moved) return undefined
  const [start, end] = ordered(map, selection)
  const offsetAt = (point: Point, edge: "start" | "end") => {
    const line = map.promptLines[clamp(map.promptFirst + point.row - map.promptTop, 0, map.promptLines.length - 1)]
    if (!line) return 0
    // One entry per grapheme of the editor text (a tab or a control character still counts), so offsets stay the editor's.
    let at = 0
    const typed = graphemes(line.text).map((grapheme) => {
      const width = [...cells(grapheme)].reduce((sum, cell) => sum + cell.width, 0)
      at += width
      return { from: at - width, to: at }
    })
    const col = point.col - map.promptInset
    const count = edge === "start" ? typed.filter((cell) => cell.to <= col).length : typed.filter((cell) => cell.from <= col).length
    return clamp(line.start + count, line.start, line.end)
  }
  const range = { start: offsetAt(start, "start"), end: offsetAt(end, "end") }
  return range.end > range.start ? range : undefined
}

/** `line` with the cells `[from, to)` drawn as the selection (the prompt editor's selected look), or as `look` (the find bar's hits). */
export function highlightLine(line: Line, from: number, to: number, look: Partial<Span> = { fg: "background", bg: "primary" }): Line {
  const out: Span[] = []
  let col = 0
  for (const span of line) {
    let before = ""
    let inside = ""
    let after = ""
    for (const cell of cells(span.text)) {
      const mid = col + cell.width
      if (mid <= from) before += cell.text
      else if (col >= to) after += cell.text
      else inside += cell.text
      col = mid
    }
    if (before) out.push({ ...span, text: before })
    if (inside) out.push({ ...span, ...look, text: inside })
    if (after) out.push({ ...span, text: after })
  }
  return out
}

/** Footer selections run in reading order between two screen points, like a terminal's own: `[start, end]`, rows clamped to the footer. */
function footerOrdered(map: SelectionMap, selection: Selection): [Point, Point] | undefined {
  const footer = map.footer
  if (!footer?.rows.length) return undefined
  const clampRow = (row: number) => Math.min(footer.top + footer.rows.length - 1, Math.max(footer.top, row))
  const a = { row: clampRow(selection.anchor.row), col: selection.anchor.col }
  const b = { row: clampRow(selection.focus.row), col: selection.focus.col }
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a]
}

/** The cells of each footer row the selection covers: screen row → `[from, to)`. */
export function footerHighlight(map: SelectionMap, selection: Selection): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  const range = selection.area === "footer" && selection.moved ? footerOrdered(map, selection) : undefined
  if (!range) return out
  const [start, end] = range
  for (let row = start.row; row <= end.row; row++) {
    const text = map.footer!.rows[row - map.footer!.top] ?? ""
    const from = row === start.row ? start.col : 0
    const to = row === end.row ? Math.min(end.col + 1, textEnd(text)) : textEnd(text)
    if (to > from) out.set(row, [from, to])
  }
  return out
}

/** The selected footer text: each row's covered cells, trailing spaces dropped, rows joined by newlines. */
export function footerText(map: SelectionMap, selection: Selection): string {
  const rows: string[] = []
  for (const [row, [from, to]] of footerHighlight(map, selection)) {
    const text = map.footer!.rows[row - map.footer!.top] ?? ""
    rows.push(cellsOf(text).filter((cell) => cell.from >= from && cell.to <= to).map((cell) => cell.text).join("").trimEnd())
  }
  return rows.join("\n")
}

/** The footer row under `point` as plain text, for a double (word) or triple (row) click. */
export const footerRow = (map: SelectionMap, row: number) => map.footer?.rows[row - map.footer.top] ?? ""
