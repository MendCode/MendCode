import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { realpathSync } from "node:fs"
import { createFauxEngine } from "../../engine-faux/src/index"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../../daemon/src/daemon"
import { remoteTokens } from "../../daemon/src/remote"
import { createClient } from "../src/index"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
async function boot() {
  const dir = tempDir(), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir)
  const token = tokens.create({ name: "laptop" }).token
  const observer = tokens.create({ name: "viewer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const adapter = daemon.httpAdapter!
  cleanup.push(() => daemon.stop())
  const requests: Array<{ url: string; authorization: string }> = []
  const NativeWebSocket = globalThis.WebSocket
  class LocalWebSocket {
    static OPEN = 1
    readyState = 0
    bufferedAmount = 0
    binaryType = "arraybuffer"
    onopen?: () => void
    onmessage?: (event: { data: ArrayBuffer }) => void
    onerror?: () => void
    onclose?: () => void
    private peer?: Bun.ServerWebSocket<any>
    constructor(url: URL, options: Bun.WebSocketOptions) {
      const address = new URL(url)
      address.protocol = address.protocol === "wss:" ? "https:" : "http:"
      const authorization = String(options.headers?.Authorization)
      requests.push({ url: address.toString(), authorization })
      queueMicrotask(async () => {
        const server = { requestIP: () => ({ address: "local-test" }), upgrade: (_request: Request, options: { data: unknown }) => {
          this.peer = { data: options.data, send: (data: Uint8Array) => { const copy = Uint8Array.from(data).buffer; queueMicrotask(() => this.onmessage?.({ data: copy })); return data.byteLength }, close: () => this.close() } as Bun.ServerWebSocket<any>
          return true
        } } as unknown as Parameters<typeof adapter.fetch>[1]
        const response = await adapter.fetch(new Request(address, { headers: { Authorization: authorization } }), server)
        if (response) { this.onerror?.(); this.close(); return }
        this.readyState = 1
        adapter.websocket.open(this.peer!)
        this.onopen?.()
      })
    }
    send(data: ArrayBuffer) { adapter.websocket.message(this.peer!, Buffer.from(data)) }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      if (this.peer) adapter.websocket.close(this.peer)
      this.onclose?.()
    }
  }
  globalThis.WebSocket = LocalWebSocket as unknown as typeof WebSocket
  cleanup.push(() => { globalThis.WebSocket = NativeWebSocket })
  const events: SessionEvent[] = []
  function client(value = token, extra: { directory?: string; username?: string; reconnect?: boolean } = {}) {
    const { reconnect, ...remote } = extra
    const client = createClient({ name: "http-local-test", remote: { httpUrl: "http://127.0.0.1:4096/", hostname: "127.0.0.1", port: 4096, token: value, ...remote }, ...(reconnect === undefined ? {} : { reconnect }), onEvent: (event) => events.push(event), timeoutMs: 1000 })
    cleanup.push(() => client.close())
    return client
  }
  return { client, daemon, token, observer, project, requests, events, tokens }
}
async function until(check: () => boolean) {
  const end = Date.now() + 1000
  while (!check()) { if (Date.now() > end) throw new Error("local HTTP event deadline"); await Bun.sleep(2) }
}

test("HTTP WebSocket client uses hello, subscriptions, live turns and reconnect cursors without network", async () => {
  const h = await boot()
  const client = h.client()
  await client.connect()
  expect(client.daemonDirectory).toBe(h.project)
  expect(client.remoteInfo).toEqual({ readOnly: false, tokenName: "laptop" })
  const reply = await client.send({ type: "session.create", directory: h.project })
  expect(reply.ok).toBe(true)
  const sessionId = reply.ok ? reply.result!.sessionId as SessionId : createIdFactory()("session")
  await client.subscribe(sessionId)
  expect((await client.send({ type: "user.submit", sessionId, text: "inspect HTTP", attachments: [] })).ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  const cursor = client.cursor(sessionId)!
  client.dropConnection()
  expect((await client.send({ type: "session.get", sessionId })).ok).toBe(true)
  expect(h.requests).toHaveLength(2)
  expect(client.cursor(sessionId)).toBe(cursor)
  expect(new Set(h.events.map((event) => event.seq)).size).toBe(h.events.length)
})

test("HTTP Basic token auth and project directory selection use headers, never URL credentials", async () => {
  const h = await boot(), project = realpathSync(tempDir())
  const local = h.client()
  await local.connect()
  const registered = await local.registerWorkspace("review", project)
  expect(registered.ok).toBe(true)
  expect((await local.workspaces("adapters")).ok).toBe(true)
  const client = h.client(h.token, { directory: project, username: "mendcode" })
  await client.connect()
  expect(client.daemonDirectory).toBe(project)
  const request = h.requests[1]!
  expect(request.authorization.startsWith("Basic ")).toBe(true)
  expect(request.url).not.toContain(h.token)
  expect(new URL(request.url).username).toBe("")
  expect(new URL(request.url).searchParams.get("directory")).toBe(project)
})

test("HTTP read-only denial and token revocation retain wire semantics", async () => {
  const h = await boot()
  const client = h.client(h.observer, { reconnect: false })
  await client.connect()
  expect(client.remoteInfo?.readOnly).toBe(true)
  expect(await client.send({ type: "session.create", directory: h.project })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await client.workspaces()).toMatchObject({ ok: false, error: { code: "forbidden" } })
  h.tokens.revoke("viewer")
  const result = await client.send({ type: "session.list" })
  expect(result.ok).toBe(false)
})
