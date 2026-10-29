import { afterEach, expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createIdFactory, MemoryBrowseReport, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { EngineResolution } from "@mendcode/kernel"
import type { Store } from "@mendcode/store"
import { startDaemon, type DaemonOptions } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { readPlanReviews } from "../src/plan-review"
import { httpOpenApi } from "../src/http"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"
import { until } from "./native-harness"
import { createMemoryAssistant } from "../src/memory-assistant"

const ids = createIdFactory()
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
async function boot(complete?: DaemonOptions["complete"], models?: DaemonOptions["models"]) {
  const dir = realpathSync(tempDir()), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir), full = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const resolutions: EngineResolution[] = []
  let store!: Store
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "d.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: false, log() {}, ...(complete ? { complete } : {}), ...(models ? { models } : {}), engine: ({ store: s }) => {
    store = s
    return {
      needsCompaction: () => false,
      async compact() { return { status: "ok" } },
      async runTurn(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: input.text } })
        const request = input.text.startsWith("plan") ? { kind: "approval" as const, title: "Review plan", detail: "", itemId, tool: "plan_review", planReview: { title: "Socket recovery", markdown: "# Recovery\n\nKeep queued work.", phase: input.text === "plan-only" ? "plan" as const : "implementation" as const, destination: "build" } }
          : input.text === "question" ? { kind: "question" as const, title: "Recovery choices", detail: "", itemId, tool: "question", questions: [
            { header: "Strategy", question: "How should recovery run?", options: [{ label: "Retry", description: "Bounded retries" }, { label: "Stop", description: "Explicit restart" }], custom: false },
            { header: "Checks", question: "Which checks?", options: [{ label: "Socket" }, { label: "Queue" }], multiple: true },
          ] }
          : { kind: "approval" as const, title: "Read source", detail: "read: src/socket.ts", itemId, tool: "read", permission: "read" as const, permissionContext: { name: "read", patterns: ["src/socket.ts"], always: ["src/socket.ts"] } }
        const result = await input.ask(request)
        resolutions.push(result)
        input.emit({ type: "item.completed", itemId, status: "ok", text: result.kind })
        return { status: "ok" }
      },
    }
  } })
  cleanup.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ name: "B88", socketPath: daemon.socketPath, onEvent: (event) => void events.push(event) })
  cleanup.push(() => client.close())
  await client.connect()
  async function open(directory = project) {
    const reply = await client.send({ type: "session.create", directory })
    if (!reply.ok) throw new Error(reply.error.message)
    const sessionId = reply.result!.sessionId as SessionId
    await client.subscribe(sessionId)
    return sessionId
  }
  const sessionId = await open()
  const request = async (route: string, value?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1${route}`, { method: value === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${full}`, "Content-Type": "application/json", ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...(signal ? { signal } : {}) }))
    if (!response) throw new Error("Missing response")
    return response
  }
  async function pending(text: string, target = sessionId) {
    const before = events.length
    const reply = await client.send({ type: "user.submit", sessionId: target, text, attachments: [] })
    if (!reply.ok) throw new Error(reply.error.message)
    await until(() => events.slice(before).some((event) => event.type === "server.request"))
    const event = events.slice(before).find((event) => event.type === "server.request")!
    if (event.type !== "server.request") throw new Error("Missing request")
    return event
  }
  const settled = () => until(() => store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  return { daemon, dir, project, tokens, full, observer, client, events, store, sessionId, request, open, pending, settled, resolutions }
}

test("OpenAPI describes all eight donor operations and their payloads", () => {
  const paths = httpOpenApi().paths as Record<string, any>
  for (const [route, method, id] of [["/permission", "get", "permission.list"], ["/permission/{requestID}/reply", "post", "permission.reply"], ["/question", "get", "question.list"], ["/question/{requestID}/reply", "post", "question.reply"], ["/question/{requestID}/reject", "post", "question.reject"], ["/plan-review", "get", "planReview.list"], ["/plan-review/{requestID}/reply", "post", "planReview.reply"], ["/memory/side-chat", "post", "memory.sideChat"]]) {
    expect(paths[route!]![method!]!.operationId).toBe(id)
    expect(paths[route!]![method!]!.responses["403"]).toBeDefined()
  }
  expect(paths["/permission/{requestID}/reply"].post.requestBody.content["application/json"].schema.properties.reply.enum).toEqual(["once", "always", "reject"])
})

test("all interactions require full tokens; routing, unknown ids and wrong kinds cannot consume requests", async () => {
  const h = await boot(), pending = await h.pending("permission")
  for (const route of ["/permission", "/question", "/plan-review", "/memory/side-chat"]) {
    const value = route === "/memory/side-chat" ? { message: "Explain" } : undefined
    expect((await h.request(route, value, { Authorization: `Bearer ${h.observer}` })).status).toBe(403)
  }
  expect((await h.request(`/question/${pending.requestId}/reject`, {})).status).toBe(404)
  expect((await h.request(`/permission/${ids("request")}/reply`, { reply: "once" })).status).toBe(404)
  expect((await h.request("/permission", undefined, { "x-opencode-directory": realpathSync(tempDir()) })).status).toBe(403)
  expect((await h.request(`/permission/${pending.requestId}/reply`, { reply: "all" })).status).toBe(400)
  expect((await h.request("/permission?limit=1")).status).toBe(400)
  expect(await (await h.request("/permission")).json()).toHaveLength(1)
  h.tokens.revoke("full")
  expect((await h.request("/permission")).status).toBe(401)
})

for (const reply of ["once", "always", "reject"] as const) test(`permission ${reply} reaches the native resolver once`, async () => {
  const h = await boot(), pending = await h.pending("permission")
  const response = await h.request("/permission")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual([{ id: pending.requestId, sessionID: h.sessionId, permission: "read", patterns: ["src/socket.ts"], always: ["src/socket.ts"], metadata: { title: "Read source", detail: "read: src/socket.ts" }, tool: { messageID: pending.itemId, callID: pending.itemId } }])
  const native = await h.client.pendingInteractions(h.project, "permission")
  expect(native.ok && native.requests[0]?.id).toBe(pending.requestId)
  const route = `/permission/${pending.requestId}/reply`
  expect(await (await h.request(route, { reply, message: "Avoid unrelated files" })).json()).toBe(true)
  await h.settled()
  expect(h.resolutions).toEqual([reply === "reject" ? { kind: "deny", reason: "Avoid unrelated files" } : { kind: "approve", scope: reply === "always" ? "session" : "once" }])
  expect((await h.request(route, { reply })).status).toBe(404)
  expect(await (await h.request("/permission")).json()).toEqual([])
})

test("pending lists cover every session of only the selected registered workspace", async () => {
  const h = await boot(), otherProject = realpathSync(tempDir())
  const otherSession = await h.open(otherProject), sibling = await h.open()
  await h.pending("permission")
  await h.pending("permission", sibling)
  const remote = await h.pending("permission", otherSession)
  expect(await (await h.request("/permission")).json()).toHaveLength(2)
  const registered = await h.client.send({ type: "workspace.create", name: "other", directory: otherProject, adapter: "local" })
  expect(registered.ok).toBe(true)
  const headers = { "x-opencode-directory": otherProject }
  expect(await (await h.request("/permission", undefined, headers)).json()).toHaveLength(1)
  expect((await h.request(`/permission/${remote.requestId}/reply`, { reply: "once" })).status).toBe(404)
  expect((await h.request(`/permission/${remote.requestId}/reply`, { reply: "once" }, headers)).status).toBe(200)
})

test("questions return ordered batches; invalid counts/choices stay pending, replies preserve arrays", async () => {
  const h = await boot(), pending = await h.pending("question")
  const items = await (await h.request("/question")).json()
  expect(items[0].questions.map((item: any) => item.header)).toEqual(["Strategy", "Checks"])
  const route = `/question/${pending.requestId}/reply`
  for (const answers of [[["Retry"]], [["Unknown"], []], [["Retry", "Stop"], []], [["Retry"], ["Socket", "Socket"]]]) expect((await h.request(route, { answers })).status).toBe(400)
  expect(await (await h.request(route, { answers: [["Retry"], ["Socket", "Queue"]] })).json()).toBe(true)
  await h.settled()
  expect(h.resolutions).toEqual([{ kind: "answer", text: "Retry\nSocket, Queue", answers: [["Retry"], ["Socket", "Queue"]] }])
  expect(await (await h.request("/question")).json()).toEqual([])
})

test("question rejection needs no JSON body and cancellation removes stale requests", async () => {
  const h = await boot(), pending = await h.pending("question")
  const response = await h.daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1/question/${pending.requestId}/reject`, { method: "POST", headers: { Authorization: `Bearer ${h.full}` } }))
  expect(await response!.json()).toBe(true)
  await h.settled()
  expect(h.resolutions).toEqual([{ kind: "deny" }])
  const next = await h.pending("question")
  await h.client.send({ type: "turn.cancel", sessionId: h.sessionId, turnId: next.turnId })
  await h.settled()
  expect(await (await h.request("/question")).json()).toEqual([])
})

for (const action of ["apply", "edit", "reject", "close"] as const) test(`plan ${action} uses the durable native review flow`, async () => {
  const h = await boot(), pending = await h.pending("plan")
  expect(await (await h.request("/plan-review")).json()).toEqual([{ id: pending.requestId, sessionID: h.sessionId, title: "Socket recovery", markdown: "# Recovery\n\nKeep queued work.", tool: { messageID: pending.itemId, callID: pending.itemId } }])
  const reply = { action, ...(action === "edit" ? { markdown: "# Refined plan", comments: "Keep retries bounded" } : {}), ...(action === "reject" ? { reason: "Needs a regression" } : {}) }
  expect(await (await h.request(`/plan-review/${pending.requestId}/reply`, reply)).json()).toBe(true)
  await h.settled()
  expect(h.resolutions[0]).toMatchObject({ kind: "plan_review", ...reply })
  expect(readPlanReviews(h.store, h.sessionId)[0]?.reply).toMatchObject(reply)
  expect(await (await h.request("/plan-review")).json()).toEqual([])
})

test("planning-only apply and conflicting peers keep explicit authority and first reply wins", async () => {
  const h = await boot(), pending = await h.pending("plan-only")
  const route = `/plan-review/${pending.requestId}/reply`
  expect((await h.request(route, { action: "apply" })).status).toBe(400)
  expect(await (await h.request("/plan-review")).json()).toHaveLength(1)
  const replies = await Promise.all([h.request(route, { action: "edit", markdown: "# Revised" }), h.request(route, { action: "close" })])
  expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1)
  expect([404, 409]).toContain(replies.find((reply) => reply.status !== 200)!.status)
  await h.settled()
  expect(h.resolutions).toHaveLength(1)
})

test("HTTP rejection feedback and custom answers redact secrets before engine delivery", async () => {
  const secret = "sk-proj-" + "Ab12".repeat(8)
  const h = await boot(), permission = await h.pending("permission")
  expect((await h.request(`/permission/${permission.requestId}/reply`, { reply: "reject", message: `Rotate ${secret}` })).status).toBe(200)
  await h.settled()
  const question = await h.pending("question")
  expect((await h.request(`/question/${question.requestId}/reply`, { answers: [["Retry"], [`Rotate ${secret}`]] })).status).toBe(200)
  await h.settled()
  expect(JSON.stringify(h.resolutions)).not.toContain(secret)
  expect(h.resolutions).toHaveLength(2)
})

test("memory REST is denied; local side chat uses caller history/selection without changing memory or side history", async () => {
  const calls: Parameters<NonNullable<DaemonOptions["complete"]>>[0][] = []
  const h = await boot(async (input) => { calls.push(input); return JSON.stringify({ reply: "Ready for review", actions: [{ kind: "create-memory", text: "Keep retries bounded", scope: "user" }] }) })
  const before = h.store.memories.list({ directory: h.project, session: "all" })
  const payload = { root: h.project, message: "Draft a memory", history: [{ id: "old", role: "user" as const, text: "Earlier question", createdAt: "2026-10-01" }], context: { selectedWorkspaceID: h.project, selectedGroupID: null, selectedCategoryID: "commands", pageContext: "Selected: retries" } }
  expect((await h.request("/memory/side-chat", payload)).status).toBe(403)
  expect(calls).toHaveLength(0)
  expect(await h.client.memorySideChat(h.project, payload)).toEqual({ ok: true, response: { text: "Ready for review", actions: [{ kind: "create-memory", text: "Keep retries bounded", scope: "global" }] } })
  expect(calls[0]?.prompt).toContain("Earlier question")
  expect(calls[0]?.prompt).toContain("Selected: retries")
  expect(calls[0]?.prompt).toContain("commands")
  expect(calls[0]?.system).toContain("cannot run tools")
  expect(h.store.memories.list({ directory: h.project, session: "all" })).toEqual(before)
  expect(existsSync(path.join(h.dir, "memory-assistant"))).toBe(false)
  expect((await h.client.memorySideChat(h.project, { message: "Another question" })).ok).toBe(true)
  expect(calls[1]?.prompt).not.toContain("Earlier question")
  expect((await h.request("/memory/side-chat", { message: "Explain", root: realpathSync(tempDir()) })).status).toBe(403)
})

test("local memory provider failures stay tool-free and abort discards late actions without leaking secrets", async () => {
  const secret = "sk-proj-" + "Ab12".repeat(8)
  const absent = await boot()
  expect(await absent.client.memorySideChat(absent.project, { message: "Explain" })).toMatchObject({ ok: true, response: { actions: [], text: expect.stringContaining("configured") } })
  let release!: (value: string) => void, entered = false
  const complete: NonNullable<DaemonOptions["complete"]> = async (input) => { expect(input.prompt).not.toContain(secret); entered = true; return new Promise<string>((resolve) => { release = resolve }) }
  const h = await boot(complete)
  const browsed = await h.client.send({ type: "memory.browse", directory: h.project, view: "project" })
  if (!browsed.ok) throw new Error(browsed.error.message)
  const browseReport = MemoryBrowseReport.parse(browsed.result)
  const assistant = createMemoryAssistant({ dir: h.dir, store: h.store, complete, browse: () => browseReport, profile: () => "", draft: () => undefined, model: () => undefined })
  cleanup.push(() => assistant.stop())
  const controller = new AbortController()
  const response = assistant.sideChat(h.project, { message: `Explain ${secret}` }, controller.signal)
  await until(() => entered)
  controller.abort()
  expect(await response).toEqual({ text: "Memory side chat canceled", actions: [] })
  release(JSON.stringify({ reply: secret, actions: [{ kind: "delete-category", text: "Remove" }] }))
  await Bun.sleep(5)
  expect(h.store.memories.list({ directory: h.project, session: "all" })).toEqual([])
  expect(existsSync(path.join(h.dir, "memory-assistant"))).toBe(false)
  const failing = await boot(async () => { throw new Error(secret) })
  const failure = await failing.client.memorySideChat(failing.project, { message: "Explain" })
  expect(failure).toEqual({ ok: true, response: { text: "Memory side chat provider unavailable", actions: [] } })
})

test("memory uses configured fallback roles once each and redacts provider responses", async () => {
  const calls: string[] = []
  const secret = "sk-proj-" + "Ab12".repeat(8)
  const h = await boot(async ({ model }) => {
    calls.push(model?.model ?? "default")
    if (model?.model === "memory-fake") throw new Error("Unavailable")
    return JSON.stringify({ text: `Review ${secret}`, actions: [{ kind: "propose-memory", text: `Rotate ${secret}` }] })
  }, { selectable: true, defaults: { model: "main-fake" }, list: () => ["memory-fake", "main-fake"].map((id) => ({ id, name: id, provider: "local", efforts: [] })) })
  expect((await h.client.send({ type: "settings.set", patch: { models: { memoryAssistant: { model: "memory-fake" } } } })).ok).toBe(true)
  const response = await h.client.memorySideChat(h.project, { message: "Draft a safe memory" })
  expect(response.ok).toBe(true)
  expect(JSON.stringify(response)).not.toContain(secret)
  expect(calls).toEqual(["memory-fake", "main-fake"])
})
