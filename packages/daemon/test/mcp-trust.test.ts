import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createMcpManager, type McpClient } from "@mendcode/mcp"
import { startDaemon, type McpControl } from "../src"
import { createMcpConfigLoader, projectTrusted } from "../src/mcp-loader"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-mcp-trust-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function project(servers: Record<string, unknown>) {
  const directory = temp()
  mkdirSync(path.join(directory, ".mendcode"))
  writeFileSync(path.join(directory, ".mendcode", "mcp.json"), JSON.stringify({ servers }))
  return directory
}

test("the daemon's MCP loader holds an untrusted project's servers back until the directory is in the trusted list", async () => {
  const userDir = temp()
  const directory = project({ spawn: { command: "/nonexistent/never-run" }, remote: { url: "https://project.example/mcp" } })
  writeFileSync(path.join(userDir, "mcp.json"), JSON.stringify({ servers: { mine: { command: "user-cmd" } } }))
  let trusted: string[] | undefined
  const load = createMcpConfigLoader({ userDir, layers: (dir) => [{ dir: userDir, source: "user" }, { dir: path.join(dir, ".mendcode"), source: "project" }], allowed: () => true, trustedDirs: () => trusted })
  const before = await load(directory)
  expect(Object.keys(before.servers)).toEqual(["mine"])
  expect(before.blocked?.map((item) => item.name).sort()).toEqual(["remote", "spawn"])
  trusted = [directory]
  const after = await load(directory)
  expect(Object.keys(after.servers).sort()).toEqual(["mine", "remote", "spawn"])
  expect(after.blocked).toBeUndefined()
  expect(await createMcpConfigLoader({ userDir, layers: () => [], allowed: () => false, trustedDirs: () => trusted })(directory)).toEqual({ servers: {}, errors: [] })
  expect(projectTrusted({ trustedToolDirs: ["/somewhere/else"], directory })).toBe(false)
  expect(projectTrusted({ trustedToolDirs: undefined, directory })).toBe(false)
})

test("trust changes and package changes make the daemon rebuild the MCP server set", async () => {
  const dir = temp(), directory = temp()
  const manager = createMcpManager({ configLoader: () => ({ servers: {}, errors: [] }), clientFactory: ({ name }): McpClient => { throw new Error(`no client for ${name}`) } })
  cleanup.push(() => manager.stop())
  const invalidated: Array<string | undefined> = []
  const mcp: McpControl = { ...manager, invalidate: (target) => { invalidated.push(target); return manager.invalidate(target) } }
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), mcp, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "mcp-trust" })
  await client.connect()
  cleanup.push(() => client.close())
  const calls = async (run: () => Promise<unknown>) => {
    invalidated.length = 0
    await run()
    return invalidated.length
  }
  const source = path.join(temp(), "pkg")
  cpSync(path.resolve(import.meta.dir, "../../../examples/official-packages/mendcode-review"), source, { recursive: true })
  expect(await calls(() => client.send({ type: "tools.trust", directory, trusted: true }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "tools.trust", directory, trusted: false }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "packages.install", directory, source, scope: "project" }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "packages.enable", directory, key: "project:mendcode-review", enabled: false }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "packages.enable", directory, key: "project:mendcode-review", enabled: true }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "settings.set", patch: { disabledPackages: ["user:other"] } }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "settings.set", patch: { trustedToolDirs: [directory] } }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "packages.remove", directory, name: "mendcode-review", scope: "project" }))).toBeGreaterThan(0)
  expect(await calls(() => client.send({ type: "settings.set", patch: { theme: "dark" } as never }))).toBe(0)
})

test("the startup trust report counts MCP servers that wait for trust", async () => {
  const dir = temp(), directory = temp()
  const manager = createMcpManager({ configLoader: () => ({ servers: {}, errors: [], blocked: [{ name: "held", command: "run it", source: "x" }] }) })
  cleanup.push(() => manager.stop())
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), mcp: manager, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "mcp-trust-report" })
  await client.connect()
  cleanup.push(() => client.close())
  expect(await client.send({ type: "hooks.list", directory })).toMatchObject({ ok: true, result: { pending: { mcp: 1 } } })
})
