const HEADER_END = Buffer.from("\r\n\r\n")
const MAX_HEADER_BYTES = 8 * 1024
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** Encodes one JSON-RPC message with LSP `Content-Length` framing. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

/** Incremental decoder: chunks may split a message anywhere or carry several messages. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /** Returns every complete, parseable message in the bytes seen so far; malformed frames are skipped. */
  push(chunk: Uint8Array): unknown[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.buffer = Buffer.alloc(0)
        break
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const length = /content-length:\s*(\d+)/i.exec(header)?.[1]
      const bodyStart = headerEnd + HEADER_END.length
      if (length === undefined || Number(length) > MAX_BODY_BYTES) {
        this.buffer = this.buffer.subarray(bodyStart)
        continue
      }
      const bodyEnd = bodyStart + Number(length)
      if (this.buffer.length < bodyEnd) break
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")
      this.buffer = this.buffer.subarray(bodyEnd)
      try {
        messages.push(JSON.parse(body))
      } catch {
        /* skip a malformed body; framing stays in sync */
      }
    }
    return messages
  }
}
