import { expect, test } from "bun:test"
import { AgentCommandRecord, AgentCommandsReport, Command, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
const targetSessionId = ids("session")

test("peer command create validates each kind and its own payload", () => {
  for (const request of [{ kind: "request_summary" }, { kind: "rename", title: "Build UI" }, { kind: "tag", tags: ["ui"] }, { kind: "pause_after_turn", reason: "Review first" }, { kind: "stop" }, { kind: "send_message", text: "hello" }, { kind: "peer_message", text: "hello" }]) expect(Command.safeParse({ ...base, type: "session.agent-command.create", targetSessionId, request }).success).toBe(true)
  for (const request of [{ kind: "rename" }, { kind: "tag", text: "wrong" }, { kind: "request_summary", title: "wrong" }, { kind: "stop", reason: 2 }]) expect(Command.safeParse({ ...base, type: "session.agent-command.create", targetSessionId, request }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.agent-command.create", targetSessionId, request: { kind: "stop" }, expiresAt: 9_000_000_000_000_000 }).success).toBe(false)
})

test("target review cannot forge running/completed results or widen policy", () => {
  const commandId = ids("command")
  for (const state of ["accepted", "rejected"]) expect(Command.safeParse({ ...base, type: "session.agent-command.update", commandId, state }).success).toBe(true)
  for (const state of ["running", "completed", "pending", "expired"]) expect(Command.safeParse({ ...base, type: "session.agent-command.update", commandId, state }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.agent-command.update", commandId, state: "accepted", result: "fake" }).success).toBe(false)
})

test("policy and list are read-only; create/review always require write authority", () => {
  expect(isReadOnlyCommand("session.agent-command.policy")).toBe(true)
  expect(isReadOnlyCommand("session.agent-command.list")).toBe(true)
  expect(isReadOnlyCommand("session.agent-command.create")).toBe(false)
  expect(isReadOnlyCommand("session.agent-command.update")).toBe(false)
})

test("records carry bounded lifecycle, policy and result without accepting invented fields", () => {
  const record = { commandId: ids("command"), sourceSessionId: base.sessionId, targetSessionId, request: { kind: "request_summary" }, state: "completed", policy: { decision: "safe_auto", permissions: ["session.summary.read"], reason: "read-only" }, createdAt: 1, updatedAt: 2, expiresAt: 3, result: "Ready" }
  expect(AgentCommandRecord.safeParse(record).success).toBe(true)
  expect(AgentCommandRecord.safeParse({ ...record, result: "x".repeat(4001) }).success).toBe(false)
  expect(AgentCommandRecord.safeParse({ ...record, state: "cancelled" }).success).toBe(false)
  expect(AgentCommandsReport.safeParse({ commands: [record], metadata: [] }).success).toBe(true)
})
