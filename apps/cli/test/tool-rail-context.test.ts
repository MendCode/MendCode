import { describe, expect, test } from "bun:test"
import { parseToolRail, toolRailProblems, toolRailShown, TOOL_RAIL_DEFAULT } from "@mendcode/protocol/wire"
import { renderToolCard, trimDiffContext, parseDiff } from "../src/view/tool-card"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"

const plain = (line: { text: string }[]) => line.map((span) => span.text).join("")
const DIFF = ["@@ -18,11 +18,11 @@", " a", " b", " c", " d", "-old", "+new", " e", " f", " g", " h", " i"].join("\n")
const edit = (extra: Partial<Parameters<typeof renderToolCard>[0]> = {}) =>
  renderToolCard({ title: "edit: src/a.ts", text: DIFF, status: "ok", width: 80, expanded: true, level: "preview", frame: 0, tailLines: 0, ...extra }).map(plain)

describe("tool rail", () => {
  test("file tools lose the rule by default and every other tool keeps it", () => {
    const entries = parseToolRail(TOOL_RAIL_DEFAULT)
    for (const name of ["read", "write", "edit", "apply_patch", "notebook_edit"]) expect(toolRailShown(entries, name)).toBe(false)
    for (const name of ["shell", "grep", "mcp__x__y", "future_tool"]) expect(toolRailShown(entries, name)).toBe(true)
  })

  test("any tool, a prefix or all of them can be switched, the last matching entry winning", () => {
    expect(toolRailShown(parseToolRail("shell:off"), "shell")).toBe(false)
    expect(toolRailShown(parseToolRail("mcp__*:off,mcp__keep:on"), "mcp__a__b")).toBe(false)
    expect(toolRailShown(parseToolRail("mcp__*:off,mcp__keep:on"), "mcp__keep")).toBe(true)
    expect(toolRailShown(parseToolRail("*:off,edit:on"), "edit")).toBe(true)
    expect(toolRailShown(parseToolRail("*:off,edit:on"), "grep")).toBe(false)
    expect(toolRailProblems("edit:maybe").length).toBe(1)
    expect(toolRailProblems("edit:on,shell:off")).toEqual([])
    expect(normalizeTuiProfile({ toolRail: "nonsense" }).toolRail).toBe(DEFAULT_TUI_PROFILE.toolRail)
  })

  test("a card without its rule keeps its body in the same columns", () => {
    const withRule = edit()
    const without = edit({ rail: false })
    expect(withRule.some((row) => row.includes("│"))).toBe(true)
    expect(without.some((row) => row.includes("│"))).toBe(false)
    expect(without.map((row) => row.replace(/\s+$/, "").length)).toEqual(withRule.map((row) => row.replace(/\s+$/, "").length))
  })
})

describe("diff context", () => {
  test("keeps the unchanged lines the setting asks for on each side of a change", () => {
    const rows = parseDiff(DIFF)!.rows
    expect(trimDiffContext(rows, 3).filter((row) => row.kind === "context").map((row) => row.text)).toEqual(["b", "c", "d", "e", "f", "g"])
    expect(trimDiffContext(rows, 1).filter((row) => row.kind === "context").map((row) => row.text)).toEqual(["d", "e"])
    expect(trimDiffContext(rows, 0).filter((row) => row.kind === "context")).toEqual([])
  })

  test("a card draws three lines each side by default and none when the setting is 0", () => {
    expect(edit().join("\n")).toContain("g")
    const none = edit({ diffContext: 0 })
    expect(none.some((row) => row.includes(" c"))).toBe(false)
    expect(none.some((row) => row.includes("new"))).toBe(true)
  })

  test("a gap between kept lines is marked like a second hunk", () => {
    const text = ["@@ -1,12 +1,12 @@", "-x", "+y", " a", " b", " c", " d", " e", " f", " g", "-p", "+q"].join("\n")
    const rows = trimDiffContext(parseDiff(text)!.rows, 1)
    expect(rows.map((row) => (row.kind === "hunk" ? "⋯" : row.text))).toEqual(["x", "y", "a", "⋯", "g", "p", "q"])
  })
})

describe("long diff lines", () => {
  const long = `@@ -1,1 +1,1 @@\n-a\n+${"x".repeat(900)}`
  test("a line takes at most the rows the setting allows and ends in an ellipsis", () => {
    const rows = renderToolCard({ title: "edit: s.css", text: long, status: "ok", width: 60, expanded: true, level: "preview", frame: 0, tailLines: 0, diffLineRows: 2 }).map(plain)
    const added = rows.filter((row) => row.includes("x"))
    expect(added.length).toBe(2)
    expect(added.at(-1)!.trimEnd().endsWith("…")).toBe(true)
  })
})
