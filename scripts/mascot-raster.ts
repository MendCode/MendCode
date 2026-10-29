/**
 * Terminal rows as a picture: every cell of the real render output (theme spans with their colors) becomes a block of
 * pixels. Block letters and the mascot's half blocks are exact; other text is set in a 5 x 7 bitmap font, and a glyph
 * the font does not have is drawn as a small square. Used by `render-mascot-docs.ts` for the images under docs/assets.
 */
import type { ColorName, Line } from "../apps/cli/src/ui/theme"

export type Raster = { width: number; height: number; rgba: Uint8Array }
export type RasterTheme = { background: string; colors: Readonly<Record<string, string>> }

/** One cell is `CELL` pixels wide and twice as tall, so half a cell is a square pixel of the sprite. */
export const CELL = 12

// Rows of five bits, top to bottom.
const FONT: Record<string, string> = {
  A: "0E11111F111111", B: "1E11111E11111E", C: "0E11101010110E", D: "1E11111111111E", E: "1F10101E10101F", F: "1F10101E101010", G: "0E11101711110F",
  H: "1111111F111111", I: "0E04040404040E", J: "0702020202120C", K: "11121418141211", L: "1010101010101F", M: "111B1515111111", N: "11191513111111",
  O: "0E11111111110E", P: "1E11111E101010", Q: "0E11111115120D", R: "1E11111E141211", S: "0F10100E01011E", T: "1F040404040404", U: "1111111111110E",
  V: "11111111110A04", W: "11111115151B11", X: "11110A040A1111", Y: "11110A04040404", Z: "1F01020408101F",
  a: "00000E010F110F", b: "10101E1111111E", c: "00000E1010110E", d: "01010F1111110F", e: "00000E111F100E", f: "0609081C080808", g: "000F11110F010E",
  h: "10101619111111", i: "04000C0404040E", j: "0200060202120C", k: "10101214181412", l: "0C04040404040E", m: "00001A15151111", n: "00001619111111",
  o: "00000E1111110E", p: "001E11111E1010", q: "000F11110F0101", r: "00001619101010", s: "00000F100E011E", t: "08081C08080906", u: "0000111111130D",
  v: "00001111110A04", w: "0000111115150A", x: "0000110A040A11", y: "001111110F010E", z: "00001F0204081F",
  "0": "0E11131519110E", "1": "040C040404040E", "2": "0E11010204081F", "3": "1F02040201110E", "4": "02060A121F0202", "5": "1F101E0101110E",
  "6": "0608101E11110E", "7": "1F010204080808", "8": "0E11110E11110E", "9": "0E11110F01020C",
  ".": "00000000000C0C", ",": "000000000C0408", ":": "000C0C000C0C00", "-": "0000001F000000", _: "0000000000001F", "/": "00010204081000",
  "\\": "00100804020100", "~": "00000815020000", "(": "02040808080402", ")": "08040202020408", "[": "0E08080808080E", "]": "0E02020202020E",
  "+": "0004041F040400", "|": "04040404040404", "^": "040A1100000000", "'": "04040800000000", "`": "08040200000000", "!": "04040404040004",
  "?": "0E110102040004", ">": "08040201020408", "<": "02040810080402", "=": "00001F001F0000", "*": "0004150E150400", "#": "0A0A1F0A1F0A0A",
  "@": "0E11010D15150E", "%": "18190204081303", '"': "0A0A0A00000000", "·": "00000004000000", "…": "00000000001500", "●": "000E1F1F1F0E00",
  "❭": "08040201020408", "❯": "08040201020408", "•": "0000000E0E0000",
}

/** Which arms a box-drawing glyph has: up, right, down, left. */
const BOX: Record<string, string> = { "─": "0101", "│": "1010", "┌": "0110", "┐": "0011", "└": "1100", "┘": "1001", "├": "1110", "┤": "1011", "┬": "0111", "┴": "1101", "┼": "1111", "╭": "0110", "╮": "0011", "╰": "1100", "╯": "1001", "┃": "1010", "━": "0101" }

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]

/** The xterm 256-color cell a terminal without truecolor shows for `hex` (the mapping of `ui/theme.ts`). */
export function to256Hex(hex: string): string {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return `#${rgb(hex).map((v) => (level(v) === 0 ? 0 : 55 + 40 * level(v)).toString(16).padStart(2, "0")).join("")}`
}

export function rasterLines(lines: readonly Line[], input: { cols: number; rows: number; theme: RasterTheme; depth?: "truecolor" | "256"; cell?: number }): Raster {
  const cell = input.cell ?? CELL
  const [cw, ch] = [cell, cell * 2]
  const out: Raster = { width: input.cols * cw, height: input.rows * ch, rgba: new Uint8Array(input.cols * cw * input.rows * ch * 4) }
  const shade = (hex: string) => (input.depth === "256" ? to256Hex(hex) : hex)
  const fill = (x: number, y: number, w: number, h: number, hex: string) => {
    const [r, g, b] = rgb(hex)
    for (let py = Math.max(0, y); py < Math.min(out.height, y + h); py++) for (let px = Math.max(0, x); px < Math.min(out.width, x + w); px++) out.rgba.set([r, g, b, 255], (py * out.width + px) * 4)
  }
  fill(0, 0, out.width, out.height, shade(input.theme.background))
  const role = (name: ColorName | undefined, fallback: string) => (name ? input.theme.colors[name] ?? fallback : fallback)
  for (let row = 0; row < Math.min(input.rows, lines.length); row++) {
    let col = 0
    for (const span of lines[row]!) {
      const fg = shade(span.fgHex ?? role(span.fg, input.theme.colors.text!))
      const bg = span.bgHex ?? (span.bg ? role(span.bg, input.theme.background) : undefined)
      for (const char of span.text) {
        if (col >= input.cols) break
        const [x, y] = [col * cw, row * ch]
        if (bg) fill(x, y, cw, ch, shade(bg))
        if (char === "█") fill(x, y, cw, ch, fg)
        else if (char === "▀") fill(x, y, cw, cw, fg)
        else if (char === "▄") fill(x, y + cw, cw, cw, fg)
        else if (BOX[char]) {
          const [up, right, down, left] = [...BOX[char]!].map((arm) => arm === "1")
          const [mx, my, t] = [x + Math.floor(cw / 2), y + cw, Math.max(1, Math.floor(cell / 8))]
          if (up) fill(mx, y, t, cw, fg)
          if (down) fill(mx, my, t, cw, fg)
          if (left) fill(x, my, Math.floor(cw / 2) + t, t, fg)
          if (right) fill(mx, my, cw - Math.floor(cw / 2), t, fg)
        } else if (char !== " ") {
          const glyph = FONT[char]
          const dot = Math.max(1, Math.floor(cw / 6))
          const [left, top] = [x + Math.floor((cw - 5 * dot) / 2), y + Math.floor((ch - 7 * dot) / 2)]
          if (!glyph) fill(x + Math.floor(cw / 2) - dot, y + cw - dot, dot * 2, dot * 2, fg)
          else for (let gy = 0; gy < 7; gy++) {
            const bits = Number.parseInt(glyph.slice(gy * 2, gy * 2 + 2), 16)
            for (let gx = 0; gx < 5; gx++) if (bits & (16 >> gx)) fill(left + gx * dot, top + gy * dot, dot, dot, span.dim ? shade(role("muted", fg)) : fg)
          }
        }
        col++
      }
    }
  }
  return out
}

/**
 * What an image protocol shows over the text grid: `image` alpha-blended into the box of cells at `at` (rows and columns of
 * the raster made with the same `cell`). The image is the one the image layer would send; a size other than the box's
 * pixels is fitted by repeating or skipping pixels, as the layer's integer scaling does.
 */
export function overlayImage(out: Raster, image: { width: number; height: number; rgba: Uint8Array }, at: { row: number; col: number; cols: number; rows: number }, cell = CELL) {
  const [left, top, width, height] = [at.col * cell, at.row * cell * 2, at.cols * cell, at.rows * cell * 2]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.min(image.height - 1, Math.floor(y * image.height / height)) * image.width + Math.min(image.width - 1, Math.floor(x * image.width / width))) * 4
    const alpha = image.rgba[from + 3]! / 255
    const [px, py] = [left + x, top + y]
    if (alpha === 0 || px < 0 || py < 0 || px >= out.width || py >= out.height) continue
    const to = (py * out.width + px) * 4
    for (let channel = 0; channel < 3; channel++) out.rgba[to + channel] = Math.round(image.rgba[from + channel]! * alpha + out.rgba[to + channel]! * (1 - alpha))
  }
  return out
}

/** Pictures side by side on one background, `gap` pixels apart. */
export function rasterRow(parts: readonly Raster[], gap: number, background: string): Raster {
  const height = Math.max(...parts.map((part) => part.height))
  const width = parts.reduce((sum, part) => sum + part.width, 0) + gap * (parts.length - 1)
  const out: Raster = { width, height, rgba: new Uint8Array(width * height * 4) }
  const [r, g, b] = rgb(background)
  for (let at = 0; at < width * height; at++) out.rgba.set([r, g, b, 255], at * 4)
  let x = 0
  for (const part of parts) {
    for (let y = 0; y < part.height; y++) out.rgba.set(part.rgba.subarray(y * part.width * 4, (y + 1) * part.width * 4), (y * width + x) * 4)
    x += part.width + gap
  }
  return out
}
