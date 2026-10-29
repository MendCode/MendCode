import { afterEach, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { TaskRecord } from "@mendcode/protocol"
import { appHarness, cleanTemps, conversation, ids, tempDir, type Harness } from "./session-ui-harness"

const harnesses: Harness[] = []
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.app.onKey("\x03"); cleanTemps() })
const summaries = [{ name: "audit", description: "Inspect code", argumentHint: "<scope>", source: "project" }, { name: "local:audit", description: "Inspect MCP code", argumentHint: "<scope>", source: "mcp" }]
function start(reply?: (command: CommandInput) => CommandReply | undefined) {
  const harness = appHarness({ dataDir: tempDir(), directory: tempDir(), reply: (command) => command.type === "commands.list" ? { ok: true, result: { commands: summaries } } : reply?.(command) })
  harness.app.applySettings({ onboarded: true })
  conversation(harness.sessionId, (event) => harness.app.onEvent(event)).exchange("Inspect the project", "Ready to inspect commands.")
  harnesses.push(harness)
  return harness
}

test("Tab completes built-in and file command text without dispatching", async () => {
  const harness = start()
  await harness.type("/ini\t")
  expect(harness.text().join("\n")).toContain("/init")
  expect(harness.sentOf("commands.execute")).toHaveLength(0)
  expect(harness.sentOf("user.submit")).toHaveLength(0)
  await harness.app.onKey("\x15")
  await harness.type("/aud\t")
  expect(harness.text().join("\n")).toContain("/audit")
  expect(harness.sentOf("commands.execute")).toHaveLength(0)
})

test("Enter sends raw quoted command arguments, not a client-expanded prompt", async () => {
  const harness = start()
  await harness.type('/audit "two words" @notes.txt\r')
  expect(harness.sentOf("commands.execute")).toEqual([{ type: "commands.execute", sessionId: harness.sessionId, name: "audit", args: '"two words" @notes.txt', attachments: [] }])
  expect(harness.sentOf("commands.expand")).toHaveLength(0)
  expect(harness.sentOf("user.submit")).toHaveLength(0)
})

test("a refused command restores the prompt and shows the daemon error", async () => {
  const harness = start((command) => command.type === "commands.execute" ? { ok: false, error: { code: "invalid_command", message: "unknown model fixture" } } : undefined)
  await harness.type("/audit files\r")
  expect(harness.text().join("\n")).toContain("/audit files")
  expect(harness.text().join("\n")).toContain("unknown model fixture")
})

test("review opens the durable child transcript and subscriptions", async () => {
  const childId = ids("session")
  const task = { taskId: childId } as TaskRecord
  const harness = start((command) => command.type === "commands.execute" ? { ok: true, result: { task, queueId: ids("queue") } } : undefined)
  await harness.type("/review feature\r")
  expect(harness.sentOf("commands.execute")).toContainEqual(expect.objectContaining({ name: "review", args: "feature" }))
  expect(harness.subscriptions.some((entry) => entry.sessionId === childId)).toBe(true)
  conversation(childId, (event) => harness.app.onEvent(event)).exchange("/review feature", "No actionable defects.")
  harness.app.render()
  expect(harness.text().join("\n")).toContain("No actionable defects.")
  expect(harness.text().join("\n")).toContain("/review feature")
})

test("MCP prompts join completion lazily on explicit slash input", async () => {
  const harness = start((command) => command.type === "commands.discover" ? { ok: true, result: { commands: [{ name: "local:inspect", description: "Inspect MCP project", argumentHint: "<scope>" }], issues: [] } } : undefined)
  expect(harness.sentOf("commands.discover")).toHaveLength(0)
  await harness.type("/local:ins")
  expect(harness.sentOf("commands.discover")).toHaveLength(1)
  expect(harness.text().join("\n")).toContain("/local:inspect")
  await harness.app.onKey("\t")
  expect(harness.sentOf("commands.execute")).toHaveLength(0)
  await harness.type(" files\r")
  expect(harness.sentOf("commands.execute")).toContainEqual(expect.objectContaining({ name: "local:inspect", args: "files" }))
})
