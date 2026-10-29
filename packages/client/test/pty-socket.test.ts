import { afterEach, expect, test } from "bun:test"
import { connectPtySocket, ptyConnectUrl } from "../src/pty-socket"
import type { RemoteTransport } from "../src/index"

const remote: RemoteTransport = { httpUrl: "http://127.0.0.1:4096/", hostname: "127.0.0.1", port: 4096, token: "owner-token", directory: "/work/project" }
const input = { ptyId: `pty_${"a".repeat(32)}`, ticket: "one-use-ticket" }
const native = globalThis.WebSocket
afterEach(() => { globalThis.WebSocket = native })

test("PTY socket URLs carry only scoped tickets, directory and valid cursors", () => {
  const url = ptyConnectUrl(remote, { ...input, cursor: 7 })
  expect(url.protocol).toBe("ws:")
  expect(url.pathname).toBe(`/pty/${input.ptyId}/connect`)
  expect(url.searchParams.get("ticket")).toBe(input.ticket)
  expect(url.searchParams.get("directory")).toBe(remote.directory!)
  expect(url.searchParams.get("cursor")).toBe("7")
  expect(url.toString()).not.toContain(remote.token)
  expect(ptyConnectUrl({ ...remote, httpUrl: "https://server.example/" }, { ...input, cursor: -1 }).protocol).toBe("wss:")
  for (const value of ["http://user:private-secret@localhost:4096/", "http://server.example/", "http://localhost:4096/path", "http://localhost:4096/?token=private-secret", "file:///tmp/pty"]) {
    try { ptyConnectUrl({ ...remote, httpUrl: value }, input); throw new Error("accepted") }
    catch (error) { expect(String(error)).not.toContain("private-secret"); expect(String(error)).not.toContain("accepted") }
  }
  for (const cursor of [NaN, -2, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => ptyConnectUrl(remote, { ...input, cursor })).toThrow("invalid PTY cursor")
})

test("PTY client separates text from binary cursor, tracks live UTF-16 offset and bounds input without a network", async () => {
  let socket!: FakeSocket
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    binaryType = "arraybuffer"
    onopen?: () => void
    onmessage?: (event: { data: string | ArrayBuffer }) => void
    onclose?: () => void
    onerror?: () => void
    writes: string[] = []
    closes: number[] = []
    constructor(readonly url: URL, readonly options: Bun.WebSocketOptions) { socket = this; queueMicrotask(() => this.onopen?.()) }
    send(data: string) { this.writes.push(data) }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.closes.push(code); this.onclose?.() }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const output: string[] = [], cursors: number[] = []
  let closed = 0
  const client = await connectPtySocket(remote, { ...input, timeoutMs: 100, onData: (text) => { output.push(text) }, onCursor: (cursor) => { cursors.push(cursor) }, onClose: () => { closed++ } })
  expect(socket.options.headers).toBeUndefined()
  socket.onmessage?.({ data: "retained" })
  const json = new TextEncoder().encode(JSON.stringify({ cursor: 90 }))
  const control = new Uint8Array(json.length + 1)
  control.set(json, 1)
  socket.onmessage?.({ data: control.buffer })
  socket.onmessage?.({ data: "🌿" })
  expect(output).toEqual(["retained", "🌿"])
  expect(cursors).toEqual([90])
  expect(client.cursor).toBe(92)
  client.write("echo test\n")
  expect(socket.writes).toEqual(["echo test\n"])
  expect(() => client.write("x".repeat(128 * 1024 + 1))).toThrow("output unavailable")
  socket.bufferedAmount = 128 * 1024
  expect(() => client.write("x")).toThrow("output unavailable")
  socket.onmessage?.({ data: new Uint8Array([0, 123]).buffer })
  expect(socket.closes).toEqual([1008])
  expect(closed).toBe(1)
  expect(() => client.write("x")).toThrow("output unavailable")
})

test("PTY socket failure and deadline settle with terse errors that contain no ticket", async () => {
  class Refused {
    static OPEN = 1
    onopen?: () => void
    onmessage?: () => void
    onclose?: () => void
    onerror?: () => void
    constructor() { queueMicrotask(() => this.onclose?.()) }
    close() {}
  }
  globalThis.WebSocket = Refused as unknown as typeof WebSocket
  await expect(connectPtySocket(remote, { ...input, timeoutMs: 100, onData() {} })).rejects.toThrow("PTY connection closed")
  // A transport that never opens or emits events exercises the helper's own deadline.
  globalThis.WebSocket = class { close() {} } as unknown as typeof WebSocket
  await expect(connectPtySocket(remote, { ...input, timeoutMs: 1, onData() {} })).rejects.toThrow("PTY connection rejected")
})
