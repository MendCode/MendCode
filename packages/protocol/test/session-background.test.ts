import { expect, test } from "bun:test"
import { Command, createIdFactory, Settings } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }

test("background commands validate writer lifetime and metadata resets without trusting a caller writer id", () => {
  expect(Command.safeParse({ ...base, type: "session.background.register", state: "needs_input", pinned: true }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.background.writer.acquire", ttlMs: 30_000 }).success).toBe(true)
  for (const ttlMs of [0, -1, 86_400_001]) expect(Command.safeParse({ ...base, type: "session.background.writer.acquire", ttlMs }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.background.writer.acquire", writerId: ids("client") }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.agent-view.metadata.patch", patch: { title: null, tags: null, group: null, priority: null, notes: null, pinned: null, archived: null } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.agent-view.metadata.patch", patch: { priority: "critical" } }).success).toBe(false)
})

test("owner wake is configurable; mutating background and inbox operations are never read-only", () => {
  expect(Settings.safeParse({ subagentOwnerWake: false }).success).toBe(true)
  expect(Settings.safeParse({ subagentOwnerWake: "false" }).success).toBe(false)
  for (const type of ["session.background.register", "session.background.remove", "session.background.writer.acquire", "session.background.writer.release", "session.agent-view.metadata.patch", "session.agent-command.patch"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  for (const type of ["session.children", "session.background.list", "session.agent-view.metadata.list", "session.agent-view.metadata.get"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})

test("agent inbox supports global and incoming queries and an additive result patch", () => {
  expect(Command.safeParse({ id: base.id, clientId: base.clientId, type: "session.agent-command.list" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.agent-command.list", incoming: true }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.agent-command.patch", commandId: ids("command"), state: "completed", result: null }).success).toBe(true)
})
