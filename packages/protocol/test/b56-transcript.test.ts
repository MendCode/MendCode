import { expect, test } from "bun:test"
import { createIdFactory, ItemCompleted, SessionExport, SessionUndo } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }

test("B56 transcript options and targeted undo are additive", () => {
  expect(SessionExport.parse({ ...base, type: "session.export", format: "markdown" })).not.toHaveProperty("reasoning")
  expect(SessionExport.parse({ ...base, type: "session.export", format: "json", reasoning: true, toolDetails: false, assistantMetadata: true, timestamps: true })).toMatchObject({ reasoning: true, toolDetails: false })
  expect(SessionUndo.parse({ ...base, type: "session.undo" })).not.toHaveProperty("atItemId")
  expect(SessionUndo.parse({ ...base, type: "session.undo", atItemId: ids("item") })).toHaveProperty("atItemId")
  expect(SessionExport.safeParse({ ...base, type: "session.export", format: "markdown", reasoning: "yes" }).success).toBe(false)
})

test("native tool input is bounded and optional on completed events", () => {
  const event = { type: "item.completed", sessionId: base.sessionId, seq: 1, at: 0, itemId: ids("item"), status: "ok" }
  expect(ItemCompleted.safeParse(event).success).toBe(true)
  expect(ItemCompleted.safeParse({ ...event, toolInput: "x".repeat(4000) }).success).toBe(true)
  expect(ItemCompleted.safeParse({ ...event, toolInput: "x".repeat(4001) }).success).toBe(false)
})
