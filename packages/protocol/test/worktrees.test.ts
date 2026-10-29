import { expect, test } from "bun:test"
import { Command, createIdFactory, WorktreeRead, WorktreeChange } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("B30 additive commands distinguish pure queries from registry writes", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/repo" }
  for (const operation of ["status", "doctor"] as const) expect(Command.safeParse({ ...base, type: "worktree.query", query: { operation } }).success).toBe(true)
  for (const operation of ["open", "remove", "reset"] as const) expect(Command.safeParse({ ...base, type: "worktree.query", query: { operation, target: "/repo/work" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "worktree.change", change: { operation: "adopt", target: "/repo/work" } }).success).toBe(true)
  expect(isReadOnlyCommand("worktree.query")).toBe(false)
  expect(isReadOnlyCommand("worktree.change")).toBe(false)
})
test("B30 rejects execution flags, control characters, missing targets and unbounded input", () => {
  expect(WorktreeRead.safeParse({ operation: "remove" }).success).toBe(false)
  expect(WorktreeRead.safeParse({ operation: "open", target: "repo\n" }).success).toBe(false)
  expect(WorktreeChange.safeParse({ operation: "create", input: { name: "x".repeat(101) } }).success).toBe(false)
  expect(WorktreeChange.safeParse({ operation: "create", input: { name: "safe", execute: true } }).success).toBe(false)
  expect(WorktreeRead.safeParse({ operation: "reset", target: "safe", force: true }).success).toBe(false)
  expect(WorktreeRead.safeParse({ operation: "adopt", target: "safe" }).success).toBe(false)
})
