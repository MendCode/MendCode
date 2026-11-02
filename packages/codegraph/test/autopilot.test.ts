import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUTOPILOT, createGraphAutopilot, systemFolder, type GraphAutopilot } from "../src/autopilot"
import { createIndexGate } from "../src/index-gate"
import { createIndexer } from "../src/indexer"
import { createCodeGraphTools } from "../src/tools"

const root = mkdtempSync(join(tmpdir(), "mcev-autopilot-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const home = join(root, "home")
let counter = 0

/** A git project under the fake home with `files` TypeScript sources. */
function project({ files, git = true }: { files: number; git?: boolean }) {
  const dir = join(home, `app${counter++}`)
  mkdirSync(dir, { recursive: true })
  if (git) mkdirSync(join(dir, ".git"))
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.ts`), `export function fn${i}() { return ${i} }\n`)
  return dir
}

function rig({ maxFiles = 50, enabled = () => true, wait = 3_000, checkGap = 0 }: { maxFiles?: number; enabled?: () => boolean; wait?: number; checkGap?: number } = {}) {
  const scans: string[] = []
  const logs: string[] = []
  const statuses: Array<{ state: string; percent?: number | undefined }> = []
  const cacheDir = mkdtempSync(join(root, "cache-"))
  const indexer = createIndexer({ cacheDir, now: Date.now, onScan: (path) => scans.push(path), onIndex: (status) => statuses.push({ state: status.state, percent: status.percent }), onProgress: (status) => statuses.push({ state: status.state, percent: status.percent }) })
  const gate = createIndexGate({ home, maxFiles })
  const autopilot = createGraphAutopilot({ indexer, gate: (cwd, signal) => gate.check({ cwd, mode: "auto", signal }), enabled, log: (line) => logs.push(line), wait, checkGap })
  return { indexer, autopilot, scans, logs, statuses, cacheDir, gate }
}

const settle = async (autopilot: GraphAutopilot, cwd: string) => {
  await autopilot.idle(cwd)
  await Bun.sleep(5)
  await autopilot.idle(cwd)
}

describe("where the autopilot never builds", () => {
  test("the filesystem root, operating system folders and dependency folders are not projects", () => {
    expect(systemFolder("/")).toBe("system folder")
    for (const dir of ["/usr", "/usr/local/src/app", "/etc/nginx", "/System/Library", "/Library/Foo", "/bin"]) expect(systemFolder(dir)).toBe("system folder")
    expect(systemFolder("/work/app/node_modules/left-pad")).toBe("dependency folder")
    expect(systemFolder("/work/app")).toBeUndefined()
    expect(systemFolder("/private/tmp/scratch/app")).toBeUndefined()
  })

  test("the home folder, a folder above it, a folder with no repository and an oversize project get no build", async () => {
    const { autopilot, indexer, logs } = rig({ maxFiles: 10 })
    const big = project({ files: 12 })
    const plain = join(home, "notes")
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, "a.ts"), "export const a = 1\n")
    for (const dir of [home, root, "/", "/usr", plain, big]) {
      autopilot.note({ cwd: dir, reason: "turn" })
      await settle(autopilot, dir)
      expect(autopilot.state(dir)).toBe("none")
      expect(indexer.peek(dir)).toBeUndefined()
      expect(existsSync(indexer.cachePath(dir))).toBe(false)
    }
    // Each decision is logged once, with its reason.
    expect(logs.some((line) => line.includes("[GRAPH]") && line.includes("skips (large folder)") && line.includes(big))).toBe(true)
    expect(logs.some((line) => line.includes("skips (home folder)"))).toBe(true)
    expect(logs.some((line) => line.includes("skips (system folder)"))).toBe(true)
  })

  test("a lookup in such a folder is answered by the gate and builds nothing", async () => {
    const { autopilot, indexer } = rig({ maxFiles: 10 })
    const big = project({ files: 12 })
    const gate = createIndexGate({ home, maxFiles: 10 })
    const tools = createCodeGraphTools({ cacheDir: "unused", indexer, autopilot, gate: (cwd, signal) => gate.check({ cwd, mode: "auto", signal }) })
    const find = tools.find((tool) => tool.name === "graph_find")!
    const result = await find.execute(find.args.parse({ query: "fn1" }), { cwd: big, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("too large")
    expect(indexer.peek(big)).toBeUndefined()
  })
})

describe("the build starts by itself", () => {
  test("a turn in a git project with no graph builds it in the background, once, and the feature switch gates it", async () => {
    let on = false
    const { autopilot, indexer, scans, logs, statuses } = rig({ enabled: () => on })
    const dir = project({ files: 6 })
    autopilot.note({ cwd: dir, reason: "turn" })
    await Bun.sleep(50)
    expect(autopilot.state(dir)).toBe("none")
    expect(scans).toEqual([])
    on = true
    autopilot.note({ cwd: dir, reason: "turn" })
    autopilot.note({ cwd: dir, reason: "turn" })
    await settle(autopilot, dir)
    expect(indexer.peek(dir)?.files.size).toBe(6)
    expect(scans).toHaveLength(6)
    expect(existsSync(indexer.cachePath(dir))).toBe(true)
    // One "indexing" at the start, at most nine progress steps, then "indexed".
    expect(statuses[0]).toEqual({ state: "indexing", percent: undefined })
    expect(statuses.at(-1)?.state).toBe("indexed")
    expect(statuses.length).toBeLessThanOrEqual(11)
    expect(logs.filter((line) => line.includes("builds the code graph"))).toHaveLength(1)
    expect(autopilot.state(dir)).toBe("idle")
  })

  test("a first build reports its progress in steps of ten and never one event per file", async () => {
    const { autopilot, statuses, indexer } = rig({ maxFiles: 100 })
    const dir = project({ files: 40 })
    autopilot.note({ cwd: dir, reason: "session" })
    await settle(autopilot, dir)
    const percents = statuses.filter((status) => status.state === "indexing").map((status) => status.percent)
    expect(percents[0]).toBeUndefined()
    expect(percents.slice(1).every((percent) => percent !== undefined && percent % 10 === 0 && percent < 100)).toBe(true)
    expect(percents.length).toBeLessThanOrEqual(10)
    expect(indexer.peek(dir)?.files.size).toBe(40)
  })

  test("a build can be cancelled: turning the feature off aborts it and leaves no graph", async () => {
    let on = true
    const { autopilot, indexer } = rig({ enabled: () => on, maxFiles: 5_000 })
    const dir = project({ files: 1_500 })
    autopilot.note({ cwd: dir, reason: "turn" })
    await Bun.sleep(5)
    on = false
    autopilot.reconsider()
    await settle(autopilot, dir)
    expect(["none", "idle"]).toContain(autopilot.state(dir))
    if (autopilot.state(dir) === "none") expect(indexer.peek(dir)).toBeUndefined()
  })
})

describe("a lookup on a missing graph", () => {
  test("builds it and answers from it when it is ready within the wait", async () => {
    const { autopilot, indexer, logs } = rig()
    const dir = project({ files: 5 })
    const tools = createCodeGraphTools({ cacheDir: "unused", indexer, autopilot })
    const find = tools.find((tool) => tool.name === "graph_find")!
    const result = await find.execute(find.args.parse({ query: "fn3" }), { cwd: dir, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.output).toContain("fn3")
    expect(logs.some((line) => line.includes("builds the code graph"))).toBe(true)
  })

  test("says the graph is building, with progress and what to do, when it is not ready in time; a later call answers", async () => {
    const { autopilot, indexer } = rig({ maxFiles: 5_000, wait: 1 })
    const dir = project({ files: 1_200 })
    const tools = createCodeGraphTools({ cacheDir: "unused", indexer, autopilot })
    const find = tools.find((tool) => tool.name === "graph_find")!
    const first = await find.execute(find.args.parse({ query: "fn7" }), { cwd: dir, signal: new AbortController().signal })
    expect(first.isError).toBe(false)
    expect(first.output).toContain("no code graph")
    expect(first.output).toContain("started building it in the background")
    expect(first.output).toMatch(/use grep, glob and read/i)
    expect(first.output).toContain("again")
    expect(first.meta).toMatchObject({ graph: "building" })
    const second = await find.execute(find.args.parse({ query: "fn7" }), { cwd: dir, signal: new AbortController().signal })
    // Still building (or just done): never a silent failure, never a second build.
    if (second.meta?.graph === "building") expect(second.output).toContain("still building")
    await settle(autopilot, dir)
    const third = await find.execute(find.args.parse({ query: "fn7" }), { cwd: dir, signal: new AbortController().signal })
    expect(third.output).toContain("fn7")
    expect(indexer.peek(dir)?.files.size).toBe(1_200)
  })

  test("graph_impact on a missing graph starts the build and says so instead of 'no cached orientation'", async () => {
    const { autopilot, indexer } = rig({ maxFiles: 5_000, wait: 1 })
    const dir = project({ files: 1_200 })
    const impact = createCodeGraphTools({ cacheDir: "unused", indexer, autopilot }).find((tool) => tool.name === "graph_impact")!
    const result = await impact.execute(impact.args.parse({ path: "f1.ts" }), { cwd: dir, signal: new AbortController().signal })
    expect(result.output).toContain("building")
    await settle(autopilot, dir)
  })

  test("without the autopilot (feature off) a lookup builds the graph itself, as before", async () => {
    const { indexer } = rig()
    const dir = project({ files: 3 })
    const find = createCodeGraphTools({ cacheDir: "unused", indexer }).find((tool) => tool.name === "graph_find")!
    const result = await find.execute(find.args.parse({ query: "fn1" }), { cwd: dir, signal: new AbortController().signal })
    expect(result.output).toContain("fn1")
    const off = rig({ enabled: () => false })
    const other = project({ files: 3 })
    const offFind = createCodeGraphTools({ cacheDir: "unused", indexer: off.indexer, autopilot: off.autopilot }).find((tool) => tool.name === "graph_find")!
    expect((await offFind.execute(offFind.args.parse({ query: "fn1" }), { cwd: other, signal: new AbortController().signal })).output).toContain("fn1")
  })
})

describe("keeping it fresh", () => {
  const touch = (dir: string, names: string[], stamp: number) => {
    for (const name of names) {
      writeFileSync(join(dir, name), `export function changed_${stamp}_${name.replace(/\W/g, "")}() { return ${stamp} }\n`)
      utimesSync(join(dir, name), stamp, stamp)
    }
  }

  test("drift below the threshold changes nothing; at the threshold the autopilot refreshes only the changed files", async () => {
    const { autopilot, indexer, scans, logs } = rig({ maxFiles: 500 })
    const dir = project({ files: 40 })
    autopilot.note({ cwd: dir, reason: "session" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(40)
    // 40 indexed files: the threshold is max(10, ceil(3%)) = 10.
    expect(AUTOPILOT.REFRESH_MIN_FILES).toBe(10)
    touch(dir, Array.from({ length: 9 }, (_, i) => `f${i}.ts`), 1_000_000)
    autopilot.note({ cwd: dir, reason: "turn" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(40)
    expect(Object.keys(indexer.peek(dir)!.byPath.get("f0.ts") ?? []).length).toBeGreaterThan(0)
    expect(indexer.peek(dir)!.nodes.some((node) => node.name.startsWith("changed_"))).toBe(false)

    touch(dir, Array.from({ length: 10 }, (_, i) => `f${i}.ts`), 2_000_000)
    autopilot.note({ cwd: dir, reason: "turn" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(50)
    expect(indexer.peek(dir)!.nodes.filter((node) => node.name.startsWith("changed_"))).toHaveLength(10)
    expect(logs.some((line) => line.includes("sees 10 of 40 files changed (threshold 10)"))).toBe(true)
  })

  test("new files count as drift, and a large project's threshold is 3% of its files", async () => {
    const { autopilot, indexer, scans } = rig({ maxFiles: 2_000 })
    const dir = project({ files: 500 })
    autopilot.note({ cwd: dir, reason: "session" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(500)
    // ceil(3% of 500) = 15: fourteen new files wait, the fifteenth makes the refresh.
    for (let i = 0; i < 14; i++) writeFileSync(join(dir, `new${i}.ts`), `export const n${i} = ${i}\n`)
    autopilot.note({ cwd: dir, reason: "turn" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(500)
    writeFileSync(join(dir, "new14.ts"), "export const n14 = 14\n")
    autopilot.note({ cwd: dir, reason: "turn" })
    await settle(autopilot, dir)
    expect(scans).toHaveLength(515)
    expect(indexer.peek(dir)!.files.size).toBe(515)
  })

  test("the disk is looked at no more than once per interval, however many turns begin", async () => {
    const { autopilot, indexer, scans } = rig({ maxFiles: 500, checkGap: 60_000 })
    const dir = project({ files: 20 })
    autopilot.note({ cwd: dir, reason: "session" })
    await settle(autopilot, dir)
    let walks = 0
    const drift = indexer.drift.bind(indexer)
    indexer.drift = (args) => { walks++; return drift(args) }
    touch(dir, Array.from({ length: 12 }, (_, i) => `f${i}.ts`), 3_000_000)
    for (let i = 0; i < 5; i++) { autopilot.note({ cwd: dir, reason: "turn" }); await Bun.sleep(10) }
    await settle(autopilot, dir)
    // The build set the interval's clock; five turns inside it look at nothing.
    expect(walks).toBe(0)
    expect(scans).toHaveLength(20)
  })
})
