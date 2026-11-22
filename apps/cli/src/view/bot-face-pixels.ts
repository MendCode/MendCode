import type { BotShape } from "../../../../packages/packages/src/agents"
import type { Span } from "../ui/theme"
import { faceFrameCount, type FaceState } from "./bot-face-anim"
import type { EyeStyle, MouthStyle } from "./bot-face-image"

/**
 * Experimental bots: the pixel-art face drawn with half-block characters, the text a terminal that cannot draw images shows. It is the
 * same character as the generated picture (`bot-face-image.ts`): the body in the bot's color role, black eyes, a mouth for the state and
 * a small mark (sleep, thought). A cell is two pixels stacked, so the 9 by 4 cells of a card are 9 by 8 pixels, which are square in a
 * cell that is twice as tall as wide. Pure data and arithmetic: the colors arrive resolved from the theme.
 */
export const PIXEL_COLS = 9
export const PIXEL_ROWS = 8

/** Nothing, the body, or the ink of the eyes, mouth and mark. */
export type Pixel = 0 | 1 | 2
export type PixelGrid = Pixel[][]
type Point = readonly [number, number]

/** The body of each shape, one string a row of pixels. */
const BODIES: Record<BotShape, readonly string[]> = {
  circle: ["...###...", ".#######.", "#########", "#########", "#########", "#########", ".#######.", "...###..."],
  square: [".#######.", "#########", "#########", "#########", "#########", "#########", "#########", ".#######."],
  hexagon: ["..#####..", ".#######.", "#########", "#########", "#########", "#########", ".#######.", "..#####.."],
  diamond: ["....#....", "...###...", "..#####..", "#########", "#########", "..#####..", "...###...", "....#...."],
  triangle: ["....#....", "...###...", "...###...", "..#####..", ".#######.", ".#######.", "#########", "#########"],
}

/** The row of the eyes and of the mouth, and where the state's mark sits; a triangle is narrow at the top, so its face sits lower. */
const GEOMETRY: Record<BotShape, { eye: number; mouth: number; mark: Point }> = {
  circle: { eye: 3, mouth: 5, mark: [7, 1] },
  square: { eye: 3, mouth: 5, mark: [7, 1] },
  hexagon: { eye: 3, mouth: 5, mark: [7, 1] },
  diamond: { eye: 3, mouth: 5, mark: [6, 2] },
  triangle: { eye: 4, mouth: 6, mark: [5, 2] },
}

export type PixelFaceInput = { shape: BotShape; eyes: EyeStyle; mouth: MouthStyle; state: FaceState; frame: number }

/** The left eye's pixels; the right eye is its mirror. */
function leftEye({ state, eyes }: Pick<PixelFaceInput, "state" | "eyes">, row: number): Point[] {
  if (state === "sleeping") return [[2, row + 1], [3, row + 1]]
  if (state === "problem") return [[2, row], [3, row + 1]]
  if (state === "listening") return eyes === "round" ? [[3, row - 1], [2, row], [3, row]] : [[2, row - 1], [3, row - 1], [2, row], [3, row]]
  return eyes === "round" ? [[2, row]] : eyes === "diamond" ? [[2, row - 1], [2, row]] : [[2, row], [3, row]]
}

function mouthPixels({ state, mouth, frame }: Pick<PixelFaceInput, "state" | "mouth" | "frame">, row: number): Point[] {
  const flat: Point[] = [[3, row], [4, row], [5, row]]
  if (state === "talking") return frame === 0 ? [...flat, [3, row + 1], [4, row + 1], [5, row + 1]] : [[4, row], [4, row + 1]]
  if (state === "waiting") return [[2, row], [4, row], [6, row]]
  if (state === "problem") return [[4, row], [3, row + 1], [5, row + 1]]
  // A sleeper's head droops: the eyes and the flat mouth both sit one pixel lower, with a pixel of body between them.
  if (state === "sleeping") return flat.map(([x, y]): Point => [x, y + 1])
  if (mouth === "flat") return flat
  return mouth === "small" ? [[4, row]] : [[3, row], [5, row], [4, row + 1]]
}

function markPixels({ state, frame }: Pick<PixelFaceInput, "state" | "frame">, [x, y]: Point): Point[] {
  if (state === "sleeping") return frame === 0 ? [[x, y]] : [[x, y], [x - 1, y]]
  if (state === "thinking") return frame === 0 ? [[x, y]] : [[x, y], [x - 1, y], [x, y + 1], [x - 1, y + 1]]
  return []
}

/** The face as a grid of pixels (0 nothing, 1 body, 2 ink). The same input always gives the same grid. */
export function pixelFace(input: PixelFaceInput): PixelGrid {
  const grid: PixelGrid = BODIES[input.shape].map((row) => [...row].map((char): Pixel => (char === "#" ? 1 : 0)))
  const frame = input.frame % faceFrameCount(input.state)
  const { eye, mouth, mark } = GEOMETRY[input.shape]
  const ink = ([x, y]: Point) => {
    if (grid[y]?.[x] === 1) grid[y]![x] = 2
  }
  for (const point of leftEye(input, eye)) {
    ink(point)
    ink([PIXEL_COLS - 1 - point[0], point[1]])
  }
  mouthPixels({ ...input, frame }, mouth).forEach(ink)
  markPixels({ ...input, frame }, mark).forEach(ink)
  return grid
}

/** The colors of a face, already resolved from the theme: `body` for the shape and `pen` for the eyes, mouth and mark. */
export type PixelPalette = { body: string; pen: string }

const luminance = (hex: string) => (0.2126 * Number.parseInt(hex.slice(1, 3), 16) + 0.7152 * Number.parseInt(hex.slice(3, 5), 16) + 0.0722 * Number.parseInt(hex.slice(5, 7), 16)) / 255

/** Black ink, or white when the body is too dark for black to read: the rule of the generated picture. */
export const penFor = (body: string): string => (luminance(body) < 0.18 ? "#ffffff" : "#000000")

/** One cell from the two pixels stacked in it. */
function cell({ top, bottom, palette }: { top: Pixel; bottom: Pixel; palette: PixelPalette }): Span {
  const color = (pixel: Pixel) => (pixel === 2 ? palette.pen : palette.body)
  if (top === 0 && bottom === 0) return { text: " " }
  if (top === bottom) return { text: "█", fgHex: color(top) }
  if (top === 0) return { text: "▄", fgHex: color(bottom) }
  if (bottom === 0) return { text: "▀", fgHex: color(top) }
  return { text: "▀", fgHex: color(top), bgHex: color(bottom) }
}

/** Neighbouring cells with the same colors become one span. */
function joined(cells: Span[]): Span[] {
  const spans: Span[] = []
  for (const next of cells) {
    const tail = spans[spans.length - 1]
    if (tail && tail.fgHex === next.fgHex && tail.bgHex === next.bgHex) tail.text += next.text
    else spans.push({ ...next })
  }
  return spans
}

/** The grid as terminal rows of half blocks: two pixel rows to a text row. */
export function halfBlockText({ grid, palette }: { grid: PixelGrid; palette: PixelPalette }): Span[][] {
  const lines: Span[][] = []
  for (let y = 0; y < grid.length; y += 2) {
    lines.push(joined(grid[y]!.map((top, x) => cell({ top, bottom: grid[y + 1]?.[x] ?? 0, palette }))))
  }
  return lines
}

type Cell = "none" | "top" | "bottom" | "both"
/** The two-cell icon: two cells of two pixels cannot hold a shape, so they hold the state, each state with its own pair of blocks. */
const ICON: Record<FaceState, readonly (readonly [Cell, Cell])[]> = {
  sleeping: [["bottom", "bottom"], ["bottom", "none"]],
  listening: [["top", "top"]],
  thinking: [["top", "both"], ["both", "top"]],
  talking: [["bottom", "top"], ["top", "bottom"]],
  waiting: [["none", "bottom"]],
  problem: [["none", "none"]],
}

export function iconSpans({ state, frame, palette }: { state: FaceState; frame: number; palette: PixelPalette }): Span[] {
  const frames = ICON[state]
  const pair = frames[frame % frames.length]!
  const pixels: Record<Cell, [Pixel, Pixel]> = { none: [1, 1], top: [2, 1], bottom: [1, 2], both: [2, 2] }
  return joined(pair.map((kind) => cell({ top: pixels[kind][0], bottom: pixels[kind][1], palette })))
}
