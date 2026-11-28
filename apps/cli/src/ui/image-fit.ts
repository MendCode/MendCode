import type { PetImage } from "../pets/decode"
import type { CellPixels } from "../pets/frames"
import { drain, type Steps } from "./cooperate"

/** Longest side a decoded transcript image is kept at: a screenshot never costs more than a few MB of RGBA. */
export const MAX_KEPT_SIDE = 1280

/** Area-averaging resize (alpha-weighted, so a transparent edge never bleeds its color); enlarging repeats the nearest pixel. */
export function resizeRgba(source: PetImage, width: number, height: number): PetImage {
  return drain(resizeRgbaSteps(source, width, height))
}

/** `resizeRgba` as steps (one output row each), so a big picture can be scaled without holding the event loop. */
export function* resizeRgbaSteps(source: PetImage, width: number, height: number): Steps<PetImage> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`[IMAGES]: invalid size ${width}x${height}`)
  if (width === source.width && height === source.height) return source
  const rgba = new Uint8Array(width * height * 4)
  const lefts = new Int32Array(width)
  const rights = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * source.width) / width)
    lefts[x] = from
    rights[x] = Math.max(from + 1, Math.ceil(((x + 1) * source.width) / width))
  }
  // A picture with no see-through pixel (a screenshot, a photo) is averaged straight from 32-bit reads, with no alpha weights.
  const solid = isOpaque(source) ? new Uint32Array(source.rgba.buffer, source.rgba.byteOffset, source.width * source.height) : undefined
  for (let y = 0; y < height; y++) {
    const top = Math.floor((y * source.height) / height)
    const bottom = Math.max(top + 1, Math.ceil(((y + 1) * source.height) / height))
    for (let x = 0; x < width; x++) {
      const left = lefts[x]!
      const right = rights[x]!
      const out = (y * width + x) * 4
      let r = 0
      let g = 0
      let b = 0
      if (solid) {
        for (let sy = top; sy < bottom; sy++) {
          for (let at = sy * source.width + left, end = sy * source.width + right; at < end; at++) {
            const pixel = solid[at]!
            r += pixel & 255
            g += (pixel >>> 8) & 255
            b += (pixel >>> 16) & 255
          }
        }
        const count = (bottom - top) * (right - left)
        rgba[out] = Math.round(r / count)
        rgba[out + 1] = Math.round(g / count)
        rgba[out + 2] = Math.round(b / count)
        rgba[out + 3] = 255
        continue
      }
      let a = 0
      for (let sy = top; sy < bottom; sy++) {
        let at = (sy * source.width + left) * 4
        for (let sx = left; sx < right; sx++, at += 4) {
          const alpha = source.rgba[at + 3]!
          r += source.rgba[at]! * alpha
          g += source.rgba[at + 1]! * alpha
          b += source.rgba[at + 2]! * alpha
          a += alpha
        }
      }
      if (a > 0) {
        rgba[out] = Math.round(r / a)
        rgba[out + 1] = Math.round(g / a)
        rgba[out + 2] = Math.round(b / a)
      }
      rgba[out + 3] = Math.round(a / ((bottom - top) * (right - left)))
    }
    yield
  }
  return { width, height, rgba }
}

/** Whether every pixel is opaque, by one 32-bit read each; a picture with a see-through pixel stops at the first. Little-endian: alpha is the top byte. */
function isOpaque(source: PetImage): boolean {
  if (source.rgba.byteOffset % 4 !== 0 || source.rgba.length !== source.width * source.height * 4) return false
  const pixels = new Uint32Array(source.rgba.buffer, source.rgba.byteOffset, source.width * source.height)
  for (let at = 0; at < pixels.length; at++) if (pixels[at]! >>> 24 !== 255) return false
  return true
}

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
