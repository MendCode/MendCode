import { rootCertificates } from "node:tls"
import type { RemoteTransport } from "./index"

export function ptyConnectUrl(remote: RemoteTransport, input: { ptyId: string; ticket: string; directory?: string; cursor?: number }) {
  let url: URL
  try { url = new URL(remote.httpUrl!) } catch { throw new Error("[CLIENT]: PTY requires an HTTP connection") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("[CLIENT]: invalid PTY server URL")
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("[CLIENT]: PTY HTTP requires loopback")
  if (!/^pty_[a-f0-9]{32}$/.test(input.ptyId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ticket)) throw new Error("[CLIENT]: invalid PTY connection")
  if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < -1)) throw new Error("[CLIENT]: invalid PTY cursor")
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = `/pty/${input.ptyId}/connect`
  url.searchParams.set("ticket", input.ticket)
  const directory = input.directory ?? remote.directory
  if (directory) url.searchParams.set("directory", directory)
  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))
  return url
}

/** Reopen with a fresh ticket and the returned cursor; terminal traffic stays separate from v2 frames. */
export function connectPtySocket(remote: RemoteTransport, input: { ptyId: string; ticket: string; directory?: string; cursor?: number; timeoutMs?: number; onData(text: string): void; onCursor?(cursor: number): void; onClose?(): void }) {
  const url = ptyConnectUrl(remote, input)
  return new Promise<{ write(data: string): void; close(): void; readonly cursor: number }>((resolve, reject) => {
    const PtyWebSocket = WebSocket as unknown as { new(url: URL, options: Bun.WebSocketOptions): WebSocket }
    const ws = new PtyWebSocket(url, { ...(remote.ca ? { tls: { rejectUnauthorized: true, ca: [...rootCertificates, remote.ca] } } : {}) })
    ws.binaryType = "arraybuffer"
    let opened = false
    let cursor = Math.max(0, input.cursor ?? 0)
    const fail = () => { clearTimeout(timer); ws.close(); reject(new Error("[CLIENT]: PTY connection rejected")) }
    const timer = setTimeout(fail, input.timeoutMs ?? 15_000)
    ws.onopen = () => {
      opened = true
      clearTimeout(timer)
      resolve({
        write(data) {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(data) > 128 * 1024) throw new Error("[CLIENT]: PTY output unavailable")
          ws.send(data)
        },
        close: () => ws.close(),
        get cursor() { return cursor },
      })
    }
    ws.onmessage = (event) => {
      if (typeof event.data === "string") { cursor += event.data.length; input.onData(event.data); return }
      const data = new Uint8Array(event.data as ArrayBuffer)
      if (data[0] !== 0) { ws.close(1008, "Invalid PTY frame"); return }
      try {
        const value = JSON.parse(new TextDecoder().decode(data.subarray(1)))
        if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error()
        cursor = value.cursor
        input.onCursor?.(cursor)
      } catch { ws.close(1008, "Invalid PTY cursor") }
    }
    ws.onerror = () => { if (!opened) fail(); else ws.close() }
    ws.onclose = () => { clearTimeout(timer); if (opened) input.onClose?.(); else reject(new Error("[CLIENT]: PTY connection closed")) }
  })
}
