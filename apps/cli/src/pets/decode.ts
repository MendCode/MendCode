import { readFile } from "node:fs/promises"
import { decodePng } from "../../../../packages/tools/src/pet-decode"
export { decodePng } from "../../../../packages/tools/src/pet-decode"

/** Straight (non-premultiplied) RGBA8, row-major, `width * height * 4` bytes. */
export type PetImage = { width: number; height: number; rgba: Uint8Array }

/** Untrusted pet files: refuse anything bigger before allocating. */
export const MAX_SHEET_BYTES = 32 * 1024 * 1024
export const MAX_SHEET_SIDE = 4096

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function checkSize(format: string, width: number, height: number) {
  if (width < 1 || height < 1) throw new RangeError(`[PETS]: ${format} has an empty image`)
  if (width > MAX_SHEET_SIDE || height > MAX_SHEET_SIDE) throw new RangeError(`[PETS]: ${format} ${width}x${height} exceeds ${MAX_SHEET_SIDE}px`)
}

/** Reads a PNG or WebP spritesheet (by content, not extension) into straight RGBA8. */
export async function decodeSheet(path: string): Promise<PetImage> {
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_SHEET_BYTES) throw new RangeError(`[PETS]: spritesheet is larger than ${MAX_SHEET_BYTES} bytes`)
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (isPng(data)) return decodePng(data)
  if (isWebp(data)) return decodeWebp(data)
  throw new TypeError("[PETS]: unsupported spritesheet format (PNG or WebP expected)")
}

function isPng(data: Uint8Array) {
  return PNG_SIGNATURE.every((byte, i) => data[i] === byte)
}

function isWebp(data: Uint8Array) {
  const tag = (offset: number) => String.fromCharCode(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0)
  return data.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP"
}

/** Canvas size from the RIFF header, so a hostile file cannot make us allocate before the size check. */
export function webpSize(data: Uint8Array): { width: number; height: number } {
  const chunk = String.fromCharCode(data[12] ?? 0, data[13] ?? 0, data[14] ?? 0, data[15] ?? 0)
  const at = (i: number) => data[i] ?? 0
  if (chunk === "VP8X") return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) }
  if (chunk === "VP8L") {
    if (at(20) !== 0x2f) throw new TypeError("[PETS]: bad WebP lossless header")
    return { width: 1 + (at(21) | ((at(22) & 0x3f) << 8)), height: 1 + ((at(22) >> 6) | (at(23) << 2) | ((at(24) & 0x0f) << 10)) }
  }
  if (chunk === "VP8 ") return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff }
  throw new TypeError("[PETS]: unknown WebP chunk")
}

type WebpDecoder = { init: (module: WebAssembly.Module) => Promise<void>; default: (buffer: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }> }

let webp: Promise<WebpDecoder> | undefined

/** Loaded on first WebP use only; the decoder wasm has to be compiled from bytes because Bun cannot fetch it by URL. */
function loadWebp(): Promise<WebpDecoder> {
  webp ??= (async () => {
    const decoder = (await import("@jsquash/webp/decode.js")) as unknown as WebpDecoder
    const { default: file } = await import("@jsquash/webp/codec/dec/webp_dec.wasm", { with: { type: "file" } })
    const wasm = await readFile(file)
    await decoder.init(await WebAssembly.compile(wasm))
    return decoder
  })()
  webp.catch(() => {
    webp = undefined
  })
  return webp
}

/** PNG or WebP bytes (by content) as straight RGBA8, size-checked like a spritesheet; the transcript's image cards decode through this. */
export async function decodeImageBytes(bytes: Uint8Array): Promise<PetImage> {
  if (bytes.byteLength > MAX_SHEET_BYTES) throw new RangeError(`[IMAGES]: image is larger than ${MAX_SHEET_BYTES} bytes`)
  if (isPng(bytes)) return decodePng(bytes)
  if (isWebp(bytes)) return decodeWebp(bytes)
  throw new TypeError("[IMAGES]: unsupported image format")
}

async function decodeWebp(data: Uint8Array): Promise<PetImage> {
  const { width, height } = webpSize(data)
  checkSize("WebP", width, height)
  const decoder = await loadWebp()
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const image = await decoder.default(copy)
  return { width: image.width, height: image.height, rgba: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) }
}
