import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { compiledTarget, measureCliStartup, measureScenario, seedDataDir, summary } from "./perf"
import { PERF_BUDGETS, soloViolations, violations, type FrameStats, type PerfResult, type SoloPerfResult } from "./perf-budgets"
import { timeScale } from "./test-budget"
import { parsePsTime, processStats, spread } from "./perf-proc"
import { summarize } from "./perf-real"
import { compare, flatten, table } from "./perf-ab"

const frame = (p95: number): FrameStats => ({ samples: 10, p50: p95 / 2, p95, max: p95 * 2 })
function result(messages: number, patch: Partial<PerfResult> = {}): PerfResult {
  return {
    messages,
    daemon: { rssIdleMB: 120, rssWithClientMB: 140, readyMs: 300 },
    startupMs: { import: 20, firstFrame: 120 },
    rssMB: { boot: 42, imported: 56, idle: 70, scrolledUp: 120, afterStream: 130 },
    heapMB: { idle: 8, scrolledUp: 15, afterStream: 15 },
    frameMs: { idle: frame(1), scrollUp: frame(2), scrollDown: frame(1), stream: frame(3) },
    screenBytes: 1000,
    ...patch,
  }
}

describe("performance budget rules", () => {
  test("a run inside every budget has no violations", () => {
    expect(violations([result(0), result(1000), result(10_000)], 150)).toEqual([])
  })

  test("each kind of regression is named", () => {
    const slowStream = result(1000, { frameMs: { idle: frame(1), scrollUp: frame(2), scrollDown: frame(1), stream: frame(PERF_BUDGETS.frameP95Ms.stream + 1) } })
    expect(violations([slowStream])).toEqual([expect.stringContaining("stream frame p95")])
    expect(violations([result(0, { daemon: { rssIdleMB: 400, rssWithClientMB: 400, readyMs: 300 } })])).toHaveLength(2)
    expect(violations([result(0, { rssMB: { boot: 42, imported: 56, idle: 300, scrolledUp: 320, afterStream: 330 } })])).toHaveLength(2)
    expect(violations([result(0)], PERF_BUDGETS.startupMs.cliHelp + 1)).toEqual([expect.stringContaining("cli help")])
  })

  test("memory that grows with the history is a violation even when each size is inside its absolute budget", () => {
    const small = result(0, { rssMB: { boot: 42, imported: 56, idle: 60, scrolledUp: 120, afterStream: 130 }, daemon: { rssIdleMB: 110, rssWithClientMB: 120, readyMs: 300 } })
    const grown = result(10_000, { rssMB: { boot: 42, imported: 56, idle: 60 + PERF_BUDGETS.growthWith10kMessagesMB.client + 1, scrolledUp: 120, afterStream: 130 }, daemon: { rssIdleMB: 110, rssWithClientMB: 120 + PERF_BUDGETS.growthWith10kMessagesMB.daemon + 1, readyMs: 300 } })
    expect(violations([small, grown])).toEqual([expect.stringContaining("client idle RSS growth"), expect.stringContaining("daemon RSS growth")])
    // The growth rule needs both ends of the comparison.
    expect(violations([grown])).toEqual([])
  })

  test("a time scale loosens the time budgets and never the memory or growth budgets", () => {
    const slowStream = result(1000, { frameMs: { idle: frame(1), scrollUp: frame(2), scrollDown: frame(1), stream: frame(PERF_BUDGETS.frameP95Ms.stream * 2) } })
    expect(violations([slowStream])).toHaveLength(1)
    expect(violations([slowStream], undefined, 3)).toEqual([])
    expect(violations([slowStream], undefined, 1.5)).toHaveLength(1)
    expect(violations([result(0)], PERF_BUDGETS.startupMs.cliHelp * 2, 3)).toEqual([])
    expect(violations([result(0, { startupMs: { import: PERF_BUDGETS.startupMs.import * 2, firstFrame: 120 } })], undefined, 3)).toEqual([])
    expect(violations([result(0, { daemon: { rssIdleMB: 400, rssWithClientMB: 400, readyMs: 300 } })], undefined, 100)).toHaveLength(2)
    expect(violations([result(0, { rssMB: { boot: 42, imported: 56, idle: 300, scrolledUp: 320, afterStream: 330 } })], undefined, 100)).toHaveLength(2)
    const small = result(0, { rssMB: { boot: 42, imported: 56, idle: 60, scrolledUp: 120, afterStream: 130 } })
    const grown = result(10_000, { rssMB: { boot: 42, imported: 56, idle: 60 + PERF_BUDGETS.growthWith10kMessagesMB.client + 1, scrolledUp: 120, afterStream: 130 } })
    expect(violations([small, grown], undefined, 100)).toEqual([expect.stringContaining("client idle RSS growth")])
  })

  test("the solo budgets scale the same way", () => {
    const solo = (stream: number, rss: number): SoloPerfResult => ({
      messages: 1000,
      startupMs: { import: 20, firstFrame: 120, hosted: 90 },
      rssMB: { boot: 40, imported: 56, hosted: 100, idle: rss, scrolledUp: 200, afterStream: 210 },
      heapMB: { idle: 8, scrolledUp: 15, afterStream: 15 },
      frameMs: { idle: frame(1), scrollUp: frame(2), scrollDown: frame(1), stream: frame(stream) },
      screenBytes: 1000,
    })
    expect(soloViolations([solo(60, 100)])).toHaveLength(1)
    expect(soloViolations([solo(60, 100)], 3)).toEqual([])
    expect(soloViolations([solo(1, 1000)], 100)).toHaveLength(1)
  })

  test("the human summary has a row per scenario", () => {
    expect(summary([result(0), result(1000)], 150).split("\n")).toHaveLength(4)
  })
})

describe("process readings", () => {
  test("reads this process: memory, CPU time that grows with work, and the footprint where the platform has one", () => {
    const first = processStats(process.pid)!
    expect(first.rssMB).toBeGreaterThan(5)
    if (process.platform === "darwin") {
      expect(first.footprintMB).toBeGreaterThan(1)
      expect(first.peakFootprintMB).toBeGreaterThanOrEqual(first.footprintMB!)
    }
    const until = performance.now() + 30
    while (performance.now() < until) Math.sqrt(Math.random())
    expect(processStats(process.pid)!.cpuMs).toBeGreaterThan(first.cpuMs)
  })

  test("a process that is gone reads as undefined", () => {
    expect(processStats(2 ** 22 + 12345)).toBeUndefined()
  })

  test("ps time fields convert to milliseconds, with and without hours and days", () => {
    expect(parsePsTime("0:01.50")).toBe(1500)
    expect(parsePsTime("2:03.25")).toBe(123_250)
    expect(parsePsTime("1:00:00.00")).toBe(3_600_000)
    expect(parsePsTime("1-00:00:01")).toBe(86_401_000)
  })

  test("the median is the lower middle and the range is kept", () => {
    expect(spread([5, 1, 3])).toEqual({ median: 3, min: 1, max: 5 })
    expect(spread([4, 1, 2, 3])).toEqual({ median: 2, min: 1, max: 4 })
  })

  test("a real-CLI run is summarized per metric over its runs", () => {
    const run = (ready: number) => ({ startupMs: { firstFrame: 100, ready }, exitMs: 10 }) as never
    expect(summarize([run(120), run(100), run(110)])["startupMs.ready"]).toEqual({ median: 110, min: 100, max: 120 })
  })
})

describe("A/B comparison", () => {
  test("flattens nested numbers to dotted paths and compares medians against the base range", () => {
    expect(flatten({ a: { b: 1, c: [2, { d: 3 }] }, e: "x" })).toEqual({ "a.b": 1, "a.c[0]": 2, "a.c[1].d": 3 })
    const base = [10, 11, 12, 10, 11].map((rss) => ({ rss, cpu: 5 }))
    const candidate = [14, 15, 13, 14, 16].map((rss) => ({ rss, cpu: 4 }))
    const rows = compare(base, candidate)
    expect(rows.find((row) => row.key === "rss")).toMatchObject({ a: { median: 11, min: 10, max: 12 }, b: { median: 14 }, worse: true, better: false })
    expect(rows.find((row) => row.key === "cpu")).toMatchObject({ better: true, worse: false, changePct: -20 })
    expect(table(rows)).toContain("WORSE")
  })

  test("a candidate inside the base range is neither better nor worse", () => {
    const rows = compare([{ x: 10 }, { x: 14 }, { x: 12 }], [{ x: 13 }, { x: 11 }, { x: 12 }])
    expect(rows[0]).toMatchObject({ worse: false, better: false })
  })
})

describe("benchmark seeding", () => {
  test("writes the requested number of finished messages through the real store", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-perf-seed-"))
    try {
      const directory = path.join(dir, "project")
      mkdirSync(directory)
      const { sessionId, lastSeq } = seedDataDir({ dir, directory, messages: 40 })
      const store = openStore({ dir })
      const completed = store.readAfter(sessionId, 0, 1000).filter((event) => event.type === "item.completed")
      expect(completed).toHaveLength(40)
      expect(store.lastSeq(sessionId)).toBe(lastSeq)
      store.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/**
 * The measured budgets: the compiled binary, a real daemon on the faux engine (offline, throwaway HOME) and the terminal
 * client scrolling and streaming through sessions of 0, 1,000 and 10,000 messages. Skipped on Windows, which has no `ps`.
 */
const measured = process.platform === "win32" ? describe.skip : describe
measured("performance budgets of the compiled binary", () => {
  const buildDir = mkdtempSync(path.join(tmpdir(), "mend-perf-test-"))
  afterAll(() => rmSync(buildDir, { recursive: true, force: true }))

  test("memory, start-up and frame times stay inside their budgets for 0, 1,000 and 10,000 messages", async () => {
    const target = await compiledTarget(buildDir)
    const results: PerfResult[] = []
    for (const size of [0, 1000, 10_000]) results.push(await measureScenario(target, size))
    const cliHelpMs = await measureCliStartup(target, 3)
    // MENDCODE_TEST_TIME_SCALE (set by the CI workflow only) loosens the time budgets; every memory and growth budget stays exact.
    expect(violations(results, cliHelpMs, timeScale()), summary(results, cliHelpMs)).toEqual([])
  }, 240_000 * timeScale())
})
