import { describe, expect, test } from "bun:test"
import { beside, bigNumber, boxPanel, clip, columns, deck, deckChrome, fit, panel, panelGrid, panelsRow, spread, wrapHints } from "../src/view/deck"
import { lineWidth, textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"

const text = (line: Line) => line.map((span) => span.text).join("")

describe("deck primitives", () => {
  test("styled rows count wide graphemes independently of span colors", () => {
    expect(lineWidth([{ text: "猫", fg: "muted" }, { text: "👨‍👩‍👧", fg: "primary" }])).toBe(4)
  })
  test("weighted grids reflow, clip wide graphemes and window each panel independently", () => {
    const body = Array.from({ length: 10 }, (_, i): Line => [{ text: `${i} ${"猫".repeat(100)}` }])
    for (const width of [58, 98, 158, 218]) {
      const rows = panelGrid({ width, rows: [[{ title: "List", body, weight: 2, scroll: 7 }, { title: "Detail", body, scroll: 1 }, { title: "Summary", body: [] }]], heights: [5] })
      for (const row of rows) expect(textWidth(text(row))).toBe(width)
      expect(rows).toHaveLength(width < 68 ? 17 : width < 108 ? 11 : 5)
      expect(rows.map(text).join("\n")).toContain("7 猫")
      expect(rows.map(text).join("\n")).toContain("1 猫")
      if (width < 68) {
        expect(rows.map(text).join("\n")).not.toContain("│")
        expect(text(rows[1]!)).toMatch(/^─+$/)
      } else expect(text(rows[4]!)).toContain("└")
    }
    const row = panelGrid({ width: 158, rows: [[{ title: "Main", body: [], weight: 3 }, { title: "Side", body: [] }]], heights: [3] })
    expect(text(row[0]!).indexOf("┐")).toBe(117)
  })
  test("fit clips and pads to exactly the width without splitting a grapheme", () => {
    expect(text(fit([{ text: "abc" }], 5))).toBe("abc  ")
    expect(text(fit([{ text: "ab✅cd" }], 3))).toBe("ab ")
    expect(textWidth(text(fit([{ text: "👨‍👩‍👧👨‍👩‍👧" }], 3)))).toBe(3)
    expect(clip([{ text: "hello" }, { text: "world" }], 7).map((s) => s.text)).toEqual(["hello", "wo"])
  })

  test("columns split the width by weight with gaps, summing exactly", () => {
    expect(columns(100, [1, 1, 1, 1], 1)).toEqual([25, 24, 24, 24])
    for (const width of [20, 57, 143]) expect(columns(width, [2, 1, 3], 1).reduce((a, b) => a + b, 0) + 2).toBe(width)
  })

  test("spread puts right-aligned text at the edge, and drops it when it does not fit", () => {
    expect(text(spread([{ text: "left" }], [{ text: "right" }], 12))).toBe("left   right")
    expect(text(spread([{ text: "left side" }], [{ text: "right" }], 12))).toBe("left side   ")
  })

  test("a panel is a borderless section: bold title, a gap, the body, at the old box's height", () => {
    const section = panel({ title: "Token Mix", body: [[{ text: "4.1M input" }]], width: 20, height: 7 })
    expect(section.map(text)).toEqual(["Token Mix           ", " ".repeat(20), "4.1M input          ", ...Array(4).fill(" ".repeat(20))])
    expect(section[0]!.find((s) => s.text === "Token Mix")).toMatchObject({ fg: "text", bold: true })
    expect(panel({ title: "Focus", body: [], width: 12, active: true })[0]!.find((s) => s.text === "Focus")?.fg).toBe("primary")
    const compact = panel({ title: "T", body: [[{ text: "a" }], [{ text: "b" }], [{ text: "c" }]], width: 8, height: 4, compact: true })
    expect(compact.map(text)).toEqual(["T       ", "a       ", "b       ", "c       "])
    // Without a height it keeps the rows the bordered panel used (borders, padding, title gap).
    expect(panel({ title: "T", body: [[{ text: "a" }]], width: 10 })).toHaveLength(7)
    expect(panel({ body: [[{ text: "x" }]], width: 10, compact: true })).toHaveLength(3)
  })

  test("content keeps inside width - 4, as it did inside the borders", () => {
    const rows = panel({ body: [[{ text: "abcdefghij" }]], width: 8, compact: true })
    expect(text(rows[0]!)).toBe("abcd    ")
  })

  test("boxPanel keeps the bordered box for chat content", () => {
    const box = boxPanel({ title: "Token Mix", body: [[{ text: "4.1M input" }]], width: 20, height: 7 })
    expect(box.map(text)).toEqual([
      "┌──────────────────┐",
      "│                  │",
      "│ Token Mix        │",
      "│                  │",
      "│ 4.1M input       │",
      "│                  │",
      "└──────────────────┘",
    ])
    expect(box[2]!.find((s) => s.text === "Token Mix")?.fg).toBe("primary")
  })

  test("beside joins blocks with a gap and pads the shorter one", () => {
    const rows = beside([{ lines: panel({ body: [[{ text: "x" }]], width: 5, compact: true }), width: 5 }, { lines: [[{ text: "y" }]], width: 3 }])
    expect(rows.map(text)).toEqual(["x     y  ", "         ", "         "])
  })

  test("hints wrap at their separators", () => {
    expect(wrapHints("↑↓ Day   ←→ Week   A Details   Esc Back", 20)).toEqual(["↑↓ Day   ←→ Week", "A Details   Esc Back"])
  })

  test("the deck draws the page standard: title · subtitle, summary right, rule, body, key footer", () => {
    const rows = deck({ page: "stats", status: { label: "LIVE" }, subtitle: "global · daily · 365d", summary: "3 sessions", body: [[{ text: "body" }]], hints: "Esc Back", width: 60, height: 14 }).map(text)
    expect(rows).toHaveLength(14)
    for (const row of rows) expect(textWidth(row)).toBe(60)
    expect(rows[1]!.trim().startsWith("Stats · global · daily · 365d")).toBe(true)
    expect(rows[1]!.trimEnd().endsWith("3 sessions")).toBe(true)
    expect(rows[1]).not.toContain("LIVE")
    expect(rows[2]!.trim()).toMatch(/^─+$/)
    expect(rows[4]!.trim()).toBe("body")
    expect(rows[13]!.trim()).toBe("esc back")
    const warn = deck({ page: "loops", status: { label: "PAUSED", tone: "warn" }, body: [], hints: "q", width: 30, height: 9 })
    expect(warn[1]!.find((s) => s.text === "PAUSED")?.fg).toBe("warning")
  })

  test("deckChrome counts the rows around the body, including tabs and a mode line", () => {
    expect(deckChrome("Esc Back", 60)).toBe(6)
    expect(deckChrome("Esc Back   R Refresh", 60, { tabs: true, mode: true })).toBe(9)
  })

  test("bigNumber is a centered bold value over its muted label, at the old tile height", () => {
    const tile = bigNumber({ label: "tokens", value: "8.4M", detail: "6.2M peak", width: 16, height: 8, tone: "success" })
    expect(tile).toHaveLength(8)
    expect(tile.map((row) => text(row).trim()).slice(0, 4)).toEqual(["", "8.4M", "tokens", "6.2M peak"])
    for (const row of tile) expect(textWidth(text(row))).toBe(16)
    expect(tile[1]!.find((s) => s.text === "8.4M")).toMatchObject({ fg: "success", bold: true })
    expect(tile[2]!.find((s) => s.text === "tokens")).toMatchObject({ fg: "muted" })
    const noDetail = bigNumber({ label: "sessions", value: "1,204", width: 16, height: 7 })
    expect(noDetail).toHaveLength(7)
  })

  test("panelsRow lines up several panels at one shared height, split by weight", () => {
    const row = panelsRow(
      [
        { title: "Token Mix", body: [[{ text: "4.1M input" }], [{ text: "2.0M output" }]] },
        { title: "Response Load", body: [[{ text: "61h AI" }]] },
      ],
      50,
    )
    expect(row).toHaveLength(8)
    for (const line of row) expect(textWidth(text(line))).toBe(50)
    expect(text(row[0]!)).toContain("Token Mix")
    expect(text(row[0]!)).toContain("Response Load")
    expect(text(row[2]!)).toContain("4.1M input")
    expect(text(row[3]!)).toContain("2.0M output")
    expect(panelsRow([], 30)).toEqual([])
  })
})
