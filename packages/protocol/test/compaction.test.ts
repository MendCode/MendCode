import { expect, test } from "bun:test"
import { Command, SessionEvent, TuiProfilePatch, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const target = { sessionId: ids("session"), turnId: ids("turn") }

test("compaction follow-up is a bounded mutation, never a read-only command", () => {
  const command = { id: ids("command"), clientId: ids("client"), type: "session.compaction.set", ...target, text: "Continue with tests\nthen review" }
  expect(Command.safeParse(command).success).toBe(true)
  expect(Command.safeParse({ ...command, text: "" }).success).toBe(true)
  expect(Command.safeParse({ ...command, text: "x".repeat(8001) }).success).toBe(false)
  expect(Command.safeParse({ ...command, turnId: undefined }).success).toBe(false)
  expect(isReadOnlyCommand("session.compaction.set")).toBe(false)
})

test("compaction lifecycle events replay with the scratchpad and queue identity", () => {
  const base = { type: "compaction.updated", ...target, seq: 1, at: 1, reason: "auto", followUp: "Continue", followUpQueueId: ids("queue") }
  for (const state of ["writing", "packed", "skipped", "failed", "cancelled", "interrupted"]) expect(SessionEvent.safeParse({ ...base, state }).success).toBe(true)
  expect(SessionEvent.safeParse({ ...base, state: "invented" }).success).toBe(false)
  expect(SessionEvent.safeParse({ ...base, state: "packed", followUp: "x".repeat(8001) }).success).toBe(false)
})

test("compaction appearance is available through the existing TUI profile API", () => {
  for (const compactionStyle of ["auto", "minimal", "cockpit", "quiet"]) expect(TuiProfilePatch.safeParse({ compactionStyle, compactionProgress: false, compactionScratchpad: true }).success).toBe(true)
  expect(TuiProfilePatch.safeParse({ compactionStyle: "arcade" }).success).toBe(false)
  for (const compactionPanel of ["panel", "stats", "arcade", "scratchpad", "quiet"]) expect(TuiProfilePatch.safeParse({ compactionPanel }).success).toBe(true)
  expect(TuiProfilePatch.safeParse({ compactionPanel: "cockpit" }).success).toBe(false)
})
