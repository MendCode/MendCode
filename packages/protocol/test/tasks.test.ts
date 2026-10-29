import { expect, test } from "bun:test"
import { Command, createIdFactory, Settings, TaskInput } from "../src"

const ids = createIdFactory()
test("additive task commands validate resumable ids and bounded waits", () => {
  const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
  expect(TaskInput.safeParse({ description: "Resume", prompt: "Continue", task_id: "not-a-session" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "task.status", taskId: ids("session"), action: "wait", timeoutMs: 300_000 }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "task.status", taskId: ids("session"), action: "wait", timeoutMs: 300_001 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "task.run", input: { description: "Explore", prompt: "Find", background: true, model: "local:model#precise" } }).success).toBe(true)
})

test("memory controls and subagent limits are independent and bounded", () => {
  expect(Settings.safeParse({ memoryUse: false, memoryGenerate: true, memoryEnabled: true, memoryRequireApproval: false, memoryMaintenance: "preview", subagentDepth: 0 }).success).toBe(true)
  for (const value of [{ subagentDepth: -1 }, { subagentMaxChildren: 0 }, { subagentMaxDescendants: 0 }, { memoryMaxPromptTokens: 32_001 }, { memoryProjectMaxEntries: 0 }, { memoryMaintenance: "anything" }]) expect(Settings.safeParse(value).success).toBe(false)
})
