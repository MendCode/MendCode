/** A small GIF89a writer for tests: real variable-width LZW, per-frame delay, disposal, transparency, offsets and interlacing. */
export type GifFixtureFrame = { indexes: Uint8Array; delayCs: number; disposal?: number; transparent?: number; left?: number; top?: number; width?: number; height?: number; interlaced?: boolean; palette?: number[][] }

function lzw(indexes: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize, end = clear + 1
  const bytes: number[] = []
  let bits = 0, held = 0
  const emit = (code: number, size: number) => {
    bits |= code << held
    held += size
    while (held >= 8) { bytes.push(bits & 0xff); bits >>>= 8; held -= 8 }
  }
  let table = new Map<string, number>()
  let size = minCodeSize + 1, next = end + 1
  emit(clear, size)
  let prefix = String(indexes[0]!)
  let code = indexes[0]!
  for (let at = 1; at < indexes.length; at++) {
    const key = `${prefix},${indexes[at]}`
    const known = table.get(key)
    if (known !== undefined) { prefix = key; code = known; continue }
    emit(code, size)
    if (next >= 4095) {
      emit(clear, size)
      table = new Map()
      size = minCodeSize + 1
      next = end + 1
    } else {
      table.set(key, next)
      if (next === 1 << size && size < 12) size++
      next++
    }
    prefix = String(indexes[at]!)
    code = indexes[at]!
  }
  emit(code, size)
  emit(end, size)
  if (held > 0) bytes.push(bits & 0xff)
  return new Uint8Array(bytes)
}

const table = (palette: number[][], bits: number) => Array.from({ length: 1 << bits }, (_, i) => palette[i] ?? [0, 0, 0]).flat()
const depth = (colors: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, colors))))

export function encodeGif(input: { width: number; height: number; palette: number[][]; frames: GifFixtureFrame[] }): Uint8Array {
  const bits = depth(input.palette.length)
  const out: number[] = [...Buffer.from("GIF89a"), input.width & 255, input.width >> 8, input.height & 255, input.height >> 8, 0x80 | (bits - 1), 0, 0, ...table(input.palette, bits)]
  for (const frame of input.frames) {
    const [width, height] = [frame.width ?? input.width, frame.height ?? input.height]
    out.push(0x21, 0xf9, 4, ((frame.disposal ?? 0) << 2) | (frame.transparent === undefined ? 0 : 1), frame.delayCs & 255, frame.delayCs >> 8, frame.transparent ?? 0, 0)
    const local = frame.palette ? depth(frame.palette.length) : 0
    out.push(0x2c, (frame.left ?? 0) & 255, (frame.left ?? 0) >> 8, (frame.top ?? 0) & 255, (frame.top ?? 0) >> 8, width & 255, width >> 8, height & 255, height >> 8, (frame.palette ? 0x80 | (local - 1) : 0) | (frame.interlaced ? 0x40 : 0))
    if (frame.palette) out.push(...table(frame.palette, local))
    let rows = frame.indexes
    if (frame.interlaced) {
      const order: number[] = []
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < height; y += step) order.push(y)
      rows = new Uint8Array(width * height)
      order.forEach((y, line) => rows.set(frame.indexes.subarray(y * width, (y + 1) * width), line * width))
    }
    const minCodeSize = Math.max(2, frame.palette ? local : bits)
    const data = lzw(rows, minCodeSize)
    out.push(minCodeSize)
    for (let at = 0; at < data.length; at += 255) out.push(Math.min(255, data.length - at), ...data.subarray(at, at + 255))
    out.push(0)
  }
  out.push(0x3b)
  return new Uint8Array(out)
}
