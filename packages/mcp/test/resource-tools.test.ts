import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { createMcpManager, mcpResourceTools, MCP_RESOURCE_LIST_TOOL, MCP_RESOURCE_READ_TOOL, type McpManager } from "../src"
import { tempDir } from "./helpers"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const CATALOG = join(import.meta.dir, "fixtures/fake-catalog.ts")

function manager(servers: Record<string, { env?: Record<string, string>; enabled?: boolean; command?: string }>): McpManager {
  const created = createMcpManager({ configLoader: () => ({ servers: Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, { command: entry.command ?? process.execPath, args: [CATALOG], ...(entry.env ? { env: entry.env } : {}), ...(entry.enabled === false ? { enabled: false } : {}) }])), errors: [] }) })
  cleanups.push(() => created.stop())
  return created
}

const context = (signal = new AbortController().signal) => ({ cwd: "/", signal })

async function tools(source: McpManager, directory = tempDir()) {
  const found = await mcpResourceTools({ manager: source, directory })
  return { directory, list: found.find((tool) => tool.name === MCP_RESOURCE_LIST_TOOL)!, read: found.find((tool) => tool.name === MCP_RESOURCE_READ_TOOL)!, found }
}

test("the resource tools exist only while a server offers resources or templates", async () => {
  expect((await tools(manager({ docs: {} }))).found.map((tool) => tool.name)).toEqual([MCP_RESOURCE_LIST_TOOL, MCP_RESOURCE_READ_TOOL])
  expect((await tools(manager({ docs: { env: { NO_CATALOG: "1" } } }))).found).toEqual([])
  expect((await tools(manager({}))).found).toEqual([])
  expect((await tools(manager({ broken: { command: "/not/a/program" } }))).found).toEqual([])
  expect((await tools(manager({ docs: { enabled: false } }))).found).toEqual([])
})

test("both tools are read tools with plain object schemas", async () => {
  const { list, read } = await tools(manager({ docs: {} }))
  expect([list.permission, read.permission]).toEqual(["read", "read"])
  expect(list.args.safeParse({}).success).toBe(true)
  expect(read.args.safeParse({ server: "docs" }).success).toBe(false)
  expect(read.args.safeParse({ server: "docs", uri: "docs://guide" }).success).toBe(true)
})

test("mcp_resource_list shows every server's resources and templates, one line each, and can narrow to a server", async () => {
  const { list } = await tools(manager({ docs: {}, wiki: {} }))
  const all = await list.execute({}, context())
  expect(all.isError).toBe(false)
  const lines = all.output.split("\n")
  expect(lines[0]).toBe("server\turi\tname\t[mime]\t[description]")
  expect(lines).toContain("docs\tdocs://guide\tProject guide\ttext/plain\tArchitecture and conventions")
  expect(lines).toContain("wiki\tdocs://release\tRelease notes\ttext/plain")
  expect(lines.some((line) => line.startsWith("docs\tissues://{id}\tIssue (template"))).toBe(true)
  expect(all.meta).toEqual({ resources: 4, templates: 2 })
  const only = await list.execute({ server: "wiki" }, context())
  expect(only.output).not.toContain("docs\t")
  const missing = await list.execute({ server: "nope" }, context())
  expect(missing).toMatchObject({ isError: true })
  expect(missing.output).toContain("servers with resources: docs, wiki")
})

test("mcp_resource_read returns text inline and only labels binary content", async () => {
  const { read } = await tools(manager({ docs: {} }))
  const result = await read.execute({ server: "docs", uri: "docs://guide" }, context())
  expect(result.isError).toBe(false)
  expect(result.output).toContain("--- docs://guide (text/plain) ---\nDaemon owns I/O. Clients send typed commands.")
  expect(result.output).toContain("--- docs://image (image/png) ---\n[binary content: image/png, 3 bytes, not shown]")
  expect(result.output).not.toContain("AAAA")
})

test("mcp_resource_read reports failures as tool errors, never throws, and honours cancellation", async () => {
  const { read } = await tools(manager({ docs: {} }))
  expect(await read.execute({ server: "docs", uri: "docs://missing" }, context())).toMatchObject({ isError: true, output: expect.stringContaining("resource not found") })
  expect(await read.execute({ server: "ghost", uri: "x://y" }, context())).toMatchObject({ isError: true, output: expect.stringContaining("unknown or disabled MCP server: ghost") })
  const cancelled = new AbortController()
  cancelled.abort()
  expect(await read.execute({ server: "docs", uri: "docs://guide" }, context(cancelled.signal))).toMatchObject({ isError: true, output: "cancelled" })
})
