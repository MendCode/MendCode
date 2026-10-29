import type { PetState } from "../../../../packages/protocol/src/pet-data"
import type { PetImage } from "./decode"

export const PET_ROWS = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"] as const
/** A row of the Codex atlas. */
export type AtlasRow = (typeof PET_ROWS)[number]
/** What a pet can show: an atlas row, or a state only an imported pet brings. */
export type PetRow = AtlasRow | PetState
type ExtraRow = Exclude<PetRow, AtlasRow>

/** The row that shows when a pet lacks one of the states only an import brings; a pet without that one shows idle, as for any row it lacks. */
export const PET_ROW_FALLBACK: Record<ExtraRow, AtlasRow> = { thinking: "running", compacting: "running", agents: "running", sleeping: "idle" }

/** `row`, or the row that stands in for it when `has` says the pet lacks it. */
export function rowOrFallback(row: PetRow, has: (row: PetRow) => boolean): PetRow {
  return has(row) ? row : (PET_ROW_FALLBACK as Partial<Record<PetRow, AtlasRow>>)[row] ?? row
}

export const ATLAS_COLUMNS = 8

/** Frame counts per row (the used columns; the rest of the row is transparent). */
export const PET_FRAME_COUNTS: Record<AtlasRow, number> = { idle: 6, "running-right": 8, "running-left": 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6, review: 6 }

const uniform = (count: number, each: number, last: number) => Array.from({ length: count }, (_, i) => (i === count - 1 ? last : each))

/** Milliseconds each frame stays on screen (Codex animation-rows: a shorter body, a longer final frame). */
export const PET_FRAME_DURATIONS: Record<AtlasRow, readonly number[]> = {
  idle: [280, 110, 110, 140, 140, 320],
  "running-right": uniform(8, 120, 220),
  "running-left": uniform(8, 120, 220),
  waving: uniform(4, 140, 280),
  jumping: uniform(5, 140, 280),
  failed: uniform(8, 140, 240),
  waiting: uniform(6, 150, 260),
  running: uniform(6, 120, 220),
  review: uniform(6, 150, 280),
}

export type AtlasGrid = { columns: number; rows: number; cellWidth: number; cellHeight: number }

/** 8 columns by 9 rows (v1) or 11 rows (v2, look directions). Anything that does not divide evenly is not an atlas. */
export function atlasGrid(sheet: Pick<PetImage, "width" | "height">): AtlasGrid {
  const { width, height } = sheet
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width % ATLAS_COLUMNS !== 0) throw new Error("invalid atlas")
  const rows = height % PET_ROWS.length === 0 ? PET_ROWS.length : height % 11 === 0 ? 11 : 0
  if (rows === 0) throw new Error("invalid atlas")
  return { columns: ATLAS_COLUMNS, rows, cellWidth: width / ATLAS_COLUMNS, cellHeight: height / rows }
}

/** Native atlas cell, including transparent margins. All states share the same raster geometry. */
export function frame(sheet: PetImage, row: AtlasRow, index: number): PetImage {
  const grid = atlasGrid(sheet)
  if (!Number.isInteger(index) || index < 0 || index >= PET_FRAME_COUNTS[row]) throw new RangeError(`[PETS]: frame ${index} is outside row ${row}`)
  const rowIndex = PET_ROWS.indexOf(row)
  if (rowIndex < 0) throw new RangeError(`[PETS]: unknown row ${String(row)}`)
  const rgba = new Uint8Array(grid.cellWidth * grid.cellHeight * 4)
  const left = index * grid.cellWidth
  const top = rowIndex * grid.cellHeight
  for (let y = 0; y < grid.cellHeight; y++) {
    const from = ((top + y) * sheet.width + left) * 4
    rgba.set(sheet.rgba.subarray(from, from + grid.cellWidth * 4), y * grid.cellWidth * 4)
  }
  return { width: grid.cellWidth, height: grid.cellHeight, rgba }
}

/** Every frame of a row, so a caller can keep them and drop the (large) sheet. */
export function rowFrames(sheet: PetImage, row: AtlasRow): PetImage[] {
  return Array.from({ length: PET_FRAME_COUNTS[row] }, (_, index) => frame(sheet, row, index))
}

export type CellPixels = { width: number; height: number }
/** Used only when neither the host nor the terminal reports its geometry. */
export const DEFAULT_CELL_PIXELS: CellPixels = { width: 8, height: 16 }
export const HALF_BLOCK_PIXELS: CellPixels = { width: 1, height: 2 }
export type PixelFit = { scale: number; divisor: number; width: number; height: number; x: number; y: number }

/** Integer enlargement, or an exact integer divisor only when 1× cannot fit. No aspect rounding. */
export function pixelFit(source: Pick<PetImage, "width" | "height">, width: number, height: number): PixelFit | undefined {
  if (![width, height, source.width, source.height].every((n) => Number.isInteger(n) && n > 0)) throw new RangeError("[PETS]: invalid pixel size")
  const scale = Math.floor(Math.min(width / source.width, height / source.height))
  let divisor = 1
  if (scale === 0) {
    divisor = Math.ceil(Math.max(source.width / width, source.height / height))
    while (divisor <= Math.min(source.width, source.height) && (source.width % divisor !== 0 || source.height % divisor !== 0)) divisor++
    if (source.width % divisor !== 0 || source.height % divisor !== 0) return undefined
  }
  const w = source.width * Math.max(1, scale) / divisor
  const h = source.height * Math.max(1, scale) / divisor
  return { scale: Math.max(1, scale), divisor, width: w, height: h, x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2) }
}

/** Shared by preview, chat and half blocks: the target box in cells, rasterized using its cell geometry. */
export function sizePet(source: PetImage, cols: number, rows: number, cellPixels: CellPixels = DEFAULT_CELL_PIXELS, align?: "bottom"): PetImage {
  const pixels = scalePixels(source, cols * cellPixels.width, rows * cellPixels.height)
  return align === "bottom" ? groundPixels(pixels) : pixels
}

export function scale(source: PetImage, cols: number, rows: number): PetImage {
  return sizePet(source, cols, rows, HALF_BLOCK_PIXELS)
}

/** Centered transparent letterbox. Every output pixel is a byte-for-byte source pixel or transparent padding. */
export function scalePixels(source: PetImage, width: number, height: number): PetImage {
  const fit = pixelFit(source, width, height)
  const rgba = new Uint8Array(width * height * 4)
  if (!fit) return { width, height, rgba }
  for (let y = 0; y < fit.height; y++) {
    for (let x = 0; x < fit.width; x++) {
      const from = (Math.floor(y / fit.scale) * fit.divisor * source.width + Math.floor(x / fit.scale) * fit.divisor) * 4
      rgba.set(source.rgba.subarray(from, from + 4), ((fit.y + y) * width + fit.x + x) * 4)
    }
  }
  return { width, height, rgba }
}

/** Bottom-align opaque pixels within the same canvas so the pet stands on the prompt. */
export function groundPixels(image: PetImage): PetImage {
  let last = -1
  for (let y = image.height - 1; y >= 0 && last < 0; y--) for (let x = 0; x < image.width; x++) if (image.rgba[(y * image.width + x) * 4 + 3]! >= 128) { last = y; break }
  if (last < 0 || last === image.height - 1) return image
  const rgba = new Uint8Array(image.rgba.length)
  rgba.set(image.rgba.subarray(0, (last + 1) * image.width * 4), (image.height - last - 1) * image.width * 4)
  return { ...image, rgba }
}
