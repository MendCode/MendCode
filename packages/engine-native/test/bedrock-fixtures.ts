/** Local AWS binary frames; fixture CRC is table-based, independent of the adapter's bitwise decoder. */
const table = Array.from({ length: 256 }, (_, i) => {
  let value = i
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc = (bytes: Uint8Array) => { let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0 }
export function bedrockFrame(type: string, payload: unknown, exception = false): Buffer {
  const header = (name: string, value: string) => {
    const prefix = Buffer.from([name.length]), size = Buffer.alloc(2)
    size.writeUInt16BE(Buffer.byteLength(value))
    return Buffer.concat([prefix, Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)])
  }
  const headers = Buffer.concat([header(":message-type", exception ? "exception" : "event"), header(exception ? ":exception-type" : ":event-type", type), header(":content-type", "application/json")])
  const body = Buffer.from(JSON.stringify(payload))
  const frame = Buffer.alloc(headers.length + body.length + 16)
  frame.writeUInt32BE(frame.length)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc(frame.subarray(0, -4)), frame.length - 4)
  return frame
}
export const bedrockFinish = (reason = "end_turn") => [
  bedrockFrame("messageStop", { stopReason: reason }),
  bedrockFrame("metadata", { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60, cacheWriteInputTokens: 30 } }),
]
export function bedrockResponse(frames = [bedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ok" } }), ...bedrockFinish()], chunk = 17) {
  const bytes = Buffer.concat(frames)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.subarray(offset, offset += chunk)) } }), { headers: { "content-type": "application/vnd.amazon.eventstream" } })
}
