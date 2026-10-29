import { afterEach, expect, test } from "bun:test"
import type { ModelRequest } from "@mendcode/engine-native"
import type { SessionId, TaskRecord, TurnId } from "@mendcode/protocol"
import { boot, callTool, hang, openSession, stop, until, type NativeHarness, type Step } from "./native-harness"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const start = async (options: Parameters<typeof boot>[0] = {}) => { const h = await boot(options); all.push(h); return h }
const LONG = 20_000

/** A background child of `parent`, started the way the task tool starts one. Its first model call takes the next scripted step. */
const child = async (h: NativeHarness, parent: SessionId) => {
  const reply = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Inspect engine", prompt: "Report findings", background: true } })
  expect(reply.ok).toBe(true)
  return (reply.ok ? reply.result?.task : undefined) as TaskRecord
}
const submit = (h: NativeHarness, id: SessionId, text: string) => h.client.send({ type: "user.submit", sessionId: id, text, attachments: [] })
const added = (h: NativeHarness, id: SessionId) => h.store.readAfter(id, 0, 2000).filter((event) => event.type === "queue.added" && event.notice)
const turns = (h: NativeHarness, id: SessionId) => h.store.turns.list(id)
const ended = (h: NativeHarness, id: SessionId) => turns(h, id).filter((turn) => turn.status !== "running").length
const pending = (h: NativeHarness) => h.store.sessionBackground.wakes.pending(100)
const finished = (h: NativeHarness, count = 1) => h.store.tasks.list().length >= count && h.store.tasks.list().every((task) => task.state === "completed")
const childNotices = (request: ModelRequest) => request.messages.flatMap((message) => (message.role === "user" && message.content.includes("[Background subagent ") ? [message.content] : []))
const shownNotices = (h: NativeHarness) => h.events.filter((event) => event.type === "item.started" && event.kind === "user_message" && event.meta?.notice === true)
/** Time for the outbox's own timers (200 ms, then 1 s) to send anything they still hold. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_400))
/** An owner's model call that answers only once every child has finished, so the completion is known to wait while the turn still works. */
const onceFinished = (h: () => NativeHarness, events: ReturnType<typeof stop>, count = 1): Step => async () => { await until(() => finished(h(), count)); return events }

test("a child that finishes while its owner's turn still calls tools is announced inside that turn, at its next model call, once", async () => {
  const h: NativeHarness = await start({ steps: [onceFinished(() => h, callTool("probe", {})), stop("Found the native entry point"), stop("used the finding")] })
  const parent = await openSession(h)
  await submit(h, parent, "split the work")
  await until(() => h.requests.length === 1)
  const task = await child(h, parent)
  await until(() => ended(h, parent) === 1)
  await settle()
  // One owner turn: the completion was not left for a turn of its own (the script has no further call to give).
  expect(turns(h, parent)).toHaveLength(1)
  expect(h.requests).toHaveLength(3)
  expect(childNotices(h.requests[0]!)).toHaveLength(0)
  const seen = childNotices(h.requests[2]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain("[Background subagent completed]")
  expect(seen[0]).toContain(task.taskId)
  expect(seen[0]).toContain("Found the native entry point")
  expect(seen[0]).toContain("untrusted evidence")
  // After the tool result that was running, at the tail: what the model had read before is unchanged.
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: seen[0]! })
  expect(h.requests[2]!.messages.at(-2)).toMatchObject({ role: "tool", output: "probed" })
  // Never lost, never twice: closed in the outbox, logged once, nothing left queued, one notice shown in that turn.
  expect(pending(h)).toHaveLength(0)
  expect(added(h, parent)).toHaveLength(1)
  expect(h.store.queueOf(parent)).toEqual([])
  expect(shownNotices(h)).toMatchObject([{ turnId: turns(h, parent)[0]!.turnId }])
  // The turn is still the user's: its text and authority are what the user sent.
  expect(turns(h, parent)[0]).toMatchObject({ notice: false, preview: "split the work", status: "completed" })
}, LONG)

test("the owner's turn ends before another model call: the completion gets its own turn when the owner is idle, as before", async () => {
  const h: NativeHarness = await start({ steps: [onceFinished(() => h, stop("handed it off")), stop("Late finding"), stop("read the late finding")] })
  const parent = await openSession(h)
  await submit(h, parent, "hand it off")
  await until(() => h.requests.length === 1)
  await child(h, parent)
  await until(() => ended(h, parent) === 2)
  await settle()
  expect(turns(h, parent)).toHaveLength(2)
  expect(h.requests).toHaveLength(3)
  expect(childNotices(h.requests[2]!)).toHaveLength(1)
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Late finding") })
  expect(turns(h, parent)[1]).toMatchObject({ notice: true })
  expect(added(h, parent)).toHaveLength(1)
  expect(pending(h)).toHaveLength(0)
}, LONG)

test("two children that finish during one model call are one message, and a shell task that ended before them comes first in it", async () => {
  let parent!: SessionId
  const h: NativeHarness = await start({
    shell: true,
    steps: [
      callTool("shell", { command: "sleep 0.3; echo built", background: true }),
      onceFinished(() => h, callTool("probe", {}), 2),
      // The children answer only after the shell task's notice reached the owner, so the order is known.
      async () => { await until(() => added(h, parent).length === 1); return stop("First finding") },
      async () => { await until(() => added(h, parent).length === 1); return stop("Second finding") },
      stop("collected all three"),
    ],
  })
  parent = await openSession(h)
  await submit(h, parent, "run everything")
  await until(() => h.requests.length === 2)
  const first = await child(h, parent), second = await child(h, parent)
  await until(() => ended(h, parent) === 1)
  await settle()
  expect(turns(h, parent)).toHaveLength(1)
  expect(h.requests).toHaveLength(5)
  const last = h.requests[4]!.messages.at(-1)!
  expect(last.role).toBe("user")
  const text = last.role === "user" ? last.content : ""
  expect(text).toMatch(/^\[background task bg_\w+ exited 0/)
  expect(text).toContain("built")
  expect(text.match(/\[Background subagent completed\]/g)).toHaveLength(2)
  expect(text).toContain(first.taskId)
  expect(text).toContain(second.taskId)
  expect(text.indexOf("built")).toBeLessThan(text.indexOf("[Background subagent"))
  expect(h.requests[4]!.messages.at(-2)).toMatchObject({ role: "tool", output: "probed" })
  expect(shownNotices(h)).toHaveLength(1)
  expect(pending(h)).toHaveLength(0)
  expect(h.store.queueOf(parent)).toEqual([])
}, LONG)

test("a completion the model read with task_status wait is not announced as well; a user's own look at the task does not count", async () => {
  const h: NativeHarness = await start({
    steps: [
      async () => { await until(() => h.store.tasks.list().length === 1); return callTool("task_status", { task_id: h.store.tasks.list()[0]!.taskId, action: "wait", timeout_ms: 10_000 }) },
      async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return stop("Waited-for finding") },
      hang,
      stop("answered"),
    ],
  })
  const parent = await openSession(h)
  await submit(h, parent, "wait for it")
  await until(() => h.requests.length === 1)
  const task = await child(h, parent)
  await until(() => h.requests.length === 3)
  const waited = h.requests[2]!.messages.at(-1)!
  expect(waited).toMatchObject({ role: "tool", name: "task_status", isError: false })
  const shown = waited.role === "tool" ? waited.output : ""
  expect(shown).toContain("state: completed")
  expect(shown).toContain("Waited-for finding")
  expect(shown).toContain("wait_timed_out: false")
  expect(pending(h)).toHaveLength(0)
  expect(childNotices(h.requests[2]!)).toHaveLength(0)
  // A second child that the user (not the model) inspects stays to be announced.
  h.steps.unshift(stop("Unread finding"))
  const other = await child(h, parent)
  await until(() => finished(h, 2))
  const looked = await h.client.send({ type: "task.status", sessionId: parent, taskId: other.taskId, action: "wait", timeoutMs: 1_000 })
  expect(looked.ok && looked.result?.text).toContain("Unread finding")
  expect(pending(h).map((wake) => wake.task.taskId)).toEqual([other.taskId])
  await h.client.send({ type: "turn.cancel", sessionId: parent, turnId: turns(h, parent)[0]!.turnId as TurnId })
  await until(() => turns(h, parent)[0]?.status === "cancelled")
  await settle()
  expect(added(h, parent)).toHaveLength(0)
  expect(turns(h, parent)).toHaveLength(1)
  expect(task.taskId).not.toBe(other.taskId)
}, LONG)

test("cancelling the owner drops a completion that waited for its next model call; nothing arrives with the user's next message", async () => {
  const h: NativeHarness = await start({ steps: [callTool("probe", {}), hang, stop("Dropped finding"), stop("resumed")] })
  const parent = await openSession(h)
  await submit(h, parent, "work")
  await until(() => h.requests.length === 2)
  await child(h, parent)
  await until(() => finished(h) && pending(h).length === 1)
  // The owner is inside a model call: there is no boundary yet, so the completion waits in the outbox, not in the queue.
  expect(h.store.queueOf(parent)).toEqual([])
  await h.client.send({ type: "turn.cancel", sessionId: parent, turnId: turns(h, parent)[0]!.turnId as TurnId })
  await until(() => turns(h, parent)[0]?.status === "cancelled")
  expect(pending(h)).toHaveLength(0)
  await submit(h, parent, "go on")
  await until(() => ended(h, parent) === 2)
  await settle()
  expect(h.requests).toHaveLength(4)
  expect(childNotices(h.requests[3]!)).toHaveLength(0)
  expect(JSON.stringify(h.requests[3]!.messages)).not.toContain("Dropped finding")
  expect(added(h, parent)).toHaveLength(0)
  expect(turns(h, parent)).toHaveLength(2)
}, LONG)

test("owner wake off: a finished child is not announced inside the running turn either", async () => {
  const h: NativeHarness = await start({ steps: [onceFinished(() => h, callTool("probe", {})), stop("Quiet finding"), stop("done")] })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { subagentOwnerWake: false } })
  await submit(h, parent, "work")
  await until(() => h.requests.length === 1)
  await child(h, parent)
  await until(() => ended(h, parent) === 1)
  await settle()
  expect(h.requests).toHaveLength(3)
  expect(childNotices(h.requests[2]!)).toHaveLength(0)
  expect(added(h, parent)).toHaveLength(0)
  expect(pending(h)).toHaveLength(0)
}, LONG)
