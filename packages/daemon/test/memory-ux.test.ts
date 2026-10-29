import { afterEach, expect, test } from "bun:test"
import { boot, callTool, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const fact = { action: "upsert_fact", scope: "user", text: "The user's name is Nora.", category: "preferences" }
const saved = (h: NativeHarness) => h.store.memories.list({ directory: h.project }).filter((entry) => entry.status === "saved")
const requests = (h: NativeHarness) => h.events.filter((event) => event.type === "server.request")
const notices = (h: NativeHarness) => h.events.filter((event) => event.type === "item.completed" && event.meta?.memorySaved === true)

test("explicit Spanish consent saves once, normalized extractor duplicate writes nothing", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", fact), stop("done")], extractMemory: async () => [{ scope: "user", text: "  THE USER'S name IS   Nora.  ", category: "preferences" }] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true } })
  await say(h, id, "me llamo Nora recuerda eso")
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(requests(h)).toHaveLength(0)
  expect(saved(h)).toHaveLength(1)
  expect(notices(h)).toHaveLength(1)
  expect(notices(h)[0]).toMatchObject({ text: `Memory  saved · user · "The user's name is Nora."`, meta: { memoryChange: "saved", memoryScope: "user", memoryText: "The user's name is Nora." } })
  expect(h.store.extraction.list()[0]?.proposed).toBe(0)
})

for (const decision of ["save", "edit", "reject", "always"] as const) test(`model memory approval: ${decision}`, async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", fact), stop("done"), callTool("memory_graph", { ...fact, text: "Use pnpm" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId: id, text: "Hello", attachments: [] })
  await until(() => requests(h).length === 1)
  const request = requests(h)[0]!
  expect(request.title).toBe("Save to memory?")
  expect(request.detail).toBe("The user's name is Nora.\n[user] [preferences]")
  expect(request.detail).not.toContain("upsert_fact")
  const answer = decision === "reject" ? { kind: "deny" as const } : { kind: "approve" as const, scope: "once" as const, ...(decision === "edit" ? { memoryText: "My name is Alice" } : {}), ...(decision === "always" ? { memoryAlways: true } : {}) }
  expect((await h.client.send({ type: "request.resolve", sessionId: id, requestId: request.requestId, decision: answer })).ok).toBe(true)
  await until(() => h.store.turns.list(id).every((turn) => turn.status !== "running"))
  expect(saved(h)).toHaveLength(decision === "reject" ? 0 : 1)
  expect(notices(h)).toHaveLength(decision === "reject" ? 0 : 1)
  if (decision === "edit") expect(saved(h)[0]?.text).toBe("My name is Alice")
  if (decision === "always") {
    expect(h.store.settings.get().memoryRequireApproval).toBe(false)
    await say(h, id, "Next")
    expect(requests(h)).toHaveLength(1)
    expect(saved(h)).toHaveLength(2)
  }
})

test("one fact consent does not authorize another fact in the turn", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", fact), callTool("memory_graph", { ...fact, text: "Use npm" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId: id, text: "My name is Nora, remember that", attachments: [] })
  await until(() => requests(h).length === 1)
  expect(saved(h)).toHaveLength(1)
  expect(requests(h)[0]?.detail).toContain("Use npm")
  await h.client.send({ type: "request.resolve", sessionId: id, requestId: requests(h)[0]!.requestId, decision: { kind: "deny" } })
})

test("repeated write is a no-op with no saved notice; saved facts can be edited and deleted", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", fact), stop("done"), callTool("memory_graph", fact), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await say(h, id, "Remember my name is Nora")
  await say(h, id, "Remember my name is Nora")
  expect(saved(h)).toHaveLength(1)
  expect(notices(h)).toHaveLength(1)
  const memoryId = saved(h)[0]!.memoryId
  expect((await h.client.send({ type: "memory.update", memoryId, text: "My name is Alice" })).ok).toBe(true)
  expect(saved(h)[0]?.text).toBe("My name is Alice")
  expect((await h.client.send({ type: "memory.delete", memoryId })).ok).toBe(true)
  expect(saved(h)).toHaveLength(0)
})

test("extractor announces only committed saved facts, not pending or failed proposals", async () => {
  let count = 0
  const h = await boot({ steps: [stop("done"), stop("done")], extractMemory: async () => [{ scope: "user", text: `Use bun ${++count}`, category: "commands" }] })
  all.push(h)
  const id = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryPolicies: { commands: "auto" } } })
  await say(h, id, "A durable rule")
  await until(() => h.store.extraction.list()[0]?.state === "completed")
  expect(notices(h)).toHaveLength(0)
  await h.client.send({ type: "settings.set", patch: { memoryRequireApproval: false } })
  await say(h, id, "Another durable rule")
  await until(() => notices(h).length === 1)
  expect(notices(h)[0]).toMatchObject({ text: `Memory  saved · user · "Use bun 2"`, meta: { memoryChange: "saved", memoryText: "Use bun 2" } })
})

test("disabled memory refuses writes even in full mode", async () => {
  const h = await boot({ memoryTools: true, steps: [callTool("memory_graph", fact), stop("done")] })
  all.push(h)
  const id = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { memoryEnabled: false } })
  await say(h, id, "me llamo Nora recuerda eso")
  expect(saved(h)).toHaveLength(0)
  expect(notices(h)).toHaveLength(0)
})

test("memory approval fields cannot resolve an unrelated request", async () => {
  const h = await boot({ steps: [callTool("write", { path: "x.ts", content: "export {}" }), stop("done")] })
  all.push(h)
  const id = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId: id, text: "Write x.ts", attachments: [] })
  await until(() => requests(h).length === 1)
  expect(await h.client.send({ type: "request.resolve", sessionId: id, requestId: requests(h)[0]!.requestId, decision: { kind: "approve", scope: "once", memoryAlways: true } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(h.store.settings.get().memoryRequireApproval).not.toBe(false)
  await h.client.send({ type: "request.resolve", sessionId: id, requestId: requests(h)[0]!.requestId, decision: { kind: "deny" } })
})
