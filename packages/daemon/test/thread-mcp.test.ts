import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createIdFactory, type PermissionMode, type Settings } from "@mendcode/protocol"
import { createVirtualClock, processMcpTurn, type EngineEvent, type TurnInput } from "@mendcode/kernel"
import type { ThreadPort } from "@mendcode/tools"
import { createThreadMcp, threadMcpEnabled } from "../src/thread-mcp"
import { bridgeAuthorizer } from "../src/thread-mcp-approval"
import { remoteExecutionSettings } from "../src/remote-policy"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const ids = createIdFactory()
function turn(): TurnInput {
  return { sessionId: ids("session"), turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, emit: () => {}, newItemId: () => ids("item"), ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} }
}
function fixture(engine: "claude" | "codex" | "acp:demo" = "codex") {
  const clock = createVirtualClock()
  let stops = 0
  const service = createThreadMcp({ clock, listen: () => ({ url: "http://127.0.0.1:12345/mcp", stop: () => { stops++ } }) })
  cleanup.push(service.stop)
  const calls: string[] = []
  const port: ThreadPort = {
    granted: () => false,
    list: () => ({ ok: true, output: "project threads" }),
    read: (args) => args.sessionId === "other_project" ? { ok: false, message: "no session in this project" } : { ok: true, output: "[user] marker ‹secret:1›" },
    search: () => ({ ok: true, output: "match" }),
    message: async () => (calls.push("message"), { ok: true, output: "queued" }),
    wait: async () => ({ ok: true, output: "last answer" }),
    interrupt: async () => ({ ok: true, output: "interrupted" }),
    mergeBack: () => ({ ok: false, message: "not exposed" }),
    stats: () => ({ ok: false, message: "not exposed" }),
  }
  let allow = true
  let enabled = true
  let authorize = async () => allow
  const lease = service.open({ engine, turn: turn(), allowed: () => enabled, threads: port, authorize: () => authorize(), create: async () => (calls.push("create"), { ok: true, output: "created" }), delegate: async (args) => (calls.push(`delegate:${args.engine}:${args.background}${args.task_id ? `:${args.task_id}:${args.model}` : ""}`), { ok: true, output: "child queued" }) })
  const config = engine === "claude" ? JSON.parse(readFileSync(lease.args[1]!, "utf8")).mcpServers.mendcode_threads : undefined
  const authorization = lease.servers[0]!.headers[0]!.value
  const request = (method: string, params: unknown = {}, patch: { authorization?: string; origin?: string; url?: string; body?: string } = {}) => service.handle(new Request(patch.url ?? "http://127.0.0.1:12345/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: patch.authorization ?? authorization, ...(patch.origin ? { origin: patch.origin } : {}) }, body: patch.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }))
  const call = async (name: string, args: unknown = {}) => (await (await request("tools/call", { name, arguments: args })).json()) as any
  return { clock, lease, service, request, call, calls, authorization, authorize: (fn: typeof authorize) => { authorize = fn }, allow: (value: boolean) => { allow = value }, enable: (value: boolean) => { enabled = value }, stops: () => stops }
}

test("full tier and a separate engine opt-in are required, and remote settings cannot enable it", () => {
  const on: Settings = { tier: "full", threadMcp: { claude: true } }
  expect(threadMcpEnabled({}, "claude")).toBe(false)
  expect(threadMcpEnabled(on, "claude")).toBe(true)
  expect(threadMcpEnabled(on, "codex")).toBe(false)
  expect(threadMcpEnabled(on, "claude", true)).toBe(false)
  for (const tier of ["balanced", "minimalist"] as const) expect(threadMcpEnabled({ ...on, tier, features: { thread_mcp: true, mcp: true } }, "claude")).toBe(false)
  for (const features of [{ mcp: false }, { thread_mcp: false }]) expect(threadMcpEnabled({ ...on, features }, "claude")).toBe(false)
  expect(remoteExecutionSettings({ threadMcp: { codex: true } })).toBe(true)
})

test("ACP leases use a session server list, per-agent opt-in and the existing revocation policy", async () => {
  const on: Settings = { tier: "full", threadMcp: { acp: { demo: true } } }
  expect(threadMcpEnabled(on, "acp:demo")).toBe(true)
  expect(threadMcpEnabled(on, "acp:other")).toBe(false)
  expect(threadMcpEnabled(on, "acp:demo", true)).toBe(false)
  for (const tier of ["balanced", "minimalist"] as const) expect(threadMcpEnabled({ ...on, tier }, "acp:demo")).toBe(false)
  for (const features of [{ mcp: false }, { thread_mcp: false }]) expect(threadMcpEnabled({ ...on, features }, "acp:demo")).toBe(false)
  const h = fixture("acp:demo")
  expect(h.lease.args).toEqual([])
  expect(h.lease.servers[0]).toMatchObject({ type: "http", name: "mendcode_threads", url: "http://127.0.0.1:12345/mcp" })
  expect((await h.call("thread_list")).result.isError).toBe(false)
  h.enable(false)
  expect((await h.request("tools/list")).status).toBe(401)
  const idle = fixture("acp:demo")
  idle.clock.advance(10 * 60_000 + 1)
  expect((await idle.request("tools/list")).status).toBe(401)
  const released = fixture("acp:demo")
  released.lease.release()
  expect((await released.request("tools/list")).status).toBe(403)
})

test("stateless MCP discovery and bounded thread verbs reuse ports, with no arbitrary command surface", async () => {
  const h = fixture()
  expect((await (await h.request("initialize", { protocolVersion: "2025-06-18" })).json()).result.protocolVersion).toBe("2025-06-18")
  const result = await (await h.request("tools/list")).json()
  expect(result.result.tools.map((tool: any) => tool.name)).toEqual(["thread_list", "thread_create", "thread_message", "thread_wait", "thread_read", "thread_search", "thread_interrupt", "delegate_task", "orchestrator_capabilities"])
  expect((await h.call("thread_read", { sessionId: "local_thread" })).result.content[0].text).toContain("‹secret:1›")
  expect((await h.call("thread_read", { sessionId: "other_project" })).result.isError).toBe(true)
  for (const [name, args] of [["thread_create", { title: "check" }], ["thread_message", { sessionId: "local_thread", text: "hello" }], ["thread_wait", { sessionId: "local_thread", timeoutSeconds: 1 }], ["thread_search", { sessionId: "local_thread", query: "word" }], ["thread_interrupt", { sessionId: "local_thread" }], ["delegate_task", { description: "review", prompt: "review", engine: "claude", model: "claude-sonnet" }]] as const) expect((await h.call(name, args)).result.isError).toBe(false)
  expect(h.calls).toEqual(["create", "message", "delegate:claude:true"])
  // A child it started goes on with its history, here on another model.
  expect((await h.call("delegate_task", { description: "review", prompt: "go on", task_id: "ses_child", model: "gpt-6-luna" })).result.isError).toBe(false)
  expect(h.calls.at(-1)).toBe("delegate:undefined:true:ses_child:gpt-6-luna")
  expect((await h.call("bash", { command: "pwd" })).error.code).toBe(-32602)
  expect((await h.call(["thread_create"] as any, { title: "invalid name" })).error.code).toBe(-32602)
  expect((await h.call("thread_read", { sessionId: "local_thread", limit: 100 })).error.code).toBe(-32602)
  expect((await h.call("thread_create", { title: "escape", directory: "/other" })).error.code).toBe(-32602)
  h.allow(false)
  expect((await h.call("thread_message", { sessionId: "local_thread", text: "denied" })).result.isError).toBe(true)
  expect(h.calls.filter((call) => call === "message")).toHaveLength(1)
})

test("authentication, origin/host, payload, expiry, live feature switch and revocation fail closed", async () => {
  const h = fixture()
  expect((await h.request("tools/list", {}, { authorization: "Bearer invalid" })).status).toBe(401)
  expect((await h.request("tools/list", {}, { authorization: `Bearer ${"é".repeat(64)}` })).status).toBe(401)
  expect((await h.request("tools/list", {}, { origin: "https://attacker.test" })).status).toBe(403)
  expect((await h.request("tools/list", {}, { url: "http://attacker.test/mcp" })).status).toBe(403)
  expect((await h.request("tools/list", {}, { body: "x".repeat(65537) })).status).toBe(413)
  expect((await (await h.request("tools/list", {}, { body: "null" })).json()).error.code).toBe(-32600)
  h.enable(false)
  expect((await h.request("tools/list")).status).toBe(401)
  h.enable(true)
  h.clock.advance(10 * 60_000)
  expect((await h.request("tools/list")).status).toBe(401)
  h.lease.release()
  expect(h.stops()).toBe(1)
  expect((await h.request("tools/list")).status).toBe(403)
  const max = fixture()
  for (let i = 0; i < 12; i++) { max.clock.advance(5 * 60_000); await max.request("ping") }
  expect((await max.request("tools/list")).status).not.toBe(200)
})

test("Claude config is private and disposable; Codex injection is process flags; the bearer never reaches results", async () => {
  const h = fixture("claude")
  const file = h.lease.args[1]!
  expect(h.lease.args[0]).toBe("--mcp-config")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const token = h.authorization.slice("Bearer ".length)
  expect(h.lease.scrub(`contains ${token}`)).toBe("contains [redacted]")
  for (let chunk = 1; chunk <= 64; chunk++) {
    const stream = h.lease.stream()
    const raw = `prefix ${token} tail ${token} end`
    let text = ""
    for (let i = 0; i < raw.length; i += chunk) text += stream.push(raw.slice(i, i + chunk))
    text += stream.flush()
    expect(text).toBe("prefix [redacted] tail [redacted] end")
  }
  expect(JSON.stringify(await h.call("orchestrator_capabilities"))).not.toContain(token)
  h.lease.release()
  expect(existsSync(file)).toBe(false)
  const codex = fixture()
  expect(codex.lease.args[0]).toBe("-c")
  expect(codex.lease.args[1]).toStartWith("mcp_servers.mendcode_threads.url=")
})

test("approval policy honors denies, explicit asks, read grants, plan ceilings and policy changes while asking", async () => {
  const input = turn()
  let settings: Settings = { tier: "full" }
  let mode: PermissionMode = "ask"
  let asked = 0
  let change: (() => void) | undefined
  input.permissionMode = () => mode
  input.ask = async () => { asked++; change?.(); return { kind: "approve", scope: "once" } }
  const approve = bridgeAuthorizer({ turn: input, directory: "/project", settings: () => settings, profile: () => undefined, sessionRules: () => [], allowed: () => true, mask: (text) => text })
  expect(await approve("thread_list", {}, true)).toBe(true)
  expect(asked).toBe(0)
  expect(await approve("thread_read", { sessionId: "other" }, false)).toBe(true)
  expect(asked).toBe(1)
  settings = { tier: "full", permission: { threads: "deny" } }
  mode = "full"
  expect(await approve("thread_read", { sessionId: "other" }, true)).toBe(false)
  settings = { tier: "full", permission: { threads: "ask" } }
  expect(await approve("thread_read", { sessionId: "other" }, true)).toBe(true)
  expect(asked).toBe(2)
  mode = "plan"
  expect(await approve("thread_create", { title: "check" }, false)).toBe(false)
  expect(await approve("delegate_task", { prompt: "change" }, false)).toBe(false)
  mode = "ask"
  settings = { tier: "full" }
  change = () => { settings = { tier: "full", tools: { task: false } } }
  expect(await approve("delegate_task", { prompt: "change" }, false)).toBe(false)
})

test("bridge history reads need an individual approval in full/edits, even with allow rules or session-scoped answers", async () => {
  for (const mode of ["full", "edits", "plan"] as const) {
    const input = turn()
    input.permissionMode = () => mode
    let asked = 0
    input.ask = async () => { asked++; return { kind: "approve", scope: "session" } }
    const authorize = bridgeAuthorizer({ turn: input, directory: "/project", settings: () => ({ permission: { threads: "allow" } }), profile: () => undefined, sessionRules: () => [], allowed: () => true, mask: (text) => text })
    for (const name of ["thread_read", "thread_search", "thread_wait"]) {
      expect(await authorize(name, { sessionId: "target" }, false)).toBe(true)
      expect(await authorize(name, { sessionId: "target" }, false)).toBe(true)
    }
    expect(asked).toBe(6)
    expect(await authorize("thread_read", { sessionId: "mentioned" }, true)).toBe(true)
    expect(asked).toBe(6)
    input.ask = async () => ({ kind: "deny" })
    expect(await authorize("thread_wait", { sessionId: "target" }, false)).toBe(false)
  }
})

test("mutating retries reuse one result and changed keys conflict; release while awaiting approval prevents mutation", async () => {
  const h = fixture()
  const args = { title: "child", clientRequestId: "stable" }
  const first = await h.call("thread_create", args)
  expect(await h.call("thread_create", args)).toEqual(first)
  expect((await h.call("thread_create", { ...args, title: "changed" })).error.code).toBe(-32602)
  expect(h.calls).toEqual(["create"])
  let resolve!: (approved: boolean) => void
  h.authorize(() => new Promise<boolean>((done) => { resolve = done }))
  const pending = h.call("thread_message", { sessionId: "local_thread", text: "not sent" })
  while (!resolve) await Promise.resolve()
  expect(h.lease.waiting()).toBe(true)
  h.lease.release()
  resolve(true)
  expect((await pending).result.isError).toBe(true)
  expect(h.calls).toEqual(["create"])
})

test("calls sent together wait their turn instead of failing, and only the 200th call reaches the limit", async () => {
  const h = fixture("claude")
  let open!: (approved: boolean) => void
  h.authorize(() => new Promise<boolean>((done) => { open = done }))
  const first = h.call("delegate_task", { description: "one", prompt: "a" })
  while (!open) await Promise.resolve()
  const second = h.call("delegate_task", { description: "two", prompt: "b" })
  await Bun.sleep(5)
  expect(h.calls).toEqual([])
  expect(h.lease.waiting()).toBe(true)
  h.authorize(async () => true)
  open(true)
  const results = await Promise.all([first, second])
  expect(results.map((r) => r.result.isError ?? false)).toEqual([false, false])
  expect(h.calls).toEqual(["delegate:undefined:true", "delegate:undefined:true"])
  expect(h.lease.waiting()).toBe(false)
  for (let i = 2; i < 200; i++) await h.call("thread_list")
  expect((await h.call("thread_list")).result.content[0].text).toBe("Bridge call limit reached: 200 calls in this turn")
})

test("split token deltas are redacted before the process wrapper emits persisted events", () => {
  const h = fixture()
  const token = h.authorization.slice("Bearer ".length)
  const events: EngineEvent[] = []
  const input = processMcpTurn({ ...turn(), emit: (event) => { events.push(event) }, externalMcp: { args: h.lease.args, cwd: "/temp", scrub: h.lease.scrub, stream: h.lease.stream } })
  const itemId = ids("item")
  input.emit({ type: "item.started", itemId, kind: "agent_message" })
  for (const text of `prefix ${token} tail`) input.emit({ type: "item.delta", itemId, text })
  input.emit({ type: "item.completed", itemId, status: "ok", text: `prefix ${token} tail` })
  expect(events.filter((event) => event.type === "item.delta").map((event) => event.text).join("")).toBe("prefix [redacted] tail")
  expect(JSON.stringify(events)).not.toContain(token)
  const interrupted = ids("item")
  input.emit({ type: "item.delta", itemId: interrupted, text: "last partial answer" })
  input.flushProcessMcp()
  expect(events.flatMap((event) => event.type === "item.delta" && event.itemId === interrupted ? [event.text] : []).join("")).toBe("last partial answer")
})
