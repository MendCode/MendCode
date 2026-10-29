import { expect, test } from "bun:test"
import { Command, RestCommand, RestPartUpdate, RestPrompt, RestReadInput, RestSessionUpdate, RestShell, RestSummarize, MAX_FORMAT_SCHEMA_BYTES, TurnOptions, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("B81 additive session REST commands validate targets and do not grant read-only authority", () => {
  const sessionId = ids("session")
  for (const command of [
    { ...base, type: "session.rest.read", directory: "/project", input: { operation: "get", sessionId } },
    { ...base, type: "session.rest.update", sessionId, patch: { time: { archived: null } } },
    { ...base, type: "session.rest.control", sessionId, operation: "wait", timeoutMs: 10 },
  ]) {
    const parsed = Command.parse(command)
    expect(isReadOnlyCommand(parsed.type)).toBe(false)
  }
  expect(Command.safeParse({ ...base, type: "session.rest.control", sessionId, operation: "cancel-turn" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.rest.control", sessionId, operation: "wait", timeoutMs: 60_000 }).success).toBe(false)
})
test("B81 cursor/query combinations and unsupported donor options fail before dispatch", () => {
  const sessionId = ids("session")
  for (const input of [{ operation: "message", sessionId }, { operation: "get" }, { operation: "messages", sessionId, before: "a", after: "b", limit: 1 }, { operation: "list", cursor: "a", roots: true }, { operation: "messages", sessionId, after: "a" }]) expect(RestReadInput.safeParse(input).success).toBe(false)
  expect(RestReadInput.parse({ operation: "messages", sessionId, limit: 0 }).limit).toBe(0)
  expect(RestSessionUpdate.safeParse({ title: "Title", permission: [{ permission: "*", pattern: "*", action: "allow" }] }).success).toBe(true)
  expect(RestSessionUpdate.safeParse({ title: "Title", permission: [{ permission: "*", pattern: "*", action: "maybe" }] }).success).toBe(false)
  // Options the daemon cannot honour parse, so the HTTP adapter refuses them explicitly (501) instead of a generic 400.
  expect(RestPrompt.safeParse({ parts: [{ type: "file", url: "https://example.test/file", mime: "text/plain" }] }).success).toBe(true)
  expect(RestPrompt.safeParse({ parts: [{ type: "text", text: "hi" }], noReply: true }).success).toBe(true)
  expect(RestPrompt.safeParse({ parts: [{ type: "text", text: "hi" }], unknown: true }).success).toBe(false)
  expect(RestPrompt.safeParse({ parts: [{ type: "bogus" }] }).success).toBe(false)
})
test("R7 prompt, command, shell and part schemas", () => {
  const messageID = ids("item")
  expect(RestPrompt.parse({ messageID, variant: "high", system: "s", parts: [{ type: "agent", name: "x" }, { type: "subtask", agent: "a", prompt: "p" }] }).messageID).toBe(messageID)
  expect(RestPrompt.safeParse({ messageID: "msg_1", parts: [{ type: "text", text: "a" }] }).success).toBe(false)
  expect(RestCommand.parse({ command: "ship", arguments: "", messageID, variant: "v", parts: [{ type: "file", mime: "text/plain", url: "data:text/plain,hi" }] }).parts).toHaveLength(1)
  expect(RestShell.safeParse({ command: "ls" }).success).toBe(false)
  expect(RestShell.parse({ agent: "build", command: "ls", model: { providerID: "p", modelID: "m" }, messageID }).messageID).toBe(messageID)
  expect(RestSummarize.parse({ providerID: "p", modelID: "m", auto: true, instructions: "keep" }).auto).toBe(true)
  expect(RestPartUpdate.parse({ id: "p", type: "text", text: "t" }).text).toBe("t")
})
test("R7 mutate, compact options, attachment.put and a stable message id are additive commands", () => {
  const base = { id: ids("command"), clientId: ids("client") }, sessionId = ids("session"), messageId = ids("item")
  expect(Command.safeParse({ ...base, type: "session.rest.mutate", sessionId, operation: "delete-message", messageId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.rest.mutate", sessionId, operation: "delete-part", messageId }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.rest.mutate", sessionId, operation: "update-part", messageId, partId: "p" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.rest.mutate", sessionId, operation: "update-part", messageId, partId: "p", text: "new" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.compact", sessionId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.compact", sessionId, instructions: "keep names", model: { model: "m" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.compact", sessionId, instructions: "" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "user.submit", sessionId, text: "t", attachments: [], messageId }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "attachment.put", name: "a.png", data: "iVBORw0KGgo=" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "attachment.put", name: "a.png", data: "not base64!" }).success).toBe(false)
  expect(isReadOnlyCommand("session.rest.mutate")).toBe(false)
  expect(isReadOnlyCommand("attachment.put")).toBe(false)
})
test("R6 scope and path filters apply to session lists only, stay inside the project and exclude cursors", () => {
  const sessionId = ids("session")
  for (const operation of ["list", "agent-view"] as const) expect(RestReadInput.parse({ operation, scope: "project", path: "packages/a" })).toMatchObject({ scope: "project", path: "packages/a" })
  expect(RestReadInput.parse({ operation: "list", path: "" }).path).toBe("")
  for (const input of [{ operation: "list", path: "../up" }, { operation: "list", path: "a/../../b" }, { operation: "list", path: "/abs" }, { operation: "list", path: "C:/x" }, { operation: "list", scope: "global" }, { operation: "list", cursor: "a", path: "x" }, { operation: "list", cursor: "a", scope: "project" }, { operation: "status", scope: "project" }, { operation: "messages", sessionId, path: "x" }, { operation: "usage", start: 0, scope: "project" }]) expect(RestReadInput.safeParse(input).success).toBe(false)
})
test("R6 user.submit may carry a caller-chosen message id", () => {
  const sessionId = ids("session"), messageId = ids("item")
  expect(Command.parse({ ...base, type: "user.submit", sessionId, text: "hi", attachments: [], messageId })).toMatchObject({ messageId })
  expect(Command.safeParse({ ...base, type: "user.submit", sessionId, text: "hi", attachments: [], messageId: "nope" }).success).toBe(false)
})
test("prompt options: tools map, noReply and json_schema format parse; turn options keep to object schemas", () => {
  const text = [{ type: "text", text: "hi" }]
  expect(RestPrompt.safeParse({ parts: text, noReply: true, tools: { bash: false, "mcp_*": false } }).success).toBe(true)
  expect(RestPrompt.safeParse({ parts: text, format: { type: "text" } }).success).toBe(true)
  expect(RestPrompt.safeParse({ parts: text, format: { type: "json_schema", schema: { type: "object" }, retryCount: 3 } }).success).toBe(true)
  expect(RestPrompt.safeParse({ parts: text, format: { type: "json_schema" } }).success).toBe(false)
  expect(RestPrompt.safeParse({ parts: text, format: { type: "json_schema", schema: {}, retryCount: 11 } }).success).toBe(false)
  expect(TurnOptions.safeParse({ noReply: true, excludeTools: ["bash"], format: { schema: { type: "object" }, retries: 0 } }).success).toBe(true)
  expect(TurnOptions.safeParse({ format: { schema: { type: "array" } } }).success).toBe(false)
  expect(TurnOptions.safeParse({ format: { schema: { type: "object", description: "x".repeat(MAX_FORMAT_SCHEMA_BYTES) } } }).success).toBe(false)
  expect(TurnOptions.safeParse({ noReply: false }).success).toBe(false)
  const submit = { ...base, type: "user.submit", sessionId: ids("session"), text: "hi", attachments: [] }
  expect(Command.safeParse({ ...submit, turnOptions: { excludeTools: ["shell"] } }).success).toBe(true)
  expect(Command.safeParse({ ...submit, turnOptions: { unknown: true } }).success).toBe(false)
  expect(isReadOnlyCommand("user.submit")).toBe(false)
})
