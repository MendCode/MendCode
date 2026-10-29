import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src/daemon"
import { legacyTheme, nativeTheme } from "../../protocol/test/theme-fixtures"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-b65-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  const file = path.join(project, "Forest_Mode.json")
  writeFileSync(file, JSON.stringify(nativeTheme))
  const globals: unknown[] = []
  const start = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "B65", onGlobal: (event) => { globals.push(event) } })
    await client.connect()
    cleanups.push(() => client.close())
    return { daemon, client }
  }
  return { dir, project, file, globals, start, ...await start() }
}

describe("B65 daemon themes", () => {
  test("validate reports success and failure without installing or changing settings", async () => {
    const fixture = await boot()
    expect(await fixture.client.validateTheme(fixture.file)).toMatchObject({ ok: true, result: { ok: true, file: fixture.file, errors: [], callsProviders: false } })
    for (const content of ["not JSON", "{}", JSON.stringify({ ...nativeTheme, colors: {} }), " ".repeat(16385)]) {
      writeFileSync(fixture.file, content)
      expect(await fixture.client.validateTheme(fixture.file)).toMatchObject({ ok: true, result: { ok: false } })
    }
    expect(await fixture.client.validateTheme(path.join(fixture.dir, "missing"))).toMatchObject({ ok: true, result: { ok: false } })
    expect(existsSync(path.join(fixture.project, ".mendcode"))).toBe(false)
    expect(await fixture.client.send({ type: "settings.get" })).toMatchObject({ result: { settings: {} } })
  })
  test("install defaults to project, uses filename or --name and is discoverable with layer precedence", async () => {
    const fixture = await boot()
    const destination = path.join(fixture.project, ".mendcode", "themes", "Forest_Mode.json")
    expect(await fixture.client.installTheme(fixture.file, fixture.project)).toMatchObject({ ok: true, result: { name: "Forest_Mode", scope: "project", path: destination, callsProviders: false } })
    expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(nativeTheme)
    expect(await fixture.client.installTheme(fixture.file, fixture.project, { name: "Forest_Mode", scope: "user" })).toMatchObject({ ok: true })
    expect(await fixture.client.send({ type: "themes.list", directory: fixture.project })).toMatchObject({ result: { themes: [{ name: "Forest_Mode", source: "project", json: nativeTheme }] } })
  })
  test("invalid install and invalid selection preserve the old theme and unrelated settings", async () => {
    const fixture = await boot()
    await fixture.client.send({ type: "settings.set", patch: { theme: "mend", reducedMotion: true } })
    await fixture.client.installTheme(fixture.file, fixture.project)
    const destination = path.join(fixture.project, ".mendcode", "themes", "Forest_Mode.json")
    const before = readFileSync(destination, "utf8")
    writeFileSync(fixture.file, "{}")
    expect(await fixture.client.installTheme(fixture.file, fixture.project)).toMatchObject({ ok: false })
    expect(readFileSync(destination, "utf8")).toBe(before)
    expect(await fixture.client.selectTheme("missing", fixture.project)).toMatchObject({ ok: false })
    writeFileSync(destination, "{}")
    expect(await fixture.client.selectTheme("Forest_Mode", fixture.project)).toMatchObject({ ok: false })
    expect(await fixture.client.send({ type: "settings.get" })).toMatchObject({ result: { settings: { theme: "mend", reducedMotion: true } } })
  })
  test("user selection preserves the TUI profile; project selections stay isolated and survive restart", async () => {
    const fixture = await boot()
    const other = path.join(fixture.dir, "other")
    mkdirSync(other)
    await fixture.client.send({ type: "tui.change", input: { operation: "apply", profile: { density: "compact", theme: "matrix" } } })
    await fixture.client.send({ type: "settings.set", patch: { reducedMotion: true } })
    await fixture.client.installTheme(fixture.file, fixture.project, { name: "user-forest", scope: "user" })
    expect(await fixture.client.selectTheme("user-forest", fixture.project, "user")).toMatchObject({ ok: true, result: { name: "user-forest", scope: "user" } })
    expect(JSON.parse(readFileSync(path.join(fixture.dir, "tui", "profile.json"), "utf8"))).toMatchObject({ density: "compact", theme: "user-forest" })
    expect(fixture.globals).toContainEqual(expect.objectContaining({ type: "tui.changed", profile: expect.objectContaining({ theme: "user-forest", density: "compact" }) }))
    await fixture.client.installTheme(fixture.file, fixture.project)
    await fixture.client.installTheme(fixture.file, other, { name: "other-forest" })
    await fixture.client.selectTheme("Forest_Mode", fixture.project)
    await fixture.client.selectTheme("other-forest", other)
    const settings = { theme: "user-forest", reducedMotion: true, projectThemes: { [fixture.project]: "Forest_Mode", [other]: "other-forest" } }
    expect(await fixture.client.send({ type: "settings.get" })).toMatchObject({ result: { settings } })
    fixture.client.close()
    await fixture.daemon.stop()
    const next = await fixture.start()
    expect(await next.client.send({ type: "settings.get" })).toMatchObject({ result: { settings } })
    expect(fixture.globals).toContainEqual(expect.objectContaining({ type: "settings.changed", settings }))
  })
  test("v1 document installation preserves the source for daemon discovery and client normalization", async () => {
    const fixture = await boot()
    writeFileSync(fixture.file, JSON.stringify(legacyTheme))
    expect(await fixture.client.validateTheme(fixture.file)).toMatchObject({ result: { ok: true } })
    expect(await fixture.client.installTheme(fixture.file, fixture.project)).toMatchObject({ ok: true })
    expect(await fixture.client.selectTheme("Forest_Mode", fixture.project)).toMatchObject({ ok: true })
    expect(await fixture.client.send({ type: "themes.list", directory: fixture.project })).toMatchObject({ result: { themes: [{ json: legacyTheme }] } })
  })
  test("installation rejects symlink scopes, directories and destinations instead of writing outside scope", async () => {
    const fixture = await boot()
    const outside = path.join(fixture.dir, "outside")
    mkdirSync(outside)
    symlinkSync(outside, path.join(fixture.project, ".mendcode"))
    expect(await fixture.client.installTheme(fixture.file, fixture.project)).toMatchObject({ ok: false })
    expect(existsSync(path.join(outside, "themes"))).toBe(false)
    mkdirSync(path.join(fixture.dir, "themes"))
    symlinkSync(fixture.file, path.join(fixture.dir, "themes", "Forest_Mode.json"))
    expect(await fixture.client.installTheme(fixture.file, fixture.project, { scope: "user" })).toMatchObject({ ok: false })
    expect(await fixture.client.selectTheme("Forest_Mode", fixture.project, "user")).toMatchObject({ ok: false })
    expect(JSON.parse(readFileSync(fixture.file, "utf8"))).toEqual(nativeTheme)
  })
})
