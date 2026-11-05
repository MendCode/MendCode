import type { OwnEventRow } from "./compress"

/** `\0MB1`: a sealed turn block. Its rows come back exactly as they were stored in `events`. */
const MAGIC = [0x00, 0x4d, 0x42, 0x31] as const
const VERSION = 1
const ZSTD_LEVEL = 9

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function pushVarint(out: number[], value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`[STORE]: turn block cannot hold ${value}`)
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
}

function readVarint(bytes: Uint8Array, at: { offset: number }): number {
  let value = 0
  let scale = 1
  for (;;) {
    if (at.offset >= bytes.byteLength) throw new RangeError("[STORE]: turn block ends inside a number")
    const byte = bytes[at.offset++]!
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return value
    scale *= 0x80
  }
}

/** Signed deltas (time can step back when a clock is corrected) as zigzag varints. */
const zigzag = (value: number) => (value < 0 ? -2 * value - 1 : 2 * value)
const unzigzag = (value: number) => (value % 2 === 1 ? -(value + 1) / 2 : value / 2)

export const isTurnBlock = (value: Uint8Array) => value.byteLength > MAGIC.length && MAGIC.every((byte, i) => value[i] === byte)

/**
 * One turn's stored event rows as a single zstd frame. Sequence and time are deltas, types an index into the block's own
 * table, payloads the stored strings unchanged; `decodeTurnBlock` returns rows byte-identical to the ones given.
 */
export function encodeTurnBlock(rows: readonly OwnEventRow[]): Uint8Array {
  const types: string[] = []
  const typeIndex = new Map<string, number>()
  const head: number[] = []
  const payloads: Uint8Array[] = []
  pushVarint(head, rows.length)
  let seq = 0
  let at = 0
  for (const row of rows) {
    if (row.seq <= seq && payloads.length) throw new RangeError("[STORE]: turn block rows must be in sequence order")
    let index = typeIndex.get(row.type)
    if (index === undefined) {
      typeIndex.set(row.type, (index = types.length))
      types.push(row.type)
    }
    const payload = encoder.encode(row.payload)
    pushVarint(head, row.seq - seq)
    pushVarint(head, zigzag(row.at - at))
    pushVarint(head, index)
    pushVarint(head, payload.byteLength)
    payloads.push(payload)
    seq = row.seq
    at = row.at
  }
  const table: number[] = []
  pushVarint(table, types.length)
  const typeBytes = types.map((type) => encoder.encode(type))
  for (const type of typeBytes) pushVarint(table, type.byteLength)
  const parts = [Uint8Array.from(table), ...typeBytes, Uint8Array.from(head), ...payloads]
  const plain = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    plain.set(part, offset)
    offset += part.byteLength
  }
  const packed = Bun.zstdCompressSync(plain, { level: ZSTD_LEVEL })
  const out = new Uint8Array(MAGIC.length + 1 + packed.byteLength)
  out.set(MAGIC, 0)
  out[MAGIC.length] = VERSION
  out.set(packed, MAGIC.length + 1)
  return out
}

export function decodeTurnBlock(block: Uint8Array): OwnEventRow[] {
  if (!isTurnBlock(block)) throw new TypeError("[STORE]: not a turn block")
  if (block[MAGIC.length] !== VERSION) throw new RangeError(`[STORE]: turn block version ${block[MAGIC.length]} is newer than this build`)
  const plain = Bun.zstdDecompressSync(block.subarray(MAGIC.length + 1))
  const at = { offset: 0 }
  const typeCount = readVarint(plain, at)
  const lengths = Array.from({ length: typeCount }, () => readVarint(plain, at))
  const types = lengths.map((length) => decoder.decode(plain.subarray(at.offset, (at.offset += length))))
  const count = readVarint(plain, at)
  const heads: Array<{ seq: number; at: number; type: string; bytes: number }> = []
  let seq = 0
  let time = 0
  for (let i = 0; i < count; i++) {
    seq += readVarint(plain, at)
    time += unzigzag(readVarint(plain, at))
    const type = types[readVarint(plain, at)]
    if (type === undefined) throw new RangeError("[STORE]: turn block names an unknown type")
    heads.push({ seq, at: time, type, bytes: readVarint(plain, at) })
  }
  const rows = heads.map((head) => ({ seq: head.seq, type: head.type, at: head.at, payload: decoder.decode(plain.subarray(at.offset, (at.offset += head.bytes))) }))
  if (at.offset !== plain.byteLength) throw new RangeError("[STORE]: turn block has trailing bytes")
  return rows
}
