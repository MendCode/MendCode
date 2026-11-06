import { describe, expect, test } from "bun:test"
import path from "node:path"
import { compare, noiseFrom, parseSmaps, parseVmmap, toMB, toMarkdown, toJson, verdict, SCHEMA_VERSION, type Flat, type Noise } from "./perf-attrib"

const PRELOAD = path.join(import.meta.dir, "perf-attrib-preload.ts")

describe("perf-attrib hook", () => {
  test("off: the preload registers nothing and costs no timer or handler", () => {
    const probe = `process.stdout.write(JSON.stringify({ usr2: process.listenerCount("SIGUSR2"), timers: process.getActiveResourcesInfo().filter((r) => r === "Timeout").length }))`
    const run = Bun.spawnSync([process.execPath, "--preload", PRELOAD, "-e", probe], { env: { PATH: process.env.PATH ?? "" } })
    expect(JSON.parse(run.stdout.toString())).toEqual({ usr2: 0, timers: 0 })
  })

  test("on: SIGUSR2 writes the heap by object type for the requested label", async () => {
    const dir = (await import("node:fs")).mkdtempSync(path.join((await import("node:os")).tmpdir(), "attrib-hook-"))
    await Bun.write(path.join(dir, "request"), "t-ready")
    const child = Bun.spawn([process.execPath, "--preload", PRELOAD, "-e", "console.log('ready'); setInterval(() => {}, 100)"], { env: { PATH: process.env.PATH ?? "", PERF_ATTRIB_DIR: dir }, stdout: "pipe" })
    await child.stdout.getReader().read()
    await Bun.sleep(200)
    process.kill(child.pid, "SIGUSR2")
    const file = Bun.file(path.join(dir, `${child.pid}-t-ready.json`))
    for (let i = 0; i < 60 && !(await file.exists()); i++) await Bun.sleep(50)
    child.kill()
    const dump = await Bun.file(path.join(dir, `${child.pid}-t-ready.json`)).json() as { heap: { heapSize: number; objectTypeCounts: Record<string, number> } }
    expect(dump.heap.heapSize).toBeGreaterThan(0)
    expect(Object.keys(dump.heap.objectTypeCounts).length).toBeGreaterThan(10)
  })

  test("the product has no hook of its own: nothing under apps or packages reads the dump variable", () => {
    const found = Bun.spawnSync(["/usr/bin/grep", "-rl", "PERF_ATTRIB_DIR", path.join(import.meta.dir, "../apps"), path.join(import.meta.dir, "../packages"), "--include=*.ts", "--exclude-dir=node_modules"]).stdout.toString().trim()
    expect(found).toBe("")
  })
})

describe("perf-attrib parsing", () => {
  test("sizes in vmmap units become MB", () => {
    expect(toMB("512.0M")).toBe(512)
    expect(toMB("2048K")).toBe(2)
    expect(toMB("1.5G")).toBe(1536)
    expect(toMB("0K")).toBe(0)
  })

  test("vmmap summary rows keep region names with spaces and sum dirty and swapped; reserved rows and the malloc zone table are dropped", () => {
    const text = [
      "REGION TYPE                        SIZE     SIZE     SIZE     SIZE     SIZE     SIZE     SIZE    COUNT (non-coalesced) ",
      "===========                     ======= ========    =====  ======= ========   ======    =====  ======= ",
      "JS JIT Generated Code            512.0M       0K       0K     176K       0K       0K       0K        3 ",
      "JS VM Reservations (reserved)     67.5G       0K       0K       0K       0K       0K       0K        2         reserved VM address space (unallocated)",
      "WebKit Malloc                    224.1M    2752K    2048K    1024K       0K       0K       0K        5 ",
      "TOTAL                            456.6G   113.5M    3969K    3328K       0K      16K       0K      372 ",
      "MALLOC ZONE                                  SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED  FRAG SIZE  % FRAG   COUNT",
      "DefaultMallocZone_0x108e18000               25.2M       256K       256K       496K        103       864K         0K      0%       9",
    ].join("\n")
    expect(parseVmmap(text)).toEqual({ JS_JIT_Generated_Code: 0.17, WebKit_Malloc: 3 })
  })

  test("smaps_rollup fields", () => {
    expect(parseSmaps("Pss:                2048 kB\nPrivate_Dirty:      1024 kB\nSwap:                  0 kB\n")).toEqual({ Pss: 2, Private_Dirty: 1, Swap: 0 })
  })
})

describe("perf-attrib verdict", () => {
  const noise: Noise = { schema: SCHEMA_VERSION, runs: 6, measuredAt: "2026-11-03", build: "x", range: { "total.ready.fp_mb": 1, "tui.rest.region.WebKit_Malloc": 0.5, "tui.rest.heap.type.Array": 10 } }
  const run = (extra: Flat = {}): Flat => ({ "total.ready.fp_mb": 60, "tui.rest.region.WebKit_Malloc": 20, "tui.rest.heap.type.Array": 1000, ...extra })

  test("a difference inside the measured noise is the same, and the verdict is igual", () => {
    const rows = compare([run(), run({ "total.ready.fp_mb": 60.5 })], [run({ "total.ready.fp_mb": 60.8 }), run()], noise)
    expect(rows.every((row) => row.status === "same")).toBe(true)
    expect(verdict(rows).word).toBe("igual")
  })

  test("a rise beyond the noise is up, names the region that explains it and exits as a finding", () => {
    const rows = compare([run()], [run({ "total.ready.fp_mb": 63, "tui.rest.region.WebKit_Malloc": 22.5 })], noise)
    const v = verdict(rows)
    expect(v.word).toBe("sube")
    expect(v.text).toContain("tui.rest.region.WebKit_Malloc")
  })

  test("a drop beyond the noise is baja, never a finding", () => {
    expect(verdict(compare([run()], [run({ "total.ready.fp_mb": 57 })], noise)).word).toBe("baja")
  })

  test("calibration keeps the widest spread of any build", () => {
    expect(noiseFrom([[run(), run({ "total.ready.fp_mb": 61 })], [run(), run({ "total.ready.fp_mb": 62 })]])["total.ready.fp_mb"]).toBe(2)
  })

  test("json is versioned and markdown carries the verdict", () => {
    const rows = compare([run()], [run({ "total.ready.fp_mb": 63 })], noise)
    const json = toJson({ base: "a", cand: "b", rounds: 1, rows, noise, extra: {} })
    expect(json.schema).toBe(SCHEMA_VERSION)
    expect(json.metrics["total.ready.fp_mb"]).toMatchObject({ base: 60, cand: 63, status: "up" })
    expect(toMarkdown({ base: "a", cand: "b", rounds: 1, rows, noise })).toContain("**perf-attrib: sube")
  })
})
