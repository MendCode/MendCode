import { expect, test } from "bun:test"
import { Command, Frame, RestConfig, RestProjectConfig, RestLogInput, RestUpgradeInput, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("B82 additive server commands keep sensitive reads and mutations out of read-only authority", () => {
  for (const [type, fields, read] of [
    ["server.health", {}, true], ["server.memory", {}, true],
    ["server.config.get", {}, false], ["server.config.update", { patch: { model: "openai/scripted" } }, false],
    ["server.dispose", { directory: "/project" }, false], ["app.log", { input: { service: "test", level: "info", message: "entry" } }, false],
    ["server.upgrade", { input: { target: "2.1.0" } }, false],
  ] as const) expect(isReadOnlyCommand(Command.parse({ ...base, type, ...fields }).type)).toBe(read)
  expect(Command.safeParse({ ...base, type: "server.memory", snapshot: true }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "server.dispose", force: true }).success).toBe(false)
  expect(Frame.safeParse({ v: 1, kind: "global", body: { type: "server.lifecycle", change: "disposed", gseq: 1, at: 1, directory: "/project" } }).success).toBe(true)
})

test("B82 config and control payloads reject unsupported fields instead of silently storing them", () => {
  expect(RestConfig.safeParse({ models: { main: { model: "scripted" } }, default_agent: "plan", tools: { read: true } }).success).toBe(true)
  expect(RestProjectConfig.safeParse({ model: "openai/scripted", defaultPermission: "ask", memoryUse: false }).success).toBe(true)
  expect(RestConfig.safeParse({ provider: { openai: { apiKey: "secret" } } }).success).toBe(false)
  expect(RestProjectConfig.safeParse({ theme: "matrix" }).success).toBe(false)
  expect(RestConfig.safeParse({ model: "scripted" }).success).toBe(false)
  expect(RestLogInput.safeParse({ service: "test", level: "trace", message: "entry" }).success).toBe(false)
  expect(RestUpgradeInput.safeParse({ target: "https://example.test/binary" }).success).toBe(false)
  expect(RestUpgradeInput.safeParse({ target: "../../binary" }).success).toBe(false)
})
