import { describe, expect, test } from "bun:test"
import { createIdFactory, type ContextReport, type SessionEvent, type UsageReport } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { contextSuggestions, renderContextPage, rentByOwner } from "../src/view/context-page"
import { forecastTurns } from "../src/view/context-forecast"
import { segmentSpans, type FooterInput } from "../src/view/footer"
import { createUsageNotes } from "../src/view/usage-notes"
import { createUsagePageState, renderUsagePage } from "../src/view/usage-page"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const text = (line: Line) => line.map((span) => span.text).join("")
const sample = (...tokens: number[]) => tokens.map((value, index) => ({ turnId: `t${index}`, tokens: value }))

describe("context forecast", () => {
  test("turns left come from the average growth of the last turns", () => {
    expect(forecastTurns(sample(40_000, 50_000, 60_000), 100_000)).toEqual({ turns: 4, perTurn: 10_000 })
    expect(forecastTurns(sample(40_000, 70_000, 80_000), 100_000)).toEqual({ turns: 1, perTurn: 20_000 })
    expect(forecastTurns(sample(95_000, 99_000, 100_000), 100_000)).toMatchObject({ turns: 0 })
  })

  test("nothing is shown with too little history, a context that is not growing, or a long way to go", () => {
    expect(forecastTurns(sample(40_000, 50_000), 100_000)).toBeUndefined()
    expect(forecastTurns(sample(50_000, 50_000, 49_000), 100_000)).toBeUndefined()
    expect(forecastTurns(sample(1_000, 1_500, 2_000), 200_000)).toBeUndefined()
    expect(forecastTurns(sample(40_000, 50_000, 60_000), 0)).toBeUndefined()
  })

  test("a drop in the context (a compaction, an undo) starts the window over", () => {
    expect(forecastTurns(sample(80_000, 90_000, 20_000, 30_000), 100_000)).toBeUndefined()
    expect(forecastTurns(sample(80_000, 90_000, 20_000, 30_000, 40_000), 100_000)).toEqual({ turns: 6, perTurn: 10_000 })
  })

  test("the usage notes keep one context sample per turn and forget them when a compaction rewrites the history", () => {
    const notes = createUsageNotes()
    let seq = 0
    const usage = (turnId: string, input: number) => notes.apply({ type: "usage.recorded", sessionId: "s", seq: ++seq, at: NOW, turnId, provider: "p", model: "m", input, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as unknown as SessionEvent)
    usage("a", 10_000)
    usage("a", 12_000)
    usage("b", 20_000)
    expect(notes.contexts).toEqual([{ turnId: "a", tokens: 12_100 }, { turnId: "b", tokens: 20_100 }])
    notes.apply({ type: "compaction.updated", sessionId: "s", seq: ++seq, at: NOW, state: "packed" } as unknown as SessionEvent)
    expect(notes.contexts).toEqual([])
    usage("c", 5_000)
    notes.reset()
    expect(notes.contexts).toEqual([])
  })
})

describe("forecast footer segment", () => {
  const input = (patch: Partial<FooterInput>): FooterInput => ({ segments: ["forecast"], width: 100, glyphs: glyphs({}), stateLabel: "", state: "idle", dotOn: false, connection: "connected", permission: "ask", permissionLabel: "", quotas: [], now: NOW, notice: "", ...patch })

  test("it words the turns left, warns when few remain, and is empty without a forecast", () => {
    expect(text(segmentSpans("forecast", input({})))).toBe("")
    expect(text(segmentSpans("forecast", input({ forecast: { turns: 9 } })))).toBe("~9 turns to compact")
    expect(segmentSpans("forecast", input({ forecast: { turns: 9 } }))[0]!.fg).toBe("muted")
    expect(text(segmentSpans("forecast", input({ forecast: { turns: 1 } })))).toBe("~1 turn to compact")
    expect(segmentSpans("forecast", input({ forecast: { turns: 2 } }))[0]!.fg).toBe("warning")
    expect(text(segmentSpans("forecast", input({ forecast: { turns: 0 } })))).toBe("compacts next turn")
  })

  function harness(settings: Record<string, unknown>) {
    const frames: Line[][] = []
    const screen = { size: { width: 100, height: 12 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const sessionId = ids("session")
    const app = createApp({ sessionId, screen, directory: "/work/app", exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => NOW, mode: "full", send: async () => ({ ok: true }) } as never)
    app.applySettings({ compactAtTokens: 100_000, ...settings } as never)
    let seq = 0
    const turn = (inputTokens: number) => {
      const turnId = ids("turn")
      app.onEvent({ sessionId, seq: ++seq, at: 0, type: "usage.recorded", turnId, provider: "p", model: "m", input: inputTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as SessionEvent)
    }
    const footer = () => frames.at(-1)!.at(-1)!.map((span) => span.text).join("").trim()
    return { app, turn, footer }
  }

  test("balanced and full show it by default, minimalist and no tier do not", () => {
    for (const [tier, shown] of [["balanced", true], ["full", true], ["minimalist", false], [undefined, false]] as const) {
      const h = harness({ ...(tier ? { tier } : {}) })
      for (const tokens of [40_000, 50_000, 60_000]) h.turn(tokens)
      h.app.render()
      expect(h.footer().includes("~4 turns to compact")).toBe(shown)
    }
  })

  test("/tier forecast off hides it in balanced, and a footer that places it shows it even in minimalist", () => {
    const off = harness({ tier: "balanced", features: { forecast: false } })
    for (const tokens of [40_000, 50_000, 60_000]) off.turn(tokens)
    off.app.render()
    expect(off.footer()).not.toContain("to compact")
    const placed = harness({ tier: "minimalist", footer: ["state", "forecast"] })
    for (const tokens of [40_000, 50_000, 60_000]) placed.turn(tokens)
    placed.app.render()
    expect(placed.footer()).toContain("~4 turns to compact")
    const unplaced = harness({ tier: "balanced", footer: ["state", "quota"] })
    for (const tokens of [40_000, 50_000, 60_000]) unplaced.turn(tokens)
    unplaced.app.render()
    expect(unplaced.footer()).not.toContain("to compact")
  })
})

describe("context rent", () => {
  const rent: NonNullable<ContextReport["rent"]> = [
    { tool: "mcp__github__search", owner: "mcp:github", tokens: 900, uses: 0 },
    { tool: "mcp__github__issue", owner: "mcp:github", tokens: 700, uses: 0 },
    { tool: "big", owner: "extension:heavy", tokens: 500, uses: 0 },
    { tool: "shell", owner: "built-in", tokens: 300, uses: 12 },
    { tool: "read", owner: "built-in", tokens: 250, uses: 30 },
  ]
  const report = (patch: Partial<ContextReport> = {}): ContextReport => ({ model: "m", contextWindow: 200_000, sections: [{ id: "tools", label: "tools", chars: 10_000, tokens: 2_650, count: 5 }], largest: [], images: 0, estimatedTokens: 3_000, compactAtTokens: 160_000, rent, ...patch })

  test("tools are grouped by owner, biggest first, with their uses", () => {
    expect(rentByOwner(report())).toEqual([
      { owner: "mcp:github", tokens: 1_600, tools: 2, uses: 0 },
      { owner: "built-in", tokens: 550, tools: 2, uses: 42 },
      { owner: "extension:heavy", tokens: 500, tools: 1, uses: 0 },
    ])
    expect(rentByOwner(report({ rent: undefined }))).toEqual([])
  })

  test("the page shows the rent beside the resources, flags what was never called, and suggests turning off a big idle owner", () => {
    const rows = renderContextPage({ report: report(), width: 100, height: 60 }).map(text)
    const joined = rows.join("\n")
    expect(joined).toContain("Context rent: ≈2,650 tokens of tool schemas on every request · 3 of 5 tools unused (≈2,100)")
    expect(joined).toContain("mcp:github: ≈1,600 tokens · 2 tools · 0 uses · unused")
    expect(joined).toContain("built-in: ≈550 tokens · 2 tools · 42 uses")
    expect(joined).toContain("Uses count calls still in this history")
    const hints = contextSuggestions(report())
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain("mcp:github adds ≈1,600 tokens to every request (2 tools) and none was called")
  })

  test("a report without rent, or a small idle owner, adds nothing", () => {
    expect(renderContextPage({ report: report({ rent: undefined }), width: 100, height: 60 }).map(text).join("\n")).not.toContain("Context rent")
    expect(contextSuggestions(report({ rent: [{ tool: "tiny", owner: "extension:small", tokens: 100, uses: 0 }] }))).toEqual([])
  })
})

describe("tokens saved in /usage", () => {
  const TODAY = "2026-09-26"
  const base: UsageReport = { from: "2026-08-01", to: TODAY, days: [], models: [], quotas: [], tools: [{ tool: "shell", calls: 30, ms: 60_000, errors: 2 }] }
  const toolsTab = (report: UsageReport) => renderUsagePage({ report, state: { ...createUsagePageState(TODAY), tab: 4 }, today: TODAY, width: 120, height: 60, now: Date.UTC(2026, 8, 26, 12) }).map(text).join("\n")

  test("the Tools tab lists tokens saved per filter with the total, and stays quiet when none ran", () => {
    const shown = toolsTab({ ...base, savings: [{ source: "tests", calls: 12, tokens: 31_000 }, { source: "git", calls: 1, tokens: 200 }] })
    expect(shown).toContain("Tokens saved")
    expect(shown).toContain("~31,200 tokens kept out of context")
    expect(shown).toMatch(/tests\s+~31,000 tok · 12 calls/)
    expect(shown).toMatch(/git\s+~200 tok · 1 call\b/)
    expect(toolsTab(base)).not.toContain("Tokens saved")
  })
})
