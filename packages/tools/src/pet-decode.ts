import { inflateSync } from "node:zlib"

/** Shared straight RGBA8 raster, row-major, `width * height * 4` bytes. */
export type PetImage = { width: number; height: number; rgba: Uint8Array }

/** Untrusted pet files: refuse anything bigger before allocating. */
export const MAX_SHEET_BYTES = 32 * 1024 * 1024
export const MAX_SHEET_SIDE = 4096

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function checkSize(format: string, width: number, height: number) {
  if (width < 1 || height < 1) throw new RangeError(`[PETS]: ${format} has an empty image`)
  if (width > MAX_SHEET_SIDE || height > MAX_SHEET_SIDE) throw new RangeError(`[PETS]: ${format} ${width}x${height} exceeds ${MAX_SHEET_SIDE}px`)
}

function isPng(data: Uint8Array) {
  return PNG_SIGNATURE.every((byte, i) => data[i] === byte)
}

type PngHeader = { width: number; height: number; depth: number; color: number; interlace: number }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export function decodePng(data: Uint8Array): PetImage {
  if (!isPng(data)) throw new TypeError("[PETS]: bad PNG signature")
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let header: PngHeader | undefined
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const parts: Uint8Array[] = []
  let compressed = 0
  let pos = 8
  while (pos + 8 <= data.length) {
    const length = view.getUint32(pos)
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!)
    const body = pos + 8
    if (body + length > data.length) throw new RangeError("[PETS]: truncated PNG chunk")
    if (type === "IHDR") header = { width: view.getUint32(body), height: view.getUint32(body + 4), depth: data[body + 8]!, color: data[body + 9]!, interlace: data[body + 12]! }
    else if (type === "PLTE") palette = data.subarray(body, body + length)
    else if (type === "tRNS") transparency = data.subarray(body, body + length)
    else if (type === "IDAT") {
      parts.push(data.subarray(body, body + length))
      compressed += length
    } else if (type === "IEND") break
    pos = body + length + 4
  }
  if (!header || compressed === 0) throw new TypeError("[PETS]: PNG is missing IHDR or IDAT")
  const { width, height, depth, color, interlace } = header
  checkSize("PNG", width, height)
  if (depth !== 8) throw new RangeError(`[PETS]: PNG bit depth ${depth} is not supported (8-bit only)`)
  if (interlace !== 0) throw new RangeError("[PETS]: interlaced PNG is not supported")
  const channels = CHANNELS[color]
  if (!channels) throw new RangeError(`[PETS]: PNG color type ${color} is not supported`)
  if (color === 3 && !palette) throw new TypeError("[PETS]: palette PNG without PLTE")

  const joined = new Uint8Array(compressed)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  const stride = width * channels
  const raw = inflateSync(joined, { maxOutputLength: (stride + 1) * height })
  if (raw.length !== (stride + 1) * height) throw new RangeError("[PETS]: PNG pixel data has the wrong size")

  const rgba = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  let current = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    unfilter({ filter: raw[base]!, raw, base: base + 1, current, previous, channels })
    expandRow({ color, channels, current, palette, transparency, out: rgba, offset: y * width * 4, width })
    const swap = previous
    previous = current
    current = swap
  }
  return { width, height, rgba }
}

function unfilter({ filter, raw, base, current, previous, channels }: { filter: number; raw: Uint8Array; base: number; current: Uint8Array; previous: Uint8Array; channels: number }) {
  const stride = current.length
  for (let i = 0; i < stride; i++) {
    const x = raw[base + i]!
    const left = i >= channels ? current[i - channels]! : 0
    const up = previous[i]!
    let value: number
    switch (filter) {
      case 0:
        value = x
        break
      case 1:
        value = x + left
        break
      case 2:
        value = x + up
        break
      case 3:
        value = x + ((left + up) >> 1)
        break
      case 4: {
        const upLeft = i >= channels ? previous[i - channels]! : 0
        const estimate = left + up - upLeft
        const dLeft = Math.abs(estimate - left)
        const dUp = Math.abs(estimate - up)
        const dUpLeft = Math.abs(estimate - upLeft)
        value = x + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft)
        break
      }
      default:
        throw new RangeError(`[PETS]: PNG filter ${filter} is invalid`)
    }
    current[i] = value & 255
  }
}

function expandRow({ color, channels, current, palette, transparency, out, offset, width }: { color: number; channels: number; current: Uint8Array; palette: Uint8Array | undefined; transparency: Uint8Array | undefined; out: Uint8Array; offset: number; width: number }) {
  if (color === 6) {
    out.set(current, offset)
    return
  }
  for (let x = 0, o = offset; x < width; x++, o += 4) {
    const i = x * channels
    if (color === 2) {
      out[o] = current[i]!
      out[o + 1] = current[i + 1]!
      out[o + 2] = current[i + 2]!
      out[o + 3] = 255
    } else if (color === 0) {
      out[o] = out[o + 1] = out[o + 2] = current[i]!
      out[o + 3] = 255
    } else if (color === 4) {
      out[o] = out[o + 1] = out[o + 2] = current[i]!
      out[o + 3] = current[i + 1]!
    } else {
      const index = current[i]!
      if (!palette || index * 3 + 2 >= palette.length) throw new RangeError("[PETS]: PNG palette index is out of range")
      out[o] = palette[index * 3]!
      out[o + 1] = palette[index * 3 + 1]!
      out[o + 2] = palette[index * 3 + 2]!
      out[o + 3] = transparency?.[index] ?? 255
    }
  }
}
