import type { PetImage } from "../pets/decode"
import { limitSide } from "./image-fit"

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

/** One image attachment as RGBA, at most `MAX_KEPT_SIDE` on its longest side. The decoders load on first use. */
export async function decodeCardImage(bytes: Uint8Array): Promise<PetImage> {
  const kind = sniffImage(bytes)
  if (!kind) throw new TypeError("[IMAGES]: unsupported image format")
  if (kind === "jpeg") return limitSide((await import("./jpeg")).decodeJpeg(bytes))
  if (kind === "gif") return limitSide((await import("./gif")).decodeGif(bytes))
  return limitSide(await (await import("../pets/decode")).decodeImageBytes(bytes))
}
