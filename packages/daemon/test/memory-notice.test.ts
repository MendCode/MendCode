import { afterEach, expect, test } from "bun:test"
import { boot, callTool, openSession, say, stop, until, type NativeHarness } from "./native-harness"
import { memoryExtractionPrompt } from "../src/memory-extract-prompt"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const saved = (h: NativeHarness) => h.store.memories.list({ directory: h.project }).filter((entry) => entry.status === "saved")
const pending = (h: NativeHarness) => h.store.memories.list({ directory: h.project }).filter((entry) => entry.status === "pending")
const requests = (h: NativeHarness) => h.events.filter((event) => event.type === "server.request")
const notices = (h: NativeHarness) => h.events.filter((event) => event.type === "item.completed" && event.meta?.memorySaved === true) as unknown as Array<{ text: string; meta: Record<string, unknown> }>
const changes = (h: NativeHarness) => h.globals.filter((event) => event.type === "memory.changed")

const REQUEST = "dame respuesta con una tabla, un bloque de código y una lista de tareas"
const RESTATED = "Formato: Tabla, bloque de código y lista de tareas / Idioma: Español"

test("memory.changed says what changed: scope, status and text for a save, an edit and a removal", async () => {
  const h = await boot({ steps: [] })
  all.push(h)
  const added = await h.client.send({ type: "memory.add", scope: "project", directory: h.project, text: "Use bun for tests", category: "commands" })
  expect(added.ok).toBe(true)
  const memoryId = saved(h)[0]!.memoryId
  await h.client.send({ type: "memory.update", memoryId, text: "Use bun test for tests" })
  await h.client.send({ type: "memory.delete", memoryId })
  await until(() => changes(h).length >= 3)
  expect(changes(h).slice(0, 3)).toMatchObject([
    { change: "added", scope: "project", status: "saved", text: "Use bun for tests" },
    { change: "updated", scope: "project", status: "saved", text: "Use bun test for tests" },
    { change: "deleted", scope: "project", status: "saved", text: "Use bun test for tests" },
  ])
})

test("a proposal that waits for review says pending, never saved", async () => {
  const h = await boot({ steps: [stop("done")], extractMemory: async () => [{ scope: "project", text: "Review me", category: "commands" }] })
  all.push(h)
  const id = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true } })
  await say(h, id, "Something durable")
  await until(() => changes(h).length >= 1)
  expect(changes(h)[0]).toMatchObject({ change: "added", status: "pending", text: "Review me" })
})

test("tool writes say saved, updated and removed with the scope and the start of the memory", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory", { action: "add", scope: "project", text: "Use pnpm", category: "commands" }), stop("ok")] })
  all.push(h)
  const id = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: false } })
  await say(h, id, "Note the package manager")
  const memoryId = saved(h)[0]!.memoryId
  h.steps.push(callTool("memory", { action: "update", id: memoryId, text: "Use bun" }), stop("ok"), callTool("memory", { action: "delete", id: memoryId }), stop("ok"))
  await say(h, id, "Switch the package manager")
  await say(h, id, "Forget the package manager")
  expect(notices(h).map((event) => event.text)).toEqual([`Memory  saved · project · "Use pnpm"`, `Memory  updated · project · "Use bun"`, `Memory  removed · project · "Use bun"`])
  expect(notices(h).map((event) => event.meta?.memoryChange)).toEqual(["saved", "updated", "removed"])
  expect(notices(h)[0]?.meta?.memoryId).toBe(memoryId)
})

test("a save that restates this request is asked about even with approval off", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", { action: "upsert_fact", scope: "user", text: RESTATED, category: "preferences" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: false } })
  await h.client.send({ type: "user.submit", sessionId: id, text: REQUEST, attachments: [] })
  await until(() => requests(h).length === 1)
  expect(requests(h)[0]).toMatchObject({ title: "Save to memory?" })
  expect((requests(h)[0] as { detail: string }).detail).toContain("Restates this request")
  expect(saved(h)).toHaveLength(0)
  await h.client.send({ type: "request.resolve", sessionId: id, requestId: requests(h)[0]!.requestId, decision: { kind: "deny" } })
  await until(() => h.store.turns.list(id).every((turn) => turn.status !== "running"))
  expect(saved(h)).toHaveLength(0)
  expect(notices(h)).toHaveLength(0)
})

test("a standing instruction and an explicit remember still save with no dialog", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", { action: "upsert_fact", scope: "user", text: "Answers use a table, a code block and a task list", category: "preferences" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: false } })
  await say(h, id, "From now on answer with a table, a code block and a task list")
  expect(requests(h)).toHaveLength(0)
  expect(saved(h)).toHaveLength(1)
  h.steps.push(callTool("memory_graph", { action: "upsert_fact", scope: "user", text: "Use pnpm", category: "commands" }), stop("done"))
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: true } })
  await say(h, id, "remember: Use pnpm")
  expect(requests(h)).toHaveLength(0)
  expect(saved(h)).toHaveLength(2)
})

test("with approval on, the card still asks for an unrelated model save", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", { action: "upsert_fact", scope: "user", text: "Use pnpm", category: "commands" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId: id, text: "Hello", attachments: [] })
  await until(() => requests(h).length === 1)
  expect((requests(h)[0] as { detail: string }).detail).not.toContain("Restates")
  await h.client.send({ type: "request.resolve", sessionId: id, requestId: requests(h)[0]!.requestId, decision: { kind: "deny" } })
})

test("the extractor waits for review on a fact that restates the request, and saves a stated standing one", async () => {
  let reply: Array<{ scope: "project" | "user"; text: string; category: string }> = [{ scope: "user", text: RESTATED, category: "preferences" }]
  const h = await boot({ steps: [stop("done"), stop("done")], extractMemory: async () => reply })
  all.push(h)
  const id = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryRequireApproval: false, memoryPolicies: { preferences: "auto" } } })
  await say(h, id, REQUEST)
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(saved(h)).toHaveLength(0)
  expect(pending(h).map((entry) => entry.text)).toEqual([RESTATED])
  expect(notices(h)).toHaveLength(0)
  reply = [{ scope: "user", text: "Answer with tables and a task list", category: "preferences" }]
  await say(h, id, "From now on answer with tables and a task list")
  await until(() => notices(h).length === 1)
  expect(saved(h).map((entry) => entry.text)).toEqual(["Answer with tables and a task list"])
})

test("the extractor prompt keeps one-off requests out and says when to leave a fact out", () => {
  const prompt = memoryExtractionPrompt("user: dame una tabla")
  for (const phrase of ["always, from now on, remember, I prefer", "A one-off request is not a preference", "When unsure, leave it out", "its content, format or language", "task status"]) expect(prompt).toContain(phrase)
  expect(prompt.endsWith("user: dame una tabla")).toBe(true)
})
