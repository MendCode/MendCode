import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { PackagesReport } from "@mendcode/protocol"
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

/** Broken packages in the data dir before the daemon starts: it must come up, answer, and keep the good package working. */
test("a daemon with broken packages installed starts, lists them with their problem, and the good package still works", async () => {
  const dir = temp("mendd-broken-")
  const project = temp("mendd-broken-proj-")
  const packages = path.join(dir, "packages")
  write(path.join(packages, "good", "mendcode-package.json"), JSON.stringify({ name: "good", version: "1.0.0", description: "works" }))
  write(path.join(packages, "good", "commands", "hello.md"), "say hello")
  // Invalid manifest.
  write(path.join(packages, "badmanifest", "mendcode-package.json"), "{ not json")
  // Valid manifest, every loader fed garbage.
  write(path.join(packages, "garbage", "mendcode-package.json"), JSON.stringify({ name: "garbage", version: "1.0.0", description: "garbage everywhere", activate: { tuiProfile: { permissionMode: "bypass" } } }))
  write(path.join(packages, "garbage", "tools", "broken.json"), "{ nope")
  write(path.join(packages, "garbage", "hooks.json"), "[[[")
  write(path.join(packages, "garbage", "mcp.json"), "not json")
  write(path.join(packages, "garbage", "statusline.json"), "{")
  write(path.join(packages, "garbage", "recipes", "r.json"), "{")
  write(path.join(packages, "garbage", "workflows", "w.json"), "{")
  write(path.join(packages, "garbage", "themes", "t.json"), "{")
  write(path.join(packages, "garbage", "extensions", "throws.ts"), "throw new Error('boom at import')")
  write(path.join(packages, "garbage", "SYSTEM.md"), "x".repeat(10))
  // A manifest that names a file that does not exist.
  write(path.join(packages, "ghost", "mendcode-package.json"), JSON.stringify({ name: "ghost", version: "1.0.0", description: "g", activate: { keybindings: "missing.json" } }))

  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "broken" })
  await client.connect()
  cleanups.push(() => client.close())

  const list = await client.send({ type: "packages.list", directory: project })
  expect(list.ok).toBe(true)
  const report = ((list as { result?: unknown }).result as PackagesReport).packages
  expect(report.map((pkg) => pkg.key).sort()).toEqual(["user:badmanifest", "user:garbage", "user:ghost", "user:good"])
  expect(report.find((pkg) => pkg.key === "user:badmanifest")?.problem).toBeTruthy()
  expect(report.find((pkg) => pkg.key === "user:good")?.problem).toBeUndefined()

  for (const type of ["tools.list", "commands.list", "skills.list", "themes.list", "agents.list"] as const) {
    const reply = await client.send({ type, directory: project } as never)
    expect([type, reply.ok]).toEqual([type, true])
  }
  const commands = ((await client.send({ type: "commands.list", directory: project })) as { result?: unknown }).result as { commands: Array<{ name: string }> }
  expect(commands.commands.map((command) => command.name)).toContain("hello")

  // A turn still runs.
  const created = await client.send({ type: "session.create", directory: project } as never)
  expect(created.ok).toBe(true)
})
