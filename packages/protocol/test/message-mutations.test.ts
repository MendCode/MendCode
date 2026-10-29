import { expect, test } from "bun:test"
import { Command, createIdFactory, SessionEvent, visibleEvents, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session"), messageId: ids("item") }

test("B87 mutations are bounded, additive, identity-checked and never read-only", () => {
  for (const type of ["session.message.delete", "session.part.delete", "session.part.update"] as const) {
    const input = { ...base, type, ...(type !== "session.message.delete" ? { partId: "body" } : {}), ...(type === "session.part.update" ? { part: { id: "body", type: "text", text: "edited" } } : {}) }
    const parsed = Command.parse(input)
    expect("expectedRevision" in parsed && parsed.expectedRevision).toBe(0)
    expect(isReadOnlyCommand(type)).toBe(false)
  }
  expect(Command.safeParse({ ...base, type: "session.part.update", partId: "body", part: { id: "body", type: "text", text: "x".repeat(65537) } }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.message.delete", expectedRevision: -1 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.part.delete", partId: "../secret" }).success).toBe(false)
})

test("visibleEvents uses immutable revisions without replaying deleted items or obsolete deltas", () => {
  const itemId = base.messageId
  const turnId = ids("turn")
  const common = { sessionId: base.sessionId, at: 1 }
  const events = [
    { ...common, seq: 1, type: "item.started", itemId, turnId, kind: "agent_message" },
    { ...common, seq: 2, type: "item.delta", itemId, text: "old" },
    { ...common, seq: 3, type: "item.completed", itemId, status: "ok", text: "old" },
    { ...common, seq: 4, type: "message.revised", itemId, turnId, revision: 1, deleted: false, snapshot: { status: "ok", text: "new" } },
  ].map((event) => SessionEvent.parse(event))
  const visible = visibleEvents(events)
  expect(visible.some((event) => event.type === "item.delta")).toBe(false)
  expect(visible.find((event) => event.type === "item.completed")).toMatchObject({ text: "new" })
  events.push(SessionEvent.parse({ ...common, seq: 5, type: "message.revised", itemId, turnId, revision: 2, deleted: true, snapshot: { status: "ok", text: "" } }))
  expect(visibleEvents(events).some((event) => event.type.startsWith("item."))).toBe(false)
})
