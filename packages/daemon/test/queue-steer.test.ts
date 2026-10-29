import { afterEach, expect, test } from "bun:test"
import type { QueueId } from "@mendcode/protocol"
import { boot, callTool, hang, openSession, stop, until, type NativeHarness } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0).reverse()) await h.cleanup() })
const completed = (h: NativeHarness) => h.events.filter((event) => event.type === "turn.completed").length
const queueIdOf = (reply: { ok: boolean; result?: unknown }) => (reply.result as { queueId: QueueId }).queueId

test("a steered message joins the running turn after the tool result under the default policy", async () => {
  const h = await boot({ steps: [callTool("write", { path: "steer.txt", content: "local fixture" }, "w"), stop("Done")] })
  running.push(h)
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "First", attachments: [] })
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.findLast((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing approval")
  const reply = await h.client.send({ type: "user.submit", sessionId, text: "Use the other file", attachments: [], delivery: "steer" })
  expect(reply).toMatchObject({ ok: true, result: { steered: true } })
  expect(h.store.queueOf(sessionId).map((entry) => entry.text)).toEqual(["Use the other file"])
  await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
  await until(() => completed(h) === 1)
  expect(h.requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "Use the other file" })
  expect(h.store.queueOf(sessionId)).toEqual([])
})

test("reorder and edit persist across a restart, and queue.list reads them back", async () => {
  const h = await boot({ steps: [hang] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
  await until(() => h.requests.length === 1)
  const a = queueIdOf(await h.client.send({ type: "user.submit", sessionId, text: "a typo", attachments: [] }))
  const b = queueIdOf(await h.client.send({ type: "user.submit", sessionId, text: "b", attachments: [] }))
  expect(await h.client.send({ type: "queue.reorder", sessionId, queueId: b, to: "top" })).toMatchObject({ ok: true, result: { position: 0 } })
  expect(await h.client.send({ type: "queue.edit", sessionId, queueId: a, text: "a fixed" })).toMatchObject({ ok: true })
  expect(await h.client.send({ type: "queue.list", sessionId })).toMatchObject({ ok: true, result: { entries: [{ queueId: b, text: "b" }, { queueId: a, text: "a fixed" }] } })
  await h.client.close()
  await h.daemon.stop()
  const again = await boot({ dir: h.dir, project: h.project, steps: [stop("one"), stop("two")] })
  running.push(again)
  await again.client.subscribe(sessionId, 0)
  expect(again.store.queueOf(sessionId).map((entry) => [entry.queueId, entry.text])).toEqual([[b, "b"], [a, "a fixed"]])
  expect(await again.client.send({ type: "queue.list", sessionId })).toMatchObject({ ok: true, result: { held: true, entries: [{ text: "b" }, { text: "a fixed" }] } })
  await again.client.send({ type: "queue.promote", sessionId, queueId: b })
  await until(() => completed(again) === 2)
  expect(again.requests.map((request) => request.messages.at(-1))).toMatchObject([{ content: "b" }, { content: "a fixed" }])
})

test("a retried send with the same clientRequestId queues once and returns the first answer", async () => {
  const h = await boot({ steps: [hang] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
  await until(() => h.requests.length === 1)
  const first = await h.client.send({ type: "user.submit", sessionId, text: "Once", attachments: [], clientRequestId: "retry-1" })
  const second = await h.client.send({ type: "user.submit", sessionId, text: "Once", attachments: [], clientRequestId: "retry-1" })
  expect(queueIdOf(second)).toBe(queueIdOf(first))
  expect(h.store.queueOf(sessionId).map((entry) => entry.text)).toEqual(["Once"])
  const other = await h.client.send({ type: "user.submit", sessionId, text: "Twice", attachments: [], clientRequestId: "retry-2" })
  expect(queueIdOf(other)).not.toBe(queueIdOf(first))
})

test("two sends with the same clientRequestId at once queue one message and both get its answer", async () => {
  const h = await boot({ steps: [hang] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
  await until(() => h.requests.length === 1)
  const [first, second] = await Promise.all([
    h.client.send({ type: "user.submit", sessionId, text: "Once", attachments: [], clientRequestId: "same" }),
    h.client.send({ type: "user.submit", sessionId, text: "Once", attachments: [], clientRequestId: "same" }),
  ])
  expect(queueIdOf(second)).toBe(queueIdOf(first))
  expect(h.store.queueOf(sessionId).map((entry) => entry.text)).toEqual(["Once"])
})

test("queue edit masks pasted secrets like any prompt and refuses an empty text", async () => {
  const h = await boot({ steps: [hang] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId, text: "Old", attachments: [] })
  await until(() => h.requests.length === 1)
  const id = queueIdOf(await h.client.send({ type: "user.submit", sessionId, text: "draft", attachments: [] }))
  const secret = "sk-ant-api03-" + "A".repeat(40)
  expect(await h.client.send({ type: "queue.edit", sessionId, queueId: id, text: `use ${secret}` })).toMatchObject({ ok: true })
  expect(h.store.queueOf(sessionId)[0]!.text).not.toContain(secret)
  expect(await h.client.send({ type: "queue.edit", sessionId, queueId: id, text: "" })).toMatchObject({ ok: false })
})
