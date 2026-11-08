import { afterEach, describe, expect, test } from "bun:test"
import { renderHome, type HomeLook } from "../src/view/home"
import { LOGO_MARK, LOGO_TITLE } from "../src/view/logo-mark"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { appHarness, scratch } from "./extensions-harness"

/** The home's identity settings: the logo's size, the block's place, and a logo that keeps its size while the slash menu is open. */

const plain = (line: Array<{ text: string }>) => line.map((span) => span.text).join("")
const rowsOf = (look: HomeLook, size = { width: 150, height: 33, screenHeight: 36 }) => renderHome({ ...size, root: "~/x", look }).map(plain)
const has = (rows: string[], row: string) => rows.some((line) => line.includes(row))

describe("Logo size", () => {
  test("large draws the mark over the big title, medium the mark over the name, small the name alone", () => {
    const large = rowsOf({ logoSize: "large" })
    expect([has(large, LOGO_MARK[0]!), has(large, LOGO_TITLE[1]!)]).toEqual([true, true])
    const medium = rowsOf({ logoSize: "medium" })
    expect([has(medium, LOGO_MARK[0]!), has(medium, LOGO_TITLE[1]!)]).toEqual([true, false])
    expect(medium.some((line) => line.trim() === "MendCode")).toBe(true)
    const small = rowsOf({ logoSize: "small" })
    expect([has(small, LOGO_MARK[0]!), has(small, LOGO_TITLE[1]!)]).toEqual([false, false])
    expect(small.some((line) => line.trim() === "MendCode")).toBe(true)
  })

  test("both draws the same letters as the wordmark at each size", () => {
    expect(has(rowsOf({ logoKind: "both", logoSize: "large" }), LOGO_TITLE[1]!)).toBe(true)
    const medium = rowsOf({ logoKind: "both", logoSize: "medium" })
    expect(has(medium, LOGO_TITLE[1]!)).toBe(false)
    expect(medium.some((line) => line.trim() === "MendCode")).toBe(true)
  })

  test("a pixel mascot follows the size too: small draws no picture, medium keeps the picture with the name, not the big title", () => {
    const sprite = (cols: number, rows: number) => Array.from({ length: rows }, () => [{ text: "▀".repeat(cols), fgHex: "#9c7ae8" }])
    const mascot = { pixel: { boxes: [{ cols: 22, rows: 11 }], lines: sprite } }
    const lines = (logoSize: HomeLook["logoSize"]) => renderHome({ width: 150, height: 40, screenHeight: 44, root: "~/x", look: { logoKind: "both", logoSize }, mascot })
    const drawn = (logoSize: HomeLook["logoSize"]) => lines(logoSize).some((line) => line.some((span) => (span as { fgHex?: string }).fgHex === "#9c7ae8"))
    expect([drawn("large"), drawn("medium"), drawn("small")]).toEqual([true, true, false])
    expect(has(lines("large").map(plain), LOGO_TITLE[1]!)).toBe(true)
    expect(has(lines("medium").map(plain), LOGO_TITLE[1]!)).toBe(false)
  })

  test("the large title sits two rows under the mark where the screen has them, one at 80 x 24", () => {
    const gap = (rows: string[]) => rows.findIndex((line) => line.includes(LOGO_TITLE[0]!)) - rows.findIndex((line) => line.includes(LOGO_MARK.at(-1)!)) - 1
    expect(gap(rowsOf({}))).toBe(2)
    expect(gap(rowsOf({}, { width: 80, height: 20, screenHeight: 24 }))).toBe(1)
  })
})

describe("Home position", () => {
  test("top puts the logo right under the header row; center leaves rows above it", () => {
    const markRow = (rows: string[]) => rows.findIndex((line) => line.includes(LOGO_MARK[0]!))
    const top = markRow(rowsOf({ homeAlign: "top" }))
    const center = markRow(rowsOf({ homeAlign: "center" }))
    expect(top).toBe(3)
    expect(center).toBeGreaterThan(top)
  })

  test("both settings default to what the home did before, and unknown values fall back", () => {
    expect([DEFAULT_TUI_PROFILE.logoSize, DEFAULT_TUI_PROFILE.homeAlign]).toEqual(["large", "center"])
    const read = normalizeTuiProfile({ logoSize: "huge", homeAlign: "left" } as unknown as Partial<TuiProfile>)
    expect([read.logoSize, read.homeAlign]).toEqual(["large", "center"])
  })
})

describe("the slash menu over the home", () => {
  const made: Array<{ cleanup(): void }> = []
  afterEach(() => { for (const temp of made.splice(0)) temp.cleanup() })

  test("typing / keeps the logo's size and rows; the menu covers the bottom of the home, not the logo", async () => {
    const temp = scratch()
    made.push(temp)
    temp.write("data/tui/profile.json", JSON.stringify(DEFAULT_TUI_PROFILE))
    const h = await appHarness({ dataDir: temp.dataDir, width: 150, height: 36 })
    await h.start({ onboarded: true } as never)
    const logo = (text: string) => text.split("\n").flatMap((line, row) => (line.includes(LOGO_MARK[0]!) || line.includes(LOGO_TITLE[0]!) ? [row] : []))
    const before = logo(h.text())
    expect(before).toHaveLength(2)
    await h.type("/")
    expect(logo(h.text())).toEqual(before)
    await h.type("pr")
    expect(logo(h.text())).toEqual(before)
  })
})
