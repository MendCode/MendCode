import { afterAll, describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { homeIdentity, logoRows, renderHome } from "../src/view/home"
import { LOGO_MARK, LOGO_MARK_ASCII } from "../src/view/logo-mark"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps } from "./session-ui-harness"

afterAll(cleanTemps)

const text = (line: Line) => line.map((span) => span.text).join("")
const cell = (rows: readonly string[], row: number, col: number) => [...rows[row]!][col]!
const base = { root: "~/Code/MendCodeV2", version: "0.4.2", now: 0 }

describe("the infinity mark", () => {
  test("half blocks: the website's two loops in 24 x 6 cells, the same after a half turn, drawn with the wordmark's block characters", () => {
    expect(LOGO_MARK).toHaveLength(6)
    for (const row of LOGO_MARK) {
      expect(textWidth(row)).toBe(24)
      expect(row).toMatch(/^[ █▀▄]+$/)
    }
    // The symbol is point-symmetric: turned half way (a top half becoming a bottom half) it is itself.
    const turned = [...LOGO_MARK].reverse().map((row) => [...row].reverse().map((char) => (char === "▀" ? "▄" : char === "▄" ? "▀" : char)).join(""))
    expect(turned).toEqual([...LOGO_MARK])
  })
  test("the falling stroke runs unbroken through the middle while the rising one stops short of it on both sides", () => {
    for (const [row, col] of [[1, 10], [2, 11], [3, 12], [4, 13]] as const) expect(cell(LOGO_MARK, row, col)).not.toBe(" ")
    // Where the rising stroke would cross it there is a gap, one cell wide, above and below.
    expect([cell(LOGO_MARK, 1, 12), cell(LOGO_MARK, 4, 11)]).toEqual([" ", " "])
    expect([cell(LOGO_MARK, 1, 13), cell(LOGO_MARK, 4, 10)]).not.toContain(" ")
  })
  test("ASCII: the same outline in plain characters, the falling stroke whole and the rising one broken", () => {
    expect(LOGO_MARK_ASCII).toHaveLength(6)
    for (const row of LOGO_MARK_ASCII) {
      expect(row.length).toBe(24)
      expect(row).toMatch(/^[\x20-\x7e]+$/)
    }
    for (const [row, col] of [[1, 10], [2, 11], [3, 12], [4, 13]] as const) expect(cell(LOGO_MARK_ASCII, row, col)).toBe("\\")
    expect([cell(LOGO_MARK_ASCII, 1, 13), cell(LOGO_MARK_ASCII, 4, 10)]).toEqual(["/", "/"])
    expect([cell(LOGO_MARK_ASCII, 2, 12), cell(LOGO_MARK_ASCII, 3, 11)]).toEqual([" ", " "])
  })
})

describe("the home's title", () => {
  test("left as shipped it is the mark with the product name centered under it, in the text color, in place of the pixel MENDCODE", () => {
    const rows = renderHome({ ...base, width: 120, height: 34, screenHeight: 40 })
    const plain = rows.map(text)
    const top = plain.findIndex((row) => row.includes(LOGO_MARK[0]!))
    for (let i = 0; i < LOGO_MARK.length; i++) expect(plain[top + i]!.indexOf(LOGO_MARK[i]!)).toBe(48)
    expect(plain[top + LOGO_MARK.length]!.trim()).toBe("")
    expect(plain[top + LOGO_MARK.length + 1]!.indexOf("MendCode")).toBe(56)
    expect(rows[top]!.find((span) => span.text === LOGO_MARK[0])).toMatchObject({ fg: "text" })
    expect(plain.join("\n")).not.toContain(logoRows()[0]!)
    // A renamed product is the name under the mark.
    expect(homeIdentity({ productName: "Acme" }).at(-1)!.trim()).toBe("Acme")
  })
  test("ASCII glyphs draw the ASCII mark", () => {
    expect(homeIdentity({ ascii: true }).slice(0, 6)).toEqual([...LOGO_MARK_ASCII])
    expect(homeIdentity({ ascii: true }).join("")).toMatch(/^[\x20-\x7e]*$/)
  })
  test("a wordmark of its own text or font, and the wordmark beside a mascot, stay letters", () => {
    expect(homeIdentity({ logoText: "ACME" })).toEqual(logoRows("ACME"))
    expect(homeIdentity({ logoFont: "solid" })).toEqual(logoRows(undefined, "solid"))
    expect(homeIdentity({ logoKind: "both" }).join("\n")).toContain(logoRows()[0]!)
    expect(homeIdentity({ logoKind: "both" }).join("\n")).not.toContain(LOGO_MARK[0]!)
  })
  test("a small terminal gets the plain name instead", () => {
    const rows = renderHome({ ...base, width: 120, height: 17, screenHeight: 23 }).map(text)
    expect(rows.join("\n")).not.toContain(LOGO_MARK[0]!)
    expect(rows.some((row) => row.trim() === "MendCode")).toBe(true)
  })
  test("in the app, a terminal set to ASCII glyphs gets the ASCII mark on the start screen", () => {
    const h = appHarness({ width: 100, height: 30, hostProfile: { ...DEFAULT_TUI_PROFILE, glyphs: "ascii", sidebar: "hidden" } })
    h.app.render()
    const screen = h.text().join("\n")
    for (const row of LOGO_MARK_ASCII) expect(screen).toContain(row.trimEnd())
    expect(screen).not.toContain(LOGO_MARK[0]!)
  })
})
