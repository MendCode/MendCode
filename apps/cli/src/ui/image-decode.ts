import type { PetImage } from "../pets/decode"
import { drainCooperatively, type Steps } from "./cooperate"
import { limitSide, limitSideSteps, resizeRgbaSteps } from "./image-fit"

/** Largest image the transcript fetches and decodes; a bigger attachment keeps its text card. */
export const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024

/** The formats the transcript can draw, by the bytes' own signature. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "gif" | "webp" | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif"
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp"
  return undefined
}

/**
 * The pixel size of a picture from its header, without decoding it; undefined when the header is not in `bytes`, or names a kind
 * the decoders here refuse (a 16-bit or interlaced PNG), so the caller decodes it to find out.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined)
  const kind = sniffImage(bytes)
  if (kind === "png") {
    // IHDR: width, height, bit depth 8, a color type the decoder reads, no interlace.
    if (bytes.length < 29 || bytes[24] !== 8 || ![0, 2, 3, 4, 6].includes(bytes[25]!) || bytes[28] !== 0) return undefined
    return found(view.getUint32(16), view.getUint32(20))
  }
  if (kind === "gif") return bytes.length >= 10 ? found(view.getUint16(6, true), view.getUint16(8, true)) : undefined
  if (kind === "jpeg") {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker === 0xff) { offset++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return found(view.getUint16(offset + 7), view.getUint16(offset + 5))
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  // WebP has three header layouts; it is rare in a transcript, so it is decoded to learn its size.
  return undefined
}

/** `decodeCardImage` scaled to `width` x `height` (the cells it is drawn in), as the transcript draws it. */
export async function renderCardImage(bytes: Uint8Array, width: number, height: number): Promise<PetImage> {
  const kept = await decodeCardImage(bytes)
  if (kept.width === width && kept.height === height) return kept
  return drainCooperatively(resizeRgbaSteps(kept, width, height))
}

/**
 * One image attachment as RGBA, at most `MAX_KEPT_SIDE` on its longest side. The decoders load on first use. PNG and JPEG decoding
 * and the shrinking run in slices of a few milliseconds with the event loop served between them, so several pictures in one
 * turn never freeze the terminal (a 3200x2400 photo took 300 ms in one block).
 */
export async function decodeCardImage(bytes: Uint8Array): Promise<PetImage> {
  const kind = sniffImage(bytes)
  if (!kind) throw new TypeError("[IMAGES]: unsupported image format")
  if (kind === "jpeg") return drainCooperatively(shrunk((await import("./jpeg")).decodeJpegSteps(bytes)))
  if (kind === "gif") return limitSide((await import("./gif")).decodeGif(bytes))
  if (kind === "png") {
    const { decodePngSteps } = await import("../../../../packages/tools/src/pet-decode")
    return drainCooperatively(shrunk(decodePngSteps(bytes)))
  }
  return limitSide(await (await import("../pets/decode")).decodeImageBytes(bytes))
}

function* shrunk(decoding: Steps<PetImage>): Steps<PetImage> {
  return yield* limitSideSteps(yield* decoding)
}
