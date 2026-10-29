import { describe, expect, test } from "bun:test"
import { center, contentWidth, hintRows, kpiRow, kvList, page, pageChrome, parseHints, section, tabsRow, twoColumns, type PageTab } from "../src/view/page"
import { textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"

const text = (line: Line) => line.map((span) => span.text).join("")
const TABS: PageTab[] = [
  { key: "1", label: "Overview" },
  { key: "2", label: "Limits" },
  { key: "3", label: "Tokens" },
  { key: "4", label: "Models" },
  { key: "5", label: "Tools" },
  { key: "6", label: "Sessions" },
]

describe("page standard", () => {
  test("the content column is at most 112 cells and 4 narrower than the page", () => {
    expect(contentWidth(200)).toBe(112)
    expect(contentWidth(100)).toBe(96)
    expect(contentWidth(10)).toBe(10)
  })

  test("legacy hint strings split into key and label, with the back hint apart", () => {
    expect(parseHints("←→ Day   ↑↓ Week   [ ] Range   1/2/3/M Mode   A Details   Esc/Q Back")).toEqual({
      back: { key: "Esc/Q", label: "back" },
      hints: [
        { key: "←→", label: "day" },
        { key: "↑↓", label: "week" },
        { key: "[ ]", label: "range" },
        { key: "1/2/3/M", label: "mode" },
        { key: "A", label: "details" },
      ],
    })
    expect(parseHints("Enter Open · Esc Close")).toEqual({ back: { key: "Esc", label: "close" }, hints: [{ key: "Enter", label: "open" }] })
  })

  test("a key that is a word stays a key; only trailing plain words are the label", () => {
    expect(parseHints("Enter Open Session").hints).toEqual([{ key: "Enter", label: "open session" }])
    expect(parseHints("q").hints).toEqual([{ key: "q", label: "" }])
  })

  test("hints wrap at their separators into at most maxRows rows, never cutting a hint", () => {
    const hints = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: "label" }))
    const rows = hintRows(hints, 30, 2)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(textWidth(text(row))).toBeLessThanOrEqual(30)
    expect(text(rows[0]!)).toBe("k0 label · k1 label · k2 label")
    expect(rows[0]![0]).toMatchObject({ text: "k0", fg: "text", bold: true })
    expect(rows[0]![1]).toMatchObject({ fg: "muted" })
  })

  test("tabs mark the active one on the element background and shorten when narrow", () => {
    const wide = tabsRow(TABS, 2, 120)
    expect(text(wide)).toContain(" 1 Overview ")
    const active = wide.find((span) => span.text === " 3 Tokens ")
    expect(active).toMatchObject({ bg: "element", bold: true })
    const narrow = text(tabsRow(TABS, 0, 50))
    expect(narrow).toContain(" 1 Ov ")
    expect(textWidth(narrow)).toBeLessThanOrEqual(50)
    expect(textWidth(text(tabsRow(TABS, 0, 12)))).toBeLessThanOrEqual(12)
  })

  test("a page is exactly width × height at every size", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50], [30, 8], [1, 1]] as const) {
      const rows = page({ title: "usage", context: "Pro", tabs: TABS, mode: { key: "g", label: "Daily" }, body: Array.from({ length: 80 }, (_, i) => [{ text: `row ${i}` }]), hints: "tab/1-6 Report   R Refresh   Esc Back", width, height })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(text(row))).toBe(width)
    }
    expect(page({ title: "x", body: [], hints: "", width: 0, height: 10 })).toEqual([])
  })

  test("rows: blank, title · context with summary right, tabs, rule, mode, blank, body, blank, back, keys", () => {
    const rows = page({ title: "usage", context: "Pro · a@b.c", summary: "628 sessions", tabs: TABS, activeTab: 0, mode: { key: "g", label: "Daily" }, body: [[{ text: "body" }]], hints: "tab/1-6 Report   R Refresh   Esc Back", width: 100, height: 20 }).map(text)
    expect(rows[0]!.trim()).toBe("")
    expect(rows[1]!.trim()).toMatch(/^Usage · Pro · a@b\.c +628 sessions$/)
    expect(rows[2]).toContain("1 Overview")
    expect(rows[3]!.trim()).toMatch(/^─+$/)
    expect(rows[4]!.trim()).toBe("g Daily")
    expect(rows[5]!.trim()).toBe("")
    expect(rows[6]!.trim()).toBe("body")
    expect(rows[18]!.trim()).toBe("esc back")
    expect(rows[19]!.trim()).toBe("tab/1-6 report · R refresh")
    expect(pageChrome({ tabs: true, mode: true, hints: "tab/1-6 Report   R Refresh   Esc Back", width: 100 })).toBe(9)
  })

  test("scroll moves the body window and clamps at the end", () => {
    const body = Array.from({ length: 30 }, (_, i) => [{ text: `row ${i}` }])
    const at = (scroll: number) => page({ title: "t", body, hints: "Esc Back", scroll, width: 40, height: 12 }).map(text)
    expect(at(0)[4]!.trim()).toBe("row 0")
    expect(at(5)[4]!.trim()).toBe("row 5")
    expect(at(999)[4]!.trim()).toBe("row 24")
  })

  test("a warn or error status shows on the title row in its tone; live does not", () => {
    const warn = page({ title: "memory", status: { label: "CONFIRM", tone: "warn" }, body: [], hints: "", width: 60, height: 8 })
    expect(warn[1]!.find((span) => span.text === "CONFIRM")?.fg).toBe("warning")
    const live = page({ title: "memory", status: { label: "LIVE" }, body: [], hints: "", width: 60, height: 8 })
    expect(text(live[1]!)).not.toContain("LIVE")
  })

  test("section, kvList, kpiRow and twoColumns", () => {
    expect(section({ title: "Token activity", subtitle: "Last 12 months", body: [[{ text: "x" }]], width: 40 }).map(text)).toEqual(["Token activity", "Last 12 months", "", "x"])
    const kv = kvList([{ label: "Total chats", value: "43,998" }, { label: "A very long label that will not fit", value: "max · 33%" }], 24).map(text)
    expect(kv[0]).toBe("Total chats       43,998")
    expect(kv[1]!.endsWith(" max · 33%")).toBe(true)
    for (const row of kv) expect(textWidth(row)).toBe(24)
    const kpis = kpiRow([{ value: "69.9B", label: "Lifetime tokens" }, { value: "13h", label: "Longest chat" }], 60).map(text)
    expect(kpis).toHaveLength(2)
    expect(kpis[0]).toContain("69.9B")
    expect(kpis[1]).toContain("Lifetime tokens")
    expect(kpiRow([{ value: "1", label: "aaaaaaaaaaaa" }, { value: "2", label: "bbbbbbbbbbbb" }, { value: "3", label: "cccccccccccc" }], 30)).toHaveLength(5)
    expect(twoColumns([[{ text: "L" }]], [[{ text: "R" }]], 100).map(text)[0]).toBe(`L${" ".repeat(51)}R${" ".repeat(47)}`)
    expect(twoColumns([[{ text: "L" }]], [[{ text: "R" }]], 60).map(text)).toEqual(["L", "", "R"])
  })

  test("center pads to the middle and clips when wider", () => {
    expect(text(center([{ text: "ab" }], 6))).toBe("  ab")
    expect(text(center([{ text: "abcdef" }], 4))).toBe("abcd")
  })
})
