import { describe, expect, test } from "bun:test"
import type { ContextReport } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { contextPageKey, contextPageStateKey, createContextPageState, renderContextPage, contextGlyphGrid, contextSuggestions, contextWindowSlices, type ContextPageState } from "../src/view/context-page"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const titleRow = (lines: Line[]) => lines[0]!
const tabsRow = (lines: Line[]) => lines[1]!
/** A row without the page's one-cell margin on each side; trailing padding trimmed. */
const unwrapPanel = (raw: string): string => (raw.length > 1 ? raw.slice(1, -1) : raw).trimEnd()
const tabbed = (tab = 0): ContextPageState => ({ tab })

function report(patch: Partial<ContextReport> = {}): ContextReport {
  const sections = [
    { id: "system:base", label: "system · base prompt", chars: 12_000, tokens: 3_000 },
    { id: "system:instructions", label: "system · project instructions", chars: 8_000, tokens: 2_000 },
    { id: "system:skills", label: "system · skills", chars: 0, tokens: 0 },
    { id: "system:memory", label: "system · memory", chars: 400, tokens: 100 },
    { id: "tools", label: "tools", chars: 20_000, tokens: 5_000, count: 18 },
    { id: "history:user", label: "history · user", chars: 4_000, tokens: 1_000, count: 6 },
    { id: "history:assistant", label: "history · assistant", chars: 40_000, tokens: 10_000, count: 14 },
    { id: "history:tool", label: "history · tool results", chars: 400_000, tokens: 100_000, count: 12 },
  ]
  return {
    model: "gpt-5.6",
    contextWindow: 200_000,
    sections,
    largest: [
      { role: "tool", chars: 96_000, tokens: 24_000, preview: "shell: bun test packages/kernel --coverage --reporter verbose output" },
      { role: "tool", chars: 40_000, tokens: 10_000, preview: "read: apps/cli/src/ui/app.ts" },
      { role: "assistant", chars: 20_000, tokens: 5_000, preview: "→ edit, shell" },
      { role: "user", chars: 4_000, tokens: 1_000, preview: "please refactor the transcript wrap 猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫猫" },
      { role: "tool", chars: 800, tokens: 200, preview: "grep: TODO" },
    ],
    images: 0,
    estimatedTokens: 121_100,
    measuredTokens: 118_432,
    compactAtTokens: 160_000,
    ...patch,
  }
}

const render = (over: Partial<Parameters<typeof renderContextPage>[0]> = {}) => renderContextPage({ report: report(), width: 100, height: 40, ...over })
const rowsOf = (over: Partial<Parameters<typeof renderContextPage>[0]> = {}) => plain(render(over)).map(unwrapPanel)

describe("context page keys", () => {
  test("esc and q close, r refreshes, other keys do nothing", () => {
    expect(contextPageKey("\x1b")).toEqual({ type: "close" })
    expect(contextPageKey("q")).toEqual({ type: "close" })
    expect(contextPageKey("r")).toEqual({ type: "refresh" })
    expect(contextPageKey("x")).toEqual({ type: "none" })
    expect(contextPageKey("\x1b[A")).toEqual({ type: "none" })
  })
})

describe("context page tab keys", () => {
  const start = createContextPageState()
  test("tab and shift-tab cycle Sections, Largest and Files; 1, 2 and 3 jump", () => {
    expect(start).toEqual({})
    const largest = contextPageStateKey(start, "\t")
    expect(largest.state.tab).toBe(1)
    expect(largest.action).toEqual({ type: "none" })
    const files = contextPageStateKey(largest.state, "\t")
    expect(files.state.tab).toBe(2)
    expect(contextPageStateKey(files.state, "\t").state.tab).toBe(0)
    expect(contextPageStateKey(start, "\x1b[Z").state.tab).toBe(2)
    expect(contextPageStateKey(start, "2").state.tab).toBe(1)
    expect(contextPageStateKey(start, "3").state.tab).toBe(2)
    expect(contextPageStateKey(largest.state, "1").state.tab).toBe(0)
  })
  test("jumping to the tab already shown returns the same state object", () => {
    expect(contextPageStateKey(start, "1").state).toBe(start)
    const largest = tabbed(1)
    expect(contextPageStateKey(largest, "2").state).toBe(largest)
  })
  test("close, refresh and unknown keys behave as without a state and keep the tab", () => {
    const largest = tabbed(1)
    expect(contextPageStateKey(largest, "\x1b")).toEqual({ state: largest, action: { type: "close" } })
    expect(contextPageStateKey(largest, "q").action).toEqual({ type: "close" })
    expect(contextPageStateKey(largest, "r")).toEqual({ state: largest, action: { type: "refresh" } })
    expect(contextPageStateKey(largest, "x").action).toEqual({ type: "none" })
  })
})

describe("UI-8 context page", () => {
  test("a ten-column grid represents exactly 100 shares, with free space and a marked buffer", () => {
    const r = report()
    const grid = contextGlyphGrid(r)
    expect(grid).toHaveLength(10)
    for (const row of grid) expect(row).toHaveLength(10)
    const cells = grid.flat()
    expect(cells.filter((cell) => cell.text === "▒ ")).toHaveLength(20)
    expect(cells.filter((cell) => cell.text === "· ")).toHaveLength(19)
    expect(cells.filter((cell) => cell.text !== "▒ " && cell.text !== "· ")).toHaveLength(61)
    expect(contextWindowSlices(r).categories.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(200_000)
  })

  test("the legend is based on the report's real categories and window, never compact threshold percentages", () => {
    const all = plain(render({ width: 180, height: 50 })).join("\n")
    expect(all).toContain("≈121,100 / 200,000 (60.6%)")
    expect(all).toContain("Memory: 100 tokens (0.1%)")
    expect(all).toContain("Messages: 111,000 tokens (55.5%)")
    expect(all).toContain("Autocompact buffer: 40,000 tokens (20.0%)")
    expect(all).toContain("Measured: 118,432 at last call")
    expect(all).toContain("MCP: unavailable")
  })

  test("old reports do not invent a context window or buffer", () => {
    const r = report({ contextWindow: undefined })
    expect(contextGlyphGrid(r).flat().filter((cell) => cell.text === "▒ ")).toHaveLength(0)
    expect(plain(render({ report: r, width: 180 })).join("\n")).toContain("Window unknown")
    expect(plain(render({ report: r, width: 180 })).join("\n")).toContain("Autocompact buffer: unavailable")
  })

  test("overfull reports cap the glyph grid and do not show negative free space", () => {
    const r = report({ contextWindow: 100_000 })
    expect(contextGlyphGrid(r).flat()).toHaveLength(100)
    expect(contextWindowSlices(r).categories.find((part) => part.id === "free")?.tokens).toBe(0)
    expect(contextWindowSlices(r).categories.find((part) => part.id === "buffer")?.tokens).toBe(0)
  })

  test("counts, MCP schemas and category tokens come from additive report fields", () => {
    const r = report({ categories: [
      { id: "system", label: "system", chars: 400, tokens: 100 },
      { id: "mcp", label: "mcp", chars: 240, tokens: 60, count: 2 },
      { id: "agents", label: "agents", chars: 80, tokens: 20, count: 1 },
      { id: "skills", label: "skills", chars: 160, tokens: 40, count: 3 },
      { id: "memory", label: "memory", chars: 40, tokens: 10, count: 1 },
    ], mcpTools: [{ id: "mcp__local__search", label: "mcp__local__search", chars: 120, tokens: 30, count: 1 }] })
    const all = plain(render({ report: r, width: 180, height: 50 })).join("\n")
    for (const text of ["MCP tools: 2 tools · 60 tokens", "Custom agents: 1 entries · 20 tokens", "Skills: 3 entries · 40 tokens", "mcp__local__search: 30 tokens"]) expect(all).toContain(text)
  })

  test("each extension that adds tool schemas is listed with its tokens; a report without the field shows no extension section", () => {
    const r = report({ extensions: [{ id: "extension:heavy", label: "heavy", chars: 1640, tokens: 410, count: 2 }, { id: "extension:light", label: "light", chars: 80, tokens: 20, count: 1 }] })
    const all = plain(render({ report: r, width: 180, height: 50 })).join("\n")
    for (const text of ["Extensions: 2 adding 430 tokens of tool schemas", "heavy: 410 tokens · 2 tools", "light: 20 tokens · 1 tool"]) expect(all).toContain(text)
    expect(plain(render({ report: report(), width: 180, height: 50 })).join("\n")).not.toContain("Extensions:")
  })

  test("suggestions are computed from large tool results, re-reads and actual pressure, otherwise omitted", () => {
    expect(contextSuggestions(report())).toContainEqual(expect.stringContaining("24,000 tokens"))
    const r = report({ estimatedTokens: 100, largest: [], repeatedReads: [] })
    expect(contextSuggestions(r)).toEqual([])
    expect(plain(render({ report: r, width: 180, height: 50 })).join("\n")).not.toContain("Suggestions")
    const repeats = contextSuggestions({ ...r, repeatedReads: [{ path: "src/socket.ts", count: 3, tokens: 800 }] })
    expect(repeats).toContainEqual(expect.stringContaining("src/socket.ts 3 times · 800 tokens"))
    expect(contextSuggestions(report({ estimatedTokens: 155_000 }))).toContainEqual(expect.stringContaining("5,000 tokens before autocompact"))
  })

  test("wide pages fill both columns, with largest messages visible on either tab", () => {
    for (const tab of [0, 1]) for (const width of [180, 220]) {
      const all = plain(render({ width, height: 50, state: tabbed(tab) })).join("\n")
      expect(all).toContain("Largest messages")
      expect(all).toContain("shell: bun test")
      expect(all).toContain("Resources")
      expect(all).toContain("Window · ≈tokens")
      expect(plain(render({ width, height: 50, state: tabbed(tab) })).at(-1)?.trimEnd()).toEndWith("┘")
    }
  })

  test("compact pages keep tabs and scrolling, including the largest tab", () => {
    const all = plain(render({ width: 60, height: 20, state: tabbed(1) })).join("\n")
    expect(all).toContain("Largest messages")
    expect(all).toContain("24,000 tokens")
    expect(contextPageStateKey({}, "\x1b[6~").state.scroll).toBe(10)
    expect(contextPageStateKey({ scroll: 10 }, "\x1b[5~").state.scroll).toBe(0)
    expect(plain(render({ width: 60, height: 20, state: { scroll: 10 } })).join("\n")).not.toBe(plain(render({ width: 60, height: 20, state: {} })).join("\n"))
  })

  test("active tab highlight, refresh, close and header hints remain available", () => {
    for (const [tab, name] of [[0, "Sections"], [1, "Largest"]] as const) {
      const spans = tabsRow(render({ state: tabbed(tab) }))
      expect(spans.find((span) => span.text.includes(name))).toMatchObject({ fg: "text", bg: "element", bold: true })
      expect(text(titleRow(render({ state: tabbed(tab), width: 180 })))).toContain("r refresh · tab/1-3 tabs")
    }
  })

  test("the Files tab lists what the history holds, edits first marked, and says so when there is none", () => {
    const files = [{ path: "src/app.ts", reads: 3, edits: 1, tokens: 1200 }, { path: "README.md", reads: 1, edits: 0, tokens: 300 }]
    for (const width of [60, 180]) {
      const all = plain(render({ report: report({ files }), width, height: 30, state: tabbed(2) })).join("\n")
      expect(all).toContain("2 files · ≈1,500 tokens")
      expect(all).toContain("src/app.ts")
      expect(all).toContain("read 3 · edited 1 · ≈1,200")
      expect(all).toContain("read 1 · ≈300")
    }
    expect(plain(render({ report: report({ files: [] }), state: tabbed(2) })).join("\n")).toContain("No files in context yet")
    expect(plain(render({ report: report(), state: tabbed(2) })).join("\n")).toContain("does not report files")
  })

  test("a window set with /context-window is named on the sections tab", () => {
    expect(plain(render({ report: report({ contextWindow: 200_000, contextWindowOverride: true }), width: 180, height: 40, state: tabbed(0) })).join("\n")).toContain("window set with /context-window")
  })

  test("loading, error, image and empty history states remain truthful", () => {
    expect(plain(render({ report: undefined })).join("\n")).toContain("loading context…")
    expect(plain(render({ report: undefined, error: "not available for this engine" })).join("\n")).toContain("not available for this engine")
    expect(plain(render({ report: report({ images: 3 }) })).join("\n")).toContain("3 images · tokens not estimated")
    expect(plain(render({ report: report({ largest: [] }), state: tabbed(1) })).join("\n")).toContain("History is empty")
  })

  test("all tabs, empty and loading reports respect terminal dimensions and wide graphemes", () => {
    for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60], [40, 8], [160, 45]] as const) for (const state of [undefined, tabbed(0), tabbed(1)]) for (const r of [report(), undefined, report({ largest: [], estimatedTokens: 0 })]) {
      const lines = renderContextPage({ report: r, width, height, ...(state ? { state } : {}) })
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBe(width)
    }
  })
})
