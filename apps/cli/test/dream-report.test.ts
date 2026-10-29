import { describe, expect, test } from "bun:test"
import type { DreamReport, DreamRun } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { reportRows, tokenCount } from "../src/view/dream-report"
import { NOW, REPORT, run } from "./dream-fixtures"
import { createDreamTabState, dreamTabKey, fullReportLength, parseTokenBudget, renderDreamTab } from "../src/view/dream-tab"

const plain = (rows: Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const text = (rows: Line[]) => plain(rows).join("\n")

describe("tokenCount", () => {
  test("small numbers as they are, thousands as k with one decimal under 100k", () => {
    expect([0, 820, 999, 1_000, 4_120, 60_000, 150_000, 1_500_000].map(tokenCount)).toEqual(["0", "820", "999", "1k", "4.1k", "60k", "150k", "1500k"])
  })
})

describe("the safety report rows", () => {
  test("a summary names what was read, proposed and refused with reasons, the redactions, the usage and the budget", () => {
    const out = text(reportRows({ run: run(), detail: "summary", width: 100 }))
    expect(out).toContain("trigger   manual")
    expect(out).toContain("read      2 sessions (1 reused) · 14 memories · 18.2k chars sent")
    expect(out).toContain("proposed  4 · 1 saved · 2 pending · 1 dropped")
    expect(out).toContain("preferences/user")
    expect(out).toContain("refused   3")
    expect(out).toContain("Use tabs — duplicate of a saved memory")
    expect(out).toContain("token sk-… — unsafe text")
    expect(out).toContain("redacted  2 in evidence · 1 in proposals")
    expect(out).toContain("model     2 calls · 4.1k in · 830 out · estimated (chars / 4)")
    expect(out).toContain("budget    5k / 60k tokens (8%)")
    expect(out).toContain("evolution suggest · saw 3 corrections, 1 preference (2 recurring) · suggested 1 memory, 1 skill")
    expect(out).toContain("nothing recurred in 2 sessions yet")
  })

  test("the summary caps proposals and refusals and points to the full report; the full one lists every session, proposal and refusal", () => {
    const summary = text(reportRows({ run: run(), detail: "summary", width: 100 }))
    expect(summary).toContain("+1 more · v shows the full report")
    expect(summary).not.toContain("Always deploy on Friday")
    expect(summary).not.toContain("Fix the login redirect")
    const full = text(reportRows({ run: run(), detail: "full", width: 100 }))
    expect(full).toContain("Always deploy on Friday — unknown memory id")
    expect(full).toContain("Run bun test apps/cli before a commit")
    expect(full).toContain("Fix the login redirect — 12 msgs · built")
    expect(full).toContain("Move the store to sqlite — 40 msgs · reused · 2 redacted")
    expect(full).not.toContain("more ·")
  })

  test("a recovered run says so and why; a run the budget stopped says that in red with its reason", () => {
    const rows = reportRows({ run: run({ trigger: "recovered", report: { ...REPORT, budget: { limit: 60_000, used: 59_000, stopped: true, reason: "the evolution call would not fit" } } }), detail: "summary", width: 110 })
    const out = text(rows)
    expect(out).toContain("trigger   recovered · a missed window, run late")
    expect(out).toContain("59k / 60k tokens (98%) · stopped: the evolution call would not fit")
    const trigger = rows.find((row) => row.map((span) => span.text).join("").startsWith("trigger"))!
    expect(trigger.find((span) => span.text === "recovered")).toMatchObject({ fg: "warning" })
    const budget = rows.find((row) => row.map((span) => span.text).join("").startsWith("budget"))!
    expect(budget.some((span) => span.fg === "error")).toBe(true)
  })

  test("a semantic cleanup names the model, its usage and what was left for review; a fallback is said", () => {
    const consolidation: NonNullable<DreamReport["consolidation"]> = { policy: "auto-consolidate", pendingBefore: 4, pendingAfter: 1, applied: 2, archived: 1, mode: "semantic", decisions: [{ memoryId: "m1", outcome: "kept", reason: "Model: ask", by: "model" }], semantic: { model: "judge", calls: 2, inputTokens: 1_200, outputTokens: 90, estimated: false, fallback: "budget gone" } }
    const out = text(reportRows({ run: run({ report: { ...REPORT, consolidation } }), detail: "summary", width: 120 }))
    expect(out).toContain("cleanup   semantic auto-consolidate · judge · 2 calls · 1.2k in 90 out · 2 applied · 1 archived · 1 left for review")
    expect(out).toContain("host gates only for a batch: budget gone")
    expect(text(reportRows({ run: run({ report: { ...REPORT, consolidation: { ...consolidation, policy: "disabled" } } }), detail: "summary", width: 120 }))).not.toContain("cleanup")
  })

  test("a run with nothing to report says so plainly; failures are listed", () => {
    const { evolution: _evolution, ...rest } = REPORT
    const empty: DreamReport = { ...rest, read: { sessions: [], memories: 0, promptChars: 0 }, proposed: [], refused: [], redactions: { evidence: 0, proposals: 0 }, model: { calls: 0, inputTokens: 0, outputTokens: 0, estimated: false }, failures: ["evolution: model timed out"] }
    const out = text(reportRows({ run: run({ report: empty }), detail: "summary", width: 100 }))
    expect(out).toContain("read      0 sessions · 0 memories")
    expect(out).toContain("proposed  nothing")
    expect(out).toContain("refused   nothing")
    expect(out).toContain("redacted  no secrets found")
    expect(out).toContain("model     no call made")
    expect(out).toContain("failed    evolution: model timed out")
    expect(out).not.toContain("evolution ")
  })

  test("no report: running, or recorded before reports existed", () => {
    expect(text(reportRows({ run: run({ report: undefined, status: "running" } as never), detail: "summary", width: 100 }))).toContain("the report appears when the run ends")
    expect(text(reportRows({ run: run({ report: undefined } as never), detail: "summary", width: 100 }))).toContain("no safety report for this run")
  })

  test("rows never exceed the width", () => {
    for (const width of [20, 40, 60, 100]) for (const row of plain(reportRows({ run: run(), detail: "full", width }))) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width)
  })
})

describe("parseTokenBudget", () => {
  test("plain numbers, k and m suffixes inside 1k to 2M", () => {
    expect(["60000", "60k", "60K", "1.5m", "2m", "1000", " 120 000 "].map(parseTokenBudget)).toEqual([60_000, 60_000, 60_000, 1_500_000, 2_000_000, 1_000, 120_000])
    expect(["999", "2000001", "3m", "abc", "", "1e5", "-5"].map(parseTokenBudget)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })
})

describe("dream tab: budget, report and full view", () => {
  const RUNS = [run(), run({ runId: 6, trigger: "scheduled", proposed: 0, report: undefined } as never)]

  test("the first row shows the daily time and the budget (default or set)", () => {
    const first = (tokens?: number) => plain(renderDreamTab({ runs: RUNS, state: createDreamTabState(), dreamAt: "03:30", dreamMaxTokens: tokens, pending: 1, width: 100, height: 30, now: NOW }))[0]!
    expect(first()).toContain("daily at 03:30 · budget 60k tokens (default)")
    expect(first()).toContain("1 pending to review")
    expect(first(120_000)).toContain("budget 120k tokens")
    expect(first(120_000)).not.toContain("default")
  })

  test("b types a budget: digits are characters, enter saves it, empty resets it, a bad value keeps the field open, esc cancels", () => {
    const typed = (...keys: string[]) => {
      let result = dreamTabKey(createDreamTabState(), "b", RUNS)
      for (const key of keys) result = dreamTabKey(result.state, key, RUNS)
      return result
    }
    expect(typed("1", "2", "0", "k", "\r").action).toEqual({ type: "budget", tokens: 120_000 })
    expect(typed("\r").action).toEqual({ type: "budget", tokens: null })
    expect(typed("5", "\r").state.typing).toBe("5")
    expect(typed("5", "\r").action).toEqual({ type: "none" })
    expect(typed("9", "\x7f", "8", "k", "\r").action).toEqual({ type: "budget", tokens: 8_000 })
    expect(typed("7", "\x1b").state.typing).toBeUndefined()
    expect(typed("7", "\x1b").action).toEqual({ type: "none" })
    const field = plain(renderDreamTab({ runs: RUNS, state: typed("5", "0").state, pending: 0, width: 100, height: 20, now: NOW }))[0]!
    expect(field).toContain("budget 50_")
    expect(plain(renderDreamTab({ runs: RUNS, state: typed("5").state, pending: 0, width: 100, height: 20, now: NOW }))[0]!).toContain("1k to 2M tokens")
  })

  test("the selected run's report sits under the list; an older run without one says so", () => {
    const out = plain(renderDreamTab({ runs: RUNS, state: createDreamTabState(), pending: 0, width: 100, height: 30, now: NOW })).join("\n")
    expect(out).toContain("safety report")
    expect(out).toContain("read      2 sessions")
    const older = plain(renderDreamTab({ runs: RUNS, state: { selected: 1 }, pending: 0, width: 100, height: 30, now: NOW })).join("\n")
    expect(older).toContain("no safety report for this run")
    expect(older).toContain("nothing new")
  })

  test("a recovered run is marked in the list", () => {
    const rows = plain(renderDreamTab({ runs: [run({ trigger: "recovered" })], state: createDreamTabState(), pending: 0, width: 100, height: 30, now: NOW }))
    expect(rows.some((row) => row.startsWith("› ●") && row.includes("recovered"))).toBe(true)
  })

  test("v opens the full report, arrows scroll it, v or esc returns to the list without closing the page", () => {
    const opened = dreamTabKey(createDreamTabState(), "v", RUNS)
    expect(opened.state).toMatchObject({ full: true, scroll: 0 })
    const full = plain(renderDreamTab({ runs: RUNS, state: opened.state, pending: 0, width: 100, height: 40, now: NOW })).join("\n")
    expect(full).toContain("run 7 · 2 proposals")
    expect(full).toContain("Fix the login redirect — 12 msgs · built")
    expect(full).not.toContain("r run now")

    const room = 8
    const total = fullReportLength(RUNS[0]!)
    expect(total).toBeGreaterThan(room)
    let state = opened.state
    for (let i = 0; i < total + 5; i++) state = dreamTabKey(state, "j", RUNS, { room }).state
    expect(state.scroll).toBe(total - room)
    expect(dreamTabKey(state, "k", RUNS, { room }).state.scroll).toBe(total - room - 1)
    expect(dreamTabKey(state, "\x1b[5~", RUNS, { room }).state.scroll).toBe(total - room - room)
    expect(dreamTabKey(opened.state, "k", RUNS, { room }).state).toBe(opened.state)

    const scrolled = plain(renderDreamTab({ runs: RUNS, state, pending: 0, width: 100, height: 14, now: NOW })).join("\n")
    expect(scrolled).toContain("budget")
    expect(scrolled).not.toContain("trigger   manual")

    for (const key of ["v", "\x1b"]) {
      const back = dreamTabKey(state, key, RUNS)
      expect(back.action).toEqual({ type: "none" })
      expect(back.state.full).toBeUndefined()
      expect(back.state.scroll).toBeUndefined()
    }
  })

  test("enter still reviews a run's proposals from the full report", () => {
    expect(dreamTabKey({ selected: 0, full: true }, "\r", RUNS).action).toEqual({ type: "review" })
    expect(dreamTabKey({ selected: 1, full: true }, "\r", RUNS).action).toEqual({ type: "none" })
  })

  test("the tab stays inside its box at small sizes, in both modes", () => {
    for (const state of [createDreamTabState(), { selected: 0, full: true }, { selected: 0, typing: "5" }]) {
      for (const [width, height] of [[20, 3], [40, 6], [60, 12], [100, 30]] as const) {
        const rows = renderDreamTab({ runs: RUNS, state, dreamAt: "03:30", pending: 2, width, height, now: NOW })
        expect(rows.length).toBeLessThanOrEqual(height)
        for (const row of plain(rows)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })
})
