import { expect, test } from "bun:test"
import { Command, McpConfigInput, McpCatalogReport, createIdFactory } from "../src"
import { READ_ONLY_COMMANDS } from "../src/remote"

test("MCP catalog protocol commands are additive and not remotely read-only", () => {
  const ids = createIdFactory()
  for (const input of [
    { type: "mcp.catalog", directory: "/repo" },
    { type: "mcp.resources.list", directory: "/repo" },
    { type: "mcp.resource.read", directory: "/repo", server: "docs", uri: "docs://guide" },
    { type: "mcp.prompts.list", directory: "/repo" },
    { type: "mcp.prompt.get", directory: "/repo", server: "docs", name: "Review", args: { target: "app.ts" } },
  ]) {
    expect(Command.safeParse({ ...input, id: ids("command"), clientId: ids("client") }).success).toBe(true)
    expect(READ_ONLY_COMMANDS.includes(input.type as never)).toBe(false)
  }
  expect(McpCatalogReport.safeParse({ resources: [], templates: [], prompts: [], issues: [] }).success).toBe(true)
})

test("callback config validates port ranges and HTTP(S) redirects", () => {
  expect(McpConfigInput.safeParse({ url: "https://mcp.test", oauth: { callbackPort: 19876, redirectUri: "http://127.0.0.1:19876/custom" } }).success).toBe(true)
  expect(McpConfigInput.safeParse({ url: "https://mcp.test", oauth: { redirectUri: "https://elsewhere.test/callback?project=docs" } }).success).toBe(true)
  for (const oauth of [{ callbackPort: 0 }, { callbackPort: 65536 }, { redirectUri: "ftp://elsewhere.test/callback" }, { redirectUri: "http://localhost:19876/callback#invalid" }, { redirectUri: "https://user:secret@elsewhere.test/callback" }]) expect(McpConfigInput.safeParse({ url: "https://mcp.test", oauth }).success).toBe(false)
})
