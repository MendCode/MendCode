import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory } from "@mendcode/protocol"
import { ideContext, isReadOnlyCommand } from "@mendcode/protocol/wire"
import { createIdeBridge } from "../src/ide"
import { readZedSelection, zedPosition } from "../src/ide-zed"
import { startDaemon } from "../src"
import { zedFixture } from "./ide-fixture"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-ide-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const h = zedFixture(dir)
  cleanups.push(() => h.db.close())
  return { dir, ...h }
}

test("Zed reads unsaved reversed/multiple UTF-8 ranges and one-based positions without writing", async () => {
  const h = fixture()
  const before = readFileSync(h.dbPath)
  const result = await readZedSelection(h.directory, h.dbPath)
  expect(result).toMatchObject({ status: "connected", selection: { filePath: h.file, source: "zed", ranges: [
    { text: "é🙂", selection: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
    { text: "world", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 6 } } },
  ] } })
  expect(readFileSync(h.dbPath)).toEqual(before)
  expect(zedPosition("é🙂\nx", 7)).toEqual({ index: 4, position: { line: 2, character: 1 } })
})

test("workspace specificity wins over a newer broad workspace; another project is empty", async () => {
  const h = fixture()
  h.editor(2, h.dir, h.file, "wrong", "2026-10-03")
  h.db.query("insert into editor_selections values (2, 2, 0, 5)").run()
  expect((await readZedSelection(h.directory, h.dbPath)).selection?.ranges[0]?.text).toBe("é🙂")
  expect(await readZedSelection(path.join(h.dir, "different"), h.dbPath)).toEqual({ status: "empty" })
})

test("cursor context and disk fallback work; non-editor panes and missing schemas are unavailable", async () => {
  const h = fixture()
  h.db.exec("delete from editor_selections; insert into editor_selections values (1, 1, 0, 0); update editors set contents = null")
  const cursor = await readZedSelection(h.directory, h.dbPath)
  expect(cursor.selection?.ranges[0]).toMatchObject({ text: "", selection: { start: { line: 1, character: 1 } } })
  expect(ideContext(cursor.selection!)).toContain("user opened the file")
  h.db.exec("update items set kind = 'Terminal'")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable", message: expect.stringContaining("not an editor") })
  expect(await readZedSelection(h.directory, path.join(h.dir, "missing.sqlite"))).toMatchObject({ status: "unavailable" })
  h.db.exec("drop table panes")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable" })
})

test("external editor buffers and disk symlinks never attach another project's content", async () => {
  const h = fixture()
  const external = path.join(h.dir, "external.ts")
  writeFileSync(external, "private")
  h.db.query("update editors set buffer_path = ?").run(external)
  expect(await readZedSelection(h.directory, h.dbPath)).toEqual({ status: "empty" })
  const link = path.join(h.directory, "linked.ts")
  symlinkSync(external, link)
  h.db.query("update editors set buffer_path = ?, contents = null").run(link)
  expect(await readZedSelection(h.directory, h.dbPath)).toEqual({ status: "empty" })
})

test("invalid offsets and oversized buffers, selections and range counts fail explicitly", async () => {
  const h = fixture()
  h.db.exec("update editor_selections set start = -1")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable" })
  h.db.exec("delete from editor_selections; insert into editor_selections values (1, 1, 0, 100)")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable", message: expect.stringContaining("outside") })
  h.db.query("update editors set contents = ?").run("x".repeat(33_000))
  h.db.exec("update editor_selections set end = 33000")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable", message: expect.stringContaining("32 KiB") })
  h.db.query("update editors set contents = ?").run("x".repeat(1024 * 1024 + 1))
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable", message: expect.stringContaining("1 MiB") })
  h.db.exec("delete from editor_selections")
  for (let index = 0; index < 65; index++) h.db.exec("insert into editor_selections values (1, 1, 0, 0)")
  expect(await readZedSelection(h.directory, h.dbPath)).toMatchObject({ status: "unavailable" })
})

test("project bridge is off by default, private, persistent and isolated; corrupt config refuses edits", async () => {
  const h = fixture()
  let reads = 0
  const adapter = { selection: async (directory: string, dbPath?: string) => { reads++; return readZedSelection(directory, dbPath) }, open: async () => ({ opened: true }) }
  const bridge = createIdeBridge(h.dir, adapter)
  expect(await bridge.query(h.directory)).toEqual({ editor: "zed", enabled: false, status: "off" })
  expect(reads).toBe(0)
  expect(await bridge.open(h.directory, h.file)).toMatchObject({ opened: false, message: "IDE bridge is off" })
  expect(await bridge.configure(h.directory, true, h.dbPath)).toMatchObject({ enabled: true, status: "connected" })
  expect(await createIdeBridge(h.dir, adapter).query(h.directory)).toMatchObject({ enabled: true })
  expect(await bridge.query(h.dir)).toMatchObject({ enabled: false })
  const configs = [...new Bun.Glob("*.json").scanSync(path.join(h.dir, "ide"))]
  const config = path.join(h.dir, "ide", configs[0]!)
  expect(statSync(config).mode & 0o777).toBe(0o600)
  expect(readFileSync(config, "utf8")).not.toContain("é🙂")
  await bridge.configure(h.directory, false)
  const count = reads
  await bridge.query(h.directory)
  expect(reads).toBe(count)
  writeFileSync(config, "{")
  await expect(bridge.configure(h.directory, true)).rejects.toThrow("configuration cannot be read")
  expect(readFileSync(config, "utf8")).toBe("{")
})

test("typed client crosses the real daemon protocol for Zed context, opt-in and project-safe opening", async () => {
  const h = fixture()
  const opened: Array<[string, number, number]> = []
  const daemon = await startDaemon({ dir: h.dir, socketPath: path.join(h.dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ide: { selection: readZedSelection, open: async (file, line, character) => { opened.push([file, line, character]); return { opened: true } } } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "ide-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.ideContext(h.directory)).toMatchObject({ ok: true, report: { status: "off" } })
  expect(await client.configureIde(h.directory, true, h.dbPath)).toMatchObject({ ok: true, report: { status: "connected" } })
  expect(await client.ideContext(h.directory)).toMatchObject({ ok: true, report: { selection: { filePath: h.file } } })
  expect(await client.openIdeFile(h.directory, "app.ts", 3, 2)).toEqual({ ok: true, report: { opened: true } })
  expect(opened).toEqual([[h.file, 3, 2]])
  const outside = path.join(h.dir, "outside.ts")
  writeFileSync(outside, "private")
  symlinkSync(outside, path.join(h.directory, "outside.ts"))
  for (const file of [outside, "../outside.ts", "outside.ts", "missing.ts"]) expect(await client.openIdeFile(h.directory, file)).toMatchObject({ ok: true, report: { opened: false } })
  expect(opened).toHaveLength(1)
  expect(await client.configureIde(h.directory, false)).toMatchObject({ ok: true, report: { status: "off" } })
  expect(await client.openIdeFile(h.directory, "app.ts")).toMatchObject({ ok: true, report: { opened: false } })
})

test("IDE commands validate positions and never grant remote read-only access to content or mutations", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/project" }
  for (const type of ["ide.query", "ide.configure", "ide.open"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  expect(Command.safeParse({ ...base, type: "ide.query" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "ide.configure", enabled: true, dbPath: "/tmp/db.sqlite" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "ide.open", filePath: "a.ts", line: 0 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "ide.open", filePath: "a.ts", character: 1.5 }).success).toBe(false)
})
