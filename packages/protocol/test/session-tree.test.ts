import { expect, test } from "bun:test"
import { Command, SessionTreeNode, TimelineEntry, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")
const itemId = ids("item")

test("session.tree, session.label and session.recap parse and reject malformed input", () => {
  expect(Command.safeParse({ ...base, type: "session.tree", sessionId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.tree" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.label", sessionId, itemId, label: "keep" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.label", sessionId, itemId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.label", sessionId, itemId, label: "x".repeat(401) }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.label", sessionId }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.recap", sessionId, refresh: true }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.recap", sessionId, refresh: "yes" }).success).toBe(false)
})

test("none of them is a remote read-only command: they return or change user content", () => {
  for (const type of ["session.tree", "session.label", "session.recap"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})

test("timeline entries carry an optional label and tree nodes are strict", () => {
  const entry = { turnId: ids("turn"), itemId, at: 1, preview: "p", reverted: false }
  expect(TimelineEntry.safeParse(entry).success).toBe(true)
  expect(TimelineEntry.safeParse({ ...entry, label: "keep" }).success).toBe(true)
  const node = { sessionId, title: "t", directory: "/", createdAt: 1, updatedAt: 2, archived: false, current: true, labels: [{ itemId, label: "keep", preview: "p" }] }
  expect(SessionTreeNode.safeParse(node).success).toBe(true)
  expect(SessionTreeNode.safeParse({ ...node, extra: 1 }).success).toBe(false)
})

test("session.merge names a fork and optionally the session it goes into; it is not remote read-only", () => {
  const into = ids("session")
  expect(Command.safeParse({ ...base, type: "session.merge", sessionId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.merge", sessionId, intoSessionId: into }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.merge" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.merge", sessionId, intoSessionId: "x" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.merge", sessionId, extra: 1 }).success).toBe(false)
  expect(isReadOnlyCommand("session.merge")).toBe(false)
})

test("tree nodes may carry the lineage fields of a fork or a sub-agent, and nothing else", () => {
  const node = { sessionId, title: "t", directory: "/", createdAt: 1, updatedAt: 2, archived: false, current: false, labels: [] }
  expect(SessionTreeNode.safeParse({ ...node, kind: "task", model: "claude-haiku", state: "completed", agent: "explore", description: "scan", headline: "Found it" }).success).toBe(true)
  expect(SessionTreeNode.safeParse({ ...node, kind: "fork", unmerged: 2 }).success).toBe(true)
  expect(SessionTreeNode.safeParse({ ...node, kind: "other" }).success).toBe(false)
  expect(SessionTreeNode.safeParse({ ...node, unmerged: -1 }).success).toBe(false)
})
