import type { ColorName, Line, Span } from "../../ui/theme"

/** A pixel's colour; undefined shows the board. */
export type Pixel = ColorName | undefined

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
    for (let x = 0; x < width; x++) {
      const top = at(x, row)
      const bottom = row + 1 < height ? at(x, row + 1) : undefined
      const span: Span =
        top === undefined ? (bottom === undefined ? { text: " ", bg: board } : { text: "▄", fg: bottom, bg: board })
        : top === bottom ? { text: "█", fg: top, bg: board }
        : { text: "▀", fg: top, bg: bottom ?? board }
      if (dim && span.fg) span.dim = true
      const last = spans.at(-1)
      if (last && last.fg === span.fg && last.bg === span.bg && last.dim === span.dim && last.text.endsWith(span.text)) last.text += span.text
      else spans.push(span)
    }
    lines.push(spans)
  }
  return lines
}
