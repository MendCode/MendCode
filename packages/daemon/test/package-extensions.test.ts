import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { ExtensionsReport } from "@mendcode/protocol"
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

const extension = (name: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { api.on("input", (e) => ({ text: e.text + " (via ${name})" })) } }\n`

async function boot() {
  const dir = temp("mendd-pkgext-")
  const project = temp("mendd-pkgext-proj-")
  const source = temp("mendd-pkgext-src-")
  write(path.join(source, "mendcode-package.json"), JSON.stringify({ name: "acme", version: "1.0.0", description: "Acme helpers", extensions: true }))
  write(path.join(source, "extensions", "guard.ts"), extension("guard"))
  write(path.join(source, "extensions", "audit", "index.ts"), extension("audit"))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "pkgext" })
  await client.connect()
  cleanups.push(() => client.close())
  const extensions = async () => {
    const reply = await client.send({ type: "extensions.list", directory: project })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result as ExtensionsReport).extensions
  }
  return { client, project, source, extensions }
}

describe("extensions shipped in a package", () => {
  test("a user package's extensions/ is installed and discovered from the package layer", async () => {
    const { client, project, source, extensions } = await boot()
    const installed = await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    expect(installed).toMatchObject({ ok: true, result: { packages: [{ key: "user:acme", contents: { extensions: 2 }, manifest: { extensions: true } }] } })
    const found = await extensions()
    expect(found.map((e) => [e.name, e.source, e.daemon, e.trusted, e.hooks])).toEqual([
      ["audit", "package", true, true, ["input"]],
      ["guard", "package", true, true, ["input"]],
    ])
    expect(found[1]!.file).toContain(path.join("packages", "acme", "extensions", "guard.ts"))
  })

  test("a project package's extensions stay untrusted until the directory is trusted, and disabling the package removes them", async () => {
    const { client, project, source, extensions } = await boot()
    await client.send({ type: "packages.install", directory: project, source, scope: "project" })
    expect((await extensions()).map((e) => [e.name, e.trusted, e.daemon])).toEqual([
      ["audit", false, false],
      ["guard", false, false],
    ])
    await client.send({ type: "tools.trust", directory: project, trusted: true })
    expect((await extensions()).map((e) => [e.name, e.trusted, e.daemon])).toEqual([
      ["audit", true, true],
      ["guard", true, true],
    ])
    await client.send({ type: "packages.enable", directory: project, key: "project:acme", enabled: false })
    expect(await extensions()).toEqual([])
  })

  test("a package that declares extensions it does not ship is refused", async () => {
    const { client, project, source } = await boot()
    rmSync(path.join(source, "extensions"), { recursive: true })
    const refused = await client.send({ type: "packages.install", directory: project, source, scope: "user" })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.message).toContain("declares extensions")
  })
})
