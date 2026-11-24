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

  test("an inner rise (heap counts, binary) with no total above the noise is a nota, never a finding", () => {
    const measured: Noise = { ...noise, range: { ...noise.range, "tui.after.heap.protected": 0, "tui.after.heap.objects": 300, "binary.bytes": 0, "tui.cpu_ms.after": 400 } }
    const inner = { "tui.after.heap.protected": 19, "tui.after.heap.objects": 239_842, "binary.bytes": 60_000_000 }
    const rows = compare([run(inner)], [run({ "tui.after.heap.protected": 20, "tui.after.heap.objects": 240_600, "binary.bytes": 60_049_000, "total.ready.fp_mb": 59.7 })], measured)
    const v = verdict(rows)
    expect(v.word).toBe("nota")
    expect(v.text).toContain("tui.after.heap.protected +1")
    // The same inner rise with the footprint up is a sube.
    expect(verdict(compare([run(inner)], [run({ "tui.after.heap.protected": 20, "total.ready.fp_mb": 63 })], noise)).word).toBe("sube")
    // CPU and the bytes a session stores count as totals.
    expect(verdict(compare([run({ "tui.cpu_ms.after": 8000 })], [run({ "tui.cpu_ms.after": 12_000 })], noise)).word).toBe("sube")
    expect(verdict(compare([run({ "disk.bytes_per_session": 2600 })], [run({ "disk.bytes_per_session": 9000 })], noise)).word).toBe("sube")
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

describe("perf-attrib trustworthy flags", () => {
  const noise: Noise = { schema: SCHEMA_VERSION, runs: 18, measuredAt: "2026-11-07", build: "x", range: { "tui.rest.fp_mb": 1.2, "tui.cpu_ms.rest": 139, "tui.cpu_ms.after": 1029, "disk.bytes_per_session": 17 } }
  const runs = (name: string, values: number[], extra: Flat = {}): Flat[] => values.map((value) => ({ [name]: value, ...extra }))
  const same = [350, 360, 355, 350, 352]

  test("one outlier sample on either side moves no median and flags nothing", () => {
    expect(verdict(compare(runs("tui.rest.fp_mb", [63, 63, 63, 63, 63]), runs("tui.rest.fp_mb", [63, 71, 63, 63, 63]), noise)).word).toBe("igual")
    expect(verdict(compare(runs("tui.rest.fp_mb", [63, 70, 63, 63, 63]), runs("tui.rest.fp_mb", [63, 63, 63, 63, 63]), noise)).word).toBe("igual")
    expect(verdict(compare(runs("tui.cpu_ms.after", [1800, 1840, 1800, 1830, 1810]), runs("tui.cpu_ms.after", [1820, 5200, 1800, 1790, 1815]), noise)).word).toBe("igual")
  })

  test("a sustained rise above the base's range and the floor is a sube", () => {
    expect(verdict(compare(runs("tui.rest.fp_mb", [63, 63, 63, 63, 63]), runs("tui.rest.fp_mb", [67, 67, 66.5, 67, 67.5]), noise)).word).toBe("sube")
    expect(verdict(compare(runs("tui.cpu_ms.rest", same), runs("tui.cpu_ms.rest", [1500, 1480, 1510, 1490, 1500]), noise)).word).toBe("sube")
    expect(verdict(compare(runs("disk.bytes_per_session", [2600, 2610, 2600, 2605, 2600]), runs("disk.bytes_per_session", [4700, 4700, 4710, 4700, 4690]), noise)).word).toBe("sube")
  })

  test("a median inside the base's own min..max, or under the floor, is the same however consistent", () => {
    // 64 against a base that itself ranged 60..66: the cand never left the base's range.
    expect(verdict(compare(runs("tui.rest.fp_mb", [60, 66, 62, 66, 60]), runs("tui.rest.fp_mb", [64, 64, 64, 64, 64]), noise)).word).toBe("igual")
    // +2 MB, +100 ms, +76 B: above the base's range but under each floor.
    expect(verdict(compare(runs("tui.rest.fp_mb", [63, 63, 63, 63, 63]), runs("tui.rest.fp_mb", [65, 65, 65, 65, 65]), noise)).word).toBe("igual")
    expect(verdict(compare(runs("tui.cpu_ms.rest", same), runs("tui.cpu_ms.rest", [450, 452, 455, 450, 451]), noise)).word).toBe("igual")
    expect(verdict(compare(runs("disk.bytes_per_session", [2600, 2600, 2600, 2600, 2600]), runs("disk.bytes_per_session", [2676, 2676, 2676, 2676, 2676]), noise)).word).toBe("igual")
  })

  test("the CPU floor is 15% of the base when that is larger than 150 ms", () => {
    const base = runs("tui.cpu_ms.after", [8000, 8010, 8000, 8005, 8000])
    // Between the 15% floor (1200 ms) and 1.5 times the calibrated range (1543 ms) of this phase: the larger one decides.
    expect(compare(base, runs("tui.cpu_ms.after", [9400, 9400, 9400, 9400, 9400]), noise)[0]!.status).toBe("same")
    expect(compare(base, runs("tui.cpu_ms.after", [9800, 9800, 9800, 9800, 9800]), noise)[0]!.status).toBe("up")
    const quiet: Noise = { ...noise, range: { ...noise.range, "tui.cpu_ms.after": 10 } }
    expect(compare(base, runs("tui.cpu_ms.after", [9100, 9100, 9100, 9100, 9100]), quiet)[0]!.status).toBe("same")
    expect(compare(base, runs("tui.cpu_ms.after", [9250, 9250, 9250, 9250, 9250]), quiet)[0]!.status).toBe("up")
  })

  test("a rise whose causes are orders of magnitude smaller is possible noise, not a finding", () => {
    const base = runs("tui.rest.fp_mb", [63, 63, 63, 63, 63], { "tui.rest.ctor.Blob.bytes": 1000 })
    const rows = compare(base, runs("tui.rest.fp_mb", [68.8, 68.8, 68.8, 68.8, 68.8], { "tui.rest.ctor.Blob.bytes": 11000 }), noise)
    expect(rows.find((row) => row.name === "tui.rest.fp_mb")!.status).toBe("up")
    const v = verdict(rows)
    expect(v.word).toBe("nota")
    expect(v.text).toContain("possible noise")
  })

  test("a rise that its causes explain stays a sube", () => {
    const rows = compare(runs("tui.rest.fp_mb", [63, 63, 63, 63, 63], { "tui.rest.region.WebKit_Malloc": 20 }), runs("tui.rest.fp_mb", [68, 68, 68, 68, 68], { "tui.rest.region.WebKit_Malloc": 24 }), noise)
    expect(verdict(rows).word).toBe("sube")
  })

  test("CPU with a few KB of cause and the same start-up modules is possible noise; with changed modules it is a sube", () => {
    const rows = compare(runs("tui.cpu_ms.rest", same, { "tui.rest.ctor.ModuleRecord.bytes": 2000 }), runs("tui.cpu_ms.rest", [1480, 1490, 1500, 1485, 1495], { "tui.rest.ctor.ModuleRecord.bytes": 12000 }), noise)
    const unchanged = { baseCount: 300, candCount: 300, baseBytes: 9_000_000, candBytes: 9_000_000, addedChunkSizes: [], removedChunkSizes: [] }
    expect(verdict(rows, unchanged).word).toBe("nota")
    expect(verdict(rows, { ...unchanged, candBytes: 9_040_000, addedChunkSizes: [40_000] }).word).toBe("sube")
    expect(verdict(rows).word).toBe("sube")
  })
})
