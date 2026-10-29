import { afterEach, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import type { SessionEvent } from "@mendcode/protocol"
import { boot, callTool, hang, openSession, stop, until, type NativeHarness } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0).reverse()) await h.cleanup() })
const completed = (h: NativeHarness) => h.events.filter((event) => event.type === "turn.completed").length

for (const mode of ["after-response", "after-tools"] as const) test(`${mode} uses the full tool iteration boundary and replays each prompt exactly once`, async () => {
  // Approval inside the second tool of one iteration: after-tools must not join before it has a result.
  const first = [...callTool("probe", {}, "a").slice(0, -1), ...callTool("write", { path: "queue.txt", content: "local fixture" }, "b")]
  const h = await boot({ steps: [first, stop("Done"), stop("Follow-up done")] })
  running.push(h)
  const sessionId = await openSession(h, "ask")
  expect(await h.client.queueMode(mode)).toEqual({ ok: true, mode })
  await h.client.send({ type: "user.submit", sessionId, text: "First", attachments: [] })
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.findLast((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing approval")
  const text = "Keep the changes local"
  await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
  expect(h.store.queueOf(sessionId).map((entry) => entry.text)).toEqual([text])
  expect(h.requests).toHaveLength(1)
  expect(h.store.engineMessages.load(sessionId, "native").filter((message) => (message as { content?: string }).content === text)).toHaveLength(0)
  await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
  await until(() => completed(h) === (mode === "after-tools" ? 1 : 2))
  const roles = h.requests[1]!.messages.map((message) => message.role)
  expect(roles).toEqual(mode === "after-tools" ? ["user", "assistant", "tool", "tool", "user"] : ["user", "assistant", "tool", "tool"])
  expect(h.requests[mode === "after-tools" ? 1 : 2]!.messages.at(-1)).toMatchObject({ role: "user", content: text })
  expect(h.store.queueOf(sessionId)).toEqual([])
  expect(h.events.filter((event) => event.type === "item.completed" && event.text === text)).toHaveLength(1)
  expect(h.events.filter((event) => event.type === "turn.cancelled")).toHaveLength(0)
  const replay: SessionEvent[] = []
  const client = createClient({ socketPath: h.daemon.socketPath, name: "queue-replay", onEvent: (event) => { replay.push(event) } })
  try {
    await client.connect()
    await client.subscribe(sessionId, 0)
    await until(() => replay.at(-1)?.seq === h.store.lastSeq(sessionId))
    expect(replay.filter((event) => event.type === "item.completed" && event.text === text)).toHaveLength(1)
  } finally { await client.close() }
})

test("after-response: two messages sent during an answer start one next turn that the model reads as one request", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = await boot({ steps: [async () => { await gate; return stop("First done") }, stop("Both done")] })
  running.push(h)
  const sessionId = await openSession(h)
  expect(await h.client.queueMode("after-response")).toEqual({ ok: true, mode: "after-response" })
  await h.client.send({ type: "user.submit", sessionId, text: "First", attachments: [] })
  await until(() => h.requests.length === 1)
  const second = await h.client.send({ type: "user.submit", sessionId, text: "Second", attachments: [] })
  const third = await h.client.send({ type: "user.submit", sessionId, text: "Third", attachments: [] })
  release()
  await until(() => completed(h) === 2)
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "Second\n\nThird" })
  const started = h.events.filter((event) => event.type === "turn.started")
  expect(started).toHaveLength(2)
  const queueIdOf = (reply: typeof second) => (reply.ok ? reply.result?.queueId : undefined)
  expect(started[1]).toMatchObject({ queueId: queueIdOf(second), joinedQueueIds: [queueIdOf(third)] })
  expect(h.events.filter((event) => event.type === "item.completed" && (event.text === "Second" || event.text === "Third"))).toHaveLength(2)
  expect(h.store.queueOf(sessionId)).toEqual([])
})

test("after-tools: a message sent while the final answer streams joins the same turn with one more model call", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = await boot({ steps: [async () => { await gate; return stop("First done") }, stop("Second done")] })
  running.push(h)
  const sessionId = await openSession(h)
  expect(await h.client.queueMode("after-tools")).toEqual({ ok: true, mode: "after-tools" })
  await h.client.send({ type: "user.submit", sessionId, text: "First", attachments: [] })
  await until(() => h.requests.length === 1)
  await h.client.send({ type: "user.submit", sessionId, text: "Second", attachments: [] })
  release()
  await until(() => completed(h) === 1 && h.requests.length === 2)
  expect(h.requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "Second" })
  expect(h.events.filter((event) => event.type === "turn.started")).toHaveLength(1)
  expect(h.store.queueOf(sessionId)).toEqual([])
})

test("immediate stops the old stream, starts one new turn, persists the mode and pushes changes", async () => {
  const h = await boot({ steps: [hang, stop("New answer")] })
  running.push(h)
  const sessionId = await openSession(h)
  const seen: unknown[] = []
  const other = createClient({ socketPath: h.daemon.socketPath, name: "queue-observer", onGlobal: (event) => { if (event.type === "settings.changed") seen.push(event.settings) } })
  try {
    await other.connect()
    expect(await h.client.queueMode()).toEqual({ ok: true, mode: "after-response" })
    await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
    await until(() => h.requests.length === 1)
    expect(await h.client.queueMode("immediate")).toEqual({ ok: true, mode: "immediate" })
    await h.client.send({ type: "user.submit", sessionId, text: "New", attachments: [] })
    await until(() => completed(h) === 1)
    expect(h.requests).toHaveLength(2)
    expect(h.requests[0]!.signal.aborted).toBe(true)
    expect(h.events.filter((event) => event.type === "turn.cancelled")).toMatchObject([{ by: "promotion" }])
    expect(h.store.settings.get().queue).toEqual({ mode: "immediate" })
    await until(() => seen.length > 0)
    expect(seen[0]).toMatchObject({ queue: { mode: "immediate" } })
    expect(await h.client.send({ type: "settings.set", patch: { queue: { mode: "after-turn" } } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "settings.set", patch: { queue: null } })).toMatchObject({ ok: true })
    expect(await h.client.queueMode()).toEqual({ ok: true, mode: "after-response" })
  } finally { await other.close() }
})

test("restart retains the queue held and mode, then explicit send resumes it once", async () => {
  const h = await boot({ steps: [hang] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.queueMode("after-tools")
  await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
  await until(() => h.requests.length === 1)
  await h.client.send({ type: "user.submit", sessionId, text: "Restored", attachments: [] })
  await h.client.close()
  await h.daemon.stop()
  const again = await boot({ dir: h.dir, project: h.project, steps: [stop("Resumed")] })
  running.push(again)
  await again.client.subscribe(sessionId, 0)
  expect(await again.client.queueMode()).toEqual({ ok: true, mode: "after-tools" })
  expect(again.requests).toHaveLength(0)
  const queued = again.store.queueOf(sessionId)
  expect(queued.map((entry) => entry.text)).toEqual(["Restored"])
  await again.client.send({ type: "queue.promote", sessionId, queueId: queued[0]!.queueId })
  await until(() => completed(again) === 1)
  expect(again.requests).toHaveLength(1)
  expect(again.requests[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "Restored" })
  expect(again.store.queueOf(sessionId)).toEqual([])
})
