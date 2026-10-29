import { expect, test } from "bun:test"
import { Command, Settings, SessionNotesInput, SessionRecallReadInput, SessionRecallSearchInput, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }

test("session recall commands and opt-in settings are additive", () => {
  expect(Settings.parse({ experimental: { session_recall: true } })).toMatchObject({ experimental: { session_recall: true } })
  expect(Settings.parse({})).not.toHaveProperty("experimental")
  for (const [type, input] of [["session.recall.search", { query: "decision" }], ["session.recall.read", {}], ["session.notes", { action: "read" }]]) expect(Command.safeParse({ ...base, type, input }).success).toBe(true)
  expect(Settings.safeParse({ experimental: { session_recall: "yes" } }).success).toBe(false)
})

test("recall schema bounds text, identifiers, revisions and numbers", () => {
  expect(SessionRecallSearchInput.safeParse({ query: "" }).success).toBe(false)
  expect(SessionRecallReadInput.safeParse({ session_id: "not-a-session" }).success).toBe(false)
  expect(SessionRecallReadInput.safeParse({ limit: Infinity }).success).toBe(false)
  expect(SessionRecallReadInput.safeParse({ offset: NaN }).success).toBe(false)
  expect(SessionRecallReadInput.safeParse({ query: "x".repeat(16_001) }).success).toBe(false)
  expect(SessionNotesInput.safeParse({ action: "write", version: 0, text: "x".repeat(16_000) }).success).toBe(true)
  for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(SessionNotesInput.safeParse({ action: "read", version }).success).toBe(false)
  expect(SessionNotesInput.safeParse({ action: "write", text: "x".repeat(16_001) }).success).toBe(false)
  expect(SessionNotesInput.safeParse({ action: "read", session_id: ids("session") }).success).toBe(false)
})

test("recall and notes never gain access through a remote read-only token", () => {
  for (const type of ["session.recall.search", "session.recall.read", "session.notes"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
