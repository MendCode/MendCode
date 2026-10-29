import { expect, test } from "bun:test"
import { CatalogRestInput, Command, McpConfigInput, RestCredential, RestMcpAdd, createIdFactory } from "../src"
import { READ_ONLY_COMMANDS } from "../src/remote"
import { commandTimeout } from "@mendcode/client"

test("B83 catalog controls are additive, strict and full-authority with bounded OAuth deadlines", () => {
  const ids = createIdFactory()
  const input = { operation: "oauth-callback" as const, provider: "openai", method: 0, code: "fixture-code" }
  const command = { id: ids("command"), clientId: ids("client"), type: "catalog.rest" as const, directory: "/project", input }
  expect(Command.safeParse(command).success).toBe(true)
  expect(READ_ONLY_COMMANDS.includes("catalog.rest" as never)).toBe(false)
  expect(commandTimeout(command, 1000)).toBe(56000)
  expect(commandTimeout({ ...command, input: { operation: "tool-ids" } }, 1000)).toBe(1000)
  for (const invalid of [{ ...input, method: -1 }, { ...input, method: 64 }, { ...input, extra: true }, { ...input, code: "" }]) expect(CatalogRestInput.safeParse(invalid).success).toBe(false)
})

test("B83 donor MCP config and credentials validate without widening native config ambiguities", () => {
  expect(RestMcpAdd.safeParse({ name: "local", config: { type: "local", command: ["fixture", "arg"], environment: { LOCAL: "yes" }, enabled: false } }).success).toBe(true)
  expect(McpConfigInput.safeParse({ command: "fixture", cwd: "sub", env: { LOCAL: "yes" }, timeoutMs: 1000, enabled: false }).success).toBe(true)
  for (const config of [{ type: "local", command: [] }, { type: "local", command: ["fixture"], url: "https://example.invalid" }, { type: "remote", url: "invalid" }, { type: "remote", url: "https://example.invalid", timeout: 0 }]) expect(RestMcpAdd.safeParse({ name: "fixture", config }).success).toBe(false)
  expect(McpConfigInput.safeParse({ command: "fixture", url: "https://example.invalid" }).success).toBe(false)
  expect(RestCredential.safeParse({ type: "oauth", access: "access", refresh: "refresh", expires: -1 }).success).toBe(false)
  expect(RestCredential.safeParse({ type: "api", key: "key", extra: "private" }).success).toBe(false)
})
