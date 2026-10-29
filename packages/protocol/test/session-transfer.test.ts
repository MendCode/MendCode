import { expect, test } from "bun:test"
import { Command, SessionTranscript, createIdFactory, isReadOnlyCommand } from "../src"
const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")

test("B36 export is additive; import mutates state and never joins the read-only command set", () => {
  expect(Command.safeParse({ ...base, type: "session.export", sessionId, format: "json" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.export", sessionId, format: "json", sanitize: true }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.import", source: "session.json", directory: "/project" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.import", source: "", directory: "/project" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.import", source: "session.json", directory: "/project", overwrite: true }).success).toBe(false)
  expect(isReadOnlyCommand("session.import")).toBe(false)
})

test("native transcript version, times, part kinds, IDs and count limits are validated", () => {
  const value = { format: "mendcode-session@1", sessionId, title: "", directory: "/repo", exportedAt: 0, truncated: false, turns: [{ turnId: "turn", at: 0, outcome: "completed", items: [{ itemId: "item", kind: "user_message", text: "hi" }] }] }
  expect(SessionTranscript.safeParse(value).success).toBe(true)
  for (const invalid of [{ ...value, format: "mendcode-session@2" }, { ...value, exportedAt: Infinity }, { ...value, turns: [value.turns[0], value.turns[0]] }, { ...value, turns: [{ ...value.turns[0], items: Array.from({ length: 201 }, (_, i) => ({ itemId: String(i), kind: "user_message", text: "hi" })) }] }]) expect(SessionTranscript.safeParse(invalid).success).toBe(false)
})
