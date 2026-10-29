import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { RestMessageDto, RestSessionDto, createIdFactory, type ItemId, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { summarizeSnapshots } from "../src/snapshot-diff"
import { httpOpenApi } from "../src/http"
import { createSessionPermissionRules } from "../src/session-permission-rules"

const ids = createIdFactory()
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b81-"))), project = path.join(dir, "project")
  mkdirSync(project)
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const tokens = remoteTokens(dir)
  const token = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, http: { enabled: true }, httpListen: false,
    models: { selectable: true, list: () => [{ id: "echo", name: "Echo", efforts: [], provider: "faux" }, { id: "echo2", name: "Echo 2", efforts: [], provider: "faux" }], defaults: { model: "echo" } },
    engine: ({ clock }) => ({
      ...createFauxEngine({ clock, deltaMs: 1 }),
      async runShell(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: "shell" } })
        input.emit({ type: "item.completed", itemId, status: "ok", text: `shell: ${input.text}` })
        return { status: "ok" }
      },
    }),
  })
  cleanup.push(() => daemon.stop())
  const request = async (route: string, options: { method?: string; value?: unknown; token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${options.token ?? token}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
    if (!response) throw new Error("unexpected upgrade")
    return response
  }
  const create = async (title = "Session", parentID?: SessionId) => {
    const response = await request("/session", { value: { title, ...(parentID ? { parentID } : {}) } })
    expect(response.status).toBe(200)
    const value = await response.json()
    RestSessionDto.parse(value)
    return value as { id: SessionId; time: { created: number; updated: number } }
  }
  const prompt = (sessionId: SessionId, text: string, async = false) => request(`/session/${sessionId}/${async ? "prompt_async" : "message"}`, { value: { parts: [{ type: "text", text }] } })
  return { daemon, request, create, prompt, dir, project, token, observer }
}
async function until(check: () => boolean) {
  const end = Date.now() + 1_000
  while (!check()) { if (Date.now() > end) throw new Error("B81 local event deadline"); await Bun.sleep(2) }
}

test("B81 REST create/get/list/children/status/update/delete use donor response shapes, with persisted archive", async () => {
  const h = await boot(), root = await h.create("Root"), child = await h.create("Child", root.id)
  expect(await (await h.request(`/session/${child.id}`)).json()).toMatchObject({ id: child.id, parentID: root.id, version: "0.0.1-dev" })
  expect(await (await h.request(`/session/${root.id}/children`)).json()).toMatchObject([{ id: child.id }])
  expect(await (await h.request("/session?roots=true&search=Root")).json()).toMatchObject([{ id: root.id }])
  expect(await (await h.request("/session/status")).json()).toMatchObject({ [root.id]: { type: "idle" }, [child.id]: { type: "idle" } })
  expect(await (await h.request("/session/agent-view")).json()).toMatchObject([{ sessionID: child.id }, { sessionID: root.id }])
  const patched = await h.request(`/session/${root.id}`, { method: "PATCH", value: { title: "Renamed", time: { archived: 1 } } })
  expect(await patched.json()).toMatchObject({ id: root.id, title: "Renamed", time: { archived: 1 } })
  expect(statSync(path.join(h.dir, "session-rest.json")).mode & 0o777).toBe(0o600)
  expect(await (await h.request("/session?roots=true")).json()).toEqual([])
  expect((await (await h.request("/experimental/session?archived=true")).json()).find((row: { id: string }) => row.id === root.id)).toMatchObject({ id: root.id, project: { id: expect.any(String) } })
  await h.request(`/session/${root.id}`, { method: "PATCH", value: { time: { archived: null } } })
  expect(await (await h.request(`/session/${child.id}`, { method: "DELETE" })).json()).toBe(true)
  expect((await h.request(`/session/${child.id}`)).status).toBe(404)
})

test("R9 session permission rules are set on create/update, listed on the session, private, cleared with [] and removed with the session", async () => {
  const h = await boot()
  const rules = [{ permission: "shell", pattern: "rm *", action: "deny" }, { permission: "edit", pattern: "docs/*", action: "allow" }]
  const created = await h.request("/session", { value: { title: "Ruled", permission: rules } })
  expect(created.status).toBe(200)
  const session = await created.json()
  expect(session.permission).toEqual(rules)
  RestSessionDto.parse(session)
  const file = path.join(h.dir, "session-permissions.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [session.id]: rules })
  const replaced = await h.request(`/session/${session.id}`, { method: "PATCH", value: { permission: [{ permission: "*", pattern: "*", action: "ask" }], title: "Ruled 2" } })
  expect((await replaced.json())).toMatchObject({ title: "Ruled 2", permission: [{ permission: "*", pattern: "*", action: "ask" }] })
  expect((await h.request(`/session/${session.id}`, { method: "PATCH", value: { permission: [{ permission: "shell", pattern: "*", action: "maybe" }] } })).status).toBe(400)
  expect((await (await h.request(`/session/${session.id}`)).json()).permission).toEqual([{ permission: "*", pattern: "*", action: "ask" }])
  expect((await h.request("/session", { value: { permission: Array.from({ length: 501 }, () => rules[0]) } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}`, { method: "PATCH", value: { permission: [{ permission: "shell", pattern: "*", action: "deny" }] }, token: h.observer })).status).toBe(403)
  const cleared = await h.request(`/session/${session.id}`, { method: "PATCH", value: { permission: [] } })
  expect(await cleared.json()).not.toHaveProperty("permission")
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({})
  const second = await (await h.request("/session", { value: { permission: rules } })).json()
  expect((await h.request(`/session/${second.id}`, { method: "DELETE" })).status).toBe(200)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({})
})

test("R9 child sessions inherit the rules of their ancestors, with the child's own rules last", () => {
  const parents = new Map<string, string>([["ses_child", "ses_parent"], ["ses_loop", "ses_loop"]])
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-r9-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = createSessionPermissionRules({ dir, parentOf: (id) => parents.get(id) as SessionId | undefined })
  expect(store.effective("ses_child" as SessionId)).toEqual([])
  store.set("ses_parent" as SessionId, [{ permission: "shell", pattern: "*", action: "deny" }])
  store.set("ses_child" as SessionId, [{ permission: "shell", pattern: "ls", action: "allow" }])
  store.set("ses_loop" as SessionId, [{ permission: "edit", pattern: "*", action: "ask" }])
  expect(store.effective("ses_child" as SessionId).map((rule) => rule.action)).toEqual(["deny", "allow"])
  expect(store.effective("ses_loop" as SessionId)).toHaveLength(1)
  expect(createSessionPermissionRules({ dir, parentOf: () => undefined }).own("ses_parent" as SessionId)).toEqual([{ permission: "shell", pattern: "*", action: "deny" }])
})

test("B81 v2 session pagination preserves order and filters, crosses pages without duplicates, binds cursors", async () => {
  const h = await boot()
  for (let i = 0; i < 5; i++) await h.create(`Find ${i}`)
  const first = await (await h.request("/api/session?limit=2&order=asc&search=Find")).json()
  const next = await (await h.request(`/api/session?limit=2&cursor=${encodeURIComponent(first.cursor.next)}`)).json()
  expect(first.items.map((item: { title: string }) => item.title)).toEqual(["Find 0", "Find 1"])
  expect(next.items.map((item: { title: string }) => item.title)).toEqual(["Find 2", "Find 3"])
  const previous = await (await h.request(`/api/session?limit=2&cursor=${encodeURIComponent(next.cursor.previous)}`)).json()
  expect(previous.items).toEqual(first.items)
  const last = await (await h.request(`/api/session?limit=2&cursor=${encodeURIComponent(next.cursor.next)}`)).json()
  expect(last.items).toHaveLength(1)
  expect(last.cursor.next).toBeUndefined()
  expect((await h.request(`/api/session?cursor=${first.cursor.next}&order=desc`)).status).toBe(400)
  expect((await h.request("/api/session?cursor=invalid")).status).toBe(400)
  const defaultList = await (await h.request("/session?limit=2")).json()
  expect(defaultList.map((item: { title: string }) => item.title)).toEqual(["Find 4", "Find 3"])
})

test("B81 synchronous and async prompts, message projections/cursors, v2 context and wait, unknown messages", async () => {
  const h = await boot(), session = await h.create()
  const answer = await h.prompt(session.id, "first")
  expect(answer.status).toBe(200)
  expect(await answer.json()).toMatchObject({ info: { role: "assistant", sessionID: session.id, finish: "stop" }, parts: [{ type: "step-start" }, { type: "text", text: "echo: first" }, { type: "step-finish", reason: "stop" }] })
  expect((await h.prompt(session.id, "second", true)).status).toBe(204)
  expect((await h.request(`/api/session/${session.id}/wait`, { method: "POST" })).status).toBe(204)
  const recent = await h.request(`/session/${session.id}/message?limit=2`)
  const rows = await recent.json()
  for (const row of rows) RestMessageDto.parse(row)
  expect(rows.map((item: { info: { role: string } }) => item.info.role)).toEqual(["user", "assistant"])
  expect(rows[0].parts[0].text).toBe("second")
  expect(await (await h.request(`/session/${session.id}/message?limit=1&unit=turn`)).json()).toHaveLength(2)
  const before = recent.headers.get("x-older-cursor")!
  const earlier = await (await h.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(before)}`)).json()
  expect(earlier[0].parts[0].text).toBe("first")
  expect(await (await h.request(`/session/${session.id}/message/${earlier[0].info.id}`)).json()).toEqual(earlier[0])
  expect((await h.request(`/session/${session.id}/message/${ids("item")}`)).status).toBe(404)
  const api = await (await h.request(`/api/session/${session.id}/message?limit=1&order=asc`)).json()
  expect(api.items[0]).toMatchObject({ type: "user", text: "first" })
  const next = await (await h.request(`/api/session/${session.id}/message?limit=1&cursor=${api.cursor.next}`)).json()
  expect(next.items[0]).toMatchObject({ type: "assistant", content: [{ type: "text", text: "echo: first" }] })
  expect(await (await h.request(`/api/session/${session.id}/context`)).json()).toHaveLength(4)
  expect((await h.request(`/api/session/${session.id}/prompt`, { value: { prompt: { text: "third" } } })).status).toBe(200)
})

test("B81 cancellation targets one turn, abort is idempotent, interrupt promotes the oldest queue", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "/hang", true)
  await until(() => !!h.daemon.store.turns.list(session.id).at(-1)?.itemId)
  const target = h.daemon.store.turns.list(session.id).at(-1)!.itemId as ItemId
  expect(await (await h.request(`/session/${session.id}/cancel-turn`, { value: { targetMessageID: ids("item") } })).json()).toBe("target_mismatch")
  expect(h.daemon.store.sessionsWithActiveTurn()).toHaveLength(1)
  expect(await (await h.request(`/session/${session.id}/cancel-turn`, { value: { targetMessageID: target } })).json()).toBe("cancelled")
  await until(() => h.daemon.store.lastTurnStatus(session.id) === "cancelled")
  expect(await (await h.request(`/session/${session.id}/cancel-turn`, { value: { targetMessageID: target } })).json()).toBe("already_terminal")
  expect(await (await h.request(`/session/${session.id}/abort`, { method: "POST" })).json()).toBe(true)
  await h.prompt(session.id, "/hang", true)
  await h.prompt(session.id, "queued", true)
  expect(await (await h.request(`/session/${session.id}/interrupt`, { method: "POST" })).json()).toBe(true)
  expect((await h.request(`/api/session/${session.id}/wait`, { method: "POST" })).status).toBe(204)
  const rows = await (await h.request(`/session/${session.id}/message`)).json()
  expect(rows.at(-1).parts.find((part: { type: string }) => part.type === "text").text).toBe("echo: queued")
})

test("B81 waits settle on disconnect and helper deadlines without leaking HTTP connections", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "/hang", true)
  const abort = new AbortController()
  const pending = h.request(`/api/session/${session.id}/wait`, { method: "POST", signal: abort.signal })
  await until(() => h.daemon.connections() > 0)
  abort.abort()
  expect((await pending).status).toBe(400)
  await until(() => h.daemon.connections() === 0)
  const client = createClient({ name: "B81 helper", socketPath: h.daemon.socketPath, timeoutMs: 500 })
  cleanup.push(() => client.close())
  await client.connect()
  expect(await client.restSessions(h.project, { operation: "get", sessionId: session.id })).toMatchObject({ ok: true, result: { value: { id: session.id } } })
  expect(await client.updateRestSession(session.id, { title: "Helper" })).toMatchObject({ ok: true, result: { value: { title: "Helper" } } })
  expect(await client.controlRestSession(session.id, { operation: "wait", timeoutMs: 5 })).toMatchObject({ ok: false, error: { code: "busy" } })
})

test("B81 fork/revert/unrevert retain v2 history invariants and permission response resolves an actual request", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "one")
  await h.prompt(session.id, "two")
  const rows = await (await h.request(`/session/${session.id}/message`)).json()
  const fork = await (await h.request(`/session/${session.id}/fork`, { value: { messageID: rows[2].info.id } })).json()
  expect(fork.id).not.toBe(session.id)
  const forked = await (await h.request(`/session/${fork.id}/message`)).json()
  expect(forked).toHaveLength(2)
  expect(forked[0].parts[0].text).toBe("one")
  expect((await h.request(`/session/${session.id}/revert`, { value: { messageID: rows[2].info.id } })).status).toBe(200)
  expect(await (await h.request(`/session/${session.id}/message`)).json()).toHaveLength(2)
  expect((await h.request(`/session/${session.id}/unrevert`, { method: "POST" })).status).toBe(200)
  expect(await (await h.request(`/session/${session.id}/message`)).json()).toHaveLength(4)
  await h.prompt(session.id, "/ask", true)
  await until(() => h.daemon.store.pendingRequestsOf(session.id).length > 0)
  const requestId = h.daemon.store.pendingRequestsOf(session.id)[0]!.requestId
  expect(await (await h.request(`/session/${session.id}/permissions/${requestId}`, { value: { response: "once" } })).json()).toBe(true)
  expect((await h.request(`/api/session/${session.id}/wait`, { method: "POST" })).status).toBe(204)
}, 15_000)

test("B81 todos/diff and usage use observed data, redact historical content, never expose raw secrets", async () => {
  const h = await boot(), session = await h.create(), store = h.daemon.store
  const secret = `sk-proj-${"AbC123xY".repeat(5)}`
  const turnId = ids("turn"), user = ids("item"), tool = ids("item")
  store.sessionSink.append({ type: "turn.started", sessionId: session.id, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: user, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: user, status: "ok", text: secret })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: tool, kind: "tool_call", meta: { tool: "todo" } })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: tool, status: "ok", text: "todo", toolInput: JSON.stringify({ items: [{ text: "Verify", status: "done", priority: "high" }] }) })
  store.sessionSink.append({ type: "turn.completed", sessionId: session.id, turnId })
  expect(await (await h.request(`/session/${session.id}/todo`)).json()).toEqual([{ content: "Verify", status: "completed", priority: "high" }])
  expect(await (await h.request(`/session/${session.id}/diff`)).json()).toEqual([])
  expect(await (await h.request(`/session/${session.id}/message`)).text()).not.toContain(secret)
  await h.prompt(session.id, "/usage")
  const usage = await (await h.request("/experimental/usage-insights?start=0")).json()
  expect(usage.topModels).toMatchObject([{ name: "faux/echo" }])
  expect(usage.totals.tokens).toBe(18)
  expect(usage.totals.userMessages).toBe(2)
  expect((await h.request("/experimental/usage-insights")).status).toBe(400)
})

test("B81 commands/init/compaction use the daemon engine; unsupported options fail without changing state", async () => {
  const h = await boot(), session = await h.create()
  mkdirSync(path.join(h.project, ".mendcode", "commands"), { recursive: true })
  writeFileSync(path.join(h.project, ".mendcode", "commands", "check.md"), "Inspect $ARGUMENTS")
  const command = await h.request(`/session/${session.id}/command`, { value: { command: "check", arguments: "parser" } })
  expect(command.status).toBe(200)
  expect((await command.json()).parts.find((part: { type: string }) => part.type === "text").text).toBe("echo: Inspect parser")
  expect((await h.request(`/session/${session.id}/init`, { value: { providerID: "faux", modelID: "echo", messageID: ids("item") } })).status).toBe(200)
  expect((await h.request(`/api/session/${session.id}/compact`, { method: "POST" })).status).toBe(204)
  expect((await h.request(`/session/${session.id}/summarize`, { value: { providerID: "faux", modelID: "echo" } })).status).toBe(200)
  expect((await h.request(`/session/${session.id}/summarize`, { value: { providerID: "faux", modelID: "unknown" } })).status).toBe(400)
  const before = h.daemon.store.lastSeq(session.id)
  for (const value of [{ parts: [{ type: "file", mime: "text/plain", url: "https://example.test/a" }] }, { parts: [{ type: "text", text: "hi" }], noReply: true }, { parts: [{ type: "text", text: "hi" }], tools: { bash: false } }, { parts: [{ type: "text", text: "hi" }], format: { type: "json_schema", schema: { type: "object" } } }]) expect((await h.request(`/session/${session.id}/message`, { value })).status).toBe(501)
  expect((await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "text", text: "hi" }], unknownField: true } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}`, { method: "PATCH", value: { permission: "allow" } })).status).toBe(400)
  expect(h.daemon.store.lastSeq(session.id)).toBe(before)
})

test("B81 auth, read-only, workspace routing and OpenAPI include PATCH and the complete route inventory", async () => {
  const h = await boot(), session = await h.create()
  expect((await h.request(`/session/${session.id}`, { token: h.observer })).status).toBe(403)
  expect((await h.request(`/session/${session.id}/message`, { token: h.observer })).status).toBe(403)
  expect((await h.request("/session", { value: {}, token: h.observer })).status).toBe(403)
  const other = path.join(h.dir, "other")
  mkdirSync(other)
  const clientId = ids("client")
  const registered = await (await h.request("/command", { value: { id: ids("command"), clientId, type: "workspace.create", name: "Other", directory: other, adapter: "local" } })).json()
  const headers = { "X-Mendcode-Workspace": registered.workspace.id }
  expect((await h.request(`/session/${session.id}`, { headers })).status).toBe(403)
  expect((await h.request(`/session/${session.id}/abort`, { method: "POST", headers })).status).toBe(403)
  const spec = httpOpenApi() as { paths: Record<string, any> }
  for (const route of ["/session", "/session/{sessionID}/message", "/session/{sessionID}/cancel-turn", "/session/{sessionID}/init", "/api/session/{sessionID}/wait", "/experimental/usage-insights"]) expect(spec.paths[route]).toBeDefined()
  expect((spec.paths["/session/{sessionID}"] as any).patch.requestBody.content["application/json"].schema.properties.time).toBeDefined()
  expect((await h.request("/session", { method: "OPTIONS" })).headers.get("access-control-allow-methods")).toBeNull()
})

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const dataText = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString("base64")}`
const userAndAnswer = async (h: Awaited<ReturnType<typeof boot>>, sessionId: SessionId) => {
  const rows = await (await h.request(`/session/${sessionId}/message`)).json() as Array<{ info: { id: string; role: string }; parts: Array<{ id: string; type: string; text?: string; mime?: string }> }>
  return { user: rows.find((row) => row.info.role === "user")!, assistant: rows.find((row) => row.info.role === "assistant")! }
}

test("R7 prompts keep the caller's message id and honour synthetic, ignored, file, agent and system parts", async () => {
  const h = await boot(), session = await h.create()
  const messageID = ids("item")
  const response = await h.request(`/session/${session.id}/message`, { value: { messageID, system: "Be brief", parts: [
    { type: "text", text: "visible" }, { type: "text", text: "hidden context", synthetic: true }, { type: "text", text: "shown only", ignored: true },
    { type: "file", mime: "text/plain", filename: "n.txt", url: dataText("notes") },
    { type: "file", mime: "image/png", filename: "p.png", url: `data:image/png;base64,${PNG}` },
    { type: "agent", name: "explore" }, { type: "subtask", agent: "general", description: "scan", prompt: "list files" },
  ] } })
  expect(response.status).toBe(200)
  RestMessageDto.parse(await response.json())
  const { user, assistant } = await userAndAnswer(h, session.id)
  expect(user.info.id).toBe(messageID)
  const shown = user.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  expect(shown).toContain("visible")
  expect(shown).toContain("shown only")
  expect(shown).not.toContain("hidden context")
  expect(user.parts.some((part) => part.type === "file" && part.mime === "image/png")).toBe(true)
  const answer = assistant.parts.map((part) => part.text ?? "").join("\n")
  expect(answer).toContain("hidden context")
  expect(answer).toContain("[Instructions for this turn]\nBe brief")
  expect(answer).toContain("File n.txt:\nnotes")
  expect(answer).toContain("explore agent")
  expect(answer).toContain("Delegate this to the general agent")
  expect(answer).not.toContain("shown only")
  expect((await h.request(`/session/${session.id}/message`, { value: { messageID, parts: [{ type: "text", text: "again" }] } })).status).toBeGreaterThanOrEqual(400)
  const before = h.daemon.store.lastSeq(session.id)
  expect((await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "file", mime: "image/png", url: "file:///etc/passwd" }] } })).status).toBe(501)
  expect((await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "file", mime: "application/zip", url: `data:application/zip;base64,${Buffer.from("PK").toString("base64")}` }] } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "text", text: "x", ignored: true }] } })).status).toBe(400)
  expect(h.daemon.store.lastSeq(session.id)).toBe(before)
}, 15_000)

test("R7 a deferred v2 prompt returns the id its message keeps, and v2 files and agents are composed", async () => {
  const h = await boot(), session = await h.create()
  const deferred = await (await h.request(`/api/session/${session.id}/prompt`, { value: { prompt: { text: "later", files: [{ uri: dataText("spec"), mime: "text/plain", name: "spec.txt" }], agents: [{ name: "explore" }] }, delivery: "deferred" } })).json()
  expect(deferred.id).toMatch(/^itm_/)
  expect((await h.request(`/api/session/${session.id}/wait`, { method: "POST" })).status).toBe(204)
  const page = await (await h.request(`/api/session/${session.id}/message?order=asc&limit=50`)).json()
  expect(page.items.find((item: { id: string }) => item.id === deferred.id)).toMatchObject({ type: "user" })
  const answer = page.items.find((item: { type: string }) => item.type === "assistant")
  expect(JSON.stringify(answer)).toContain("File spec.txt:\\nspec")
  const immediate = await (await h.request(`/api/session/${session.id}/prompt`, { value: { prompt: { text: "now" } } })).json()
  expect(immediate.id).toMatch(/^itm_/)
  expect(immediate.id).not.toBe(deferred.id)
})

test("R7 commands use the template's agent and model, a request wins, and messageID and file parts apply", async () => {
  const h = await boot(), session = await h.create()
  mkdirSync(path.join(h.project, ".mendcode", "commands"), { recursive: true })
  writeFileSync(path.join(h.project, ".mendcode", "commands", "ship.md"), "---\nagent: build\nmodel: faux/echo2\n---\nShip $ARGUMENTS")
  writeFileSync(path.join(h.project, ".mendcode", "commands", "delegate.md"), "---\nagent: general\nsubtask: true\n---\nResearch $ARGUMENTS")
  const messageID = ids("item")
  const response = await h.request(`/session/${session.id}/command`, { value: { command: "ship", arguments: "it", messageID, parts: [{ type: "file", mime: "text/plain", filename: "a.txt", url: dataText("ctx") }] } })
  expect(response.status).toBe(200)
  const queued = () => h.daemon.store.readAfter(session.id, 0, 200).filter((event) => event.type === "queue.added")
  expect(queued().at(-1)).toMatchObject({ messageId: messageID, selection: { agent: "build", model: { model: "echo2" } } })
  expect(JSON.stringify(await response.json())).toContain("File a.txt:\\nctx")
  await h.request(`/session/${session.id}/command`, { value: { command: "ship", arguments: "now", model: "faux/echo" } })
  expect(queued().at(-1)).toMatchObject({ selection: { model: { model: "echo" } } })
  const delegated = await (await h.request(`/session/${session.id}/command`, { value: { command: "delegate", arguments: "parser" } })).json()
  expect(JSON.stringify(delegated)).toContain("Delegate this to the general agent through the task tool:\\nResearch parser")
  expect((queued().at(-1) as { selection?: { agent?: string } }).selection?.agent).toBeUndefined()
}, 15_000)

test("R7 summarize carries instructions and a model override into the queued compaction", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "history")
  expect((await h.request(`/session/${session.id}/summarize`, { value: { providerID: "faux", modelID: "echo", instructions: "keep API names" } })).status).toBe(200)
  expect((await h.request(`/session/${session.id}/summarize`, { value: { providerID: "faux", modelID: "echo2", auto: false } })).status).toBe(200)
  const compactions = h.daemon.store.readAfter(session.id, 0, 300).filter((event) => event.type === "queue.added" && event.compact)
  expect(compactions[0]).toMatchObject({ instructions: "keep API names" })
  expect((compactions[0] as { selection?: unknown }).selection).toBeUndefined()
  expect(compactions[1]).toMatchObject({ selection: { model: { model: "echo2" } } })
})

test("R7 shell runs the user's command in order and answers with the shell message", async () => {
  const h = await boot(), session = await h.create()
  const messageID = ids("item")
  const response = await h.request(`/session/${session.id}/shell`, { value: { agent: "build", command: "echo hi", messageID, model: { providerID: "faux", modelID: "echo" } } })
  expect(response.status).toBe(200)
  const message = RestMessageDto.parse(await response.json())
  expect(message.info).toMatchObject({ role: "assistant", agent: "build", model: { providerID: "faux", modelID: "echo" } })
  expect(JSON.stringify(message.parts)).toContain("shell: echo hi")
  const { user } = await userAndAnswer(h, session.id)
  expect(user.info.id).toBe(messageID)
  expect((await h.request(`/session/${session.id}/shell`, { value: { agent: "nope", command: "x" } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}/shell`, { value: { command: "x" } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}/shell`, { value: { agent: "build", command: "x" }, token: h.observer })).status).toBe(403)
  expect((await h.request(`/session/${session.id}/shell`, { value: { agent: "build", command: "echo again", messageID } })).status).toBeGreaterThanOrEqual(400)
})

test("R7 message and part delete/update use native revisions, behind the opt-in, without a revision header", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "first question")
  const { user, assistant } = await userAndAnswer(h, session.id)
  const target = `/session/${session.id}/message/${assistant.info.id}`
  const part = assistant.parts.find((entry) => entry.type === "text")!
  const body = { id: part.id, sessionID: session.id, messageID: assistant.info.id, type: "text", text: "edited answer" }
  expect((await h.request(`${target}/part/${part.id}`, { method: "PATCH", value: body })).status).toBe(403)
  expect((await h.request(target, { method: "DELETE" })).status).toBe(403)
  h.daemon.store.settings.set({ allowMessageEdits: true })
  expect((await h.request(`${target}/part/${part.id}`, { method: "PATCH", value: body, token: h.observer })).status).toBe(403)
  expect((await h.request(`${target}/part/${part.id}`, { method: "PATCH", value: { ...body, messageID: user.info.id } })).status).toBe(400)
  expect((await h.request(`${target}/part/${part.id}`, { method: "PATCH", value: { ...body, type: "reasoning" } })).status).toBe(400)
  const edited = await h.request(`${target}/part/${part.id}`, { method: "PATCH", value: body })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({ id: part.id, type: "text", text: "edited answer" })
  expect((await userAndAnswer(h, session.id)).assistant.parts.find((entry) => entry.type === "text")?.text).toBe("edited answer")
  expect((await h.request(`${target}/part/${ids("item")}`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400)
  expect(await (await h.request(`${target}/part/${part.id}`, { method: "DELETE" })).json()).toBe(true)
  expect((await userAndAnswer(h, session.id)).assistant?.parts.some((entry) => entry.type === "text" && entry.text === "edited answer")).toBeFalsy()
  expect(await (await h.request(`/session/${session.id}/message/${user.info.id}`, { method: "DELETE" })).json()).toBe(true)
  expect(await (await h.request(`/session/${session.id}/message`)).json()).toEqual([])
  expect((await h.request(`/session/${session.id}/message/${user.info.id}`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400)
  expect(h.daemon.store.readAfter(session.id, 0, 500).filter((event) => event.type === "message.revised").length).toBeGreaterThanOrEqual(3)
}, 15_000)

test("R7 the v2 context is the engine's own history when the native engine saved one", async () => {
  const h = await boot(), session = await h.create()
  await h.prompt(session.id, "question")
  const fallback = await h.request(`/api/session/${session.id}/context`)
  expect(fallback.headers.get("x-context-source")).toBe("transcript")
  h.daemon.store.engineMessages.save(session.id, "native", [
    { role: "user", content: "Summary of the conversation so far:\n\nthe summary", compaction: { version: 1, generation: 1, method: "legacy", tailTurns: 0 } },
    { role: "user", content: "next question" },
    { role: "assistant", content: "I will look", toolCalls: [{ callId: "call_1", name: "read", args: { path: "a.ts" } }] },
    { role: "tool", callId: "call_1", name: "read", output: "file body", isError: false },
    { role: "assistant", content: "done", toolCalls: [] },
  ])
  const response = await h.request(`/api/session/${session.id}/context`)
  expect(response.headers.get("x-context-source")).toBe("engine")
  const context = await response.json() as Array<{ id: string; type: string; text?: string; summary?: string; content?: unknown[] }>
  expect(context.map((entry) => entry.type)).toEqual(["compaction", "user", "assistant", "assistant"])
  expect(context[0]).toMatchObject({ id: "ctx_000000", summary: expect.stringContaining("the summary") })
  expect(context[2]!.content).toEqual([{ type: "text", text: "I will look" }, { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "a.ts" }, output: "file body" } }])
})

test("R7 OpenAPI lists the shell, message delete and part routes", () => {
  const spec = httpOpenApi() as { paths: Record<string, any> }
  expect(spec.paths["/session/{sessionID}/shell"].post.requestBody.content["application/json"].schema.required).toContain("command")
  expect(spec.paths["/session/{sessionID}/message/{messageID}"].delete.operationId).toBe("session.deleteMessage")
  expect(spec.paths["/session/{sessionID}/message/{messageID}/part/{partID}"].patch.operationId).toBe("part.update")
  expect(spec.paths["/session/{sessionID}/message/{messageID}/part/{partID}"].delete.operationId).toBe("part.delete")
  expect(spec.paths["/session/{sessionID}/message"].post.requestBody.content["application/json"].schema.properties).toMatchObject({ messageID: expect.anything(), system: expect.anything(), variant: expect.anything() })
})

test("R8 diff is a net git-style patch, messages and sessions carry persisted summaries, revert takes partID and unrevert restores every group", async () => {
  const h = await boot(), session = await h.create(), store = h.daemon.store
  const dir = store.sessionDirectory(session.id)!, file = path.join(dir, "n.txt")
  const bytes = (text: string) => new TextEncoder().encode(text)
  const turnId = ids("turn"), user = ids("item"), toolA = ids("item"), toolB = ids("item")
  const append = (event: Record<string, unknown>) => store.sessionSink.append({ sessionId: session.id, ...event } as never)
  append({ type: "turn.started", turnId, queueId: ids("queue") })
  append({ type: "item.started", turnId, itemId: user, kind: "user_message" })
  append({ type: "item.completed", itemId: user, status: "ok", text: "edit it" })
  for (const tool of [toolA, toolB]) {
    append({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: "edit" } })
    append({ type: "item.completed", itemId: tool, status: "ok", text: "ok", toolInput: "{}" })
  }
  append({ type: "turn.completed", turnId })
  const states = ["one\ntwo\n", "one\nTWO\n", "one\nTWO\nthree\n"]
  writeFileSync(file, states[2]!)
  store.turns.files.captureBefore(session.id, turnId, file, { state: "content", content: bytes(states[0]!) })
  store.turns.files.seal(session.id, turnId, file, { state: "content", content: bytes(states[2]!) })
  store.turns.calls.capture(session.id, turnId, toolA, file, { state: "content", content: bytes(states[0]!) })
  store.turns.calls.capture(session.id, turnId, toolB, file, { state: "content", content: bytes(states[1]!) })
  store.turns.snapshots.put(session.id, turnId, { root: dir, scope: "tools", complete: true, sealed: true, summary: summarizeSnapshots(dir, store.turns.files.list(session.id, turnId), true) })

  const diff = await (await h.request(`/session/${session.id}/diff`)).json()
  expect(diff).toEqual([{ file: "n.txt", patch: expect.stringContaining("+++ b/n.txt"), additions: 2, deletions: 1, status: "modified" }])
  expect(diff[0].patch).toContain("-two")
  expect(diff[0].patch).toContain("+three")
  expect(await (await h.request(`/session/${session.id}/diff?messageID=${user}`)).json()).toMatchObject([{ file: "n.txt", additions: 2, deletions: 1 }])
  expect(await (await h.request(`/session/${session.id}/diff?messageID=${toolA}`)).json()).toEqual([])

  const rows = await (await h.request(`/session/${session.id}/message`)).json()
  expect(rows[0].info.summary.diffs).toMatchObject([{ file: "n.txt", additions: 2, deletions: 1, status: "modified" }])
  const current = await (await h.request(`/session/${session.id}`)).json()
  expect(current.summary).toEqual({ additions: 2, deletions: 1, files: 1 })
  expect(current.revert).toBeUndefined()
  expect((await h.request(`/session/${session.id}/unrevert`, { method: "POST" })).status).toBe(200)

  const part = await (await h.request(`/session/${session.id}/revert`, { value: { messageID: toolA, partID: toolB } })).json()
  expect(part.revert).toEqual({ messageID: user, partID: toolB })
  expect(readFileSync(file, "utf8")).toBe(states[1]!)
  expect(await (await h.request(`/session/${session.id}/message`)).json()).toHaveLength(rows.length)
  const whole = await (await h.request(`/session/${session.id}/revert`, { value: { messageID: toolA } })).json()
  expect(whole.revert).toEqual({ messageID: user })
  expect(readFileSync(file, "utf8")).toBe(states[0]!)
  expect(await (await h.request(`/session/${session.id}/message`)).json()).toHaveLength(0)
  expect(store.turns.undoDepth(session.id)).toBe(1)

  const restored = await (await h.request(`/session/${session.id}/unrevert`, { method: "POST" })).json()
  expect(restored.revert).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe(states[2]!)
  expect(store.turns.undoDepth(session.id)).toBe(0)
  expect((await h.request(`/session/${session.id}/revert`, { value: { messageID: toolA, extra: 1 } })).status).toBe(400)
  expect((await h.request(`/session/${session.id}/revert`, { value: { messageID: ids("item") } })).status).toBe(404)
})
