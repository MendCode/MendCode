import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { compiledTarget, measureCliStartup, measureScenario, seedDataDir, summary } from "./perf"
import { PERF_BUDGETS, soloViolations, violations, type FrameStats, type PerfResult, type SoloPerfResult } from "./perf-budgets"
import { timeScale } from "./test-budget"

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
