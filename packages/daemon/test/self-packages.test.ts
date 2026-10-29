import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { describeActivation, listPackages, listTrash } from "@mendcode/packages"
import type { PackagePort, PackageRequest } from "@mendcode/tools"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function temp() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "self-packages-")))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function write(file: string, text: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
async function fixture() {
  const dir = temp(), project = temp(), source = temp()
  for (const name of ["alpha", "beta", "retro", "modern"]) {
    const activate = name === "retro" ? { tuiProfile: { density: "compact" } } : name === "modern" ? { tuiProfile: { density: "spacious" } } : undefined
    write(path.join(source, name, "mendcode-package.json"), JSON.stringify({ name, version: "1.0.0", description: `${name} package`, ...(activate ? { activate } : {}) }))
    write(path.join(source, name, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} helpers\n---\n${name}`)
    write(path.join(source, name, "commands", "example.md"), `${name} command`)
  }
  write(path.join(source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: ["alpha", "beta", "retro", "modern"].map((name) => ({ id: name, version: "1.0.0", source: { url: name } })) }))
  let getPort!: (id: SessionId) => PackagePort
  let restrict!: (id: SessionId, value: string) => void
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock, packages, store }) => {
    getPort = packages
    restrict = (id, value) => store.meta.set(`session.local-tools.restricted:${id}`, value)
    return createFauxEngine({ clock, deltaMs: 1 })
  } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "self-packages" })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.send({ type: "settings.set", patch: { tier: "balanced" } })).toMatchObject({ ok: true })
  expect(await client.send({ type: "packages.add-source", directory: project, sourceId: "team", location: source, enabled: true })).toMatchObject({ ok: true })
  const created = await client.send({ type: "session.create", directory: project })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  const port = getPort(sessionId)
  const apply = async (request: PackageRequest) => { await port.preview(request); return port.run(request) }
  const trust = () => client.send({ type: "settings.set", patch: { trustedToolDirs: [project] } })
  const look = () => describeActivation({ userDir: dir, directory: project, disabled: [], projectTrusted: true })
  return { port, apply, trust, look, dir, project, source, restrict: (value: string) => restrict(sessionId, value), client }
}

test("faux daemon shares all local package actions, coexistence and Trash with /packages", async () => {
  const fixtureData = await fixture()
  const { port, apply, dir, project, client } = fixtureData
  expect((await port.run({ action: "search", sourceId: "team" })).entries).toBeDefined()
  await apply({ action: "install", name: "alpha", sourceId: "team", scope: "user" })
  await apply({ action: "install", name: "beta", sourceId: "team", scope: "user" })
  expect(listPackages({ userDir: dir, directory: project }).filter((pkg) => pkg.enabled).map((pkg) => pkg.name)).toEqual(["alpha", "beta"])
  const report = await port.run({ action: "info", key: "user:alpha" })
  expect(report).toMatchObject({ key: "user:alpha", version: "1.0.0" })
  expect(report.resources).toContainEqual({ id: "skills/alpha", kind: "skills", name: "alpha" })
  expect(JSON.stringify(report)).toContain("example")
  expect(await port.run({ action: "check", key: "user:alpha" })).toMatchObject({ check: { ok: true } })
  await apply({ action: "disable", key: "user:alpha" })
  expect((await port.run({ action: "list" })).packages).toContainEqual(expect.objectContaining({ name: "alpha", enabled: false }))
  await apply({ action: "enable", key: "user:alpha" })
  expect(await client.send({ type: "packages.list", directory: project })).toMatchObject({ ok: true, result: await port.run({ action: "list" }) })
  const location = listPackages({ userDir: dir, directory: project }).find((pkg) => pkg.name === "alpha")!.dir
  await apply({ action: "remove", key: "user:alpha" })
  expect(existsSync(location)).toBe(false)
  expect(JSON.stringify(listTrash({ base: dir }))).toContain("alpha")
  const scaffold = await apply({ action: "new", name: "draft", scope: "user" })
  expect(existsSync(path.join(scaffold.dir as string, "mendcode-package.json"))).toBe(true)
  expect(await port.run({ action: "check", name: "draft", scope: "user" })).toMatchObject({ check: { ok: true } })
})

test("trust, local-only, receipts and content changes fail closed", async () => {
  const { port, apply, trust, source, restrict } = await fixture()
  const install: PackageRequest = { action: "install", name: "alpha", sourceId: "team", scope: "user" }
  await expect(port.run(install)).rejects.toThrow()
  await expect(port.preview({ ...install, scope: "project" })).rejects.toThrow("Trust")
  await expect(port.preview({ action: "new", name: "draft" })).rejects.toThrow("Trust")
  await port.preview(install)
  write(path.join(source, "alpha", "commands", "example.md"), "changed since preview")
  await expect(port.run(install)).rejects.toThrow("approval")
  await apply(install)
  await expect(port.run({ ...install, replace: true })).rejects.toThrow("approval")
  await trust()
  await apply({ ...install, name: "beta", scope: "project" })
  await port.preview({ action: "disable", key: "project:beta" })
  restrict("true")
  for (const action of ["list", "info", "search", "check", "disable"] as const) await expect(port.run({ action, key: "project:beta" })).rejects.toThrow("local")
  restrict("false")
  await expect(port.preview({ ...install, sourceId: "unknown" })).rejects.toThrow()
})

test("look switch is explicit and disabling the owner restores the prior look", async () => {
  const { apply, port, look, client, project } = await fixture()
  await apply({ action: "install", name: "retro", sourceId: "team", scope: "user" })
  expect(look().overlay.density).toBe("compact")
  await expect(port.preview({ action: "install", name: "modern", sourceId: "team", scope: "user" })).rejects.toThrow("switch-look")
  expect(await client.send({ type: "packages.install-catalog", directory: project, name: "modern", sourceId: "team", scope: "user" })).toMatchObject({ ok: false })
  const preview = JSON.parse(await port.preview({ action: "switch-look", key: "user:modern" }))
  expect(preview.changes.overlayKeys).toContain("density")
  expect(preview.changes.nextLook.overlay.density).toBe("spacious")
  await port.run({ action: "switch-look", key: "user:modern" })
  expect(look().overlay.density).toBe("spacious")
  await apply({ action: "disable", key: "user:modern" })
  expect(look().overlay.density).toBe("compact")
})

test("replacement previews preserve resource switches without duplicating the old package layer", async () => {
  const { apply, port, client } = await fixture()
  await apply({ action: "install", name: "alpha", sourceId: "team", scope: "user" })
  expect(await client.send({ type: "settings.set", patch: { disabledPackageResources: ["user:alpha/commands/example"] } })).toMatchObject({ ok: true })
  await apply({ action: "disable", key: "user:alpha" })
  const enabling = JSON.parse(await port.preview({ action: "enable", key: "user:alpha" }))
  expect(enabling.precedence.claims.some((claim: { surface: string; name: string }) => claim.surface === "commands" && claim.name === "example")).toBe(false)
  await port.run({ action: "enable", key: "user:alpha" })
  const replacement = { action: "install", name: "alpha", sourceId: "team", scope: "user", replace: true } as const
  const preview = JSON.parse(await port.preview(replacement))
  expect(preview.precedence.layers.filter((layer: string) => layer.includes("alpha"))).toHaveLength(1)
  expect(preview.precedence.claims.some((claim: { surface: string; name: string }) => claim.surface === "commands" && claim.name === "example")).toBe(false)
  await port.run(replacement)
})

test("a package whose keybindings file broke after install can still be inspected, disabled and removed", async () => {
  const { port, apply, source, dir, project } = await fixture()
  write(path.join(source, "keyed", "mendcode-package.json"), JSON.stringify({ name: "keyed", version: "1.0.0", description: "keyed package", activate: { keybindings: "keys.json" } }))
  write(path.join(source, "keyed", "keys.json"), JSON.stringify({ "ctrl+g": "session.new" }))
  write(path.join(source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: [{ id: "keyed", version: "1.0.0", source: { url: "keyed" } }] }))
  await apply({ action: "install", name: "keyed", sourceId: "team", scope: "user" })
  const installed = listPackages({ userDir: dir, directory: project }).find((pkg) => pkg.name === "keyed")!
  write(path.join(installed.dir, "keys.json"), "{ not json")
  expect(await port.run({ action: "info", key: "user:keyed" })).toMatchObject({ key: "user:keyed" })
  expect(await port.run({ action: "check", key: "user:keyed" })).toMatchObject({ check: { ok: false } })
  await apply({ action: "disable", key: "user:keyed" })
  await apply({ action: "remove", key: "user:keyed" })
  expect(existsSync(installed.dir)).toBe(false)
})

test("linked source resources cannot enter an approval snapshot", async () => {
  const { port, source } = await fixture()
  const outside = temp()
  write(path.join(outside, "private.txt"), "test-only data")
  symlinkSync(path.join(outside, "private.txt"), path.join(source, "alpha", "linked.txt"))
  await expect(port.preview({ action: "install", name: "alpha", sourceId: "team", scope: "user" })).rejects.toThrow("links are not allowed")
})
