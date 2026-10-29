import type { Line, Span } from "../ui/theme"
import { clip, plainText, wrapSpans, BREAK } from "./markdown-wrap"
import type { MarkdownStyle, Roles, TableStyle } from "./markdown-style"
import { textWidth } from "./wrap"

export type Align = "left" | "center" | "right"

const MIN_COLUMN = 3
/** Enhanced tables stack when the longest words (each counted up to this many cells) cannot share the width, or a column would be thinner than the floor. */
const WORD_CAP = 10
const STACK_FLOOR = 4

/** `│ a │ b │` for the boxed styles; the others separate columns with two spaces and draw no vertical lines. */
const GAP = "  "
const boxed = (kind: TableStyle) => kind === "box" || kind === "grid"
/** Cells a table of `columns` columns spends on borders and gaps. */
const overheadOf = (kind: TableStyle, columns: number) => (boxed(kind) ? 3 * columns + 1 : GAP.length * (columns - 1))

function shrink(widths: number[], floors: number[], target: number) {
  let total = widths.reduce((a, b) => a + b, 0)
  while (total > target) {
    let widest = -1
    for (let i = 0; i < widths.length; i++) if (widths[i]! > floors[i]! && (widest < 0 || widths[i]! > widths[widest]!)) widest = i
    if (widest < 0) return
    widths[widest]!--
    total--
  }
}

type TableInput = {
  /** Header row first; every row has one entry per column. */
  cells: Span[][][]
  aligns: Align[]
  width: number
  style: MarkdownStyle
  roles: Roles
}

/** Column widths that fit `available` cells: widest columns shrink first, never below their longest word (then never below three cells). */
function columnWidths(cells: Span[][][], columns: number, available: number) {
  const natural: number[] = []
  const longestWord: number[] = []
  for (let c = 0; c < columns; c++) {
    let widest = 1
    let word = 1
    for (const row of cells) {
      const text = plainText(row[c]!)
      widest = Math.max(widest, ...text.split(BREAK).map(textWidth))
      for (const part of text.split(/\s+/)) word = Math.max(word, textWidth(part))
    }
    natural.push(widest)
    longestWord.push(word)
  }
  const widths = [...natural]
  const hardFloor = natural.map((n) => Math.min(n, MIN_COLUMN))
  shrink(widths, natural.map((n, c) => Math.max(hardFloor[c]!, Math.min(n, longestWord[c]!))), available)
  shrink(widths, hardFloor, available)
  return { widths, longestWord }
}

/** A GFM table as rows no wider than `width`; falls back to a stacked key/value list when the columns cannot fit. */
export function renderTable(input: TableInput): Line[] {
  const { cells, aligns, width, style, roles } = input
  const columns = cells[0]!.length
  const kind = style.enhanced ? style.table : "box"
  const overhead = overheadOf(kind, columns)
  const available = width - overhead
  if (available < MIN_COLUMN * columns) return stackedTable({ cells, width, roles, enhanced: style.enhanced })
  const { widths, longestWord } = columnWidths(cells, columns, available)
  if (style.enhanced && (available < STACK_FLOOR * columns || longestWord.reduce((sum, word) => sum + Math.min(word, WORD_CAP), 0) > available)) return stackedTable({ cells, width, roles, enhanced: true })

  const border = (text: string): Span => ({ text, fg: roles.tableBorder })
  const total = widths.reduce((a, b) => a + b, 0) + overhead
  const lined = boxed(kind)
  const boxRule = (left: string, middle: string, right: string): Line => [border(left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right)]
  const fullRule: Line = [border("─".repeat(total))]
  const columnRule: Line = [border(widths.map((w) => "─".repeat(w)).join(GAP))]
  const out: Line[] = []
  const pushRow = (row: Span[][], header: boolean) => {
    const wrapped = row.map((spans, c) => wrapSpans(header ? spans.map((span) => ({ ...span, bold: true })) : spans, widths[c]!))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    for (let k = 0; k < height; k++) {
      const line: Line = lined ? [border("│")] : []
      wrapped.forEach((lines, c) => {
        const content = lines[k] ?? []
        const gap = widths[c]! - textWidth(plainText(content))
        const align = aligns[c] ?? "left"
        const before = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0
        const after = gap - before
        // Unframed tables leave the last column ragged: trailing blanks would only be copied with the text.
        const closing = lined || c < columns - 1
        if (lined) line.push({ text: " ".repeat(before + 1) }, ...content, { text: " ".repeat(after + 1) }, border("│"))
        else line.push(...(c ? [{ text: GAP }] : []), ...(before ? [{ text: " ".repeat(before) }] : []), ...content, ...(closing && after ? [{ text: " ".repeat(after) }] : []))
      })
      out.push(line)
    }
  }
  if (lined) out.push(boxRule("┌", "┬", "┐"))
  if (kind === "rules") out.push(fullRule)
  pushRow(cells[0]!, true)
  if (lined) out.push(boxRule("├", "┼", "┤"))
  else out.push(kind === "rules" ? fullRule : columnRule)
  cells.slice(1).forEach((row, r) => {
    if (kind === "grid" && r > 0) out.push(boxRule("├", "┼", "┤"))
    pushRow(row, false)
  })
  if (lined) out.push(boxRule("└", "┴", "┘"))
  if (kind === "rules") out.push(fullRule)
  return out
}

/** Fallback when the columns cannot fit: one `key: value` list per row. */
function stackedTable(input: { cells: Span[][][]; width: number; roles: Roles; enhanced: boolean }): Line[] {
  const { cells, width, roles, enhanced } = input
  const [header, ...rows] = cells as [Span[][], ...Span[][][]]
  const out: Line[] = []
  if (!rows.length) {
    const joined: Span[] = header.flatMap((cell, c) => (c ? [{ text: " · ", fg: "muted" as const }, ...cell] : cell))
    return wrapSpans(joined, width)
  }
  const keyLimit = Math.max(1, Math.floor(width / 2) - 2)
  rows.forEach((row, r) => {
    if (r) out.push(enhanced ? [{ text: "─".repeat(Math.min(width, 24)), fg: roles.tableBorder }] : [])
    row.forEach((value, c) => {
      const key = clip(plainText(header[c]!), keyLimit)
      out.push(...wrapSpans(value, width, [{ text: `${key}: `, fg: enhanced ? roles.tableHeader : "muted", ...(enhanced ? { bold: true } : {}) }], [{ text: " ".repeat(Math.min(2, width - 1)) }]))
    })
  })
  return out
}
