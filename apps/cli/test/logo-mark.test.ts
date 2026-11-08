import { afterAll, describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { homeIdentity, logoRows, renderHome } from "../src/view/home"
import { LOGO_MARK, LOGO_MARK_ASCII, LOGO_TITLE, logoLockup, logoLockups } from "../src/view/logo-mark"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps } from "./session-ui-harness"

afterAll(cleanTemps)

const text = (line: Line) => line.map((span) => span.text).join("")
const cell = (rows: readonly string[], row: number, col: number) => [...rows[row]!][col]!
const base = { root: "~/Code/MendCodeV2", version: "0.4.2", now: 0 }

describe("the infinity mark", () => {
  test("half blocks: the website's two loops in 38 x 8 cells, the same after a half turn, drawn with the wordmark's block characters", () => {
    expect(LOGO_MARK).toHaveLength(8)
    for (const row of LOGO_MARK) {
      expect(textWidth(row)).toBe(38)
      expect(row).toMatch(/^[ █▀▄]+$/)
    }
    // The symbol is point-symmetric: turned half way (a top half becoming a bottom half) it is itself.
    const turned = [...LOGO_MARK].reverse().map((row) => [...row].reverse().map((char) => (char === "▀" ? "▄" : char === "▄" ? "▀" : char)).join(""))
    expect(turned).toEqual([...LOGO_MARK])
  })
  test("wider than tall like the symbol (about 2:1): a half block is a square pixel, two to a cell's height", () => {
    for (const mark of [LOGO_MARK, LOGO_MARK_ASCII]) expect(textWidth(mark[0]!) / (mark.length * 2)).toBeGreaterThanOrEqual(2)
  })
  test("the falling stroke runs unbroken through the middle while the rising one stops short of it on both sides", () => {
    for (const [row, col] of [[1, 14], [2, 16], [3, 18], [4, 19], [5, 21], [6, 23]] as const) expect(cell(LOGO_MARK, row, col)).not.toBe(" ")
    // Where the rising stroke meets the falling one there is a gap, one cell wide, above and below the crossing.
    expect([cell(LOGO_MARK, 2, 19), cell(LOGO_MARK, 5, 18)]).toEqual([" ", " "])
    expect([cell(LOGO_MARK, 2, 20), cell(LOGO_MARK, 5, 17)]).not.toContain(" ")
    // Past the crossing the rising stroke is gone: the middle rows hold the falling stroke only.
    expect(LOGO_MARK[3]!.slice(21, 34).trim()).toBe("")
    expect(LOGO_MARK[4]!.slice(3, 17).trim()).toBe("")
  })
  test("ASCII: the same outline in plain characters, the falling stroke whole and the rising one broken", () => {
    expect(LOGO_MARK_ASCII).toHaveLength(8)
    for (const row of LOGO_MARK_ASCII) {
      expect(row.length).toBe(38)
      expect(row).toMatch(/^[\x20-\x7e]+$/)
    }
    for (const [row, col] of [[1, 13], [2, 15], [3, 17], [4, 19], [5, 21], [6, 23]] as const) expect(LOGO_MARK_ASCII[row]!.slice(col, col + 2)).toBe("'.")
    expect([LOGO_MARK_ASCII[6]!.slice(13, 15), LOGO_MARK_ASCII[5]!.slice(15, 17), LOGO_MARK_ASCII[2]!.slice(21, 23), LOGO_MARK_ASCII[1]!.slice(23, 25)]).toEqual([".'", ".'", ".'", ".'"])
    expect([LOGO_MARK_ASCII[3]!.slice(1, 17), LOGO_MARK_ASCII[3]!.slice(19, 37)].map((part) => part.trim())).toEqual(["", ""])
  })
})

describe("the big title", () => {
  test("MendCode in the wordmark's letters: five rows of half blocks, every row inside the 58 columns of the widest", () => {
    expect(LOGO_TITLE).toHaveLength(5)
    expect(Math.max(...LOGO_TITLE.map(textWidth))).toBe(58)
    for (const row of LOGO_TITLE) expect(row).toMatch(/^[ █▀▄]+$/)
  })
  test("the lockups, largest first: the mark over the big title, then the mark over the name; ASCII or a renamed product get the second only", () => {
    const [roomy, big, small] = logoLockups("MendCode", false)
    const markLeft = big!.findIndex((row) => row.includes(LOGO_MARK[0]!))
    expect(markLeft).toBe(0)
    // The mark is centered on the title, and the title's rows share one left edge.
    expect(big![0]!.indexOf(LOGO_MARK[0]!)).toBe(Math.floor((58 - 38) / 2))
    const titleTop = LOGO_MARK.length + 1
    expect(big!.slice(titleTop)).toEqual([...LOGO_TITLE])
    // Where the screen has the row, the title sits two rows under the mark instead of one.
    expect(roomy!.slice(titleTop + 1)).toEqual([...LOGO_TITLE])
    expect(roomy![titleTop]).toBe("")
    expect(small).toEqual(logoLockup("MendCode", false))
    expect(logoLockups("MendCode", true)).toEqual([logoLockup("MendCode", true)])
    expect(logoLockups("Acme", false)).toEqual([logoLockup("Acme", false)])
  })
})

describe("the home's identity, by the room it has", () => {
  const plainRows = (input: Parameters<typeof renderHome>[0]) => renderHome(input).map(text)
  const hasTitle = (rows: string[]) => rows.some((row) => row.includes(LOGO_TITLE[1]!))
  const hasMark = (rows: string[]) => rows.some((row) => row.includes(LOGO_MARK[0]!))
  const hasName = (rows: string[]) => rows.some((row) => row.trim() === "MendCode")
  test("wide and tall (120 x 34): the mark over the big title, with no small name", () => {
    const rows = plainRows({ ...base, width: 120, height: 30, screenHeight: 34 })
    expect([hasMark(rows), hasTitle(rows), hasName(rows)]).toEqual([true, true, false])
    const lefts = LOGO_TITLE.map((row) => rows.find((line) => line.includes(row))!.indexOf(row))
    expect(new Set(lefts).size).toBe(1)
    expect(lefts[0]).toBe(Math.floor((120 - 58) / 2))
  })
  test("80 x 24 holds the big title over an empty session list", () => {
    expect(hasTitle(plainRows({ ...base, width: 80, height: 20, screenHeight: 24 }))).toBe(true)
  })
  test("too narrow for the title (under 70 columns): the mark with the small name under it", () => {
    const rows = plainRows({ ...base, width: 66, height: 30, screenHeight: 34 })
    expect([hasMark(rows), hasTitle(rows), hasName(rows)]).toEqual([true, false, true])
  })
  test("too short for the title: the mark with the small name; shorter still, the name alone", () => {
    const short = plainRows({ ...base, width: 120, height: 17, screenHeight: 24 })
    expect([hasMark(short), hasTitle(short), hasName(short)]).toEqual([true, false, true])
    const shorter = plainRows({ ...base, width: 120, height: 12, screenHeight: 24 })
    expect([hasMark(shorter), hasTitle(shorter), hasName(shorter)]).toEqual([false, false, true])
  })
  test("a session list the title would crowd keeps every row: the identity shrinks first", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({ title: `Task ${index}`, state: "working" as const, updatedAt: 0, startedAt: 0 }))
    const rows = plainRows({ ...base, width: 120, height: 24, screenHeight: 30, sessions })
    expect(hasTitle(rows)).toBe(false)
    for (let index = 0; index < 4; index++) expect(rows.join("\n")).toContain(`Task ${index}`)
  })
})

describe("the home's title", () => {
  test("left as shipped and too narrow for the big title, it is the mark with the product name centered under it, in the text color, in place of the pixel MENDCODE", () => {
    const rows = renderHome({ ...base, width: 66, height: 34, screenHeight: 40 })
    const plain = rows.map(text)
    const top = plain.findIndex((row) => row.includes(LOGO_MARK[0]!))
    for (let i = 0; i < LOGO_MARK.length; i++) expect(plain[top + i]!.indexOf(LOGO_MARK[i]!)).toBe(14)
    expect(plain[top + LOGO_MARK.length]!.trim()).toBe("")
    expect(plain[top + LOGO_MARK.length + 1]!.indexOf("MendCode")).toBe(29)
    expect(rows[top]!.find((span) => span.text === LOGO_MARK[0])).toMatchObject({ fg: "text" })
    expect(plain.join("\n")).not.toContain(logoRows()[0]!)
    // A renamed product is the name under the mark.
    expect(homeIdentity({ productName: "Acme" }).at(-1)!.trim()).toBe("Acme")
  })
  test("ASCII glyphs draw the ASCII mark", () => {
    expect(homeIdentity({ ascii: true }).slice(0, 8)).toEqual([...LOGO_MARK_ASCII])
    expect(homeIdentity({ ascii: true }).join("")).toMatch(/^[\x20-\x7e]*$/)
  })
  test("a wordmark of its own text or font stays those letters; beside a mascot the letters are the wordmark's own", () => {
    expect(homeIdentity({ logoText: "ACME" })).toEqual(logoRows("ACME"))
    expect(homeIdentity({ logoFont: "solid" })).toEqual(logoRows(undefined, "solid"))
    // `both` with the shipped wordmark draws the same letters as `wordmark` (the website's title), not another font; no mark, the mascot is the picture.
    const both = homeIdentity({ logoKind: "both" }).join("\n")
    for (const row of LOGO_TITLE) expect(both).toContain(row)
    expect(both).not.toContain(logoRows()[0]!)
    expect(both).not.toContain(LOGO_MARK[0]!)
    // A chosen font or text is used by both kinds alike.
    expect(homeIdentity({ logoKind: "both", logoFont: "solid" }).join("\n")).toContain(logoRows(undefined, "solid")[0]!)
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
