import { describe, expect, test } from "bun:test"
import { buildReport, notComparableNotes, renderReport } from "../lib/report"
import { median, percentile, present, ratio, sum } from "../lib/stats"
import { emptyUsage, type RunRecord, type Usage } from "../lib/types"

function record(over: Partial<Omit<RunRecord, "usage">> & { usage?: Partial<Usage> }): RunRecord {
  const { usage, ...rest } = over
  const solved = rest.solved ?? true
  return {
    harness: "mendcode", model: "m", effort: "medium", taskId: "t1", category: "bugfix", repeat: 1, startedAt: "2026-10-06T00:00:00Z",
    wallMs: 10_000, agentMs: 10_000, timedOut: false, exitCode: 0, solved, outcome: solved ? "solved" : "failed",
    check: { exitCode: solved ? 0 : 1, timedOut: false, durationMs: 1, logTail: "" },
    usage: { ...emptyUsage(), ...usage }, diff: { filesChanged: 1, insertions: 1, deletions: 1 }, transcript: null, notes: [], ...rest,
  }
}

describe("statistics", () => {
  test("median of odd and even samples", () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  test("nulls are skipped, never counted as zero", () => {
    expect(median([null, 10, null, 20])).toBe(15)
    expect(sum([null, 1, undefined, 2])).toBe(3)
    expect(present([null, NaN, 1])).toEqual([1])
  })
  test("empty input has no statistic", () => {
    expect(median([])).toBeNull()
    expect(median([null])).toBeNull()
    expect(percentile([], 90)).toBeNull()
    expect(sum([null])).toBeNull()
  })
  test("p90 is nearest rank", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(ten, 90)).toBe(9)
    expect(percentile(ten, 100)).toBe(10)
    expect(percentile(ten, 50)).toBe(5)
    expect(percentile([7], 90)).toBe(7)
    expect(percentile([1, 2, 3, 4, 100], 90)).toBe(100)
  })
  test("ratio guards against zero and missing values", () => {
    expect(ratio(1, 2)).toBe(0.5)
    expect(ratio(1, 0)).toBeNull()
    expect(ratio(null, 2)).toBeNull()
  })
})

describe("report math", () => {
  const mend = [
    record({ taskId: "a", repeat: 1, usage: { inputTokens: 1000, cachedReadTokens: 500, outputTokens: 100, toolCalls: 4, failedToolCalls: 1, compactions: 0 } }),
    record({ taskId: "a", repeat: 2, usage: { inputTokens: 3000, cachedReadTokens: 2400, outputTokens: 300, toolCalls: 6, failedToolCalls: 0, compactions: 1 }, agentMs: 30_000 }),
    record({ taskId: "b", category: "feature", solved: false, usage: { inputTokens: 2000, cachedReadTokens: 1000, outputTokens: 200, toolCalls: 5, failedToolCalls: 2, compactions: 0 } }),
  ]

  test("solved counts, per-category counts and medians", () => {
    const [harness] = buildReport(mend).models[0]!.harnesses
    expect(harness!.runs).toBe(3)
    expect(harness!.solved).toBe(2)
    expect(harness!.byCategory).toEqual({ bugfix: { solved: 2, total: 2 }, feature: { solved: 0, total: 1 } })
    expect(harness!.all.inputTokens).toEqual({ n: 3, median: 2000, p90: 3000 })
    expect(harness!.all.toolCalls.median).toBe(5)
    expect(harness!.all.wallSeconds.median).toBe(10)
    expect(harness!.solvedOnly.inputTokens.median).toBe(2000)
    expect(harness!.solvedOnly.outputTokens.median).toBe(200)
  })

  test("cache hit is aggregate (sum of cached / sum of input) and per-run median", () => {
    const [harness] = buildReport(mend).models[0]!.harnesses
    // (500 + 2400 + 1000) / (1000 + 3000 + 2000)
    expect(harness!.cache.aggregatePct).toBeCloseTo((3900 / 6000) * 100, 6)
    // per run: 50%, 80%, 50%
    expect(harness!.cache.medianPct).toBe(50)
    expect(harness!.cache.n).toBe(3)
  })

  test("per-task outcomes are listed per repeat in order", () => {
    const rows = buildReport(mend).models[0]!.tasks
    expect(rows.find((row) => row.taskId === "a")!.outcomes.mendcode).toBe("SS")
    expect(rows.find((row) => row.taskId === "b")!.outcomes.mendcode).toBe("F")
    expect(rows.find((row) => row.taskId === "a")!.medianInputTokens.mendcode).toBe(2000)
  })

  test("a run whose harness errored has no duration and no tokens", () => {
    const broken = record({ outcome: "error", solved: false, agentMs: 0, exitCode: null })
    const [harness] = buildReport([broken]).models[0]!.harnesses
    expect(harness!.harnessErrors).toBe(1)
    expect(harness!.all.wallSeconds.n).toBe(0)
    expect(harness!.all.inputTokens.n).toBe(0)
  })

  test("a paired comparison needs both harnesses to solve the same task", () => {
    const codex = [
      record({ harness: "codex", taskId: "a", usage: { inputTokens: 4000, outputTokens: 400 } }),
      record({ harness: "codex", taskId: "b", category: "feature", solved: false, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]
    const model = buildReport([...mend, ...codex]).models[0]!
    expect(model.paired?.tasks).toBe(1)
    // mendcode median input for task a is 2000 (1000 and 3000), codex 4000
    expect(model.paired?.medianInputRatio).toBe(0.5)
    expect(model.paired?.medianOutputRatio).toBe(0.5)
  })

  test("models are reported separately", () => {
    const report = buildReport([record({ model: "luna" }), record({ model: "sol" })])
    expect(report.models.map((model) => model.model)).toEqual(["luna", "sol"])
  })
})

describe("not comparable", () => {
  const mendcode = record({ harness: "mendcode", usage: { inputTokens: 1000, cachedReadTokens: 100, outputTokens: 10, toolCalls: 1, failedToolCalls: 0, compactions: 0 } })
  const codex = record({ harness: "codex", usage: { inputTokens: 900, cachedReadTokens: 800, outputTokens: 12, toolCalls: 2, failedToolCalls: 0, compactions: null } })

  test("a metric one harness cannot report is flagged, not zeroed", () => {
    const model = buildReport([mendcode, codex]).models[0]!
    expect(model.notComparable.some((note) => note.startsWith("compactions: NOT COMPARABLE, codex did not report it"))).toBe(true)
    const codexHarness = model.harnesses.find((harness) => harness.harness === "codex")!
    expect(codexHarness.all.compactions).toEqual({ n: 0, median: null, p90: null })
  })

  test("the rendered table shows n/a for it", () => {
    const text = renderReport(buildReport([mendcode, codex]))
    const row = text.split("\n").find((line) => line.startsWith("| codex") && line.includes("900"))!
    expect(row).toContain("n/a")
    expect(text).toContain("### Not comparable")
    expect(text).toContain("tool calls and failed tool calls count different things")
  })

  test("partial availability is called out", () => {
    const partial = [record({ harness: "codex", usage: { toolCalls: 3 } }), record({ harness: "codex", repeat: 2, usage: {} })]
    const notes = notComparableNotes(buildReport(partial).models[0]!.harnesses)
    expect(notes.some((note) => note.includes("codex reported it in 1 of 2 runs only"))).toBe(true)
  })

  test("a harness with no cached counter gets its own cache-hit note", () => {
    const notes = notComparableNotes(buildReport([mendcode, record({ harness: "codex", usage: { inputTokens: 5 } })]).models[0]!.harnesses)
    expect(notes).toContain("cache hit %: NOT COMPARABLE for codex (no cached-read counter reported).")
  })

  test("nothing is flagged for a single complete harness", () => {
    const complete = record({ usage: { inputTokens: 1, cachedReadTokens: 0, outputTokens: 1, toolCalls: 1, failedToolCalls: 0, compactions: 0 } })
    expect(buildReport([complete]).models[0]!.notComparable).toEqual([])
  })
})
