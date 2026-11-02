/**
 * A versioned, uncompressed varint block; text remains owned by item.completed.
 * Version 1 interleaves (sequence step, time step, length) per delta. Version 2 stores the three as columns, each as
 * groups of one repeated value or of literals, because a stream steps its sequence by one and mostly repeats its time
 * and chunk size. The writer keeps whichever form is smaller; both read.
 */
const MAGIC = [0x4d, 0x44, 0x4c, 1]
const MAGIC_V2 = [0x4d, 0x44, 0x4c, 2]
/** Fewest equal neighbours that pay for a run group (header + value) instead of literals. */
const MIN_RUN = 3
type Entry = [number, number, string, unknown, unknown, unknown]
type Columns = { seq: number[]; at: number[]; length: number[] }

function putVarint(out: number[], value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid delta varint")
  while (value >= 128) { out.push(value % 128 + 128); value = Math.floor(value / 128) }
  out.push(value)
}

function encodeColumn(out: number[], values: number[]) {
  let i = 0
  while (i < values.length) {
    let run = 1
    while (i + run < values.length && values[i + run] === values[i]) run++
    if (run >= MIN_RUN) { putVarint(out, run * 2 + 1); putVarint(out, values[i]!); i += run; continue }
    let end = i + run
    while (end < values.length) {
      let next = 1
      while (end + next < values.length && values[end + next] === values[end]) next++
      if (next >= MIN_RUN) break
      end += next
    }
    putVarint(out, (end - i) * 2)
    for (; i < end; i++) putVarint(out, values[i]!)
  }
}

const zigzag = (offset: number) => offset < 0 ? -offset * 2 - 1 : offset * 2

export function packDeltaLengths(payload: string, completed: string): Uint8Array | undefined {
  const entries = JSON.parse(payload) as Entry[]
  if (!entries.length || entries.some(e => typeof e[2] !== "string" || e[3] !== null || e[4] !== null || e[5] !== null) || entries.map(e => e[2]).join("") !== completed) return
  const columns: Columns = { seq: [], at: [], length: [] }
  let seq = 0, at = 0
  for (const entry of entries) {
    if (entry[0] <= seq || !Number.isSafeInteger((entry[1] - at) * 2)) return
    columns.seq.push(entry[0] - seq)
    columns.at.push(zigzag(entry[1] - at))
    columns.length.push(entry[2].length)
    seq = entry[0]; at = entry[1]
  }
  const plain = [...MAGIC]
  putVarint(plain, entries.length)
  for (let i = 0; i < entries.length; i++) { putVarint(plain, columns.seq[i]!); putVarint(plain, columns.at[i]!); putVarint(plain, columns.length[i]!) }
  const grouped = [...MAGIC_V2]
  putVarint(grouped, entries.length)
  encodeColumn(grouped, columns.seq)
  encodeColumn(grouped, columns.at)
  encodeColumn(grouped, columns.length)
  return Uint8Array.from(grouped.length < plain.length ? grouped : plain)
}

const has = (data: Uint8Array, magic: number[]) => magic.every((value, i) => data[i] === value)

export function isDeltaLengths(data: Uint8Array): boolean {
  return has(data, MAGIC) || has(data, MAGIC_V2)
}

/** Whether the block is in the oldest interleaved form, which the idle step may rewrite as columns. */
export function isPlainDeltaLengths(data: Uint8Array): boolean {
  return has(data, MAGIC)
}

export function unpackDeltaLengths(data: Uint8Array, completed: string): Array<[number, number, string]> {
  const grouped = has(data, MAGIC_V2)
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
  if (count > data.length * 64) throw new RangeError("invalid delta count")
  const column = () => {
    const values: number[] = []
    while (values.length < count) {
      const head = get(), size = Math.floor(head / 2)
      if (size === 0 || values.length + size > count) throw new RangeError("invalid delta group")
      if (head % 2) { const value = get(); for (let i = 0; i < size; i++) values.push(value) }
      else for (let i = 0; i < size; i++) values.push(get())
    }
    return values
  }
  const columns: Columns | undefined = grouped ? { seq: column(), at: column(), length: column() } : undefined
  let seq = 0, at = 0, offset = 0
  for (let i = 0; i < count; i++) {
    seq += columns ? columns.seq[i]! : get()
    const time = columns ? columns.at[i]! : get(); at += time % 2 ? -(time + 1) / 2 : time / 2
    const length = columns ? columns.length[i]! : get()
    out.push([seq, at, completed.slice(offset, offset + length)])
    offset += length
  }
  if (cursor !== data.length || offset !== completed.length) throw new RangeError("delta text length mismatch")
  return out
}
