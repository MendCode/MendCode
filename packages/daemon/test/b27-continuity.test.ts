import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { createIdFactory, type ContinuityRecord, type SessionId } from "@mendcode/protocol"
import { createContinuity } from "../src/continuity"
import { until } from "./native-harness"

const ids = createIdFactory()
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const questions = [{ header: "Store", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }], custom: false }]
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b27-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir })
  let closed = false
  const closeStore = () => { if (!closed) { closed = true; store.close() } }
  cleanups.push(closeStore)
  const sessionId = ids("session"), other = ids("session"), turnId = ids("turn")
  for (const id of [sessionId, other]) store.createSession({ id, directory: dir, title: "Async work" })
  store.settings.set({ experimental: { async_tools: true, async_questions: true } })
  const notices: Array<{ record: ContinuityRecord; text: string }> = []
  const runtime = createContinuity({ store, now: Date.now, requestId: () => ids("request"), emit: (event) => void store.sessionSink.append(event), mask: (_, text) => text.replaceAll("private-value", "‹secret:1›"), notify: async (record, text) => { notices.push({ record, text }); return ids("queue") } })
  cleanups.push(() => runtime.stop())
  const port = runtime.forSession(sessionId)
  const start = (id: string, run: Parameters<typeof port.start>[2], signal = new AbortController().signal) => port.start({ id, turnId, tool: "read" }, signal, run)
  return { dir, store, closeStore, runtime, port, start, notices, sessionId, other, turnId }
}
const result = (output = "Read result") => ({ output, isError: false })

test("four active and eight queued jobs: idempotent admission, cancellation frees a slot, session isolation", async () => {
  const h = harness()
  let executions = 0
  const gates: Array<() => void> = []
  const run = () => new Promise<ReturnType<typeof result>>((resolve) => { executions++; gates.push(() => resolve(result())) })
  for (let i = 0; i < 12; i++) h.start(`job_${i}`, run)
  await until(() => executions === 4)
  expect(h.runtime.list(h.sessionId).filter((record) => record.status === "queued")).toHaveLength(8)
  expect(() => h.start("overflow", run)).toThrow("capacity")
  expect(h.start("job_0", run).id).toBe("job_0")
  expect(executions).toBe(4)
  expect(() => h.runtime.forSession(h.other).get("job_0")).toThrow("this session")
  expect(() => h.runtime.forSession(h.other).cancel("job_0")).toThrow("this session")
  expect(h.port.cancel("job_0").status).toBe("cancelled")
  await until(() => executions === 5)
  gates[0]!()
  await until(() => h.port.get("job_0").output === "Read result")
  expect(h.port.get("job_0").status).toBe("cancelled")
  expect(h.notices.some(({ record }) => record.id === "job_0")).toBe(false)
  h.runtime.cancelSession(h.sessionId)
  for (const release of gates) release()
})

test("bounded wait handles terminal, timeout, abort and wrong ids without polling or cross-session access", async () => {
  const h = harness()
  let release!: () => void
  h.start("job_wait", () => new Promise((resolve) => { release = () => resolve(result()) }))
  await until(() => Boolean(release))
  expect((await h.port.wait(["job_wait"], 0, new AbortController().signal))[0]!.status).toBe("running")
  expect((await h.port.wait(["job_wait"], 5, new AbortController().signal))[0]!.status).toBe("running")
  const abort = new AbortController()
  const waiting = h.port.wait(["job_wait"], 60000, abort.signal)
  abort.abort()
  expect((await waiting)[0]!.status).toBe("running")
  const completed = h.port.wait(["job_wait"], 1000, new AbortController().signal)
  release()
  expect((await completed)[0]!.status).toBe("completed")
  await expect(h.port.wait(["unknown"], 0, abort.signal)).rejects.toThrow("Unknown")
  await expect(h.port.wait([], 0, abort.signal)).rejects.toThrow("1 to 12")
  await expect(h.runtime.forSession(h.other).wait(["job_wait"], 0, abort.signal)).rejects.toThrow("this session")
})

test("stored output is paged, masked and bounded; errors and media notices reach the durable mailbox once", async () => {
  const h = harness()
  h.start("job_output", async () => ({ ...result("private-value " + "x".repeat(60000)), images: [{}] }))
  h.start("job_failed", async () => { throw new Error("private-value failed") })
  await until(() => h.notices.length === 2)
  expect(h.store.continuity.get(h.sessionId, "job_output")!.output!.length).toBe(50000)
  expect(h.port.get("job_output", 0, 20)).toMatchObject({ status: "completed", nextOffset: 20, attachmentNotice: "Use synchronous read to retrieve media attachments." })
  expect(h.port.get("job_output", 49999, 20).nextOffset).toBeUndefined()
  expect(h.port.get("job_failed")).toMatchObject({ status: "failed", error: expect.stringContaining("‹secret:1›") })
  expect(JSON.stringify(h.store.continuity.list())).not.toContain("private-value")
  expect(JSON.stringify(h.notices)).not.toContain("private-value")
  expect(h.store.continuity.pending()).toHaveLength(0)
  h.runtime.recover()
  await Bun.sleep(5)
  expect(h.notices).toHaveLength(2)
})

test("turn abort and generation cancellation suppress continuations, retain late output and do not block new work", async () => {
  const h = harness()
  let release!: () => void
  const abort = new AbortController()
  h.start("job_old", () => new Promise((resolve) => { release = () => resolve(result("Late result")) }), abort.signal)
  await until(() => Boolean(release))
  abort.abort()
  h.runtime.cancelSession(h.sessionId)
  expect(h.store.continuity.generation(h.sessionId)).toBe(1)
  release()
  await until(() => h.port.get("job_old").output === "Late result")
  expect(h.port.get("job_old").status).toBe("cancelled")
  expect(h.notices).toHaveLength(0)
  h.start("job_new", async () => result())
  await until(() => h.notices.length === 1)
  expect(h.notices[0]!.record.generation).toBe(1)
})

test("a late result cannot recreate a cancelled record pruned from bounded history", async () => {
  const h = harness()
  let release!: () => void
  h.start("job_pruned", () => new Promise((resolve) => { release = () => resolve(result("Late result")) }))
  await until(() => Boolean(release))
  const cancelled = h.port.cancel("job_pruned")
  for (let i = 0; i < 256; i++) h.store.continuity.put({ ...cancelled, id: `newer_${i}`, status: "completed", createdAt: cancelled.createdAt + i + 1 })
  h.store.continuity.prune(h.sessionId)
  expect(h.store.continuity.get(h.sessionId, cancelled.id)).toBeUndefined()
  release()
  await Bun.sleep(5)
  expect(h.store.continuity.get(h.sessionId, cancelled.id)).toBeUndefined()
  expect(h.notices).toHaveLength(0)
})

test("questions persist independently of the turn; real ordered replies, dismissal and first resolution wins", async () => {
  const h = harness()
  const record = h.port.question({ id: "question_1", turnId: h.turnId, questions })
  h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId: h.turnId })
  expect(h.store.pendingRequestsOf(h.sessionId)[0]).toMatchObject({ requestId: record.requestId, async: true })
  expect(h.port.get("question_1").status).toBe("pending")
  expect(h.notices).toHaveLength(0)
  const command = (answers: string[][]) => ({ type: "request.resolve" as const, id: ids("command"), clientId: ids("client"), sessionId: h.sessionId, requestId: record.requestId!, decision: { kind: "answer" as const, text: answers.flat().join(", "), answers } })
  for (const answers of [[], [["Custom"]], [["SQLite", "Postgres"]], [["SQLite", "SQLite"]]]) expect(h.runtime.resolve(command(answers))).toMatchObject({ ok: false, code: "invalid_command" })
  expect(h.runtime.resolve({ ...command([["SQLite"]]), sessionId: h.other })).toBeUndefined()
  expect(h.runtime.resolve(command([["SQLite"]]))).toEqual({ ok: true })
  expect(h.runtime.resolve(command([["Postgres"]]))).toMatchObject({ code: "request_already_resolved" })
  expect(h.port.get("question_1")).toMatchObject({ status: "answered", answers: [["SQLite"]] })
  expect(h.store.pendingRequestsOf(h.sessionId)).toHaveLength(0)
  await until(() => h.notices.length === 1)
  expect(h.notices[0]!.text).toContain('[["SQLite"]]')
  const rejected = h.port.question({ id: "question_2", turnId: h.turnId, questions })
  expect(h.runtime.resolve({ ...command([]), requestId: rejected.requestId!, decision: { kind: "deny", reason: "Need more information" } })).toEqual({ ok: true })
  expect(h.port.get("question_2")).toMatchObject({ status: "dismissed", error: "Need more information" })
})

test("explicit flags default off, disabling cancels live work, and restart never repeats jobs or dismisses pending questions", async () => {
  const h = harness()
  const q = h.port.question({ id: "question_restart", turnId: h.turnId, questions })
  h.store.continuity.put({ id: "job_restart", sessionId: h.sessionId, turnId: h.turnId, tool: "read", kind: "job", status: "running", generation: 0, createdAt: Date.now(), updatedAt: Date.now() })
  h.runtime.recover()
  expect(h.port.get("job_restart")).toMatchObject({ status: "interrupted", error: expect.stringContaining("not repeated") })
  expect(h.port.get(q.id).status).toBe("pending")
  h.store.settings.set({ experimental: null })
  h.runtime.configure()
  expect(h.port.get(q.id).status).toBe("dismissed")
  expect(() => h.start("disabled", async () => result())).toThrow("disabled")
  expect(() => h.port.question({ id: "disabled_q", turnId: h.turnId, questions })).toThrow("disabled")
  h.store.settings.set({ experimental: { async_tools: true } })
  let ran = false
  h.start("stop", async (signal) => { ran = true; return new Promise((resolve) => signal.addEventListener("abort", () => resolve(result()))) })
  await until(() => ran)
  h.store.settings.set({ experimental: { async_tools: false } })
  h.runtime.configure()
  expect(h.port.get("stop").status).toBe("cancelled")
})

test("records and delivery acknowledgement survive reopening; an already queued notice is not duplicated", () => {
  const h = harness()
  const record: ContinuityRecord = { id: "job_delivered", sessionId: h.sessionId, turnId: h.turnId, kind: "job", tool: "read", generation: 0, status: "completed", output: "Result", createdAt: Date.now(), updatedAt: Date.now() }
  h.store.continuity.complete(record)
  h.store.sessionSink.append({ type: "queue.added", sessionId: h.sessionId, queueId: ids("queue"), text: `[Async job ${record.id}] completed\nResult`, notice: true, attachments: [] })
  h.runtime.recover()
  expect(h.store.continuity.pending()).toHaveLength(0)
  expect(h.notices).toHaveLength(0)
  h.runtime.stop()
  h.closeStore()
  const reopened = openStore({ dir: h.dir })
  expect(reopened.continuity.get(h.sessionId, record.id)).toMatchObject({ status: "completed", output: "Result" })
  expect(reopened.continuity.pending()).toHaveLength(0)
  reopened.close()
})
