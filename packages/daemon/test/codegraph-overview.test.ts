import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createCodeOverview, createIndexer } from "@mendcode/codegraph"
import { createFauxEngine } from "@mendcode/engine-faux"
import { CODEGRAPH_OVERVIEW, createIdFactory, isReadOnlyCommand, parseCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"

/** `codegraph.overview` (the Galaxy panel's code mode): the one command that builds the code graph on a user's key press. */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot({ overview = true }: { overview?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-cgview-")))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, "data"), home = path.join(base, "home"), project = path.join(home, "app"), cacheDir = path.join(dir, "codegraph")
  mkdirSync(path.join(project, "src"), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(home, "notes.ts"), "export const secret = 1\n")
  writeFileSync(path.join(project, "src", "hub.ts"), "export function hub() { return 1 }\n")
  for (let index = 0; index < 40; index++) writeFileSync(path.join(project, "src", `m${index}.ts`), `import { hub } from "./hub"\n${index ? `import { m${index - 1} } from "./m${index - 1}"\n` : ""}export function m${index}() { return hub() }\n`)
  const scans: string[] = []
  const indexer = createIndexer({ cacheDir, now: Date.now, onScan: (file) => scans.push(file) })
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), ...(overview ? { codeOverview: createCodeOverview({ indexer, home }) } : {}), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "panel" })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, home, project, cacheDir, scans }
}

describe("codegraph.overview", () => {
  test("nothing is indexed until the command asks, then the reply is the bounded overview of that project", async () => {
    const h = await boot()
    expect((await h.client.send({ type: "session.create", directory: h.project })).ok).toBe(true)
    expect((await h.client.send({ type: "git.status", directory: h.project })).ok).toBe(true)
    expect(h.scans).toEqual([])
    expect(existsSync(h.cacheDir)).toBe(false)

    const reply = await h.client.send({ type: "codegraph.overview", directory: h.project })
    expect(reply.ok).toBe(true)
    const report = (reply as { result: any }).result
    expect(report.state).toBe("ready")
    expect(h.scans).toHaveLength(41)
    expect(readdirSync(h.cacheDir)).toHaveLength(1)
    expect(report.total).toEqual({ files: 41, symbols: 41 })
    expect(report.files).toHaveLength(CODEGRAPH_OVERVIEW.defaultFiles)
    expect(report.files[0]).toMatchObject({ path: "src/hub.ts", imports: 0, importedBy: 40, calls: 40, degree: 40 })
    expect(report.files[0].topImportedBy).toHaveLength(CODEGRAPH_OVERVIEW.neighbours)
    expect(report.edges.length).toBeGreaterThan(0)
    expect(report.edges.length).toBeLessThanOrEqual(CODEGRAPH_OVERVIEW.edges)
    for (const file of report.files) expect(path.isAbsolute(file.path) || file.path.length > CODEGRAPH_OVERVIEW.path).toBe(false)
    expect(JSON.stringify(report)).not.toContain(h.home)

    const few = (await h.client.send({ type: "codegraph.overview", directory: h.project, limit: 3 }) as { result: any }).result
    expect(few.files.map((file: { path: string }) => file.path)).toEqual(report.files.slice(0, 3).map((file: { path: string }) => file.path))
    expect(h.scans).toHaveLength(41)
  })

  test("the home folder is refused without reading it", async () => {
    const h = await boot()
    expect(await h.client.send({ type: "codegraph.overview", directory: h.home })).toEqual({ ok: true, result: { state: "off", reason: "not a project" } })
    expect(await h.client.send({ type: "codegraph.overview", directory: path.dirname(h.home) })).toMatchObject({ ok: true, result: { state: "off" } })
    expect(h.scans).toEqual([])
    expect(existsSync(h.cacheDir)).toBe(false)
  })

  test("the user's switches win over the key: a daemon without the graph, or with the feature off, indexes nothing", async () => {
    const without = await boot({ overview: false })
    expect(await without.client.send({ type: "codegraph.overview", directory: without.project })).toEqual({ ok: true, result: { state: "off", reason: "disabled by MENDCODE_CODEGRAPH=0" } })
    const off = await boot()
    expect((await off.client.send({ type: "settings.set", patch: { features: { codegraph: false } } })).ok).toBe(true)
    expect(await off.client.send({ type: "codegraph.overview", directory: off.project })).toEqual({ ok: true, result: { state: "off", reason: "the codegraph feature is off" } })
    expect(off.scans).toEqual([])
  })

  test("the command takes a directory and a file count within the cap, and a read-only peer may not send it", () => {
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client"), type: "codegraph.overview", directory: "/work/app" }
    expect(parseCommand(base).success).toBe(true)
    expect(parseCommand({ ...base, limit: CODEGRAPH_OVERVIEW.files }).success).toBe(true)
    expect(parseCommand({ ...base, limit: CODEGRAPH_OVERVIEW.files + 1 }).success).toBe(false)
    expect(parseCommand({ ...base, limit: 0 }).success).toBe(false)
    expect(parseCommand({ ...base, directory: "" }).success).toBe(false)
    expect(parseCommand({ ...base, rebuild: true }).success).toBe(false)
    expect(isReadOnlyCommand("codegraph.overview")).toBe(false)
  })
})

describe("where the code graph indexes, told to the footer", () => {
  test("a folder outside any git repository is skipped quietly, /graph on for that project indexes it, and the panel follows the same gate", async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-cggate-")))
    cleanups.push(() => rmSync(base, { recursive: true, force: true }))
    const dir = path.join(base, "data"), home = path.join(base, "home"), loose = path.join(home, "loose"), repo = path.join(home, "repo")
    for (const folder of [dir, path.join(loose, "src"), path.join(repo, ".git"), path.join(repo, "src")]) mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(loose, "src", "a.ts"), "export function a() { return 1 }\n")
    writeFileSync(path.join(repo, "src", "b.ts"), "export function b() { return 2 }\n")
    const { createIndexGate } = await import("@mendcode/codegraph")
    const { createCodegraphStatus } = await import("../src/codegraph-status")
    const hub = createCodegraphStatus()
    const scans: string[] = []
    const indexer = createIndexer({ cacheDir: path.join(dir, "codegraph"), now: Date.now, onScan: (file) => scans.push(file) })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), codegraphStatus: hub, codeGate: createIndexGate({ home }), codeOverview: createCodeOverview({ indexer, home }), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const events: any[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "footer", onGlobal: (event) => { if ((event as { type: string }).type === "codegraph.status") events.push(event) } })
    await client.connect()
    cleanups.push(() => client.close())
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

    expect((await client.send({ type: "session.create", directory: loose })).ok).toBe(true)
    expect((await client.send({ type: "session.create", directory: repo })).ok).toBe(true)
    await settle()
    expect(events).toEqual([expect.objectContaining({ directory: loose, state: "skipped", reason: "no git repo" })])
    expect(await client.send({ type: "codegraph.overview", directory: loose })).toEqual({ ok: true, result: { state: "off", reason: "no git repo" } })
    expect(scans).toEqual([])

    expect((await client.send({ type: "settings.set", patch: { projectConfig: { [loose]: { codegraph_index: "on" } } } })).ok).toBe(true)
    await settle()
    expect(events.at(-1)).toMatchObject({ directory: loose, state: "none" })
    expect(await client.send({ type: "codegraph.overview", directory: loose })).toMatchObject({ ok: true, result: { state: "ready" } })

    expect((await client.send({ type: "settings.set", patch: { codegraph_index: "off", projectConfig: {} } })).ok).toBe(true)
    await settle()
    expect(events.at(-1)).toMatchObject({ directory: loose, state: "skipped", reason: "off" })
  })
})
