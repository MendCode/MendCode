import { expect, test } from "bun:test"
import { Command, createIdFactory, SidebarAction, SidebarSpec } from "../src"

const ids = createIdFactory()
test("sidebar schema accepts every documented type and rejects invented types/options/actions", () => {
  const types = ["context", "usage", "todos", "changes", "jobs", "loops", "workflows", "agents", "mcp", "git", "session", "clock", "text", "sidechat", "agent", "activity", "workspace", "tokens", "tools", "alerts", "pace", "savings", "queue", "lineage", "files", "limits", "rent", "orbit", "stats", "atom", "extension:weather"]
  for (const type of types) expect(SidebarSpec.safeParse([{ type, options: {} }]).success).toBe(true)
  for (const priority of ["high", "normal", "low"]) expect(SidebarSpec.safeParse([{ type: "agent", options: { priority } }]).success).toBe(true)
  for (const widget of [{ type: "agent", options: { priority: "urgent" } },{ type: "weather", options: {} }, { type: "context", options: { tokens: 12 } }, { type: "clock", options: { text: "fake" } }, { type: "clock", options: { maxRows: 0 } }, { type: "extension:", options: {} }]) expect(SidebarSpec.safeParse([widget]).success).toBe(false)
  expect(SidebarAction.safeParse({ action: "remove" }).success).toBe(false)
  expect(SidebarAction.safeParse({ action: "move", index: 0, to: -1 }).success).toBe(false)
  expect(SidebarAction.safeParse({ action: "set", widgets: Array(33).fill({ type: "clock", options: {} }) }).success).toBe(false)
  expect(Command.safeParse({ clientId: ids("client"), id: ids("command"), type: "session.aside.get", sessionId: ids("session") }).success).toBe(true)
  expect(Command.safeParse({ clientId: ids("client"), id: ids("command"), type: "session.savings", sessionId: ids("session") }).success).toBe(true)
})
