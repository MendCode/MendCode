import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { validateSessionHttpListener } from "../src/session-http"
import type { Store } from "@mendcode/store"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const ids = createIdFactory()
async function boot(httpListen?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "b87-http-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let store!: Store
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), ...(httpListen ? { httpListen } : {}), extensionsEnabled: false, log() {}, engine: ({ store: s }) => {
    store = s
    return {
      needsCompaction: () => false,
      async compact() { return { status: "ok" } },
      async runTurn(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "agent_message" })
        input.emit({ type: "item.completed", itemId, status: "ok", text: "fake answer" })
        return { status: "ok" }
      },
      async runShell(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: "shell" } })
        input.emit({ type: "item.completed", itemId, status: "ok", text: `fake shell: ${input.text}` })
        return { status: "ok" }
      },
    }
  } })
  cleanup.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ name: "b87-test", socketPath: daemon.socketPath, onEvent: (event) => events.push(event) })
  cleanup.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  await client.subscribe(sessionId)
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "writer" }).token
  const readonly = tokens.create({ name: "observer", readOnly: true }).token
  const request = (suffix: string, method: string, body?: unknown, extra: Record<string, string> = {}) => daemon.sessionHttp(new Request(`http://127.0.0.1/session/${sessionId}${suffix}`, { method, headers: { authorization: `Bearer ${full}`, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { daemon, client, store, sessionId, full, readonly, tokens, request, events }
}

test("HTTP is off by default, loopback only, bearer-authenticated and denies read-only/browser requests", async () => {
  expect(validateSessionHttpListener(undefined)).toBeUndefined()
  expect(() => validateSessionHttpListener("0.0.0.0:9877")).toThrow("loopback")
  const h = await boot()
  expect(h.daemon.httpPort).toBeUndefined()
  const endpoint = `/message/${ids("item")}`
  expect((await h.request(endpoint, "DELETE", undefined, { authorization: "" })).status).toBe(401)
  expect((await h.request(endpoint, "DELETE", undefined, { authorization: `Bearer ${h.readonly}` })).status).toBe(403)
  expect((await h.request(endpoint, "DELETE", undefined, { origin: "https://example.test" })).status).toBe(403)
  h.tokens.revoke("writer")
  expect((await h.request(endpoint, "DELETE")).status).toBe(401)
})

test("the explicit loopback session listener survives integration and authenticates live requests", async () => {
  const h = await boot("127.0.0.1:0")
  expect(h.daemon.httpPort).toBeGreaterThan(0)
  const url = `http://127.0.0.1:${h.daemon.httpPort}/session/${h.sessionId}/shell`
  const payload = { command: "probe", agent: "build", messageID: ids("item") }
  const request = (token?: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) })
  expect((await request()).status).toBe(401)
  expect((await request(h.readonly)).status).toBe(403)
  const allowed = await request(h.full)
  expect(allowed.status).toBe(200)
  const body = await allowed.text()
  expect(body).toContain("fake shell: probe")
  expect(body).not.toContain(h.full)
})

test("shell uses a local fake, returns completed output and validates payload/agent; all three HTTP mutations work", async () => {
  const h = await boot()
  expect((await h.request("/shell", "POST", { command: "probe" })).status).toBe(400)
  expect((await h.request("/shell", "POST", { command: "probe", agent: "missing" })).status).toBe(400)
  const messageID = ids("item")
  const response = await h.request("/shell", "POST", { command: "probe", agent: "build", messageID })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ info: { role: "assistant", sessionID: h.sessionId }, parts: [{ text: "fake shell: probe" }] })
  expect(h.store.messages.read(h.sessionId, messageID)?.start.kind).toBe("user_message")
  expect((await h.request("/shell", "POST", { command: "probe", agent: "build", messageID })).status).toBe(409)
  const item = h.store.readAfter(h.sessionId, 0).find((event) => event.type === "item.started" && event.kind === "tool_call")!
  if (item.type !== "item.started") throw new Error("missing tool")
  const target = `/message/${item.itemId}`
  const payload = { id: "body", type: "text", sessionID: h.sessionId, messageID: item.itemId, text: "edited output" }
  expect((await h.request(`${target}/part/body`, "PATCH", payload)).status).toBe(403)
  h.store.settings.set({ allowMessageEdits: true })
  const edited = await h.request(`${target}/part/body`, "PATCH", payload)
  expect(edited.status).toBe(200)
  expect(edited.headers.get("etag")).toBe("1")
  expect(await edited.json()).toEqual(payload)
  expect((await h.request(`${target}/part/body`, "PATCH", payload)).status).toBe(409)
  expect((await h.request(`${target}/part/body`, "PATCH", { ...payload, messageID: ids("item") }, { "if-match": "1" })).status).toBe(400)
  expect(await (await h.request(`${target}/part/body`, "DELETE", undefined, { "if-match": "1" })).json()).toBe(true)
  expect(await (await h.request(target, "DELETE", undefined, { "if-match": "2" })).json()).toBe(true)
  expect(h.store.messages.read(h.sessionId, item.itemId)?.deleted).toBe(true)
  expect((await h.request(`${target}/part/body`, "PATCH", payload, { "if-match": "bad" })).status).toBe(400)
  expect((await h.request("/shell", "POST", { agent: "build", command: "x".repeat(85000) })).status).toBe(413)
})

test("typed client mutations cross the daemon protocol and publish live revisions without modifying original events", async () => {
  const h = await boot()
  const turnId = ids("turn")
  const itemId = ids("item")
  h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue") })
  h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId, kind: "agent_message" })
  h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId, status: "ok", text: "original" })
  h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId })
  h.store.settings.set({ allowMessageEdits: true })
  expect((await h.client.updatePart(h.sessionId, itemId, { id: "body", type: "text", text: "revised" })).ok).toBe(true)
  expect((await h.client.deletePart(h.sessionId, itemId, "body", 1)).ok).toBe(true)
  expect((await h.client.deleteMessage(h.sessionId, itemId, 2)).ok).toBe(true)
  expect(h.events.filter((event) => event.type === "message.revised")).toHaveLength(3)
  expect(h.store.readAfter(h.sessionId, 0).find((event) => event.type === "item.completed")).toMatchObject({ text: "original" })
  expect((await h.client.loadWindow(h.sessionId)).ok).toBe(true)
})
