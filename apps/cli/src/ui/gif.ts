import type { PetImage } from "../pets/decode"

/** The first frame of a GIF as RGBA (transparent where the frame says so), for the transcript's image cards. Untrusted input: bounded and checked. */

export const MAX_GIF_SIDE = 4096

export function decodeGif(data: Uint8Array): PetImage {
  const tag = String.fromCharCode(...data.subarray(0, 6))
  if (data.length < 14 || (tag !== "GIF87a" && tag !== "GIF89a")) throw new TypeError("[IMAGES]: not a GIF")
  const u16 = (at: number) => data[at]! | (data[at + 1]! << 8)
  const width = u16(6)
  const height = u16(8)
  if (width < 1 || height < 1 || width > MAX_GIF_SIDE || height > MAX_GIF_SIDE) throw new RangeError(`[IMAGES]: GIF ${width}x${height} is out of range`)
  let pos = 13
  let globalTable: Uint8Array | undefined
  if (data[10]! & 0x80) {
    const size = 3 * (1 << ((data[10]! & 7) + 1))
    globalTable = data.subarray(pos, pos + size)
    pos += size
  }
  let transparent = -1
  while (pos < data.length) {
    const block = data[pos++]!
    if (block === 0x21) {
      const label = data[pos++]!
      if (label === 0xf9 && data[pos] === 4 && data[pos + 1]! & 1) transparent = data[pos + 4]!
      while (pos < data.length && data[pos] !== 0) pos += data[pos]! + 1
      pos++
      continue
    }
    if (block !== 0x2c) break
    const left = u16(pos)
    const top = u16(pos + 2)
    const frameWidth = u16(pos + 4)
    const frameHeight = u16(pos + 6)
    const flags = data[pos + 8]!
    pos += 9
    let table = globalTable
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1))
      table = data.subarray(pos, pos + size)
      pos += size
    }
    if (!table) throw new TypeError("[IMAGES]: GIF has no color table")
    const minimum = data[pos++]!
    if (minimum < 2 || minimum > 8) throw new RangeError("[IMAGES]: bad GIF code size")
    const bytes: number[] = []
    while (pos < data.length && data[pos] !== 0) {
      const length = data[pos]!
      for (let i = 1; i <= length && pos + i < data.length; i++) bytes.push(data[pos + i]!)
      pos += length + 1
    }
    const indices = lzw(bytes, minimum, frameWidth * frameHeight)
    const rgba = new Uint8Array(width * height * 4)
    const rows = flags & 0x40 ? interlaced(frameHeight) : Array.from({ length: frameHeight }, (_, y) => y)
    for (let i = 0; i < indices.length; i++) {
      const y = rows[Math.floor(i / frameWidth)]! + top
      const x = (i % frameWidth) + left
      const index = indices[i]!
      if (x >= width || y >= height || index === transparent || index * 3 + 2 >= table.length) continue
      rgba.set([table[index * 3]!, table[index * 3 + 1]!, table[index * 3 + 2]!, 255], (y * width + x) * 4)
    }
    return { width, height, rgba }
  }
  throw new TypeError("[IMAGES]: GIF has no image data")
}

/** Source row of each stored row in an interlaced frame. */
function interlaced(height: number): number[] {
  const order: number[] = []
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < height; y += step) order.push(y)
  return order
}

function lzw(bytes: number[], minimum: number, expected: number): Uint8Array {
  const clear = 1 << minimum
  const end = clear + 1
  const out = new Uint8Array(expected)
  let produced = 0
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)
  let size = minimum + 1
  let next = end + 1
  let previous = -1
  let first = 0
  let bits = 0
  let count = 0
  for (let i = 0; i < clear; i++) suffix[i] = i
  for (const byte of bytes) {
    bits |= byte << count
    count += 8
    while (count >= size) {
      const code = bits & ((1 << size) - 1)
      bits >>>= size
      count -= size
      if (code === clear) {
        size = minimum + 1
        next = end + 1
        previous = -1
        continue
      }
      if (code === end) return out
      if (previous === -1) {
        if (code >= clear) throw new RangeError("[IMAGES]: bad GIF data")
        if (produced < expected) out[produced++] = code
        previous = code
        first = code
        continue
      }
      let current = code
      let top = 0
      if (code >= next) {
        if (code > next) throw new RangeError("[IMAGES]: bad GIF data")
        stack[top++] = first
        current = previous
      }
      while (current >= clear) {
        if (top >= 4096) throw new RangeError("[IMAGES]: bad GIF data")
        stack[top++] = suffix[current]!
        current = prefix[current]!
      }
      first = current
      stack[top++] = current
      while (top > 0 && produced < expected) out[produced++] = stack[--top]!
      if (next < 4096) {
        prefix[next] = previous
        suffix[next] = first
        next++
        if (next === 1 << size && size < 12) size++
      }
      previous = code
      if (produced >= expected) return out
    }
  }
  return out
}
