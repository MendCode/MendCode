import type { PetImage } from "../pets/decode"

/**
 * A baseline (sequential Huffman, 8-bit) JPEG decoder for the transcript's image cards: grayscale and YCbCr with any chroma
 * subsampling, restart intervals, JFIF and Adobe RGB. Progressive, arithmetic-coded and CMYK files throw, and the card then
 * shows its text. Input is untrusted: sizes are bounded before anything is allocated and every read is checked.
 */

export const MAX_JPEG_SIDE = 8192
export const MAX_JPEG_PIXELS = 24_000_000

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]
/** `COS[x * 8 + u]`: the 1-D inverse DCT basis, scaled so two passes give the 2-D transform. */
const COS = new Float64Array(64)
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16)

type Huffman = { lookup: Int32Array; maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }
type Component = { id: number; h: number; v: number; tq: number; dc: number; ac: number; plane: Uint8Array; stride: number; pred: number }

type Frame = { width: number; height: number; components: Component[]; hmax: number; vmax: number }

const LOOKAHEAD = 9

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const lookup = new Int32Array(1 << LOOKAHEAD).fill(-1)
  const maxcode = new Int32Array(18).fill(-1)
  const valptr = new Int32Array(17)
  const mincode = new Int32Array(17)
  let code = 0
  let index = 0
  for (let length = 1; length <= 16; length++) {
    valptr[length] = index
    mincode[length] = code
    for (let i = 0; i < counts[length - 1]!; i++, index++, code++) {
      if (length <= LOOKAHEAD) {
        const base = code << (LOOKAHEAD - length)
        for (let fill = 0; fill < 1 << (LOOKAHEAD - length); fill++) lookup[base + fill] = (length << 8) | values[index]!
      }
    }
    maxcode[length] = counts[length - 1]! ? code - 1 : -1
    code <<= 1
  }
  return { lookup, maxcode, valptr, mincode, values }
}

export function decodeJpeg(data: Uint8Array): PetImage {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new TypeError("[IMAGES]: not a JPEG")
  const quant: Array<Uint16Array | undefined> = []
  const dcTables: Array<Huffman | undefined> = []
  const acTables: Array<Huffman | undefined> = []
  let frame: Frame | undefined
  let restart = 0
  let adobe: number | undefined
  let pos = 2
  const u16 = (at: number) => (data[at]! << 8) | data[at + 1]!

  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) { pos++; continue }
    const marker = data[pos + 1]!
    if (marker === 0xff) { pos++; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0x00) { pos += 2; continue }
    if (marker === 0xd9) break
    const length = u16(pos + 2)
    const body = pos + 4
    const end = pos + 2 + length
    if (length < 2 || end > data.length) throw new RangeError("[IMAGES]: truncated JPEG segment")
    if (marker === 0xdb) {
      for (let at = body; at < end;) {
        const precision = data[at]! >> 4
        const id = data[at]! & 15
        at++
        const table = new Uint16Array(64)
        for (let i = 0; i < 64; i++) {
          if (at + (precision ? 2 : 1) > end) throw new RangeError("[IMAGES]: truncated JPEG quantization table")
          table[ZIGZAG[i]!] = precision ? u16(at) : data[at]!
          at += precision ? 2 : 1
        }
        quant[id & 3] = table
      }
    } else if (marker === 0xc4) {
      for (let at = body; at + 17 <= end;) {
        const kind = data[at]! >> 4
        const id = data[at]! & 3
        const counts = data.subarray(at + 1, at + 17)
        const total = counts.reduce((sum, n) => sum + n, 0)
        if (total > 256 || at + 17 + total > end) throw new RangeError("[IMAGES]: bad JPEG Huffman table")
        const table = buildHuffman(counts, data.subarray(at + 17, at + 17 + total))
        if (kind === 0) dcTables[id] = table
        else acTables[id] = table
        at += 17 + total
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (data[body] !== 8) throw new TypeError("[IMAGES]: only 8-bit JPEG is supported")
      const height = u16(body + 1)
      const width = u16(body + 3)
      const count = data[body + 5]!
      if (width < 1 || height < 1 || width > MAX_JPEG_SIDE || height > MAX_JPEG_SIDE || width * height > MAX_JPEG_PIXELS) throw new RangeError(`[IMAGES]: JPEG ${width}x${height} is too large`)
      if (count !== 1 && count !== 3) throw new TypeError("[IMAGES]: unsupported JPEG color space")
      if (body + 6 + count * 3 > end) throw new RangeError("[IMAGES]: truncated JPEG frame")
      const components: Component[] = []
      for (let i = 0; i < count; i++) {
        const at = body + 6 + i * 3
        const h = data[at + 1]! >> 4
        const v = data[at + 1]! & 15
        if (h < 1 || h > 4 || v < 1 || v > 4) throw new RangeError("[IMAGES]: bad JPEG sampling factors")
        components.push({ id: data[at]!, h, v, tq: data[at + 2]! & 3, dc: 0, ac: 0, plane: new Uint8Array(0), stride: 0, pred: 0 })
      }
      frame = { width, height, components, hmax: Math.max(...components.map((c) => c.h)), vmax: Math.max(...components.map((c) => c.v)) }
    } else if (marker === 0xc2 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc && marker !== 0xc4)) {
      throw new TypeError("[IMAGES]: progressive or arithmetic JPEG is not supported")
    } else if (marker === 0xdd) restart = u16(body)
    else if (marker === 0xee && length >= 14 && String.fromCharCode(...data.subarray(body, body + 5)) === "Adobe") adobe = data[body + 11]
    else if (marker === 0xda) {
      if (!frame) throw new TypeError("[IMAGES]: JPEG scan before its frame")
      const count = data[body]!
      if (count !== frame.components.length) throw new TypeError("[IMAGES]: multi-scan JPEG is not supported")
      for (let i = 0; i < count; i++) {
        const component = frame.components.find((candidate) => candidate.id === data[body + 1 + i * 2])
        if (!component) throw new TypeError("[IMAGES]: JPEG scan names an unknown component")
        component.dc = data[body + 2 + i * 2]! >> 4
        component.ac = data[body + 2 + i * 2]! & 15
      }
      decodeScan(data, end, frame, quant, dcTables, acTables, restart)
      return toRgba(frame, adobe)
    }
    pos = end
  }
  throw new TypeError("[IMAGES]: JPEG has no image data")
}

function decodeScan(data: Uint8Array, start: number, frame: Frame, quant: Array<Uint16Array | undefined>, dcTables: Array<Huffman | undefined>, acTables: Array<Huffman | undefined>, restart: number) {
  const { width, height, components, hmax, vmax } = frame
  const mcuW = 8 * hmax
  const mcuH = 8 * vmax
  const mcusX = Math.ceil(width / mcuW)
  const mcusY = Math.ceil(height / mcuH)
  for (const component of components) {
    component.stride = mcusX * component.h * 8
    component.plane = new Uint8Array(component.stride * mcusY * component.v * 8)
  }
  let pos = start
  let bits = 0
  let count = 0
  const fill = () => {
    while (count <= 24) {
      let byte = 0
      if (pos < data.length) {
        byte = data[pos]!
        if (byte === 0xff) {
          const next = data[pos + 1] ?? 0xd9
          if (next === 0) pos += 2
          else byte = 0 // a marker: feed zeros until the decoder resynchronises
        } else pos++
      }
      bits |= byte << (24 - count)
      count += 8
    }
  }
  const peek = (n: number) => {
    if (count < n) fill()
    return bits >>> (32 - n)
  }
  const drop = (n: number) => {
    bits <<= n
    count -= n
  }
  const receive = (n: number) => {
    if (n === 0) return 0
    const value = peek(n)
    drop(n)
    return value
  }
  const extend = (value: number, n: number) => (n === 0 ? 0 : value < 1 << (n - 1) ? value - (1 << n) + 1 : value)
  const symbol = (table: Huffman) => {
    const head = table.lookup[peek(LOOKAHEAD)]!
    if (head >= 0) {
      drop(head >> 8)
      return head & 255
    }
    let code = peek(LOOKAHEAD)
    let length = LOOKAHEAD
    while (length < 16) {
      length++
      code = peek(length)
      if (table.maxcode[length]! >= 0 && code <= table.maxcode[length]! && code >= table.mincode[length]!) {
        drop(length)
        return table.values[table.valptr[length]! + code - table.mincode[length]!]!
      }
    }
    throw new RangeError("[IMAGES]: bad JPEG Huffman code")
  }
  const block = new Float64Array(64)
  const temp = new Float64Array(64)
  const decodeBlock = (component: Component, bx: number, by: number) => {
    const table = quant[component.tq]
    const dc = dcTables[component.dc]
    const ac = acTables[component.ac]
    if (!table || !dc || !ac) throw new TypeError("[IMAGES]: JPEG is missing a table")
    block.fill(0)
    const size = symbol(dc)
    if (size > 11) throw new RangeError("[IMAGES]: bad JPEG DC size")
    component.pred += extend(receive(size), size)
    block[0] = component.pred * table[0]!
    for (let k = 1; k < 64;) {
      const rs = symbol(ac)
      const run = rs >> 4
      const length = rs & 15
      if (length === 0) {
        if (run !== 15) break
        k += 16
        continue
      }
      k += run
      if (k > 63) break
      block[ZIGZAG[k]!] = extend(receive(length), length) * table[ZIGZAG[k]!]!
      k++
    }
    // Separable inverse DCT: rows, then columns.
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) sum += COS[x * 8 + u]! * block[y * 8 + u]!
      temp[y * 8 + x] = sum
    }
    const base = by * 8 * component.stride + bx * 8
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let v = 0; v < 8; v++) sum += COS[y * 8 + v]! * temp[v * 8 + x]!
      const value = Math.round(sum + 128)
      component.plane[base + y * component.stride + x] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
  let sinceRestart = 0
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restart && sinceRestart === restart) {
        // Byte-align, step over the RSTn marker and reset the predictors.
        bits = 0
        count = 0
        while (pos + 1 < data.length && !(data[pos] === 0xff && data[pos + 1]! >= 0xd0 && data[pos + 1]! <= 0xd7)) pos++
        pos += 2
        for (const component of components) component.pred = 0
        sinceRestart = 0
      }
      for (const component of components) {
        for (let v = 0; v < component.v; v++) for (let h = 0; h < component.h; h++) decodeBlock(component, mx * component.h + h, my * component.v + v)
      }
      sinceRestart++
    }
  }
}

function toRgba(frame: Frame, adobe: number | undefined): PetImage {
  const { width, height, components, hmax, vmax } = frame
  const rgba = new Uint8Array(width * height * 4)
  const sample = (component: Component, x: number, y: number) => component.plane[Math.floor((y * component.v) / vmax) * component.stride + Math.floor((x * component.h) / hmax)]!
  const [first, second, third] = components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      let r: number
      let g: number
      let b: number
      if (!second || !third) r = g = b = sample(first!, x, y)
      else if (adobe === 0) {
        r = sample(first!, x, y)
        g = sample(second, x, y)
        b = sample(third, x, y)
      } else {
        const luma = sample(first!, x, y)
        const cb = sample(second, x, y) - 128
        const cr = sample(third, x, y) - 128
        r = luma + 1.402 * cr
        g = luma - 0.344136 * cb - 0.714136 * cr
        b = luma + 1.772 * cb
      }
      rgba[out] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
      rgba[out + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
      rgba[out + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
      rgba[out + 3] = 255
    }
  }
  return { width, height, rgba }
}
