import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import { defineTool } from "@mendcode/tools"
import type { ContinuityRecord, SessionEvent, SessionId, Settings } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"
import { callTool, stop, until, type Step } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const questions = [{ header: "Database", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }], custom: false }]

async function boot(steps: Step[], settings: Settings = { experimental: { async_tools: true, async_questions: true } }, run?: (signal: AbortSignal) => Promise<string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b27-native-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const requests: ModelRequest[] = []
  let executions = 0
  const read = defineTool({ name: "read", permission: "read", description: "Read a project file", args: z.object({ path: z.string() }), async execute(_, context) { executions++; return { title: "Read", output: await run?.(context.signal) ?? "local result", truncated: false, isError: false } } })
  const factory: DaemonOptions["engine"] = ({ store, continuity }) => createNativeEngine({
    provider: { id: "scripted", model: "script-1", async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift() ?? stop("Done")
      yield* typeof step === "function" ? await step(request) : step
    } },
    tools: [read], continuity, permissionPolicy: () => store.settings.get(), history: memoryHistory(), cwdFor: () => dir, system: () => "BASE", compactionPrompt: "SUMMARIZE",
  })
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: factory, log: () => {} })
  cleanups.push(() => daemon.stop())
  daemon.store.settings.set(settings)
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "continuity", onEvent: (event) => events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const reply = await client.send({ type: "session.create", directory: dir })
  if (!reply.ok) throw new Error(reply.error.message)
  const sessionId = reply.result!.sessionId as SessionId
  await client.subscribe(sessionId, 0)
  const submit = () => client.send({ type: "user.submit", sessionId, text: "Read and plan the service", attachments: [] })
  const record = (kind: "job" | "question") => daemon.store.continuity.list(sessionId).find((record) => record.kind === kind)
  return { dir, factory, daemon, client, events, requests, sessionId, submit, record, executions: () => executions }
}

test("tool_start returns before a slow read, preserves permissions and emits one persisted continuation at a safe boundary", async () => {
  let release!: () => void
  const h = await boot([callTool("tool_start", { tool: "read", arguments: { path: "README.md" } }), stop("Independent work complete")], undefined, () => new Promise((resolve) => { release = () => resolve("Result of the async read") }))
  expect((await h.submit()).ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(h.record("job")?.status).toBe("running")
  expect(h.executions()).toBe(1)
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: expect.stringContaining('"job_id"'), isError: false })
  release()
  await until(() => h.requests.length === 3)
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Result of the async read") })
  await until(() => h.events.some((event) => event.type === "queue.added" && event.notice))
  const notices = h.events.filter((event) => event.type === "queue.added" && event.notice)
  expect(notices).toHaveLength(1)
  const record = h.record("job")!
  expect(await h.client.continuityRecord(h.sessionId, record.id, 2, 6)).toMatchObject({ ok: true, record: { status: "completed", output: "sult o", nextOffset: 8 } })
  expect(await h.client.continuity(h.sessionId, "job")).toMatchObject({ ok: true, records: [{ id: record.id, status: "completed" }] })
  expect((await h.client.send({ type: "continuity.wait", sessionId: h.sessionId, recordIds: [record.id], timeoutMs: 0 })).ok).toBe(true)
  expect((await h.client.send({ type: "continuity.cancel", sessionId: h.sessionId, recordId: record.id })).ok).toBe(true)
  const other = await h.client.send({ type: "session.create", directory: h.dir })
  expect(await h.client.continuityRecord(other.ok ? other.result!.sessionId as SessionId : h.sessionId, record.id)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
})

test("async flags are independently opt-in and target read denial cannot be bypassed by tool_start", async () => {
  const off = await boot([callTool("tool_start", { tool: "read", arguments: { path: "README.md" } }), stop("Done")], {})
  await off.submit()
  await until(() => off.requests.length === 2)
  expect(off.requests[0]!.tools.map((tool) => tool.name)).not.toContain("tool_start")
  expect(off.requests[0]!.tools.map((tool) => tool.name)).not.toContain("question_start")
  expect(off.record("job")).toBeUndefined()
  expect(off.executions()).toBe(0)
  const denied = await boot([callTool("tool_start", { tool: "read", arguments: { path: "private.txt" } }), stop("Done")], { experimental: { async_tools: true }, permission: { read: "deny" } })
  await denied.submit()
  await until(() => denied.requests.length === 2)
  expect(denied.executions()).toBe(0)
  expect(denied.record("job")).toBeUndefined()
  expect(denied.requests[1]!.messages.at(-1)).toMatchObject({ isError: true })
})

test("async jobs retain the original read approval and refuse mutations or malformed target args", async () => {
  const h = await boot([callTool("tool_start", { tool: "read", arguments: { path: "README.md" } }), stop("Done")], { experimental: { async_tools: true }, permission: { read: "ask" } })
  await h.submit()
  await until(() => h.events.some((event) => event.type === "server.request"))
  expect(h.record("job")).toBeUndefined()
  const approval = h.events.find((event) => event.type === "server.request")!
  expect(approval).toMatchObject({ kind: "approval", tool: "read" })
  expect((await h.client.send({ type: "request.resolve", sessionId: h.sessionId, requestId: approval.requestId, decision: { kind: "deny", reason: "Keep private" } })).ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "turn.cancelled" || event.type === "turn.completed"))
  expect(h.executions()).toBe(0)
  const invalid = await boot([callTool("tool_start", { tool: "shell", arguments: { command: "echo mutation" } }), callTool("tool_start", { tool: "read", arguments: {} }), stop("Done")])
  await invalid.submit()
  await until(() => invalid.requests.length === 3)
  expect(invalid.executions()).toBe(0)
  expect(invalid.record("job")).toBeUndefined()
  expect(invalid.requests[1]!.messages.at(-1)).toMatchObject({ isError: true })
  expect(invalid.requests[2]!.messages.at(-1)).toMatchObject({ isError: true })
})

test("question_start is nonblocking, question_status returns pending, and replies wake the same session without granting approval", async () => {
  const h = await boot([callTool("question_start", { questions }), (request) => {
    const posted = JSON.parse((request.messages.at(-1) as { output: string }).output) as { question_id: string }
    return callTool("question_status", { question_id: posted.question_id })
  }, stop("Independent work complete")])
  await h.submit()
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  const question = h.record("question")!
  expect(question.status).toBe("pending")
  expect(h.requests).toHaveLength(3)
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ output: expect.stringContaining('"status":"pending"') })
  expect(h.events.find((event) => event.type === "server.request")).toMatchObject({ async: true, kind: "question", questions })
  expect(await h.client.answerQuestions(h.sessionId, question.requestId!, [["Custom"]])).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect((await h.client.answerQuestions(h.sessionId, question.requestId!, [["SQLite"]])).ok).toBe(true)
  await until(() => h.requests.length === 4)
  expect(h.requests[3]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining('[["SQLite"]]') })
  expect(h.daemon.store.permissionModeOf(h.sessionId)).toBe("ask")
  expect(await h.client.answerQuestions(h.sessionId, question.requestId!, [["Postgres"]])).toMatchObject({ ok: false, error: { code: "request_already_resolved" } })
})

test("a pending asynchronous question survives daemon stop/restart and can still be answered by a reconnected client", async () => {
  const h = await boot([callTool("question_start", { questions }), stop("Independent work complete")])
  await h.submit()
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  const question = h.record("question")!
  h.client.close()
  await h.daemon.stop()
  const daemon = await startDaemon({ dir: h.dir, socketPath: path.join(h.dir, "mendd.sock"), engine: h.factory, log: () => {} })
  cleanups.push(() => daemon.stop())
  expect(daemon.store.pendingRequestsOf(h.sessionId)).toHaveLength(1)
  const client = createClient({ socketPath: daemon.socketPath, name: "reconnected" })
  cleanups.push(() => client.close())
  await client.connect()
  expect(await client.continuityRecord(h.sessionId, question.id)).toMatchObject({ ok: true, record: { status: "pending", questions } })
  expect((await client.answerQuestions(h.sessionId, question.requestId!, [["SQLite"]])).ok).toBe(true)
  await until(() => daemon.store.continuity.get(h.sessionId, question.id)?.status === "answered")
})

test("tool_status, tool_wait and tool_cancel operate on the same durable session job", async () => {
  let jobId = ""
  const h = await boot([
    callTool("tool_start", { tool: "read", arguments: { path: "README.md" } }),
    (request) => { jobId = JSON.parse((request.messages.at(-1) as { output: string }).output).job_id; return callTool("tool_status", { job_id: jobId }) },
    callTool("tool_wait", { job_ids: ["unknown"], timeout_ms: 0 }),
    () => callTool("tool_wait", { job_ids: [jobId], timeout_ms: 0 }),
    () => callTool("tool_cancel", { job_id: jobId }),
    stop("Done"),
  ], undefined, (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("Late cancellation result"), { once: true })))
  await h.submit()
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(h.requests).toHaveLength(6)
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ output: expect.stringContaining('"status":"running"') })
  expect(h.requests[3]!.messages.at(-1)).toMatchObject({ isError: true, output: expect.stringContaining("Unknown") })
  expect(h.requests[4]!.messages.at(-1)).toMatchObject({ output: expect.stringContaining('"status":"running"') })
  expect(h.requests[5]!.messages.at(-1)).toMatchObject({ output: expect.stringContaining('"status":"cancelled"') })
  expect(h.daemon.store.continuity.get(h.sessionId, jobId)?.status).toBe("cancelled")
  expect(h.events.filter((event) => event.type === "queue.added" && event.notice)).toHaveLength(0)
})

test("user cancellation withdraws queued async continuations and a later user turn never resumes cancelled work", async () => {
  let release!: () => void
  const h = await boot([
    callTool("tool_start", { tool: "read", arguments: { path: "README.md" } }),
    (request) => new Promise((resolve) => request.signal.addEventListener("abort", () => resolve(stop("Cancelled")), { once: true })),
  ], undefined, () => new Promise((resolve) => { release = () => resolve("A queued async result") }))
  await h.submit()
  await until(() => h.requests.length === 2)
  release()
  await until(() => h.daemon.store.queueOf(h.sessionId).some((entry) => entry.notice))
  const turnId = h.events.findLast((event) => event.type === "turn.started")!.turnId
  expect((await h.client.send({ type: "turn.cancel", sessionId: h.sessionId, turnId })).ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "turn.cancelled"))
  expect(h.daemon.store.queueOf(h.sessionId)).toHaveLength(0)
  expect(h.daemon.store.continuity.generation(h.sessionId)).toBe(1)
  expect(h.requests).toHaveLength(2)
  await h.submit()
  await until(() => h.requests.length === 3)
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ content: "Read and plan the service" })
})
