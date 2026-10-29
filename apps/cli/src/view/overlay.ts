import type { Line, Span } from "../ui/theme"
import { cells } from "./wrap"

/** The spans of `line` covering cells [from, to), split at cell boundaries; a wide cell cut in half becomes a space. */
export function slice(line: Line, from: number, to: number): Line {
  const out: Line = []
  let at = 0
  for (const span of line) {
    let text = ""
    for (const cell of cells(span.text)) {
      const end = at + cell.width
      if (at >= from && end <= to) text += cell.text
      else if (at < to && end > from) text += " ".repeat(Math.min(end, to) - Math.max(at, from))
      at = end
      if (at >= to) break
    }
    if (text) out.push({ ...span, text })
    if (at >= to) break
  }
  return out
}

/**
 * Paints `box` over `base` with its top-left cell at (`row`, `col`): each covered row keeps the base's cells left
 * and right of the box. Rows or cells outside the screen are dropped. `base` is not modified.
 */
export function overlayLines(base: readonly Line[], box: readonly Line[], at: { row: number; col: number }, width: number): Line[] {
  const out = base.map((line) => line)
  box.forEach((boxLine, index) => {
    const y = at.row + index
    if (y < 0 || y >= out.length) return
    const boxWidth = boxLine.reduce((sum, span) => sum + [...cells(span.text)].reduce((w, c) => w + c.width, 0), 0)
    const start = Math.max(0, at.col)
    const end = Math.min(width, at.col + boxWidth)
    if (end <= start) return
    const under = out[y]!
    const left = slice(under, 0, start)
    const pad = Math.max(0, start - left.reduce((w, s) => w + [...cells(s.text)].reduce((a, c) => a + c.width, 0), 0))
    const shown = slice(boxLine, start - at.col, end - at.col)
    const right = slice(under, end, width)
    out[y] = [...left, ...(pad ? [{ text: " ".repeat(pad) } satisfies Span] : []), ...shown, ...right]
  })
  return out
}
