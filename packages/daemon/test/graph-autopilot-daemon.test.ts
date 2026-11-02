import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createGraphAutopilot, createIndexGate, createIndexer } from "@mendcode/codegraph"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createCodegraphStatus } from "../src/codegraph-status"

/** The daemon end of the graph autopilot: sessions and turns start builds and refreshes by themselves, only while the feature is on. */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-autopilot-")))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, "data"), home = path.join(base, "home"), project = path.join(home, "app")
  mkdirSync(path.join(project, ".git"), { recursive: true })
  mkdirSync(dir, { recursive: true })
  for (let index = 0; index < 40; index++) writeFileSync(path.join(project, `m${index}.ts`), `export function m${index}() { return ${index} }\n`)
  const scans: string[] = []
  const logs: string[] = []
  const hub = createCodegraphStatus()
  const indexer = createIndexer({ cacheDir: path.join(dir, "codegraph"), now: Date.now, onScan: (file) => scans.push(file), onIndex: hub.publish, onProgress: hub.publish })
  const gate = createIndexGate({ home })
  const state = { on: false }
  const graphAutopilot = createGraphAutopilot({ indexer, gate: (cwd, signal) => gate.check({ cwd, mode: "auto", signal }), enabled: () => state.on, log: (line) => logs.push(line), checkGap: 0 })
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), codeGate: gate, codegraphStatus: hub, graphAutopilot, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "terminal" })
  await client.connect()
  cleanups.push(() => client.close())
  const open = async (directory: string) => ((await client.send({ type: "session.create", directory })) as unknown as { result: { sessionId: SessionId } }).result.sessionId
  /** Waits for what the daemon starts on its own (a gate check, then a build): until `done` holds and nothing runs. */
  const until = async (done: () => boolean, directory = project) => {
    for (let waited = 0; !done() && waited < 5_000; waited += 10) await Bun.sleep(10)
    await graphAutopilot.idle(directory)
  }
  return { client, home, project, scans, logs, hub, indexer, graphAutopilot, state, open, until }
}

describe("graph autopilot in the daemon", () => {
  test("with the feature off, opening a session and running a turn build nothing (the graph waits for a tool call, as before)", async () => {
    const h = await boot()
    const sessionId = await h.open(h.project)
    await h.client.send({ type: "user.submit", sessionId, text: "hello", attachments: [] })
    await h.graphAutopilot.idle(h.project)
    await Bun.sleep(100)
    expect(h.scans).toEqual([])
    expect(existsSync(h.indexer.cachePath(h.project))).toBe(false)
    expect(h.hub.get(h.project)).toBeUndefined()
  })

  test("with it on, a new session in a project builds the graph by itself and the footer's status goes indexing then indexed", async () => {
    const h = await boot()
    h.state.on = true
    await h.open(h.project)
    await h.until(() => h.hub.get(h.project)?.state === "indexed")
    expect(h.scans).toHaveLength(40)
    expect(h.indexer.peek(h.project)?.files.size).toBe(40)
    expect(h.hub.get(h.project)).toMatchObject({ state: "indexed", files: 40 })
    expect(h.logs.some((line) => line.startsWith("[GRAPH]:") && line.includes("builds the code graph"))).toBe(true)
  })

  test("a turn after enough changed code refreshes the graph, scanning only the changed files; a turn after a few small edits does not", async () => {
    const h = await boot()
    h.state.on = true
    const sessionId = await h.open(h.project)
    await h.until(() => h.hub.get(h.project)?.state === "indexed")
    expect(h.scans).toHaveLength(40)
    const change = (names: string[], stamp: number) => {
      for (const name of names) { writeFileSync(path.join(h.project, name), `export const v_${stamp}_${name.replace(/\W/g, "")} = ${stamp}\n`); utimesSync(path.join(h.project, name), stamp, stamp) }
    }
    change(["m1.ts", "m2.ts", "m3.ts"], 1_000_000)
    await h.client.send({ type: "user.submit", sessionId, text: "one", attachments: [] })
    await Bun.sleep(100)
    await h.graphAutopilot.idle(h.project)
    expect(h.scans).toHaveLength(40)
    for (const name of ["big1.ts", "big2.ts"]) writeFileSync(path.join(h.project, name), `export const ${name.slice(0, 4)} = 1\n${"// padding line of ordinary source code\n".repeat(500)}`)
    await h.client.send({ type: "user.submit", sessionId, text: "two", attachments: [] })
    // The three small edits still differ from the index, so the refresh scans them with the two large new files.
    await h.until(() => h.scans.length >= 45)
    expect(h.scans).toHaveLength(45)
    expect(h.logs.some((line) => line.includes("sees 5 of 40 files changed") && line.includes("bytes of code"))).toBe(true)
  })

  test("the home folder gets no build, however the session got there", async () => {
    const h = await boot()
    h.state.on = true
    writeFileSync(path.join(h.home, "notes.ts"), "export const secret = 1\n")
    const sessionId = await h.open(h.home)
    await h.client.send({ type: "user.submit", sessionId, text: "hello", attachments: [] })
    await Bun.sleep(100)
    await h.graphAutopilot.idle(h.home)
    expect(h.scans).toEqual([])
    expect(h.hub.get(h.home)).toMatchObject({ state: "skipped", reason: "home folder" })
  })
})
