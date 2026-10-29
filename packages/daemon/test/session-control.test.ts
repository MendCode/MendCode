import { afterEach, expect, test } from "bun:test"
import { createIdFactory, type SessionId, type TaskRecord } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { boot, hang, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const start = async (options: Parameters<typeof boot>[0] = {}) => { const h = await boot(options); all.push(h); return h }
const control = (h: NativeHarness, sessionId: SessionId, action: "pause" | "resume" | "stop") => h.client.send({ type: "session.control", sessionId, action })
const turns = (h: NativeHarness, sessionId: SessionId) => h.store.turns.list(sessionId)
const background = async (h: NativeHarness, parent: SessionId) => {
  const reply = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Work", prompt: "Wait", background: true } })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.task as TaskRecord
}
const summary = async (h: NativeHarness, sessionId: SessionId) => {
  const listed = await h.client.send({ type: "session.list" })
  return listed.ok ? (listed.result?.sessions as Array<{ sessionId: string; paused?: boolean; state: string }>).find((entry) => entry.sessionId === sessionId) : undefined
}

test("pause lets the running turn finish, holds new prompts, and resume starts them", async () => {
  const h = await start({ steps: [stop("one"), stop("two")] })
  const session = await openSession(h)
  await say(h, session, "first")
  expect(await control(h, session, "pause")).toMatchObject({ ok: true, result: { paused: true, cancelledTurn: false, cancelledChildren: 0 } })
  await h.client.send({ type: "user.submit", sessionId: session, text: "second", attachments: [] })
  await Bun.sleep(80)
  expect(turns(h, session)).toHaveLength(1)
  expect(await summary(h, session)).toMatchObject({ paused: true, state: "queued" })
  expect(await control(h, session, "resume")).toMatchObject({ ok: true, result: { paused: false } })
  await until(() => turns(h, session).length === 2 && turns(h, session).every((turn) => turn.status === "completed"))
  expect((await summary(h, session))?.paused).toBeFalsy()
})

test("stop cancels the running turn and every running child task, then the queue stays held until resume", async () => {
  const h = await start({ steps: [hang, hang, stop("after resume")] })
  const session = await openSession(h)
  const child = await background(h, session)
  await until(() => h.requests.length === 1)
  await h.client.send({ type: "user.submit", sessionId: session, text: "main turn", attachments: [] })
  await until(() => h.requests.length === 2)
  await h.client.send({ type: "user.submit", sessionId: session, text: "queued behind", attachments: [] })
  const reply = await control(h, session, "stop")
  expect(reply).toMatchObject({ ok: true, result: { cancelledTurn: true, cancelledChildren: 1 } })
  await until(() => h.store.tasks.list().find((task) => task.taskId === child.taskId)?.state === "cancelled")
  await until(() => turns(h, session).some((turn) => turn.status === "cancelled"))
  await Bun.sleep(60)
  expect(h.requests).toHaveLength(2)
  expect(await control(h, session, "resume")).toMatchObject({ ok: true })
  await until(() => h.requests.length === 3)
})

test("stop on a subagent session cancels only that child; stop with nothing running is a no-op", async () => {
  const h = await start({ steps: [hang] })
  const session = await openSession(h)
  expect(await control(h, session, "stop")).toMatchObject({ ok: true, result: { cancelledTurn: false, cancelledChildren: 0 } })
  const child = await background(h, session)
  await until(() => h.requests.length === 1)
  expect(await control(h, child.taskId, "stop")).toMatchObject({ ok: true, result: { cancelledTurn: true } })
  await until(() => h.store.tasks.list().find((task) => task.taskId === child.taskId)?.state === "cancelled")
})

test("unknown sessions are refused and the command is not available to read-only peers", async () => {
  const h = await start()
  expect(await control(h, createIdFactory()("session"), "pause")).toMatchObject({ ok: false })
  expect(isReadOnlyCommand("session.control")).toBe(false)
})
