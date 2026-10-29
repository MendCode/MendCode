import { expect, test } from "bun:test"
import { Command, Settings, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("project RPC validates focus and metadata and never grants read-only peers access", () => {
  const ids = createIdFactory()
  const base = { type: "project.control", id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
  expect(Command.safeParse({ ...base, input: { operation: "context-show" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, input: { operation: "focus-use" } }).success).toBe(false)
  expect(Command.safeParse({ ...base, input: { operation: "focus-use", focusID: "unknown" } }).success).toBe(false)
  expect(Command.safeParse({ ...base, input: { operation: "package-set", patch: { version: "2", unexpected: true } } }).success).toBe(false)
  expect(isReadOnlyCommand("project.control")).toBe(false)
})

test("explicit instruction and skill settings are bounded and additive", () => {
  expect(Settings.safeParse({ instructions: ["rules/**/*.md", "https://example.test/rules"], skills: { paths: ["/tmp/skills"], urls: ["https://example.test/skills"] } }).success).toBe(true)
  expect(Settings.safeParse({ instructions: [""] }).success).toBe(false)
  expect(Settings.safeParse({ instructions: Array(101).fill("rules.md") }).success).toBe(false)
  expect(Settings.safeParse({ skills: { urls: ["invalid"] } }).success).toBe(false)
})
