import type { Line, Span } from "../ui/theme"
import type { PetImage } from "./decode"
import { scale, groundPixels } from "./frames"

/** Pixels with at least this alpha (50%) count as opaque; the rest show the row background. */
export const ALPHA_THRESHOLD = 128

const hex = (rgba: Uint8Array, i: number) => `#${[0, 1, 2].map((k) => rgba[i + k]!.toString(16).padStart(2, "0")).join("")}`

/**
 * Draws an image as `rows` lines of `cols` half-block cells (top pixel = foreground of `▀`, bottom pixel = background).
 * An image that is not exactly `cols` x `rows * 2` pixels uses the shared integer nearest-neighbour fit first. Pure: no terminal I/O.
 */
export function toHalfBlocks(image: PetImage, cols: number, rows: number, align?: "bottom"): Line[] {
  const scaled = image.width === cols && image.height === rows * 2 ? image : scale(image, cols, rows)
  const pixels = align === "bottom" ? groundPixels(scaled) : scaled
  const lines: Line[] = []
  for (let row = 0; row < rows; row++) {
    const line: Span[] = []
    for (let col = 0; col < cols; col++) {
      const top = (row * 2 * cols + col) * 4
      const bottom = top + cols * 4
      const hasTop = pixels.rgba[top + 3]! >= ALPHA_THRESHOLD
      const hasBottom = pixels.rgba[bottom + 3]! >= ALPHA_THRESHOLD
      const cell: Span = hasTop && hasBottom ? { text: "▀", fgHex: hex(pixels.rgba, top), bgHex: hex(pixels.rgba, bottom) } : hasTop ? { text: "▀", fgHex: hex(pixels.rgba, top) } : hasBottom ? { text: "▄", fgHex: hex(pixels.rgba, bottom) } : { text: " " }
      const last = line[line.length - 1]
      if (last && last.fgHex === cell.fgHex && last.bgHex === cell.bgHex) last.text += cell.text
      else line.push(cell)
    }
    lines.push(line)
  }
  return lines
}
