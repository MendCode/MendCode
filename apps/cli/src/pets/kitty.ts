import { deflateSync } from "node:zlib"
import type { PetImage } from "./decode"

/** Kitty graphics protocol string builders (pure, no I/O). Every command carries q=2 so the terminal never answers on stdin. */
const APC = "\x1b_G"
const ST = "\x1b\\"

/** Base64 characters per chunk: the spec caps a chunk at 4096 and wants a multiple of 4 before the last one. */
export const KITTY_CHUNK = 4096

function apc(control: string, payload?: string) {
  return `${APC}${control}${payload === undefined ? "" : `;${payload}`}${ST}`
}

function positive(name: string, value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new RangeError(`[KITTY]: ${name} must be a positive 32-bit integer, got ${value}`)
}

/** Uploads an image without displaying it: RGBA8 (f=32), zlib-deflated (o=z), split in chunks of 4096 base64 characters. */
export function kittyTransmit({ imageId, image }: { imageId: number; image: PetImage }) {
  positive("imageId", imageId)
  positive("width", image.width)
  positive("height", image.height)
  if (image.rgba.length !== image.width * image.height * 4) {
    throw new RangeError(`[KITTY]: rgba has ${image.rgba.length} bytes, expected ${image.width * image.height * 4}`)
  }
  const data = Buffer.from(deflateSync(image.rgba)).toString("base64")
  let out = ""
  for (let start = 0; start < data.length; start += KITTY_CHUNK) {
    const more = start + KITTY_CHUNK < data.length ? 1 : 0
    const control = start === 0 ? `a=t,f=32,s=${image.width},v=${image.height},i=${imageId},o=z,q=2,m=${more}` : `m=${more}`
    out += apc(control, data.slice(start, start + KITTY_CHUNK))
  }
  return out
}

/**
 * Displays an uploaded image at the cursor cell, scaled to `cols` x `rows` cells; the cursor does not move (C=1). Same image and placement id replaces in place.
 * `band` shows only those pixel rows of the image (a picture partly scrolled out of view), at its full width.
 */
export function kittyPlace({ imageId, placementId, cols, rows, band }: { imageId: number; placementId: number; cols: number; rows: number; band?: { y: number; height: number } }) {
  positive("imageId", imageId)
  positive("placementId", placementId)
  positive("cols", cols)
  positive("rows", rows)
  if (band) {
    if (!Number.isInteger(band.y) || band.y < 0) throw new RangeError(`[KITTY]: band.y must be a non-negative integer, got ${band.y}`)
    positive("band.height", band.height)
  }
  return apc(`a=p,i=${imageId},p=${placementId},${band ? `y=${band.y},h=${band.height},` : ""}c=${cols},r=${rows},C=1,q=2`)
}

/**
 * Deletes by scope: image and placement -> that placement only (data kept); image only -> the image, its placements and its data (d=I);
 * nothing -> every placement on screen and their data (d=A).
 */
export function kittyDelete({ imageId, placementId }: { imageId?: number | undefined; placementId?: number | undefined } = {}) {
  if (imageId === undefined) {
    if (placementId !== undefined) throw new TypeError("[KITTY]: a placement id needs its image id")
    return apc("a=d,d=A,q=2")
  }
  positive("imageId", imageId)
  if (placementId === undefined) return apc(`a=d,d=I,i=${imageId},q=2`)
  positive("placementId", placementId)
  return apc(`a=d,d=i,i=${imageId},p=${placementId},q=2`)
}
