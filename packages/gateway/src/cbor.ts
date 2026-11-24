/**
 * The CBOR subset WebAuthn needs (RFC 8949): unsigned and negative integers, byte and text strings, arrays, maps and
 * true/false/null. Definite lengths only; tags, floats and indefinite lengths are refused, as are duplicate map keys,
 * nesting deeper than 8 and more than 4096 items. A malformed input throws; nothing is ever partially accepted.
 */
export type CborValue = number | string | Uint8Array | boolean | null | CborValue[] | Map<number | string, CborValue>

const MAX_DEPTH = 8
const MAX_ITEMS = 4096

export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = offset
  let items = 0
  const need = (count: number) => {
    if (count < 0 || at + count > bytes.byteLength) throw new RangeError("[CBOR]: truncated input")
  }
  function argument(info: number): number {
    if (info < 24) return info
    if (info === 24) { need(1); return bytes[at++]! }
    if (info === 25) { need(2); const value = view.getUint16(at); at += 2; return value }
    if (info === 26) { need(4); const value = view.getUint32(at); at += 4; return value }
    if (info === 27) {
      need(8)
      const high = view.getUint32(at), low = view.getUint32(at + 4)
      at += 8
      if (high > 0x1fffff) throw new RangeError("[CBOR]: integer too large")
      return high * 2 ** 32 + low
    }
    throw new TypeError("[CBOR]: indefinite or reserved length")
  }
  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new RangeError("[CBOR]: nesting too deep")
    if (++items > MAX_ITEMS) throw new RangeError("[CBOR]: too many items")
    need(1)
    const initial = bytes[at++]!
    const major = initial >> 5, info = initial & 31
    if (major === 7) {
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      throw new TypeError("[CBOR]: unsupported simple value or float")
    }
    if (major === 6) throw new TypeError("[CBOR]: tags are not accepted")
    const length = argument(info)
    if (major === 0) return length
    if (major === 1) return -1 - length
    if (major === 2 || major === 3) {
      need(length)
      const slice = bytes.slice(at, at + length)
      at += length
      if (major === 2) return slice
      try { return new TextDecoder("utf-8", { fatal: true }).decode(slice) } catch { throw new TypeError("[CBOR]: invalid UTF-8 text") }
    }
    if (major === 4) {
      if (length > MAX_ITEMS) throw new RangeError("[CBOR]: array too long")
      const list: CborValue[] = []
      for (let i = 0; i < length; i++) list.push(item(depth + 1))
      return list
    }
    // major 5: a map; keys are integers or text, each at most once.
    if (length > MAX_ITEMS) throw new RangeError("[CBOR]: map too long")
    const map = new Map<number | string, CborValue>()
    for (let i = 0; i < length; i++) {
      const key = item(depth + 1)
      if (typeof key !== "number" && typeof key !== "string") throw new TypeError("[CBOR]: map keys must be integers or text")
      if (map.has(key)) throw new TypeError("[CBOR]: duplicate map key")
      map.set(key, item(depth + 1))
    }
    return map
  }
  const value = item(0)
  return { value, end: at }
}

/** One whole CBOR item, with no bytes after it. */
export function decodeCborExact(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCbor(bytes)
  if (end !== bytes.byteLength) throw new TypeError("[CBOR]: trailing bytes")
  return value
}
