import { describe, expect, test } from "bun:test"
import type { UsageDay, UsageReport } from "@mendcode/protocol"
import { statsText } from "../src/stats"
import { cacheHit, costText, daysWithAuxiliary, harnessLabel, periodTotals, totalsOf } from "../src/view/usage-breakdown"
import { dayTokens } from "../src/view/usage-heatmap"
import { createUsagePageState, renderUsagePage } from "../src/view/usage-page"
import { textWidth } from "../src/view/wrap"

const TODAY = "2026-09-26"
const NOW = Date.parse(`${TODAY}T12:00:00`)

function day(date: string, patch: Partial<UsageDay> = {}): UsageDay {
  return { day: date, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0, calls: 0, sessions: 0, ...patch }
}

function report(): UsageReport {
  return {
    from: "2025-09-27", to: TODAY, quotas: [], sessions: 3,
    days: [
      day(TODAY, { input: 10_000, output: 2_000, reasoning: 500, cacheRead: 40_000, cacheWrite: 5_000, calls: 12, costMicros: 30_000, costUnknownCalls: 8, sessions: 2 }),
      day("2026-09-01", { input: 5_000, output: 1_000, cacheRead: 9_000, calls: 3, costMicros: 1_000, sessions: 1 }),
    ],
    models: [
      { provider: "claude", model: "claude-opus-5", input: 9_000, output: 2_000, reasoning: 500, cacheRead: 40_000, cacheWrite: 5_000, calls: 8, costMicros: 0, costUnknownCalls: 8 },
      { provider: "anthropic", model: "claude-sonnet-5", input: 6_000, output: 1_000, cacheRead: 9_000, cacheWrite: 0, calls: 7, costMicros: 31_000, costUnknownCalls: 0 },
    ],
    harnesses: [
      { harness: "claude-code", calls: 8, sessions: 1, input: 9_000, output: 2_000, reasoning: 500, cacheRead: 40_000, cacheWrite: 5_000, costMicros: 0, costUnknownCalls: 8, subagents: { calls: 2, sessions: 1, tokens: 3_000 } },
      { harness: "native", calls: 7, sessions: 2, input: 6_000, output: 1_000, reasoning: 0, cacheRead: 9_000, cacheWrite: 0, costMicros: 31_000, costUnknownCalls: 0 },
    ],
    auxiliary: [
      { role: "title", provider: "chatgpt", model: "gpt-6-luna", input: 1_000, output: 50, reasoning: 0, cacheRead: 200, cacheWrite: 0, calls: 2, costMicros: 0, costUnknownCalls: 2 },
      { role: "prReview", provider: "anthropic", model: "opus", input: 7_000, output: 7_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 },
    ],
    auxiliaryDays: [{ day: TODAY, input: 1_000, output: 50, reasoning: 0, cacheRead: 200, cacheWrite: 0, calls: 2, costMicros: 0, costUnknownCalls: 2 }],
  }
}

const plain = (lines: ReturnType<typeof renderUsagePage>) => lines.map((line) => line.map((span) => span.text).join(""))
const render = (input: { report?: UsageReport; tab: number; width?: number }) =>
  renderUsagePage({ report: input.report ?? report(), state: { ...createUsagePageState(TODAY), tab: input.tab }, today: TODAY, width: input.width ?? 140, height: 80, now: NOW })

describe("usage totals", () => {
  test("reasoning is part of output and is not counted a second time", () => {
    expect(dayTokens(day(TODAY, { input: 10, output: 20, reasoning: 15, cacheRead: 30, cacheWrite: 40 }))).toBe(100)
  })

  test("the calls outside turns join the days, and a day with only such calls appears", () => {
    const days = daysWithAuxiliary([day(TODAY, { input: 1, calls: 1, sessions: 1 })], [{ day: "2026-09-20", input: 5, output: 1, reasoning: 0, cacheRead: 2, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 }, { day: TODAY, input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 }])
    expect(days.map((entry) => [entry.day, entry.input, entry.calls, entry.sessions])).toEqual([["2026-09-20", 5, 1, 0], [TODAY, 4, 2, 1]])
  })

  test("today, 7 and 30 days and the range each count every call, cache included", () => {
    const periods = periodTotals(report(), TODAY, { label: "Last 12 months", from: "2025-09-27" })
    expect(periods.map((period) => period.label)).toEqual(["Today", "7 days", "30 days", "Last 12 months"])
    expect(periods[0]!.totals).toMatchObject({ input: 11_000, cacheRead: 40_200, cacheWrite: 5_000, calls: 14, tokens: 11_000 + 2_050 + 40_200 + 5_000 })
    expect(periods[1]!.totals.tokens).toBe(periods[0]!.totals.tokens)
    expect(periods[2]!.totals.tokens).toBe(periods[0]!.totals.tokens + 15_000)
  })

  test("a cost is known, partly known or unknown; never a guessed zero", () => {
    expect(costText(30_000, 0, 3)).toBe("$0.03")
    expect(costText(30_000, 2, 3)).toBe("$0.03+")
    expect(costText(0, 3, 3)).toBe("unknown")
    expect(costText(0, 0, 0, 500)).toBe("unknown")
    expect(costText(0, 0, 0, 0)).toBe("—")
    expect(cacheHit({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe("80%")
    expect(cacheHit({ input: 0 })).toBe("—")
    expect(totalsOf([{ input: 1, output: 2, calls: 1, costMicros: 0 }]).tokens).toBe(3)
  })

  test("harness names", () => {
    expect(["native", "claude-code", "codex", "pi", "acp:gemini", "imported:codex", "unattributed"].map(harnessLabel)).toEqual(["Native", "Claude Code", "Codex", "pi", "ACP · gemini", "Imported · codex", "Deleted sessions"])
  })
})

describe("/usage Tokens and Models", () => {
  test("Tokens shows the periods and a harness table whose total is the page's total, cache columns included", () => {
    for (const width of [140, 100, 60]) {
      const lines = render({ tab: 2, width })
      const all = plain(lines)
      for (const needle of ["Totals", "By harness", "Today", "7 days", "30 days", "Claude Code", "Native", "Outside turns", "Total", "Cache hit"]) expect(all.join("\n")).toContain(needle)
      for (const line of lines) expect(textWidth(line.map((span) => span.text).join(""))).toBe(width)
    }
    const all = plain(render({ tab: 2 }))
    const header = all.find((line) => line.includes("cache r") && line.includes("harness"))!
    expect(header).toMatch(/harness +tokens +input +output +cache r +cache w +hit +cost +calls/)
    // Every call: turns (15K in, 3K out, 49K read, 5K written) plus 1,250 outside turns; the reviewer's attribution row is not added.
    const total = all.filter((line) => /│ Total /.test(line)).at(-1)!
    expect(total).toContain("73.3K")
    expect(all.find((line) => line.includes("Claude Code ") && line.includes("unknown"))).toBeDefined()
    expect(all.find((line) => line.includes("Native ") && line.includes("$0.03"))).toBeDefined()
    expect(all.join("\n")).toContain("Claude Code: 3,000 tok from 1 sub-agent session (inside its row)")
    expect(all.find((line) => line.includes("73.3K tokens"))).toBeDefined()
  })

  test("Tokens says when there is nothing yet, and when the daemon is too old for harnesses", () => {
    const empty = plain(render({ report: { from: "2025-09-27", to: TODAY, days: [], models: [], quotas: [] }, tab: 2 })).join("\n")
    expect(empty).toContain("No model calls in this range yet")
    const { harnesses: _harnesses, ...older } = report()
    expect(plain(render({ report: older, tab: 2 })).join("\n")).toContain("does not report harnesses yet")
  })

  test("Models has cache columns and hit rate per model, a total row, and keeps an older daemon's zero cost unknown", () => {
    const all = plain(render({ tab: 3 }))
    const opus = all.find((line) => line.includes("claude/claude-opus-5"))!
    expect(opus).toMatch(/claude\/claude-opus-5 +56K +9,000 +2,000 +40K +5,000 +74% +unknown +8/)
    expect(all.find((line) => /│ Total +72K/.test(line))).toBeDefined()
    const older = { ...report(), models: [{ provider: "codex", model: "gpt-5.6", input: 100, output: 10, calls: 3, costMicros: 0 }] }
    expect(plain(render({ report: older, tab: 3 })).find((line) => line.includes("codex/gpt-5.6"))).toContain("unknown")
  })
})

test("mendcode usage prints every call's totals, cache hit and the harness rows", () => {
  const text = statsText(report(), { kind: "usage" })
  expect(text).toContain("By Harness")
  expect(text).toMatch(/Claude Code +56K tok · 74% hit · unknown/)
  expect(text).toMatch(/Outside turns +1,250 tok/)
  expect(text).toMatch(/Tokens +73\.3K/)
  expect(text).toContain("Cache hit")
})
