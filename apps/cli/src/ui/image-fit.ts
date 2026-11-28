import type { PetImage } from "../pets/decode"
import type { CellPixels } from "../pets/frames"
import { drain, type Steps } from "./cooperate"
import { resizeRgbaSteps } from "../../../../packages/tools/src/image-resize"

export { resizeRgba, resizeRgbaSteps } from "../../../../packages/tools/src/image-resize"

/** Longest side a decoded transcript image is kept at: a screenshot never costs more than a few MB of RGBA. */
export const MAX_KEPT_SIDE = 1280

/** The pixel size `limitSide` keeps a picture of `source` pixels at. */
export function keptSize(source: { width: number; height: number }, side = MAX_KEPT_SIDE): { width: number; height: number } {
  const longest = Math.max(source.width, source.height)
  if (longest <= side) return { width: source.width, height: source.height }
  const factor = side / longest
  return { width: Math.max(1, Math.round(source.width * factor)), height: Math.max(1, Math.round(source.height * factor)) }
}

/** `source` shrunk (never enlarged) so its longest side is at most `side`. */
export function limitSide(source: PetImage, side = MAX_KEPT_SIDE): PetImage {
  return drain(limitSideSteps(source, side))
}

/** `limitSide` as steps. */
export function* limitSideSteps(source: PetImage, side = MAX_KEPT_SIDE): Steps<PetImage> {
  const kept = keptSize(source, side)
  return kept.width === source.width && kept.height === source.height ? source : yield* resizeRgbaSteps(source, kept.width, kept.height)
}

export type ImageBox = { cols: number; rows: number; width: number; height: number }

/**
 * The cells an image of `source` pixels takes inside `maxCols` columns and `maxRows` rows, keeping its shape and never enlarging it,
 * and the pixel size to draw it at (always inside the cells).
 */
export function fitImage({ source, maxCols, maxRows, cell }: { source: Pick<PetImage, "width" | "height">; maxCols: number; maxRows: number; cell: CellPixels }): ImageBox {
  let width = Math.min(Math.max(1, maxCols) * cell.width, source.width)
  let height = (source.height * width) / source.width
  if (height > Math.max(1, maxRows) * cell.height) {
    height = Math.max(1, maxRows) * cell.height
    width = (source.width * height) / source.height
  }
  const pixelWidth = Math.max(1, Math.round(width))
  const pixelHeight = Math.max(1, Math.round(height))
  return { cols: Math.max(1, Math.min(maxCols, Math.ceil(pixelWidth / cell.width))), rows: Math.max(1, Math.min(maxRows, Math.ceil(pixelHeight / cell.height))), width: pixelWidth, height: pixelHeight }
}
