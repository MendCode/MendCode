import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { PackagesReport } from "@mendcode/protocol"
import { KEYBINDINGS_FILE, PROMPT_FILES } from "@mendcode/extension-api"
import { PACKAGE_READ_PATHS } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { HOOKS_FILE } from "../src/shell-hooks"
import { STATUSLINE_FILE } from "../src/status-scripts"
import { remoteExecutionCommand } from "../src/remote-policy"

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

/** A package source folder with the given manifest fields. */
function source(manifest: Record<string, unknown>) {
  const dir = temp("mendd-act-src-")
  write(path.join(dir, "mendcode-package.json"), JSON.stringify({ version: "1.0.0", description: "test package", ...manifest }))
  return dir
}

async function boot(options: { version?: string } = {}) {
  const dir = temp("mendd-act-")
  const project = temp("mendd-act-proj-")
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    ...(options.version ? { runtimeInfo: { version: options.version, buildId: "test", startedAt: 0 } as never } : {}),
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "activation" })
  await client.connect()
  cleanups.push(() => client.close())
  const packages = (reply: { ok: boolean; result?: unknown }) => (reply.result as PackagesReport).packages
  return { client, dir, project, packages }
}

const look = (name: string, theme: string) => source({ name, activate: { tuiProfile: { username: name }, theme } })

describe("one package owns the look per scope", () => {
  test("two packages that set the tier are two setups: switching to one switches the other off, and the refusal says so", async () => {
    const { client, project, packages } = await boot()
    const setup = (name: string, tier: string) => source({ name, activate: { tier } })
    await client.send({ type: "packages.install", directory: project, source: setup("lean", "minimalist"), scope: "user" })
    await client.send({ type: "packages.install", directory: project, source: setup("whole", "full"), scope: "user" })
    const refused = await client.send({ type: "packages.enable", directory: project, key: "user:whole", enabled: true })
    expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("replaces it and switches user:lean off (both set the tier)") } })
    const switched = await client.send({ type: "packages.enable", directory: project, key: "user:whole", enabled: true, switch: true })
    expect(packages(switched).map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:lean", false], ["user:whole", true]])
    const back = await client.send({ type: "packages.enable", directory: project, key: "user:lean", enabled: true, switch: true })
    expect(packages(back).map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:lean", true], ["user:whole", false]])
  })

  test("a second package with a look is installed off and says what switching changes; switching moves the ownership", async () => {
    const { client, project, dir, packages } = await boot()
    const first = await client.send({ type: "packages.install", directory: project, source: look("alpha", "dark"), scope: "user" })
    expect(packages(first)).toMatchObject([{ key: "user:alpha", enabled: true }])
    const second = await client.send({ type: "packages.install", directory: project, source: look("beta", "light"), scope: "user" })
    expect(second).toMatchObject({ ok: false, error: { message: expect.stringMatching(/user:alpha owns the look.*--switch/) } })
    const listed = packages(await client.send({ type: "packages.list", directory: project }))
    expect(listed.map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:alpha", true], ["user:beta", false]])

    const refused = await client.send({ type: "packages.enable", directory: project, key: "user:beta", enabled: true })
    expect(refused.ok).toBe(false)
    const switched = await client.send({ type: "packages.enable", directory: project, key: "user:beta", enabled: true, switch: true })
    expect(packages(switched).map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:alpha", true], ["user:beta", true]])
    expect(JSON.parse(readFileSync(path.join(dir, "activation.json"), "utf8")).look).toBe("user:beta")

    await client.send({ type: "packages.enable", directory: project, key: "user:beta", enabled: false })
    expect(JSON.parse(readFileSync(path.join(dir, "activation.json"), "utf8")).look).toBeUndefined()
  })

  test("a package with only keybindings or prompt files claims no look, so any number can coexist", async () => {
    const { client, project, packages } = await boot()
    const keys = (name: string) => {
      const dir = source({ name, activate: { keybindings: "keys.json" } })
      write(path.join(dir, "keys.json"), JSON.stringify({ "ctrl+g": "palette" }))
      return dir
    }
    await client.send({ type: "packages.install", directory: project, source: keys("one"), scope: "user" })
    const reply = await client.send({ type: "packages.install", directory: project, source: keys("two"), scope: "user" })
    expect(packages(reply).map((pkg) => pkg.enabled)).toEqual([true, true])
  })

  test("removing the owner frees the look", async () => {
    const { client, project, packages } = await boot()
    await client.send({ type: "packages.install", directory: project, source: look("alpha", "dark"), scope: "user" })
    await client.send({ type: "packages.remove", directory: project, name: "alpha", scope: "user" })
    const reply = await client.send({ type: "packages.install", directory: project, source: look("beta", "light"), scope: "user" })
    expect(packages(reply).map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:beta", true]])
  })
})

describe("capture: the terminal profile as a look package", () => {
  test("captures the stored profile's look keys into an installed package, without state or keys a package may not set", async () => {
    const { client, dir, project, packages } = await boot()
    write(path.join(dir, "tui", "profile.json"), JSON.stringify({ promptChrome: "minimal", username: "Ana", processMode: "background", tutorialDone: "yes", copyOnSelect: false }))
    const reply = await client.send({ type: "packages.capture", directory: project, name: "work" })
    expect(reply.ok).toBe(true)
    expect(packages(reply).find((pkg) => pkg.key === "user:work")).toMatchObject({ enabled: true })
    const manifest = JSON.parse(readFileSync(path.join(dir, "packages", "work", "mendcode-package.json"), "utf8"))
    expect(manifest.activate.tuiProfile).toMatchObject({ promptChrome: "minimal", username: "Ana" })
    for (const key of ["processMode", "tutorialDone", "copyOnSelect"]) expect(manifest.activate.tuiProfile[key]).toBeUndefined()
    expect(((reply as { result?: unknown }).result as { skipped: string[] }).skipped).toEqual(expect.arrayContaining(["processMode", "tutorialDone", "copyOnSelect"]))
    expect(readdirSync(dir).filter((name) => name.startsWith(".package-capture-"))).toEqual([])
  })

  test("a name already installed needs --replace, and a second look waits behind the owner", async () => {
    const { client, dir, project } = await boot()
    write(path.join(dir, "tui", "profile.json"), JSON.stringify({ promptChrome: "minimal" }))
    expect((await client.send({ type: "packages.capture", directory: project, name: "work" })).ok).toBe(true)
    const again = await client.send({ type: "packages.capture", directory: project, name: "work" })
    expect(again.ok).toBe(false)
    const other = await client.send({ type: "packages.capture", directory: project, name: "fun" })
    expect(other.ok).toBe(false)
    expect(JSON.stringify(other)).toMatch(/user:work/)
    expect((await client.send({ type: "packages.capture", directory: project, name: "work", replace: true })).ok).toBe(true)
    expect(readdirSync(dir).filter((name) => name.startsWith(".package-capture-"))).toEqual([])
  })
})

describe("security: what an activation may never carry", () => {
  test("a manifest that asks for permissions, trust or credentials is refused at install with the reason", async () => {
    const { client, project } = await boot()
    for (const activate of [{ tuiProfile: { permissionMode: "bypass" } }, { trust: true }, { providers: {} }, { tuiProfile: { processMode: "background" } }]) {
      const reply = await client.send({ type: "packages.install", directory: project, source: source({ name: "bad", activate }), scope: "user" })
      expect(reply.ok).toBe(false)
    }
  })

  test("package commands that change what runs are local only: a remote or peer client cannot restore or switch", () => {
    for (const type of ["packages.enable", "packages.install", "packages.restore", "packages.install-catalog"]) expect(remoteExecutionCommand(type)).toBe(true)
  })
})

describe("compat is enforced", () => {
  test("a package that needs a newer app or API is refused with the version it needs", async () => {
    const { client, project } = await boot({ version: "1.2.0" })
    const newer = await client.send({ type: "packages.install", directory: project, source: source({ name: "future", compatibility: { mendcode: ">=9.0.0" } }), scope: "user" })
    expect(newer).toMatchObject({ ok: false, error: { message: expect.stringMatching(/>=9\.0\.0/) } })
    const api = await client.send({ type: "packages.install", directory: project, source: source({ name: "future-api", compatibility: { api: 99 } }), scope: "user" })
    expect(api.ok).toBe(false)
    expect(((await client.send({ type: "packages.list", directory: project })) as { result?: unknown }).result).toMatchObject({ packages: [] })
    const fine = await client.send({ type: "packages.install", directory: project, source: source({ name: "fine", compatibility: { mendcode: ">=1.0.0 <2.0.0", api: 1 } }), scope: "user" })
    expect(fine.ok).toBe(true)
  })
})

describe("uninstall goes to the Trash", () => {
  test("remove keeps the folder restorable; --purge deletes it", async () => {
    const { client, project, dir, packages } = await boot()
    await client.send({ type: "packages.install", directory: project, source: source({ name: "keepme" }), scope: "user" })
    await client.send({ type: "packages.remove", directory: project, name: "keepme", scope: "user" })
    expect(existsSync(path.join(dir, "packages", "keepme"))).toBe(false)
    const trashed = readdirSync(path.join(dir, ".Trash"))
    expect(trashed.some((entry) => entry.startsWith("keepme@"))).toBe(true)

    const restored = await client.send({ type: "packages.restore", directory: project, name: "keepme", scope: "user" })
    // Back from the Trash it stays off until the user turns it on again.
    expect(packages(restored)).toMatchObject([{ key: "user:keepme", enabled: false }])

    await client.send({ type: "packages.remove", directory: project, name: "keepme", scope: "user", purge: true })
    expect(existsSync(path.join(dir, "packages", "keepme"))).toBe(false)
    expect(readdirSync(path.join(dir, ".Trash")).filter((entry) => entry.startsWith("keepme@")).length).toBe(0)
    expect((await client.send({ type: "packages.restore", directory: project, name: "keepme", scope: "user" })).ok).toBe(false)
  })
})

describe("one table of resource kinds", () => {
  test("the file names the loaders and the extension API export are the ones in the table", () => {
    for (const name of [HOOKS_FILE, STATUSLINE_FILE, KEYBINDINGS_FILE, ...Object.values(PROMPT_FILES)]) expect(PACKAGE_READ_PATHS).toContain(name)
  })
})
