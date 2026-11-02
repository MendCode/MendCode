/** A versioned, uncompressed varint block; text remains owned by item.completed. */
const MAGIC = [0x4d, 0x44, 0x4c, 1]
type Entry = [number, number, string, unknown, unknown, unknown]

export function packDeltaLengths(payload: string, completed: string): Uint8Array | undefined {
  const entries = JSON.parse(payload) as Entry[]
  if (!entries.length || entries.some(e => typeof e[2] !== "string" || e[3] !== null || e[4] !== null || e[5] !== null) || entries.map(e => e[2]).join("") !== completed) return
  const out = [...MAGIC]
  const put = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid delta varint")
    while (value >= 128) { out.push(value % 128 + 128); value = Math.floor(value / 128) }
    out.push(value)
  }
  put(entries.length)
  let seq = 0, at = 0
  for (const entry of entries) {
    if (entry[0] <= seq || !Number.isSafeInteger((entry[1] - at) * 2)) return
    put(entry[0] - seq)
    const offset = entry[1] - at
    put(offset < 0 ? -offset * 2 - 1 : offset * 2)
    put(entry[2].length)
    seq = entry[0]; at = entry[1]
  }
  return Uint8Array.from(out)
}

export function isDeltaLengths(data: Uint8Array): boolean {
  return MAGIC.every((value, i) => data[i] === value)
}

export function unpackDeltaLengths(data: Uint8Array, completed: string): Array<[number, number, string]> {
  let cursor = MAGIC.length
  const get = () => {
    let value = 0, factor = 1
    for (let i = 0; i < 8; i++) {
      const byte = data[cursor++]
      if (byte === undefined) throw new RangeError("truncated delta varint")
      value += (byte & 127) * factor
      if (!Number.isSafeInteger(value)) throw new RangeError("invalid delta varint")
      if (byte < 128) return value
      factor *= 128
    }
    throw new RangeError("oversized delta varint")
  }
  const count = get(), out: Array<[number, number, string]> = []
  if (count > data.length) throw new RangeError("invalid delta count")
  let seq = 0, at = 0, offset = 0
  for (let i = 0; i < count; i++) {
    seq += get()
    const time = get(); at += time % 2 ? -(time + 1) / 2 : time / 2
    const length = get()
    out.push([seq, at, completed.slice(offset, offset + length)])
    offset += length
  }
  if (cursor !== data.length || offset !== completed.length) throw new RangeError("delta text length mismatch")
  return out
}
