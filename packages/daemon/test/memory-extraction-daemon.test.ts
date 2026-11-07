import { afterEach, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })

test("daemon extraction obeys approval and scoped caps; use stays independent", async () => {
  let count = 0
  const h = await boot({ steps: [stop("one"), stop("two"), stop("three")], extractMemory: async () => [{ scope: "project", text: `Use pnpm ${++count}`, category: "commands" }] })
  all.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryUse: false, memoryPolicies: { commands: "auto" }, memoryProjectMaxEntries: 2 } })
  await say(h, sessionId, "First durable preference")
  await until(() => count === 1 && h.store.extraction.list().length === 0)
  expect(h.store.memories.list({ directory: h.project })[0]?.status).toBe("pending")
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: false } })
  await say(h, sessionId, "Second durable preference")
  await until(() => count === 2 && h.store.extraction.list().length === 0)
  expect(h.store.memories.list({ directory: h.project }).some((memory) => memory.status === "saved")).toBe(true)
  await say(h, sessionId, "Third durable preference")
  await until(() => count === 3 && h.store.extraction.list().length === 0)
  expect(h.store.memories.list({ directory: h.project })).toHaveLength(2)
  const report = await h.client.extractions(h.project)
  expect(report.ok && report.configured).toBe(true)
  expect(JSON.stringify(report)).not.toContain("First durable preference")
})

test("daemon maintenance previews then archives generated duplicates without changing manual facts", async () => {
  const h = await boot({ steps: [stop("preview"), stop("auto")] })
  all.push(h)
  const sessionId = await openSession(h)
  const first = await h.client.send({ type: "memory.add", scope: "project", directory: h.project, text: "Use pnpm", category: "commands" })
  expect(first.ok).toBe(true)
  const original = h.store.memories.list({ directory: h.project })[0]!
  const duplicate = { ...original, memoryId: createIdFactory()("memory"), source: "agent" as const, text: "use   pnpm" }
  h.store.memories.add(duplicate)
  await h.client.send({ type: "settings.set", patch: { memoryMaintenance: "preview" } })
  await say(h, sessionId, "Check the stored preferences")
  expect(h.store.memories.get(duplicate.memoryId)?.status).toBe("saved")
  const preview = await h.client.send({ type: "memory.extraction.list", directory: h.project })
  expect(preview.ok && preview.result?.maintenance).toMatchObject({ policy: "preview", duplicates: [{ memoryId: duplicate.memoryId, canonicalId: original.memoryId }] })
  await h.client.send({ type: "settings.set", patch: { memoryMaintenance: "auto-consolidate" } })
  await say(h, sessionId, "Apply the configured maintenance")
  expect(h.store.memories.get(duplicate.memoryId)?.status).toBe("archived")
  expect(h.store.memories.get(original.memoryId)?.status).toBe("saved")
})

test("a memory extracted after a turn records the session and the engine it came from", async () => {
  const h = await boot({ steps: [stop("one")], extractMemory: async () => [{ scope: "project", text: "Deploys go through the release script", category: "commands" }] })
  all.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true } })
  await say(h, sessionId, "How do we deploy this service to production?")
  await until(() => h.store.memories.list({ directory: h.project }).length === 1)
  expect(h.store.memories.list({ directory: h.project })[0]?.details).toMatchObject({ originSessionId: sessionId, originEngine: expect.any(String) })
})

test("an extraction the provider refused is a failed job, not an auxiliary call with no tokens; one that reported usage is counted", async () => {
  let calls = 0
  const h = await boot({ steps: [stop("one"), stop("two")], extractMemory: async (_job, _signal, onUsage) => {
    calls++
    if (calls <= 3) throw new Error("chatgpt 400 Bad Request")
    onUsage?.({ provider: "chatgpt", model: "m", input: 100, output: 5 })
    return []
  } })
  all.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true } })
  await say(h, sessionId, "How do we deploy this service to production?")
  await until(() => calls >= 3, 15_000)
  const { localDay } = await import("../src/usage-today")
  const day = localDay(Date.now())
  await until(() => h.store.extraction.list().every((job) => job.state !== "running"))
  expect(h.store.usageAuxiliary.report({ from: day, to: day }).filter((row) => row.role === "memoryExtractor")).toEqual([])
})
