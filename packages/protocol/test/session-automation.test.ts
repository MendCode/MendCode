import { expect, test } from "bun:test"
import { Command, SessionEvent, createIdFactory, isReadOnlyCommand } from "../src"
const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")

test("B15 commands are additive and secret-free queries alone join the read set", () => {
  for (const type of ["session.get", "session.inspect"]) {
    expect(Command.safeParse({ ...base, type, sessionId }).success).toBe(true)
    expect(isReadOnlyCommand(type as "session.get")).toBe(true)
  }
  for (const type of ["session.create", "session.rename", "session.delete", "session.fork", "user.submit"]) expect(isReadOnlyCommand(type as "session.create")).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.inspect", sessionId, limit: 51 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.list", roots: false, project: "/repo", state: "completed", since: 10, search: "%", active: true }).success).toBe(true)
})

test("per-turn selection is validated and persisted in queue events without breaking old submit frames", () => {
  const selection = { model: { model: "local:test", variant: "precise" }, agent: "plan" }
  expect(Command.safeParse({ ...base, type: "user.submit", sessionId, text: "x", attachments: [] }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "user.submit", sessionId, text: "x", attachments: [], selection }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "user.submit", sessionId, text: "x", attachments: [], selection: { token: "secret" } }).success).toBe(false)
  expect(SessionEvent.safeParse({ type: "queue.added", sessionId, seq: 1, at: 1, queueId: ids("queue"), text: "x", attachments: [], selection }).success).toBe(true)
})
