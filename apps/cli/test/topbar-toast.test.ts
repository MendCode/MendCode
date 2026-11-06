import { describe, expect, test } from "bun:test"
import { overlayLines } from "../src/view/overlay"
import { DETAILS_HINT, renderToast, renderToastRow, toastCut, toastPosition } from "../src/view/toast"
import { glyphSet } from "../src/ui/theme"
import { renderTopbar, topbarAnimates, truncateMiddle } from "../src/view/topbar"
import { textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"
import { appHarness } from "./session-ui-harness"

const text = (line: Line) => line.map((span) => span.text).join("")
const base = { path: "/Users/dev/Code/MendCodeV2/apps/cli", home: "/Users/dev", branch: "main", title: "Fix the flaky reconnect after suspend" }

describe("top bar", () => {
  test("branch and ~ path left, title centered, diff and context bar right, exactly the width", () => {
    const line = renderTopbar({ ...base, width: 120, diff: { added: 1234, removed: 300 }, context: { tokens: 90_000, limit: 200_000 } })
    expect(textWidth(text(line))).toBe(120)
    expect(text(line)).toStartWith("main ~/Code/MendCodeV2/apps/cli")
    expect(text(line)).toContain("Fix the flaky reconnect after suspend")
    expect(text(line)).toEndWith("+1,234 -300 |          45%")
    expect(line.filter((span) => span.bg === "text").map((span) => span.text.length)).toEqual([4])
    expect(line.find((span) => span.text === "+1,234")).toMatchObject({ fg: "success" })
    const at = text(line).indexOf("Fix the flaky")
    expect(Math.abs(at - (120 - 37) / 2)).toBeLessThanOrEqual(1)
  })

  test("narrow widths shorten the path in the middle, then the title, then drop the right side", () => {
    for (const width of [30, 50, 80, 100, 160]) {
      const line = renderTopbar({ ...base, width, diff: { added: 1, removed: 2 }, context: { tokens: 1, limit: 100 } })
      expect(textWidth(text(line))).toBe(width)
      expect(text(line)).toStartWith("main ~/")
    }
    expect(text(renderTopbar({ ...base, width: 80 }))).toContain("…")
    // The right side goes only when it would leave the left fewer than 10 cells.
    expect(text(renderTopbar({ ...base, width: 30, context: { tokens: 1, limit: 100 } }))).toContain("1%")
    const tight = text(renderTopbar({ ...base, width: 25, diff: { added: 1, removed: 2 }, context: { tokens: 1, limit: 100 } }))
    expect(tight).not.toContain("%")
    expect(tight).toStartWith("main ~/")
  })

  test("no diff and no context leave the right side empty; context percentages stay muted as in v1", () => {
    expect(text(renderTopbar({ ...base, width: 120 })).trimEnd()).toEndWith("suspend")
    // At 100 the title box (about a third of the row) is narrower than the title, so it ends with "…".
    expect(text(renderTopbar({ ...base, width: 100 })).trimEnd()).toEndWith("…")
    expect(renderTopbar({ ...base, width: 100, context: { tokens: 75, limit: 100 } }).at(-1)).toMatchObject({ text: " 75%", fg: "muted" })
    expect(renderTopbar({ ...base, width: 100, context: { tokens: 150, limit: 100 } }).at(-1)).toMatchObject({ text: " >99%", fg: "muted" })
    expect(renderTopbar({ ...base, width: 100, context: { tokens: 995, limit: 1000 } }).at(-1)).toMatchObject({ text: " 99%" })
  })

  test("a long title scrolls with ticks and says it animates; a short one does not", () => {
    const long = "a very long session title that will need to scroll around the box"
    expect(topbarAnimates({ width: 60, title: long })).toBe(true)
    expect(topbarAnimates({ width: 60, title: "short" })).toBe(false)
    const a = text(renderTopbar({ width: 60, path: "/x", title: long, tick: 0 }))
    const b = text(renderTopbar({ width: 60, path: "/x", title: long, tick: 1 }))
    expect(a).not.toBe(b)
    expect(textWidth(b)).toBe(60)
    expect(text(renderTopbar({ width: 60, path: "/x", title: long }))).toContain("…")
  })

  test("truncateMiddle keeps both ends", () => {
    expect(truncateMiddle("/Users/dev/Code/project/src", 12)).toBe("/Users…t/src")
    expect(truncateMiddle("short", 12)).toBe("short")
  })
})

describe("toast", () => {
  test("a new slash command clears an old warning before opening a panel", async () => {
    const h = appHarness({ mode: "minimal", width: 60, height: 20 })
    await h.type("/panel pulse\r")
    expect(h.text().join("\n")).toContain("Right bar presets need")
    await h.type("/queue\r")
    expect(h.text().join("\n")).toContain("Queued · 0")
    expect(h.text().join("\n")).not.toContain("Right bar presets need")
    // Warnings raised by the new command still appear.
    await h.type("\x1b")
    await h.type("/sidebar preset full\r")
    expect(h.text().join("\n")).toContain("Right bar presets need")
  })
  test("each severity has its own mark and theme colour; no border on either side, one row on the panel fill", () => {
    const g = glyphSet("unicode")
    for (const [variant, mark] of [["success", "✓"], ["info", "•"], ["warning", "!"], ["error", "✗"]] as const) {
      const rows = renderToast({ variant, title: "Memory saved", message: "project · Use bun" }, 120, g)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.find((span) => span.text.trim() === mark)).toMatchObject({ fg: variant, bold: true })
      expect(rows[0]!.find((span) => span.text === "Memory saved")).toMatchObject({ fg: variant, bold: true })
      expect(rows[0]!.every((span) => span.bg === "panel")).toBe(true)
      expect(text(rows[0]!)).not.toMatch(/[┃│]/)
    }
    expect(text(renderToastRow({ variant: "error", message: "no" }, 40, 2, glyphSet("ascii")))).toBe("  x no")
  })

  test("a long message is cut on its one row and the hint stays whole; the details hint asks for F4 only when something is hidden", () => {
    const long = { variant: "error" as const, message: "settings.set failed: ".repeat(12), hint: "F4 details" }
    const row = renderToastRow(long, 80, 2)
    expect(textWidth(text(row))).toBeLessThanOrEqual(80)
    expect(text(row)).toContain("…")
    expect(text(row)).toEndWith(" · F4 details")
    expect(row.at(-1)).toMatchObject({ fg: "muted" })
    expect(toastCut({ variant: "info", message: "saved" }, 80)).toBe(false)
    expect(toastCut({ variant: "info", message: "x".repeat(90) }, 80)).toBe(true)
    // A message of several lines is one row too: its lines joined, the rest behind F4.
    expect(toastCut({ variant: "info", message: "extra directories\n/a" }, 80)).toBe(true)
    expect(text(renderToastRow({ variant: "info", message: "extra directories\n/a\n/b" }, 80, 2))).toContain("extra directories · /a · /b")
    expect(DETAILS_HINT).toBe("F4 details")
  })

  test("on a page it is as wide as its text, at most 100 cells; very narrow screens show nothing", () => {
    expect(textWidth(text(renderToast({ variant: "info", message: "hi" }, 120)[0]!))).toBe(6)
    expect(textWidth(text(renderToast({ variant: "error", message: "x ".repeat(400) }, 200)[0]!))).toBe(100)
    expect(renderToast({ variant: "info", message: "hi" }, 15)).toEqual([])
    expect(toastPosition(60, 120)).toEqual({ row: 2, col: 58 })
  })
})

describe("overlay", () => {
  test("paints a box at a position, keeping the cells around it and splitting spans", () => {
    const baseRows: Line[] = [[{ text: "0123456789", fg: "muted" }], [{ text: "abcdefghij" }], [{ text: "ABCDEFGHIJ" }]]
    const out = overlayLines(baseRows, [[{ text: "XY", fg: "error" }], [{ text: "ZW" }]], { row: 1, col: 3 }, 10)
    expect(out.map(text)).toEqual(["0123456789", "abcXYfghij", "ABCZWFGHIJ"])
    expect(out[1]![1]).toMatchObject({ text: "XY", fg: "error" })
    expect(baseRows[1]!.map((s) => s.text)).toEqual(["abcdefghij"])
  })

  test("a wide character cut by the box edge becomes spaces; boxes past the edge are clipped", () => {
    const out = overlayLines([[{ text: "日本語です" }]], [[{ text: "--" }]], { row: 0, col: 3 }, 10)
    expect(textWidth(text(out[0]!))).toBe(10)
    // 本 (cells 2-3) and 語 (4-5) are each half covered, so their uncovered halves become one space each.
    expect(text(out[0]!)).toBe("日 -- です")
    const clipped = overlayLines([[{ text: "abcdef" }]], [[{ text: "XYZ" }]], { row: 0, col: 4 }, 6)
    expect(text(clipped[0]!)).toBe("abcdXY")
  })
})
