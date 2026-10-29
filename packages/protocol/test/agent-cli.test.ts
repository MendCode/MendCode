import { expect, test } from "bun:test"
import { Command, createIdFactory } from "../src"
import { agentName, AGENT_CREATE_PERMISSIONS, isReadOnlyCommand } from "../src/wire"

test("B66 commands are additive, strict and never read-only", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
  const create = { ...base, type: "agent.create", name: "reviewer", description: "Review", mode: "all", permissions: [...AGENT_CREATE_PERMISSIONS] }
  expect(Command.safeParse(create).success).toBe(true)
  expect(Command.safeParse({ ...create, permissions: ["secrets"] }).success).toBe(false)
  expect(Command.safeParse({ ...create, name: "../escape" }).success).toBe(false)
  expect(Command.safeParse({ ...create, description: " " }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "agent.debug", name: "build", tool: "read", params: { path: "file.txt" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "agent.debug", name: "build", params: [] }).success).toBe(false)
  expect(isReadOnlyCommand("agent.create")).toBe(false)
  expect(isReadOnlyCommand("agent.debug")).toBe(false)
  expect(agentName('Review "quoted": diffs')).toBe("review-quoted-diffs")
  expect(agentName("👁")).toBe("agent")
})
