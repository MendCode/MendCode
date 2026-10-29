import { MAX_SHEET_SIDE, type PetImage } from "./pet-decode"

/** One composed frame of an animation: the whole canvas as it shows, and for how long. */
export type GifFrame = { image: PetImage; ms: number }

export const MAX_GIF_FRAMES = 400
/** Composed frames are held at once while a pet is imported: refuse an animation that would not fit. */
export const MAX_GIF_DECODED_BYTES = 256 * 1024 * 1024
/** Browsers show a delay of 0 or 1 hundredths as a tenth of a second; so does this. */
const DEFAULT_DELAY_MS = 100

export const isGif = (data: Uint8Array) => data.length >= 13 && String.fromCharCode(...data.subarray(0, 6)).match(/^GIF8[79]a$/) !== null

/** Variable-width LZW as GIF writes it: codes least significant bit first, a clear code, an end code, a table of at most 4096 entries. */
function lzw(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  if (minCodeSize < 1 || minCodeSize > 11) throw new RangeError("[GIF]: bad LZW code size")
  const out = new Uint8Array(pixels)
  const clear = 1 << minCodeSize, end = clear + 1
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097)
  for (let code = 0; code < clear; code++) suffix[code] = code
  let size = minCodeSize + 1, next = end + 1, previous = -1, first = 0
  let bits = 0, held = 0, at = 0, written = 0
  while (written < pixels) {
    while (held < size && at < data.length) { bits |= data[at++]! << held; held += 8 }
    if (held < size) break
    let code = bits & ((1 << size) - 1)
    bits >>>= size
    held -= size
    if (code === clear) { size = minCodeSize + 1; next = end + 1; previous = -1; continue }
    if (code === end) break
    if (previous === -1) {
      if (code >= clear) throw new RangeError("[GIF]: bad first LZW code")
      out[written++] = code
      previous = first = code
      continue
    }
    const incoming = code
    let top = 0
    if (code > next || (code === next && next >= 4096)) throw new RangeError("[GIF]: LZW code out of range")
    if (code === next) { stack[top++] = first; code = previous }
    while (code >= clear) {
      if (code === end || top >= 4096) throw new RangeError("[GIF]: corrupt LZW table")
      stack[top++] = suffix[code]!
      code = prefix[code]!
    }
    first = code
    stack[top++] = first
    while (top > 0 && written < pixels) out[written++] = stack[--top]!
    if (next < 4096) {
      prefix[next] = previous
      suffix[next] = first
      next++
      if (next === 1 << size && size < 12) size++
    }
    previous = incoming
  }
  return out
}

/**
 * Every frame of a GIF, composed (disposal methods, transparency, local palettes, interlacing) into full canvases of
 * straight RGBA with its delay. Pure and bounded: sizes are checked before anything is allocated.
 */
export function decodeGif(data: Uint8Array): GifFrame[] {
  if (!isGif(data)) throw new TypeError("[GIF]: bad signature")
  const u16 = (at: number) => {
    if (at + 1 >= data.length) throw new RangeError("[GIF]: truncated file")
    return data[at]! | (data[at + 1]! << 8)
  }
  const width = u16(6), height = u16(8)
  if (width < 1 || height < 1 || width > MAX_SHEET_SIDE || height > MAX_SHEET_SIDE) throw new RangeError(`[GIF]: ${width}x${height} is empty or exceeds ${MAX_SHEET_SIDE}px`)
  let at = 13
  const palette = (flags: number) => {
    if (!(flags & 0x80)) return undefined
    const bytes = 3 * (1 << ((flags & 7) + 1))
    if (at + bytes > data.length) throw new RangeError("[GIF]: truncated palette")
    const table = data.subarray(at, at + bytes)
    at += bytes
    return table
  }
  const global = palette(data[10]!)
  /** The data sub-blocks at `at`, joined; leaves `at` after their terminator. */
  const blocks = () => {
    const parts: Uint8Array[] = []
    for (;;) {
      const length = data[at]
      if (length === undefined) throw new RangeError("[GIF]: truncated data")
      at++
      if (length === 0) break
      if (at + length > data.length) throw new RangeError("[GIF]: truncated data")
      parts.push(data.subarray(at, at + length))
      at += length
    }
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) { joined.set(part, offset); offset += part.length }
    return joined
  }

  const canvas = new Uint8Array(width * height * 4)
  const frames: GifFrame[] = []
  let control = { disposal: 0, ms: DEFAULT_DELAY_MS, transparent: -1 }
  for (;;) {
    const marker = data[at++]
    if (marker === undefined || marker === 0x3b) break
    if (marker === 0x21) {
      const label = data[at++]
      if (label === 0xf9 && data[at] === 4) {
        const flags = data[at + 1]!, delay = u16(at + 2)
        control = { disposal: (flags >> 2) & 7, ms: delay <= 1 ? DEFAULT_DELAY_MS : delay * 10, transparent: flags & 1 ? data[at + 4]! : -1 }
      }
      blocks()
      continue
    }
    if (marker !== 0x2c) throw new TypeError("[GIF]: unknown block")
    const left = u16(at), top = u16(at + 2), w = u16(at + 4), h = u16(at + 6), flags = data[at + 8]!
    at += 9
    const colors = palette(flags) ?? global
    if (!colors) throw new TypeError("[GIF]: frame without a palette")
    if (w < 1 || h < 1 || left + w > width || top + h > height) throw new RangeError("[GIF]: frame outside the canvas")
    if (frames.length >= MAX_GIF_FRAMES) throw new RangeError(`[GIF]: more than ${MAX_GIF_FRAMES} frames`)
    if ((frames.length + 1) * canvas.length > MAX_GIF_DECODED_BYTES) throw new RangeError("[GIF]: animation is too large to decode; use fewer or smaller frames")
    const minCodeSize = data[at++]!
    const indexes = lzw(blocks(), minCodeSize, w * h)
    const before = control.disposal === 3 ? canvas.slice() : undefined
    // Interlaced rows arrive in four passes: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1.
    const rows: number[] = []
    if (flags & 0x40) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < h; y += step) rows.push(y)
    for (let line = 0; line < h; line++) {
      const y = flags & 0x40 ? rows[line]! : line
      for (let x = 0; x < w; x++) {
        const index = indexes[line * w + x]!
        if (index === control.transparent || index * 3 + 2 >= colors.length) continue
        canvas.set([colors[index * 3]!, colors[index * 3 + 1]!, colors[index * 3 + 2]!, 255], ((top + y) * width + left + x) * 4)
      }
    }
    frames.push({ image: { width, height, rgba: canvas.slice() }, ms: control.ms })
    if (control.disposal === 2) for (let y = top; y < top + h; y++) canvas.fill(0, (y * width + left) * 4, (y * width + left + w) * 4)
    else if (before) canvas.set(before)
    control = { disposal: 0, ms: DEFAULT_DELAY_MS, transparent: -1 }
  }
  if (frames.length === 0) throw new TypeError("[GIF]: no frames")
  return frames
}
