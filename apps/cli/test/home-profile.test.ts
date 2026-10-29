import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { HOME_TIPS, homeTip, tipLine, tipText } from "../src/view/home-tips"
import { renderHome, logoRows, type HomeSession } from "../src/view/home"
import { LOGO_FONTS, LOGO_TEXT_MAX, logoHeight, logoRowsFor } from "../src/view/logo-fonts"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")
const lines = (rows: Line[]) => rows.map(text)
const now = Date.parse("2026-09-28T12:00:00Z")
const minutes = (count: number) => now - count * 60_000
const base = { root: "~/Code/MendCodeV2", version: "0.4.2", now }
const sessions: HomeSession[] = [
  { id: "a", title: "Approve plan", state: "needs_input", updatedAt: minutes(5), startedAt: minutes(12), detail: "Run command: ls" },
  { id: "b", title: "Port palette", state: "working", updatedAt: minutes(5), startedAt: minutes(4) },
  { id: "c", title: "Release notes", state: "completed", updatedAt: minutes(48) },
]

describe("logo fonts", () => {
  test("MENDCODE in the default font is v1's wordmark, unchanged", () => {
    expect(logoRows()).toEqual(["█▄ ▄█  █▀▀▀  █▄  █  █▀▀▄  █▀▀▀  █▀▀█  █▀▀▄  █▀▀▀", "█ ▀ █  █▀▀▀  █ ▀ █  █  █  █     █  █  █  █  █▀▀▀", "▀   ▀  ▀▀▀▀  ▀   ▀  ▀▀▀   ▀▀▀▀  ▀▀▀▀  ▀▀▀   ▀▀▀▀"])
  })

  test("each font has its own row count, and every row of a font is as wide as its letters", () => {
    for (const font of LOGO_FONTS) {
      const rows = logoRowsFor("MENDCODE", font)
      expect(rows).toHaveLength(logoHeight(font))
      expect(Math.max(...rows.map(textWidth))).toBeGreaterThan(20)
    }
    expect(LOGO_FONTS.map(logoHeight)).toEqual([3, 3, 5, 5])
  })

  test("the text is upper-cased, cut at the font's cap, and a letter the font lacks draws as ?", () => {
    expect(logoRowsFor("acme", "mendcode")).toEqual(logoRowsFor("ACME", "mendcode"))
    for (const font of LOGO_FONTS) expect(logoRowsFor("A".repeat(40), font)).toEqual(logoRowsFor("A".repeat(LOGO_TEXT_MAX[font]), font))
    expect(logoRowsFor("é", "mendcode")).toEqual(logoRowsFor("?", "mendcode"))
    expect(logoRowsFor("", "compact")).toEqual(logoRowsFor("MENDCODE", "compact"))
  })

  test("the replacement fonts use consistent letter spacing", () => {
    expect(textWidth(logoRowsFor("II", "solid")[0]!)).toBeGreaterThan(8)
  })

  test("the home draws the configured text and font, in the text color", () => {
    const look = { logoText: "ACME", logoFont: "solid" as const }
    const rows = renderHome({ ...base, width: 120, height: 40, screenHeight: 40, look })
    const art = logoRowsFor("ACME", "solid")
    const at = lines(rows).findIndex((row) => row.includes(art[0]!))
    expect(at).toBeGreaterThan(0)
    for (let i = 0; i < art.length; i++) expect(lines(rows)[at + i]).toContain(art[i]!)
    expect(rows[at]!.find((span) => span.text === art[0])).toMatchObject({ fg: "text" })
    expect(lines(rows).join("\n")).not.toContain(logoRows()[0]!)
  })

  test("a tall font gives way to the plain name before the Agent View does", () => {
    const look = { logoFont: "solid" as const }
    const tall = renderHome({ ...base, width: 120, height: 14, screenHeight: 40, sessions, look })
    expect(lines(tall).join("\n")).toContain("Approve plan")
    expect(lines(tall).some((row) => row.trim() === "MendCode")).toBe(true)
    expect(lines(tall).join("\n")).not.toContain(logoRowsFor("MENDCODE", "solid")[0]!)
  })
})

describe("product name", () => {
  test("replaces MendCode on the home's top row and as the small terminal's plain logo", () => {
    const look = { productName: "Acme Code" }
    const rows = lines(renderHome({ ...base, width: 120, height: 40, screenHeight: 40, look }))
    expect(rows[1]).toMatch(/^ {2}~\/Code\/MendCodeV2 +Acme Code v0\.4\.2$/)
    expect(rows.join("\n")).not.toContain("MendCode v")
    const small = lines(renderHome({ ...base, width: 120, height: 14, screenHeight: 20, look }))
    expect(small.some((row) => row.trim() === "Acme Code")).toBe(true)
  })
})

describe("home layout", () => {
  test("split at 160 columns: one box, the wordmark and root on the left, the Agent View on the right, no header row", () => {
    const rows = lines(renderHome({ ...base, width: 160, height: 34, screenHeight: 40, sessions, look: { layout: "split" } }))
    expect(rows[0]).toBe("")
    expect(rows[1]).toMatch(/^ {2}┌─+┐ {2}$/)
    const bottom = rows.findIndex((row) => /^ {2}└─+┘ {2}$/.test(row))
    expect(bottom).toBeGreaterThan(10)
    for (const row of rows.slice(1, bottom + 1)) expect(textWidth(row)).toBe(160)
    const logoRow = rows.findIndex((row) => row.includes(logoRows()[0]!))
    const approve = rows.findIndex((row) => row.includes("Approve plan"))
    expect(logoRow).toBeGreaterThan(1)
    // The two columns share rows: the Agent View starts to the right of the logo's right edge.
    expect(rows[approve]!.indexOf("Approve plan")).toBeGreaterThan(rows[logoRow]!.indexOf(logoRows()[0]!) + textWidth(logoRows()[0]!))
    expect(rows.join("\n")).toContain("MendCode v0.4.2")
    expect(rows.some((row) => row.includes("~/Code/MendCodeV2"))).toBe(true)
    // The root is inside the box, not on a header row above it.
    expect(rows[1]).not.toContain("~/Code")
  })

  test("split at 100 columns: the name in text where the wordmark cannot fit beside the Agent View, still two columns", () => {
    const rows = lines(renderHome({ ...base, width: 100, height: 34, screenHeight: 40, sessions, look: { layout: "split" } }))
    const bottom = rows.findIndex((row) => /^ {2}└─+┘ {2}$/.test(row))
    expect(bottom).toBeGreaterThan(10)
    for (const row of rows.slice(1, bottom + 1)) expect(textWidth(row)).toBe(100)
    expect(rows.join("\n")).not.toContain(logoRows()[0]!)
    const name = rows.findIndex((row) => row.includes("MendCode") && !row.includes("v0.4.2"))
    const approve = rows.findIndex((row) => row.includes("Approve plan"))
    expect(name).toBeGreaterThan(1)
    expect(rows[approve]!.indexOf("Approve plan")).toBeGreaterThan(rows[name]!.indexOf("MendCode") + 8)
  })

  test("split stacks identity over Agent View when the columns would be too narrow", () => {
    const rows = lines(renderHome({ ...base, width: 78, height: 40, screenHeight: 40, sessions, look: { layout: "split" } }))
    const approve = rows.findIndex((row) => row.includes("Approve plan"))
    const version = rows.findIndex((row) => row.includes("MendCode v0.4.2"))
    expect(version).toBeGreaterThan(1)
    expect(approve).toBeGreaterThan(version)
  })

  test("split needs 76 columns and a full-height terminal; otherwise v1's centered home is drawn", () => {
    const centered = lines(renderHome({ ...base, width: 120, height: 34, screenHeight: 40, sessions }))
    expect(lines(renderHome({ ...base, width: 120, height: 34, screenHeight: 40, sessions, look: { layout: "centered" } }))).toEqual(centered)
    expect(lines(renderHome({ ...base, width: 75, height: 34, screenHeight: 40, sessions, look: { layout: "split" } }))[1]).not.toMatch(/┌/)
    expect(lines(renderHome({ ...base, width: 120, height: 20, screenHeight: 23, sessions, look: { layout: "split" } })).join("\n")).not.toContain("┌")
  })

  test("centered keeps the root and product on the top row and the wordmark in the middle", () => {
    const rows = lines(renderHome({ ...base, width: 160, height: 34, screenHeight: 40, sessions, look: { layout: "centered" } }))
    expect(rows[1]).toMatch(/~\/Code\/MendCodeV2 +MendCode v0\.4\.2$/)
    expect(rows.join("\n")).not.toContain("┌")
    const left = rows.find((row) => row.includes(logoRows()[0]!))!.indexOf(logoRows()[0]!)
    expect(left).toBe(Math.floor((160 - textWidth(logoRows()[0]!)) / 2))
  })

  test("the split Agent View shows the empty state when nothing is running", () => {
    const rows = lines(renderHome({ ...base, width: 160, height: 34, screenHeight: 40, look: { layout: "split" } }))
    expect(rows.some((row) => row.includes("No sessions yet"))).toBe(true)
    expect(rows.join("\n")).not.toContain("resume or start a task")
  })

  test("the split home never exceeds the height it is given, at any size", () => {
    for (const [width, height] of [[76, 24], [100, 24], [100, 30], [160, 24], [160, 50], [200, 34]] as const) {
      const rows = renderHome({ ...base, width, height, screenHeight: Math.max(height, 24), sessions, look: { layout: "split" }, tip: HOME_TIPS[0]! })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of rows) expect(textWidth(text(row))).toBeLessThanOrEqual(width)
    }
  })
})

describe("home tips and footer", () => {
  test("a tip is drawn under the content when given, in v1's `● Tip` form, and never when absent", () => {
    const tip = "Press {highlight}Ctrl+P{/highlight} for every command"
    const rows = renderHome({ ...base, width: 120, height: 40, screenHeight: 40, tip })
    const at = lines(rows).findIndex((row) => row.includes("● Tip Press Ctrl+P for every command"))
    expect(at).toBeGreaterThan(0)
    const row = rows[at]!
    expect(row.find((span) => span.text === "● Tip ")).toMatchObject({ fg: "warning" })
    expect(row.find((span) => span.text === "Ctrl+P")).toMatchObject({ fg: "text" })
    expect(row.find((span) => span.text === "Press ")).toMatchObject({ fg: "muted" })
    expect(lines(renderHome({ ...base, width: 120, height: 40, screenHeight: 40 })).join("\n")).not.toContain("Tip")
  })

  test("an extension's welcome.below rows take the tip's place", () => {
    const below: Line[] = [[{ text: "from my extension", fg: "accent" }]]
    const shown = lines(renderHome({ ...base, width: 120, height: 40, screenHeight: 40, tip: HOME_TIPS[0]!, below })).join("\n")
    expect(shown).toContain("from my extension")
    expect(shown).not.toContain("● Tip")
  })

  test("the tip is cut to the screen, and the home keeps its height", () => {
    const rows = renderHome({ ...base, width: 70, height: 30, screenHeight: 30, tip: "x".repeat(300) })
    for (const row of rows) expect(textWidth(text(row))).toBeLessThanOrEqual(70)
    expect(rows.length).toBeLessThanOrEqual(30)
  })

  test("the footer is the last row: MCP count and /status on the left, the runtime version on the right", () => {
    const rows = renderHome({ ...base, width: 120, height: 40, screenHeight: 40, footer: { mcp: { total: 3, connected: 2, failed: false } } })
    expect(rows).toHaveLength(40)
    const last = text(rows.at(-1)!)
    expect(last).toMatch(/^ {2}⊙ 2 MCP \/status +runtime v0\.4\.2 {2}$/)
    expect(textWidth(last)).toBe(120)
    expect(rows.at(-1)!.find((span) => span.text === "⊙ ")).toMatchObject({ fg: "success" })
  })

  test("the footer marks a failed server, leaves out MCP when none are configured, and is absent when off", () => {
    const failed = renderHome({ ...base, width: 120, height: 40, screenHeight: 40, footer: { mcp: { total: 2, connected: 1, failed: true } } })
    expect(failed.at(-1)!.find((span) => span.text === "⊙ ")).toMatchObject({ fg: "error" })
    expect(text(renderHome({ ...base, width: 120, height: 40, screenHeight: 40, footer: { mcp: { total: 0, connected: 0, failed: false } } }).at(-1)!)).not.toContain("MCP")
    expect(text(renderHome({ ...base, width: 120, height: 40, screenHeight: 40, footer: {} }).at(-1)!)).toContain("runtime v0.4.2")
    expect(lines(renderHome({ ...base, width: 120, height: 40, screenHeight: 40 })).join("\n")).not.toContain("runtime v")
  })

  test("the footer is not drawn on the bare minimal home or a tiny terminal", () => {
    expect(renderHome({ ...base, width: 120, height: 40, screenHeight: 40, bare: true, footer: {} })).toHaveLength(1)
    expect(lines(renderHome({ ...base, width: 100, height: 11, screenHeight: 17, footer: {} })).join("\n")).not.toContain("runtime")
  })

  test("the footer goes with the split home too", () => {
    const rows = renderHome({ ...base, width: 160, height: 34, screenHeight: 40, look: { layout: "split" }, footer: { mcp: { total: 1, connected: 1, failed: false } } })
    expect(rows).toHaveLength(34)
    expect(text(rows.at(-1)!)).toContain("1 MCP")
  })
})

describe("home tips text", () => {
  test("tips are markers over plain words; the marker text is what shows", () => {
    expect(tipText("Use {highlight}/theme{/highlight} now")).toBe("Use /theme now")
    expect(tipLine("a {highlight}b{/highlight} c").map((span) => span.text)).toEqual(["● Tip ", "a ", "b", " c"])
  })

  test("every tip is terse English on one line, names only commands that exist, and is picked by the random number", () => {
    expect(homeTip(0)).toBe("")
    expect(homeTip(0.999999)).toBe("")
    expect(new Set(HOME_TIPS).size).toBe(HOME_TIPS.length)
    for (const tip of HOME_TIPS) {
      expect(tip).not.toContain("\n")
      expect(tipText(tip).length).toBeLessThanOrEqual(90)
      expect(tip.match(/\{highlight\}/g)?.length).toBe(tip.match(/\{\/highlight\}/g)?.length)
    }
  })
})
