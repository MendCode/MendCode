import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type ExtractionJob } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createMemoryExtraction, type ExtractedMemory } from "../src/memory-extraction"

const ids = createIdFactory()
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function until(predicate: () => boolean) {
  for (let count = 0; count < 300; count++) { if (predicate()) return; await Bun.sleep(2) }
  throw new Error("worker did not settle")
}
function fixture(extract?: (job: ExtractionJob, signal: AbortSignal) => Promise<ExtractedMemory[]>) {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-extraction-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir })
  cleanup.push(() => store.close())
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/project", title: "Extraction" })
  const proposals: ExtractedMemory[] = []
  store.settings.set({ memoryGenerate: true })
  const worker = createMemoryExtraction({ store, settings: () => store.settings.get(), now: Date.now, extract, retryMs: 1, timeoutMs: 20, commit: (_job, memories) => { proposals.push(...memories); return memories.length } })
  cleanup.push(() => worker.stop())
  const turn = (text = "Always use pnpm for this repository") => {
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    const event = store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    worker.observe(event)
    return event
  }
  return { dir, store, sessionId, proposals, worker, turn }
}

test("completed turns enqueue once; worker persists attempts and proposals without tool or secret output", async () => {
  const h = fixture(async (job) => {
    expect(job.text).toContain("Always use pnpm")
    expect(job.text).not.toContain("sk_live_")
    return [{ scope: "project", category: "commands", text: "Use pnpm" }]
  })
  const event = h.turn()
  h.worker.observe(event)
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(h.store.extraction.list()).toHaveLength(1)
  expect(h.store.extraction.list()[0]).toMatchObject({ attempts: 1, proposed: 1 })
  expect(h.proposals).toHaveLength(1)
  expect(h.worker.list()[0]).not.toHaveProperty("text")
})

test("use and generation are independent; disabling generation or memory prevents enqueue", async () => {
  const h = fixture(async () => [])
  h.store.settings.set({ memoryUse: false })
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  h.store.settings.set({ memoryGenerate: false })
  h.turn()
  h.store.settings.set({ memoryEnabled: false, memoryGenerate: true })
  h.turn()
  expect(h.store.extraction.list()).toHaveLength(1)
})

test("unconfigured extractor leaves a durable queued job with an explicit reason", async () => {
  const h = fixture()
  h.turn()
  expect(h.worker.configured).toBe(false)
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "queued", attempts: 0, reason: "Extractor not configured" })
})

test("errors retry twice then fail; explicit retry starts a new bounded attempt series", async () => {
  let fail = true
  const h = fixture(async () => { if (fail) throw new Error("bad extraction"); return [] })
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "failed")
  const job = h.store.extraction.list()[0]!
  expect(job.attempts).toBe(3)
  fail = false
  h.worker.retry(job.jobId)
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(h.store.extraction.list()[0]!.attempts).toBe(1)
  expect(() => h.worker.retry(job.jobId)).toThrow("Only failed")
})

test("worker times out an extractor that ignores abort, without accepting late results", async () => {
  let finish!: (value: ExtractedMemory[]) => void
  const h = fixture(() => new Promise((resolve) => { finish = resolve }))
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "failed")
  finish([{ scope: "project", category: "commands", text: "late" }])
  await Bun.sleep(3)
  expect(h.proposals).toEqual([])
  expect(h.store.extraction.list()[0]!.attempts).toBe(3)
})

test("shutdown pauses a live extraction and a new worker recovers the durable job", async () => {
  const h = fixture(() => new Promise(() => {}))
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "running")
  await h.worker.stop()
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "queued", attempts: 0, reason: "Paused for shutdown" })
  const next = createMemoryExtraction({ store: h.store, settings: () => h.store.settings.get(), now: Date.now, extract: async () => [], commit: () => 0 })
  cleanup.push(() => next.stop())
  next.wake()
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(h.store.extraction.list()[0]!.attempts).toBe(1)
})

test("settlement is transactional; failed writes roll back both proposals and completion", () => {
  const h = fixture()
  h.turn()
  const job = h.store.extraction.list()[0]!
  expect(() => h.store.extraction.settle(job, () => {
    h.store.memories.add({ memoryId: ids("memory"), scope: "project", directory: "/project", text: "Should roll back", category: "commands", status: "pending", source: "agent" })
    throw new Error("commit failed")
  })).toThrow("commit failed")
  expect(h.store.memories.list({ directory: "/project" })).toEqual([])
  expect(h.store.extraction.list()[0]!.state).toBe("queued")
})

test("disabling generation while an extraction is in flight skips the result", async () => {
  let finish!: (value: ExtractedMemory[]) => void
  const h = fixture(() => new Promise((resolve) => { finish = resolve }))
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "running")
  h.store.settings.set({ memoryGenerate: false })
  finish([{ scope: "user", category: "preferences", text: "Discard me" }])
  await until(() => h.store.extraction.list()[0]?.state === "skipped")
  expect(h.proposals).toEqual([])
})

test("memory/model graph calls still allow extraction; the commit deduplicates written facts", () => {
  const h = fixture()
  for (const tool of ["memory", "memory_graph"]) {
    const turnId = ids("turn")
    const itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId, status: "ok", text: "Remember this rule" })
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId: ids("item"), kind: "tool_call", meta: { tool } })
    h.worker.observe(h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId }))
  }
  expect(h.store.extraction.list()).toHaveLength(2)
  h.turn()
  expect(h.store.extraction.list()).toHaveLength(3)
})

test("status queue count includes jobs outside the bounded display list", () => {
  const h = fixture()
  for (let index = 0; index < 100; index++) h.turn(`Rule ${index}`)
  expect(h.worker.list()).toHaveLength(80)
  expect(h.worker.status()).toMatchObject({ queue: 100, lastRun: "never", lastError: "Extractor not configured" })
})
