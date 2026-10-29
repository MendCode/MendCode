import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createMcpClient, createMcpManager, loadMcpConfig, serverEnvironment, type McpClient, type McpManager, type McpServerConfig } from "../src"
import type { ExtensionLayer } from "@mendcode/packages"
import { alive, fakeConfig, put, tempDir, until } from "./helpers"

const managers: McpManager[] = []
const clients: McpClient[] = []
afterEach(async () => {
  await Promise.all([...managers.splice(0).map((m) => m.stop()), ...clients.splice(0).map((c) => c.close())])
})
const newManager = (input: Parameters<typeof createMcpManager>[0]) => {
  const manager = createMcpManager(input)
  managers.push(manager)
  return manager
}

/** A project that declares servers in its own file and in a project package, next to a user server. */
function fixture({ markerDir }: { markerDir?: string } = {}) {
  const directory = tempDir()
  const userDir = tempDir()
  const pkg = tempDir()
  const marker = (name: string) => (markerDir ? join(markerDir, name) : "")
  const spawnsMarker = (name: string) => ({ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker(name))}, "ran")`] })
  put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { user: fakeConfig() } }) })
  put({ root: directory, path: ".mendcode/mcp.json", content: JSON.stringify({ servers: { evil: spawnsMarker("evil"), remote: { url: "https://project.example/mcp?key=hidden" }, off: { command: "x", enabled: false } } }) })
  put({ root: pkg, path: "mcp.json", content: JSON.stringify({ servers: { shipped: spawnsMarker("shipped") } }) })
  const layers: ExtensionLayer[] = [
    { dir: userDir, source: "user" },
    { dir: pkg, source: "project", pkg: "acme" },
    { dir: join(directory, ".mendcode"), source: "project" },
  ]
  return { directory, userDir, layers }
}

describe("untrusted project MCP servers", () => {
  test("the loader holds project servers (own file and project packages) back and keeps user servers", async () => {
    const { directory, userDir, layers } = fixture()
    const loaded = await loadMcpConfig({ directory, userDir, layers, trusted: false, env: { SECRET: "s3cret" } })
    expect(Object.keys(loaded.servers).sort()).toEqual(["off", "user"])
    expect(loaded.blocked?.map((item) => item.name).sort()).toEqual(["evil", "remote", "shipped"])
    expect(loaded.blocked?.find((item) => item.name === "remote")?.command).toBe("https://project.example/mcp")
    expect(JSON.stringify(loaded.blocked)).not.toContain("hidden")
    const trusted = await loadMcpConfig({ directory, userDir, layers, trusted: true })
    expect(Object.keys(trusted.servers).sort()).toEqual(["evil", "off", "remote", "shipped", "user"])
    expect(trusted.servers.evil?.scope).toBe("project")
    expect(trusted.servers.user?.scope).toBeUndefined()
    expect(trusted.blocked).toBeUndefined()
  })

  test("a blocked name is not served by a user server of the same name", async () => {
    const { directory, userDir, layers } = fixture()
    put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { evil: fakeConfig() } }) })
    const loaded = await loadMcpConfig({ directory, userDir, layers, trusted: false })
    expect(loaded.servers.evil).toBeUndefined()
    expect(loaded.blocked?.some((item) => item.name === "evil")).toBe(true)
  })

  test("listing the catalog, the tools and the prompts creates no client, spawns nothing and contacts no URL", async () => {
    const markers = tempDir()
    const { directory, userDir, layers } = fixture({ markerDir: markers })
    const created: string[] = []
    const contacted: string[] = []
    const manager = newManager({
      configLoader: (dir) => loadMcpConfig({ directory: dir, userDir, layers, trusted: false }),
      fetch: async (url) => { contacted.push(String(url)); throw new Error("no network") },
      clientFactory: ({ name, config }) => { created.push(name); return createMcpClient({ name, config }) },
    })
    const tools = await manager.listTools(directory)
    const catalog = await manager.catalog(directory)
    const prompts = await manager.listPrompts(directory)
    expect(tools.tools.every((tool) => tool.server === "user")).toBe(true)
    expect(created.sort()).toEqual(["user"])
    expect(contacted).toEqual([])
    expect(existsSync(join(markers, "evil"))).toBe(false)
    expect(existsSync(join(markers, "shipped"))).toBe(false)
    expect([...catalog.resources, ...catalog.prompts, ...prompts.prompts].every((entry) => entry.server === "user")).toBe(true)
    await expect(manager.callTool({ directory, server: "evil", tool: "x", args: {} })).rejects.toThrow(/needs project trust/)
    await expect(manager.restart({ directory, server: "shipped" })).rejects.toThrow(/needs project trust/)
    expect(existsSync(join(markers, "evil"))).toBe(false)
  })

  test("status lists them as needs trust with the way to trust, without starting anything", async () => {
    const { directory, userDir, layers } = fixture()
    const manager = newManager({ configLoader: (dir) => loadMcpConfig({ directory: dir, userDir, layers, trusted: false }) })
    const report = await manager.status(directory)
    const held = report.servers.filter((server) => server.needsTrust)
    expect(held.map((server) => server.name).sort()).toEqual(["evil", "remote", "shipped"])
    expect(held.every((server) => !server.enabled && server.state === "stopped" && server.tools === 0)).toBe(true)
    expect(held.find((server) => server.name === "remote")?.transport).toBe("remote")
    expect(report.issues.some((issue) => issue.server === "evil" && /needs project trust: run \/trust on/.test(issue.message))).toBe(true)
    expect(manager.running()).toEqual([])
  })

  test("trusting rebuilds the server set; revoking stops the server and its tools disappear", async () => {
    const { directory, userDir, layers } = fixture()
    put({ root: directory, path: ".mendcode/mcp.json", content: JSON.stringify({ servers: { project: fakeConfig() } }) })
    let trusted = false
    const manager = newManager({ configLoader: (dir) => loadMcpConfig({ directory: dir, userDir, layers, trusted }) })
    expect((await manager.listTools(directory)).tools.some((tool) => tool.server === "project")).toBe(false)
    trusted = true
    await manager.invalidate()
    expect((await manager.listTools(directory)).tools.some((tool) => tool.server === "project")).toBe(true)
    const pid = manager.running().find((entry) => entry.server === "project")!.pid!
    expect(alive(pid)).toBe(true)
    trusted = false
    await manager.invalidate()
    expect(manager.running().some((entry) => entry.server === "project")).toBe(false)
    await until({ check: () => !alive(pid) })
    expect((await manager.listTools(directory)).tools.some((tool) => tool.server === "project")).toBe(false)
    expect((await manager.status(directory)).servers.find((server) => server.name === "project")?.needsTrust).toBe(true)
  })

  test("a project server gets the environment without credential-looking names, except the ones its config sets; user servers inherit all", () => {
    const base = { PATH: "/bin", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", DB_PASSWORD: "p", HOME: "/h" }
    const project: McpServerConfig = { command: "x", scope: "project", env: { GITHUB_TOKEN: "named" } }
    expect(serverEnvironment({ config: project, base })).toEqual({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "named" })
    expect(serverEnvironment({ config: { command: "x", env: { EXTRA: "1" } }, base })).toEqual({ ...base, EXTRA: "1" })
  })

  test("a spawned project server really does not see the daemon's credentials", async () => {
    const out = join(tempDir(), "env.json")
    const script = put({ root: tempDir(), path: "dump.ts", content: `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify([process.env.MENDCODE_TEST_API_KEY ?? null, process.env.MENDCODE_TEST_PLAIN ?? null, process.env.NAMED_TOKEN ?? null]))\nprocess.exit(0)\n` })
    process.env.MENDCODE_TEST_API_KEY = "daemon-secret"
    process.env.MENDCODE_TEST_PLAIN = "plain"
    try {
      for (const [scope, expected] of [["project", [null, "plain", "named"]], [undefined, ["daemon-secret", "plain", "named"]]] as const) {
        const client = createMcpClient({ name: "dump", config: { command: process.execPath, args: [script], env: { OUT: out, NAMED_TOKEN: "named" }, ...(scope ? { scope } : {}) } })
        clients.push(client)
        await client.start().catch(() => undefined)
        await until({ check: () => existsSync(out) })
        expect(JSON.parse(await Bun.file(out).text())).toEqual(expected as unknown as unknown[])
        await Bun.write(out, "")
        await Bun.$`rm -f ${out}`.quiet()
      }
    } finally {
      delete process.env.MENDCODE_TEST_API_KEY
      delete process.env.MENDCODE_TEST_PLAIN
    }
  })
})

describe("package changes rebuild the server set", () => {
  test("a removed or disabled package's server stops and its tools vanish from the next request; an installed one appears", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    const pkg = tempDir()
    put({ root: pkg, path: "mcp.json", content: JSON.stringify({ servers: { shipped: fakeConfig() } }) })
    let layers: ExtensionLayer[] = [{ dir: userDir, source: "user" }]
    const manager = newManager({ configLoader: (dir) => loadMcpConfig({ directory: dir, userDir, layers }) })
    expect((await manager.listTools(directory)).tools).toEqual([])
    layers = [{ dir: pkg, source: "user", pkg: "acme" }, ...layers]
    // Without invalidation the cached (empty) config would stay: the install is not seen.
    await manager.invalidate()
    expect((await manager.listTools(directory)).tools.some((tool) => tool.server === "shipped")).toBe(true)
    const pid = manager.running().find((entry) => entry.server === "shipped")!.pid!
    layers = [{ dir: userDir, source: "user" }]
    await manager.invalidate()
    expect(manager.running()).toEqual([])
    await until({ check: () => !alive(pid) })
    expect((await manager.listTools(directory)).tools).toEqual([])
    await expect(manager.callTool({ directory, server: "shipped", tool: "echo", args: {} })).rejects.toThrow(/unknown or disabled/)
    expect((await manager.status(directory)).servers).toEqual([])
  })

  test("a package that changes a server's command restarts it; an unchanged one keeps running", async () => {
    const directory = tempDir()
    let config = fakeConfig()
    const manager = newManager({ configLoader: () => ({ servers: { a: config, b: fakeConfig() }, errors: [] }) })
    await manager.listTools(directory)
    const before = new Map(manager.running().map((entry) => [entry.server, entry.pid]))
    config = fakeConfig({ args: [...(config.args ?? []), "--changed"] })
    await manager.invalidate()
    const after = manager.running()
    expect(after.map((entry) => entry.server)).toEqual(["b"])
    expect(after[0]?.pid).toBe(before.get("b")!)
    await until({ check: () => !alive(before.get("a")!) })
  })
})
