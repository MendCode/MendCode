import { rootCertificates } from "node:tls"
import type { RemoteTransport } from "./index"

/** WebSocket carries exactly the existing newline frames; reconnect/replay stay in createClient. */
export function connectHttpSocket(remote: RemoteTransport, input: { timeoutMs: number; data(data: Uint8Array): void; close(): void }) {
  const url = new URL(remote.httpUrl!)
  url.pathname = "/wire"
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (remote.directory) url.searchParams.set("directory", remote.directory)
  const headers = { Authorization: remote.username ? `Basic ${Buffer.from(`${remote.username}:${remote.token}`).toString("base64")}` : `Bearer ${remote.token}` }
  return new Promise<{ write(data: Uint8Array): number; end(): void; terminate(): void }>((resolve, reject) => {
    const HttpWebSocket = WebSocket as unknown as { new(url: URL, options: Bun.WebSocketOptions): WebSocket }
    const ws = new HttpWebSocket(url, { headers, ...(remote.ca ? { tls: { rejectUnauthorized: true, ca: [...rootCertificates, remote.ca] } } : {}) })
    ws.binaryType = "arraybuffer"
    let opened = false
    const timer = setTimeout(() => { ws.close(); reject(new Error("[CLIENT]: HTTP connection timeout")) }, input.timeoutMs)
    ws.onopen = () => {
      opened = true
      clearTimeout(timer)
      resolve({ write(data) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error("[CLIENT]: HTTP connection closed")
        if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(); throw new Error("[CLIENT]: HTTP output backlog exceeded") }
        ws.send(Uint8Array.from(data).buffer)
        return data.byteLength
      }, end: () => ws.close(), terminate: () => ws.close() })
    }
    ws.onmessage = (event) => input.data(typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer))
    ws.onerror = () => { clearTimeout(timer); if (!opened) { ws.close(); reject(new Error("[CLIENT]: HTTP attach failed (URL, token or TLS)")) } }
    ws.onclose = () => { clearTimeout(timer); if (opened) input.close(); else reject(new Error("[CLIENT]: HTTP attach rejected")) }
  })
}
