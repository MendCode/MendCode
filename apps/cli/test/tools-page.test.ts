import { describe, expect, test } from "bun:test"
import type { CustomToolInfo, CustomToolsReport } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createToolsPageState, renderToolsPage, toolsPageKey, type ToolsPageState } from "../src/view/tools-page"
import { textWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

function tool(name: string, patch: Partial<CustomToolInfo> = {}): CustomToolInfo {
  return { name, toolName: `custom__${name}`, description: `Does ${name} things`, source: "project", file: `/repo/.mendcode/tools/${name}.json`, command: ["./run.sh", "--flag"], trusted: false, ...patch }
}

const TOOLS = [tool("word_count"), tool("lint", { trusted: true }), tool("hello", { source: "user", trusted: true })]
const report = (tools = TOOLS, issues: CustomToolsReport["issues"] = []): CustomToolsReport => ({ directory: "/repo", tools, issues })
const render = (state: ToolsPageState, width = 100, height = 24, value = report()) => renderToolsPage({ report: value, state, width, height })
const press = (state: ToolsPageState, tools: CustomToolInfo[], ...keys: string[]) => {
  let current = state
  let action: ReturnType<typeof toolsPageKey>["action"] = { type: "none" }
  for (const key of keys) ({ state: current, action } = toolsPageKey(current, key, tools))
  return { state: current, action }
}

describe("tools page", () => {
  test("lists tools with trust state colors and source", () => {
    const lines = render(createToolsPageState())
    const text = plain(lines).join("\n")
    expect(text).not.toContain("MENDCODE")
    expect(text).toContain("word_count")
    expect(text).toContain("lint")
    expect(text).toContain("hello")
    const dots = lines.flatMap((line) => line.filter((span) => span.text.startsWith("●")).map((span) => span.fg))
    expect(dots).toContain("warning")
    expect(dots).toContain("success")
  })
  test("the selected tool shows its model name, description, command and file; untrusted ones say how to trust", () => {
    const text = plain(render(createToolsPageState())).join("\n")
    expect(text).toContain("custom__word_count")
    expect(text).toContain("not trusted")
    expect(text).toContain("Does word_count things")
    expect(text).toContain("runs")
    expect(text).toContain("./run.sh --flag")
    expect(text).toContain("file")
    expect(text).toContain("word_count.json")
    expect(text).toContain("press t")
    expect(plain(render({ selected: 1 })).join("\n")).not.toContain("press t")
  })
  test("empty state explains where manifests go, with an example", () => {
    const text = plain(render(createToolsPageState(), 100, 20, report([]))).join("\n")
    expect(text).toContain("no custom tools · add .mendcode/tools/<name>.json")
    expect(text).toContain('"command"')
  })
  test("manifest issues are listed", () => {
    const text = plain(render(createToolsPageState(), 100, 24, report(TOOLS, [{ file: "/repo/.mendcode/tools/bad.json", message: "invalid JSON: nope" }]))).join("\n")
    expect(text).toContain("bad.json")
    expect(text).toContain("invalid JSON")
  })
  test("title row is Tools · custom tools with the count and a bold amber not-trusted status on the right", () => {
    const lines = render(createToolsPageState())
    const title = plain(lines)[1]!
    expect(title.trimStart()).toStartWith("Tools · custom tools")
    expect(title.trimEnd()).toEndWith("3 tools · 1 not trusted")
    expect(title).not.toContain("LIVE")
    expect(lines[1]!.find((span) => span.text === "1 not trusted")).toMatchObject({ fg: "warning", bold: true })
    expect(plain(lines)[2]!.trim()).toMatch(/^─+$/)
    expect(plain(lines).at(-2)!.trim()).toBe("esc back")
  })
  test("all trusted: no status, only the count", () => {
    const trusted = TOOLS.map((t) => ({ ...t, trusted: true }))
    expect(plain(render(createToolsPageState(), 100, 24, report(trusted)))[1]!.trimEnd()).toEndWith("3 tools")
    expect(plain(render(createToolsPageState(), 100, 24, report([tool("only", { trusted: true })])))[1]!.trimEnd()).toEndWith("1 tool")
  })
  test("no boxes: the list and the detail are plain rows", () => {
    for (const width of [60, 120]) expect(plain(render(createToolsPageState(), width, 40)).join("")).not.toMatch(/[┌┐└┘│]/)
  })
  test("side by side from 120x24: the detail sits to the right of the list", () => {
    const rows = plain(render({ selected: 1 }, 120, 40))
    expect(rows.find((line) => line.includes("custom__lint · trusted"))).toContain("word_count")
    expect(rows.find((line) => line.includes("❯"))).toContain("lint")
  })
  test("a long list keeps the selection visible and says which part is shown", () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(`tool${String(i).padStart(2, "0")}`, { trusted: true }))
    const lines = plain(render({ selected: 25 }, 80, 24, report(many)))
    expect(lines.find((line) => line.includes("tool25"))).toContain("❯")
    expect(lines[1]).toContain("shown")
  })
  test("exact width x height at 60x20, 80x30, 120x40 and 160x50", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const value of [report(), report([]), report(TOOLS, [{ file: "/repo/.mendcode/tools/bad.json", message: "invalid JSON: nope" }])]) {
        const lines = render({ selected: 0 }, width, height, value)
        expect(lines).toHaveLength(height)
        for (const line of plain(lines)) expect(textWidth(line)).toBe(width)
      }
    }
  })
  test("exact height and no overflow at various sizes", () => {
    for (const width of [60, 90, 120, 160]) {
      for (const height of [20, 35, 50]) {
        const lines = render({ selected: 0 }, width, height, report())
        expect(lines).toHaveLength(height)
        for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })
  test("selected tool stays visible in render output", () => {
    const lines = render({ selected: 1 }, 120, 35, report())
    const text = plain(lines).join("\n")
    expect(text).toContain("lint")
    // The marker glyph ❯ indicates the selected row
    expect(text).toContain("❯")
  })
})

describe("tools page keys", () => {
  test("arrows move within bounds; escape and q close", () => {
    expect(press(createToolsPageState(), TOOLS, "\x1b[B", "j").state.selected).toBe(2)
    expect(press(createToolsPageState(), TOOLS, ...Array(9).fill("\x1b[B")).state.selected).toBe(2)
    expect(press(createToolsPageState(), TOOLS, "\x1b[A").state.selected).toBe(0)
    expect(press(createToolsPageState(), TOOLS, "\x1b").action).toEqual({ type: "close" })
    expect(press(createToolsPageState(), TOOLS, "q").action).toEqual({ type: "close" })
  })
  test("t trusts the project's tools when any is untrusted, and untrusts when all are trusted", () => {
    expect(press(createToolsPageState(), TOOLS, "t").action).toEqual({ type: "trust", trusted: true })
    const allTrusted = TOOLS.map((t) => ({ ...t, trusted: true }))
    expect(press(createToolsPageState(), allTrusted, "t").action).toEqual({ type: "trust", trusted: false })
  })
  test("t does nothing when only user tools exist", () => {
    expect(press(createToolsPageState(), [tool("u", { source: "user", trusted: true })], "t").action).toEqual({ type: "none" })
    expect(press(createToolsPageState(), [], "t").action).toEqual({ type: "none" })
  })
})
