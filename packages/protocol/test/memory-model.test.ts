import { expect, test } from "bun:test"
import { Command, DreamControlInput, MemoryAssistantAction, MemoryDetails, MemoryModelInput, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("B63 model inputs bound writes and retain every v1 action", () => {
  for (const action of ["status", "categories", "list", "search", "context", "add", "update", "delete", "propose", "overview", "upsert_fact", "link", "validate"]) expect(MemoryModelInput.safeParse({ action }).success).toBe(true)
  expect(MemoryModelInput.safeParse({ action: "add", confidence: 2 }).success).toBe(false)
  expect(MemoryModelInput.safeParse({ action: "search", maxEntries: 101 }).success).toBe(false)
  expect(MemoryDetails.parse({ categoryIDs: ["commands", "constraints"], tags: ["rule"], confidence: .8, sensitivity: "high" })).toMatchObject({ sensitivity: "high" })
  expect(MemoryAssistantAction.safeParse({ kind: "graph-link", text: "link", fromFactID: "not-an-id" }).success).toBe(false)
})

test("B63 commands are additive and no memory assistant/model command enters the peer read allowlist", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
  for (const type of ["memory.assistant.get", "memory.assistant.clear", "memory.assistant.cancel"] as const) expect(Command.safeParse({ ...base, type }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "memory.assistant.send", text: "why?", selection: { root: "/tmp/other", tab: "graph", category: "commands" } }).success).toBe(true)
  for (const type of ["memory.model", "memory.assistant.get", "memory.assistant.send", "memory.assistant.clear", "memory.assistant.cancel", "memory.assistant.archive"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})

test("R4 assistant control fields are bounded and the chat archive command needs an id to restore or delete", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project", type: "memory.assistant.archive" as const }
  for (const action of ["archive", "list"] as const) expect(Command.safeParse({ ...base, action }).success).toBe(true)
  for (const action of ["restore", "delete"] as const) {
    expect(Command.safeParse({ ...base, action }).success).toBe(false)
    expect(Command.safeParse({ ...base, action, archiveId: "abc-123" }).success).toBe(true)
    expect(Command.safeParse({ ...base, action, archiveId: "../escape" }).success).toBe(false)
  }
  expect(MemoryAssistantAction.safeParse({ kind: "propose-policy", text: "auto", categoryID: "commands", policy: "auto", settings: { memoryMaintenance: "preview" } }).success).toBe(true)
  expect(MemoryAssistantAction.safeParse({ kind: "propose-policy", text: "x", settings: { memoryRequireApproval: false } }).success).toBe(false)
  expect(MemoryAssistantAction.safeParse({ kind: "propose-policy", text: "x", policy: "sometimes" }).success).toBe(false)
  expect(MemoryAssistantAction.safeParse({ kind: "dream-service-start", text: "x", dreamAt: "25:00" }).success).toBe(false)
  expect(MemoryAssistantAction.safeParse({ kind: "dream-service-start", text: "x", dreamAt: "21:30" }).success).toBe(true)
  expect(DreamControlInput.safeParse({ operation: "run", deterministic: true }).success).toBe(true)
})
