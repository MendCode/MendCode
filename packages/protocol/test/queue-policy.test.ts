import { expect, test } from "bun:test"
import { Command, MAX_JOINED_QUEUE_ENTRIES, Settings, SessionEvent, createIdFactory, isReadOnlyCommand, startedQueueIds } from "../src"

test("turn.started names every queued message that started in it; joined ids are optional and bounded", () => {
  const ids = createIdFactory()
  const [session, turnId, first, second] = [ids("session"), ids("turn"), ids("queue"), ids("queue")]
  const base = { sessionId: session, seq: 1, at: 1, type: "turn.started", turnId, queueId: first }
  expect(SessionEvent.safeParse(base).success).toBe(true)
  expect(SessionEvent.safeParse({ ...base, joinedQueueIds: [second] }).success).toBe(true)
  expect(SessionEvent.safeParse({ ...base, joinedQueueIds: Array.from({ length: MAX_JOINED_QUEUE_ENTRIES + 1 }, () => ids("queue")) }).success).toBe(false)
  expect(startedQueueIds({ queueId: first })).toEqual([first])
  expect(startedQueueIds({ queueId: first, joinedQueueIds: [second] })).toEqual([first, second])
})

test("queue management commands and events are additive, strict and never read-only", () => {
  const ids = createIdFactory()
  const [command, client, session, queueId] = [ids("command"), ids("client"), ids("session"), ids("queue")]
  const base = { id: command, clientId: client, sessionId: session, queueId }
  for (const to of ["up", "down", "top", "bottom", 0, 7]) expect(Command.safeParse({ ...base, type: "queue.reorder", to }).success).toBe(true)
  for (const to of ["left", -1, 256, 1.5]) expect(Command.safeParse({ ...base, type: "queue.reorder", to }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "queue.edit", text: "new" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "queue.edit", text: "" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "queue.steer" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "queue.steer", extra: 1 }).success).toBe(false)
  expect(Command.safeParse({ id: command, clientId: client, sessionId: session, type: "queue.list" }).success).toBe(true)
  const submit = { id: command, clientId: client, sessionId: session, type: "user.submit", text: "hi", attachments: [] }
  for (const delivery of ["queue", "steer", "restart"]) expect(Command.safeParse({ ...submit, delivery, clientRequestId: "r1" }).success).toBe(true)
  expect(Command.safeParse({ ...submit, delivery: "now" }).success).toBe(false)
  expect(Command.safeParse({ ...submit, clientRequestId: "" }).success).toBe(false)
  expect(SessionEvent.safeParse({ sessionId: session, seq: 1, at: 1, type: "queue.edited", queueId, text: "new" }).success).toBe(true)
  expect(SessionEvent.safeParse({ sessionId: session, seq: 1, at: 1, type: "queue.changed", queue: [{ queueId, preview: "p", attachments: 0, kind: "message", delivery: "steer" }] }).success).toBe(true)
  for (const command of ["queue.reorder", "queue.edit", "queue.steer", "queue.list"] as const) expect(isReadOnlyCommand(command)).toBe(false)
})

test("queue settings are additive, optional and reject unknown policy or fields", () => {
  expect(Settings.parse({})).toEqual({})
  expect(Settings.parse({ queue: {} })).toEqual({ queue: {} })
  for (const mode of ["after-response", "after-tools", "immediate"] as const) expect(Settings.parse({ queue: { mode } })).toEqual({ queue: { mode } })
  for (const queue of [{ mode: "after-turn" }, { mode: "tool" }, { mode: 1 }, { extra: true }]) expect(Settings.safeParse({ queue }).success).toBe(false)
  expect(isReadOnlyCommand("settings.get")).toBe(false)
  for (const command of ["settings.set", "queue.remove", "queue.promote", "turn.cancel"] as const) expect(isReadOnlyCommand(command)).toBe(false)
})
