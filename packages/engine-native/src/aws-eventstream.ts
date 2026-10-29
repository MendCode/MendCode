/** AWS event-stream framing (binary headers + JSON payload), including both CRC32 checks. */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0) }
  return (value ^ 0xffffffff) >>> 0
}

const MAX_FRAME = 8 * 1024 * 1024
export async function* awsEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, touch: () => void): AsyncIterable<{ type: string; exception: boolean; payload: Record<string, any> }> {
  const reader = body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  let buffer = Buffer.alloc(0)
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done) break
      touch()
      buffer = Buffer.concat([buffer, next.value])
      while (buffer.length >= 12) {
        const total = buffer.readUInt32BE(0), headerSize = buffer.readUInt32BE(4)
        if (total < 16 || total > MAX_FRAME || headerSize > total - 16 || buffer.readUInt32BE(8) !== crc32(buffer.subarray(0, 8))) throw new Error("[PROVIDER]: invalid AWS event-stream prelude")
        if (buffer.length < total) break
        const frame = buffer.subarray(0, total)
        if (frame.readUInt32BE(total - 4) !== crc32(frame.subarray(0, total - 4))) throw new Error("[PROVIDER]: AWS event-stream checksum mismatch")
        const headers: Record<string, string> = {}
        let offset = 12
        const end = offset + headerSize
        while (offset < end) {
          const size = frame[offset++]!
          if (offset + size + 1 > end) throw new Error("[PROVIDER]: invalid AWS event header")
          const name = frame.subarray(offset, offset + size).toString("utf8")
          offset += size
          const kind = frame[offset++]!
          let length = [0, 0, 1, 2, 4, 8, -1, -1, 8, 16][kind]
          if (length === undefined) throw new Error("[PROVIDER]: invalid AWS event header type")
          if (length === -1) {
            if (offset + 2 > end) throw new Error("[PROVIDER]: truncated AWS event header")
            length = frame.readUInt16BE(offset)
            offset += 2
          }
          if (offset + length > end) throw new Error("[PROVIDER]: truncated AWS event header")
          if (kind === 7) headers[name] = frame.subarray(offset, offset + length).toString("utf8")
          offset += length
        }
        let payload: Record<string, any>
        try { payload = JSON.parse(frame.subarray(end, total - 4).toString("utf8")) } catch { throw new Error("[PROVIDER]: invalid AWS event payload") }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("[PROVIDER]: invalid AWS event payload")
        const type = headers[":event-type"] ?? headers[":exception-type"] ?? headers[":error-code"]
        if (!type) throw new Error("[PROVIDER]: AWS event has no type")
        yield { type, exception: ["exception", "error"].includes(headers[":message-type"] ?? ""), payload }
        buffer = buffer.subarray(total)
      }
    }
    if (buffer.length && !signal.aborted) throw new Error("[PROVIDER]: truncated AWS event stream")
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
