import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { listTrash, type ExtensionLayer } from "@mendcode/packages"
import type { CustomToolsReport, PackagesReport, ThemesReport } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

async function boot() {
  const dir = temp("mendd-pkg-")
  const project = temp("mendd-pkg-proj-")
  const source = temp("mendd-pkg-src-")
  write(path.join(source, "mendcode-package.json"), JSON.stringify({ name: "acme", version: "1.2.0", description: "Acme helpers" }))
  write(path.join(source, "tools", "hello.json"), JSON.stringify({ description: "package hello", command: ["echo", "hi"] }))
  write(path.join(source, "commands", "ship.md"), "---\ndescription: ship from the package\n---\nShip $ARGUMENTS")
  write(path.join(source, "commands", "review.md"), "package review")
  // The project's own command of the same name wins over the package's.
  write(path.join(project, ".mendcode", "commands", "review.md"), "project review")
  let layers: ((directory: string) => ExtensionLayer[]) | undefined
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock, extensionLayers }) => ((layers = extensionLayers), createFauxEngine({ clock, deltaMs: 1 })),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "packages" })
  await client.connect()
  cleanups.push(() => client.close())
  const result = <T>(reply: { ok: boolean; result?: unknown }) => reply.result as T
  return { client, dir, project, source, layers: () => layers!, result }
}

describe("packages commands", () => {
  test("an installed user package adds its tools and commands; the project's own files still win; disabling takes it all away", async () => {
    const { client, project, source, layers, result } = await boot()
    const installed = await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    expect(installed.ok).toBe(true)
    expect(result<PackagesReport>(installed).packages).toMatchObject([{ key: "user:acme", enabled: true, manifest: { version: "1.2.0" }, contents: { tools: 1, commands: 2 } }])

    const tools = result<CustomToolsReport>(await client.send({ type: "tools.list", directory: project })).tools
    expect(tools.map((t) => [t.toolName, t.source, t.pkg, t.trusted])).toEqual([["custom__hello", "user", "acme", true]])
    const commands = result<{ commands: Array<{ name: string; description: string; pkg?: string; source: string }> }>(await client.send({ type: "commands.list", directory: project })).commands
    expect(commands.map((c) => [c.name, c.source, c.pkg])).toEqual([
      ["bughunter", "builtin", undefined],
      ["commit", "builtin", undefined],
      ["commit-pr", "builtin", undefined],
      ["commit-push", "builtin", undefined],
      ["init", "builtin", undefined],
      ["pr-comments", "builtin", undefined],
      ["review", "project", undefined],
      ["security-review", "builtin", undefined],
      ["ship", "user", "acme"],
      ["ultraplan", "builtin", undefined],
      ["verify", "builtin", undefined],
      ["wiki", "builtin", undefined],
    ])
    expect(await client.send({ type: "commands.expand", directory: project, name: "ship", args: "v2" })).toMatchObject({ ok: true, result: { prompt: "Ship v2" } })
    expect(layers()(project).map((l) => l.pkg ?? l.source)).toEqual(["builtin", "acme", "user", "project"])
    expect(existsSync(path.join(layers()(project)[0]!.dir, "recipes", "quick.json"))).toBe(true)
    expect(existsSync(path.join(layers()(project)[0]!.dir, "skills"))).toBe(false)

    const disabled = await client.send({ type: "packages.enable", directory: project, key: "user:acme", enabled: false })
    expect(result<PackagesReport>(disabled).packages[0]!.enabled).toBe(false)
    expect(await client.send({ type: "settings.get" })).toMatchObject({ result: { settings: { disabledPackages: ["user:acme"] } } })
    expect(result<CustomToolsReport>(await client.send({ type: "tools.list", directory: project })).tools).toEqual([])
    expect(layers()(project).map((l) => l.pkg ?? l.source)).toEqual(["builtin", "user", "project"])

    await client.send({ type: "packages.enable", directory: project, key: "user:acme", enabled: true })
    expect(result<{ settings: Record<string, unknown> }>(await client.send({ type: "settings.get" })).settings.disabledPackages).toBeUndefined()
  })

  test("themes.list returns every layer's theme files for the client to validate", async () => {
    const { client, project, source, result } = await boot()
    write(path.join(source, "themes", "dusk.json"), JSON.stringify({ background: "#101010", colors: {} }))
    await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    const themes = result<ThemesReport>(await client.send({ type: "themes.list", directory: project })).themes
    expect(themes).toMatchObject([{ name: "dusk", source: "user", pkg: "acme", json: { background: "#101010" } }])
  })

  test("a project package's tools follow the project's trust", async () => {
    const { client, project, source, result } = await boot()
    await client.send({ type: "packages.install", directory: project, source, scope: "project" })
    const before = result<CustomToolsReport>(await client.send({ type: "tools.list", directory: project })).tools
    expect(before.map((t) => [t.toolName, t.source, t.trusted])).toEqual([["custom__hello", "project", false]])
    const after = result<CustomToolsReport>(await client.send({ type: "tools.trust", directory: project, trusted: true })).tools
    expect(after[0]!.trusted).toBe(true)
  })

  test("a refused install and removing a missing package are errors; remove moves an installed one to the Trash and purge deletes it", async () => {
    const { client, dir, project, source, result } = await boot()
    write(path.join(source, ".env"), "TOKEN=x")
    const refused = await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(refused.ok ? "" : refused.error.message).toContain(".env: looks like a secret")
    rmSync(path.join(source, ".env"))
    await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    expect(result<PackagesReport>(await client.send({ type: "packages.remove", directory: project, name: "acme", scope: "user" })).packages).toEqual([])
    expect(JSON.stringify(listTrash({ base: dir }))).toContain("acme")
    expect(await client.send({ type: "packages.remove", directory: project, name: "acme", scope: "user" })).toMatchObject({ ok: false, error: { code: "target_mismatch", message: "[PACKAGES]: user:acme is not installed" } })
    expect(result<PackagesReport>(await client.send({ type: "packages.restore", directory: project, name: "acme", scope: "user" })).packages.map((pkg) => pkg.key)).toEqual(["user:acme"])
    expect(result<PackagesReport>(await client.send({ type: "packages.remove", directory: project, name: "acme", scope: "user", purge: true })).packages).toEqual([])
    expect(await client.send({ type: "packages.restore", directory: project, name: "acme", scope: "user" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})
