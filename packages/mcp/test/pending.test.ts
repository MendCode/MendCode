import { expect, test } from "bun:test"
import { createMcpAuth, createMcpManager, loadMcpConfig, type LoadedMcpConfig, type McpServerConfig } from "../src"
import { put, tempDir } from "./helpers"

test("pending entries override lower layers without expanding variables or exposing execution details", async () => {
  const userDir = tempDir(), directory = tempDir()
  put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { shared: { command: "approved" } } }) })
  put({ root: directory, path: ".mendcode/mcp.json", content: JSON.stringify({ servers: { shared: { command: "${PRIVATE}", args: ["--api-key", "private-value"], enabled: true, pendingApproval: { expiresAt: 0 } } } }) })
  const config = await loadMcpConfig({ directory, userDir, env: { PRIVATE: "must-not-expand" } })
  expect(config.servers.shared).toEqual({ command: "(pending approval)", enabled: false })
  const manager = createMcpManager({ configLoader: () => config, clientFactory: () => { throw new Error("pending client must never be created") } })
  try {
    expect((await manager.listTools(directory)).tools).toEqual([])
    expect((await manager.listPrompts(directory)).prompts).toEqual([])
    expect((await manager.catalog(directory)).resources).toEqual([])
    expect(JSON.stringify(await manager.status(directory))).not.toContain("private-value")
    await expect(manager.restart({ directory, server: "shared" })).rejects.toThrow("disabled")
    await expect(manager.callTool({ directory, server: "shared", tool: "old-cached-tool", args: {} })).rejects.toThrow("disabled")
  } finally { await manager.stop() }
})

test("a config load begun before suspension cannot create a client after the server becomes pending", async () => {
  let resolve!: (value: LoadedMcpConfig) => void
  const old = new Promise<LoadedMcpConfig>((done) => { resolve = done })
  let current: Promise<LoadedMcpConfig> | LoadedMcpConfig = old
  let created = 0
  const manager = createMcpManager({ configLoader: () => current, clientFactory: () => { created++; throw new Error("must not start") } })
  try {
    const loading = manager.listTools("/fixture")
    current = { servers: { shared: { command: "pending", enabled: false } }, errors: [] }
    manager.invalidate("/fixture")
    await manager.suspend({ directory: "/fixture", server: "shared" })
    resolve({ servers: { shared: { command: "old-approved" } }, errors: [] })
    expect((await loading).tools).toEqual([])
    expect((await manager.listTools("/fixture")).tools).toEqual([])
    expect(created).toBe(0)
  } finally { await manager.stop() }
})

test("disabled URL entries cannot discover OAuth or debug the network", async () => {
  const dir = tempDir()
  let requests = 0
  const fetch = async () => { requests++; throw new Error("no network") }
  const config: McpServerConfig = { url: "https://example.invalid/mcp", enabled: false }
  const manager = createMcpManager({ configLoader: () => ({ servers: { pending: config }, errors: [] }), auth: createMcpAuth({ dir, fetch }), fetch })
  try {
    await expect(manager.startAuth({ directory: "/fixture", server: "pending" })).rejects.toThrow("disabled")
    await expect(manager.debug({ directory: "/fixture", server: "pending" })).rejects.toThrow("disabled")
    expect(requests).toBe(0)
  } finally { await manager.stop() }
})
