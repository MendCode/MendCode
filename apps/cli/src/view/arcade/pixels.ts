import type { ColorName, Line, Span } from "../../ui/theme"

/** A pixel's colour; undefined shows the board. */
export type Pixel = ColorName | undefined

function runSpan(text: string, fg: Pixel, bg: ColorName, dim: boolean): Span {
  if (fg === undefined) return { text, bg }
  return dim ? { text, fg, bg, dim: true } : { text, fg, bg }
}

/**
 * Draws a field of square pixels with half blocks: each terminal row holds two pixel rows and each column one pixel,
 * so a pixel is as wide as it is tall on a terminal whose cells are twice as tall as wide. Runs of the same glyph and
 * colours share one span.
 */
export function pixelRows(input: { width: number; height: number; at: (x: number, y: number) => Pixel; board?: ColorName; dim?: boolean }): Line[] {
  const { width, height, at, board = "element", dim = false } = input
  const lines: Line[] = []
  for (let row = 0; row < height; row += 2) {
    const spans: Span[] = []
    // The run being built: one span is made per run of the same glyph and colours, not one per pixel.
    let text = ""
    let glyph = ""
    let fg: Pixel
    let bg: ColorName = board
    for (let x = 0; x < width; x++) {
      const top = at(x, row)
      const bottom = row + 1 < height ? at(x, row + 1) : undefined
      const nextGlyph = top === undefined ? (bottom === undefined ? " " : "▄") : top === bottom ? "█" : "▀"
      const nextFg = top ?? bottom
      const nextBg = nextGlyph === "▀" ? (bottom ?? board) : board
      if (text && nextGlyph === glyph && nextFg === fg && nextBg === bg) {
        text += glyph
        continue
      }
      if (text) spans.push(runSpan(text, fg, bg, dim))
      text = glyph = nextGlyph
      fg = nextFg
      bg = nextBg
    }
    if (text) spans.push(runSpan(text, fg, bg, dim))
    lines.push(spans)
  }
  return lines
}
