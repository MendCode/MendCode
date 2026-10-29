import type { ColorName, Line, Span } from "../../ui/theme"
import { textWidth, truncateEnd, wrap } from "../wrap"
import { registerChart } from "../chart-picture"
import { markPicture } from "../line-meta"
import { cleanMermaidLabel, preparedMermaidLines } from "./legacy-shared"

/** One colour per slice, in the order the slices are written; a ninth slice starts the list again. */
const SLICE_COLORS: readonly ColorName[] = ["info", "warning", "success", "synType", "error", "accent", "primary", "secondary"]
/** The disc's width in cells. It is half as many rows, since a cell is about twice as tall as it is wide. */
const DISC = 24
/** The dot a cell of the disc is drawn with. */
const DOT = "●"

/** A number as a legend shows it: whole when it is whole, two decimals at most. */
const shown = (value: number) => String(Number(value.toFixed(2)))

/**
 * A pie as a disc of dots, one per cell in the colour of the slice it falls in, starting at twelve o'clock and going clockwise as
 * Mermaid does. Dots, not filled cells: a filled disc shows every step of its edge, a field of dots reads as a round one. The
 * legend stands to the right of the disc when the width allows it and below it otherwise: a dot, the label, the value and its
 * share, in columns.
 *
 * The disc's rows say which chart they are a part of (`markPicture`): a terminal that draws pictures paints the pie there as a
 * smooth round image and blanks these cells, so the dots are what a terminal without graphics shows.
 */
export function renderPieChart(input: string, width: number): { lines: Line[] } | undefined {
  const lines = preparedMermaidLines(input)
  const header = /^pie(?:\s+showData)?(?:\s+title\s+(.+))?$/i.exec(lines[0] ?? "")
  if (!header) return undefined
  let title = cleanMermaidLabel(header[1]) || "Pie"
  const slices: Array<{ label: string; value: number }> = []
  for (const line of lines.slice(1)) {
    if (/^title\s+/.test(line)) {
      title = cleanMermaidLabel(line.replace(/^title\s+/, ""))
      continue
    }
    const slice = /^"?([^":]+)"?\s*:\s*([\d.]+)$/.exec(line)
    if (!slice) return undefined
    const value = Number(slice[2])
    if (!Number.isFinite(value) || value < 0) return undefined
    slices.push({ label: cleanMermaidLabel(slice[1]), value })
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (!slices.length || total <= 0) return undefined
  const diameter = Math.min(DISC, width - (width % 2))
  if (diameter < 12) return undefined
  const rows = diameter / 2
  const cumulative: number[] = []
  let sum = 0
  for (const slice of slices) cumulative.push(sum += slice.value / total)
  /** The slice the cell (`x`, `y`) falls in, or -1 outside the disc. */
  const sliceAt = (x: number, y: number) => {
    const dx = (x + 0.5 - diameter / 2) / (diameter / 2)
    const dy = (y + 0.5 - rows / 2) / (rows / 2)
    if (dx * dx + dy * dy > 1) return -1
    const turn = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2)
    const index = cumulative.findIndex((value) => turn <= value)
    return index < 0 ? slices.length - 1 : index
  }
  const color = (index: number) => SLICE_COLORS[index % SLICE_COLORS.length]!
  const disc: Line[] = []
  for (let y = 0; y < rows; y++) {
    const row: Line = []
    const add = (span: Span) => {
      const last = row.at(-1)
      if (last && last.fg === span.fg) last.text += span.text
      else row.push(span)
    }
    // Outside the disc a cell has no colour at all, so the terminal's own background (an image, a transparent window) shows.
    for (let x = 0; x < diameter; x++) {
      const index = sliceAt(x, y)
      add(index < 0 ? { text: " " } : { text: DOT, fg: color(index) })
    }
    disc.push(row)
  }
  const picture = registerChart({ kind: "pie", slices: slices.map((slice, i) => ({ share: slice.value / total, color: color(i) })) })
  const mark = (row: Line, y: number) => (y < rows ? markPicture(row, { key: picture, row: y, rows, cols: diameter, col: 0 }) : row)
  const values = slices.map((slice) => shown(slice.value))
  const shares = slices.map((slice) => `${(100 * slice.value / total).toFixed(1)}%`)
  const valueWidth = Math.max(...values.map((value) => value.length), shown(total).length)
  const shareWidth = Math.max(...shares.map((share) => share.length))
  const beside = width - diameter - 3
  const labelWant = Math.max(...slices.map((slice) => textWidth(slice.label)), "Total".length)
  const fixed = 2 + 2 + valueWidth + 2 + shareWidth
  // Beside the disc when even a short label fits there; below it, at the full width, otherwise.
  const side = beside >= fixed + Math.min(labelWant, 12)
  const labelWidth = Math.max(1, Math.min(labelWant, (side ? beside : width) - fixed))
  const cell = (text: string, cells: number) => `${truncateEnd(text, cells)}${" ".repeat(Math.max(0, cells - textWidth(truncateEnd(text, cells))))}`
  const legend: Line[] = [
    ...slices.map((slice, i): Line => [
      { text: `${DOT} `, fg: color(i) },
      { text: cell(slice.label, labelWidth), fg: "body" },
      { text: `  ${values[i]!.padStart(valueWidth)}`, fg: "body" },
      { text: `  ${shares[i]!.padStart(shareWidth)}`, fg: "muted" },
    ]),
    [{ text: `  ${cell("Total", labelWidth)}  ${shown(total).padStart(valueWidth)}`, fg: "muted" }],
  ]
  // A blank row under the title: the disc touches the top of its first row, and would sit against the title's letters.
  const head: Line[] = wrap(title, width).map((text) => [{ text, fg: "heading" }])
  if (!side) return { lines: [...head, [], ...disc.map(mark), [], ...legend] }
  // The legend is centred on the disc's height; one longer than the disc runs on below it, indented the same.
  const offset = Math.max(0, Math.floor((rows - legend.length) / 2))
  const body: Line[] = []
  for (let y = 0; y < Math.max(rows, offset + legend.length); y++) {
    const left: Line = disc[y] ?? [{ text: " ".repeat(diameter) }]
    const right = legend[y - offset]
    body.push(mark(right ? [...left, { text: "   " }, ...right] : left, y))
  }
  return { lines: [...head, [], ...body] }
}
