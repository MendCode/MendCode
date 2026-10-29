import { afterEach, describe, expect, test } from "bun:test"
import { createCustomizePageState, customizePageKey, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { parseDiff, renderSplitDiffRows, renderToolCard, splitDiffAt, SPLIT_DIFF_AUTO_WIDTH, SPLIT_DIFF_MIN_WIDTH } from "../src/view/tool-card"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness as extensionsApp, scratch } from "./extensions-harness"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

const DIFF = [
  "@@ -12,5 +12,5 @@",
  " export function total(items: Item[]) {",
  "-  let sum = 0",
  "-  for (const item of items) sum += item.price",
  "+  const sum = items.reduce((acc, item) => acc + item.price * item.qty, 0)",
  "-  return sum",
  "+  return Math.round(sum * 100) / 100",
  " }",
].join("\n")
const plain = (line: { text: string }[]) => line.map((span) => span.text).join("")
const card = (width: number, splitDiff: boolean, text = DIFF) => renderToolCard({ title: "edit: src/cart.ts", text, status: "ok", width, expanded: true, level: "preview", frame: 0, tailLines: 0, splitDiff }).map(plain)

const apps: ReturnType<typeof appHarness>[] = []
const dirs: Array<ReturnType<typeof scratch>> = []
afterEach(async () => {
  const results = await Promise.allSettled(apps.splice(0).map((h) => h.app.onKey("\x03")))
  cleanTemps()
  for (const dir of dirs.splice(0)) dir.cleanup()
  for (const result of results) if (result.status === "rejected") throw result.reason
})

describe("unified diff rows", () => {
  test("a line too long for the card wraps under its own indentation, its first row keeping it", () => {
    const rows = card(60, false)
    const at = rows.findIndex((row) => row.includes("+   const sum"))
    expect(at).toBeGreaterThan(-1)
    const code = rows[at]!.indexOf("const sum")
    expect(rows[at + 1]!.slice(0, code).trim()).toBe("│")
    expect(rows[at + 1]![code]).not.toBe(" ")
  })
})

describe("split diff rows", () => {
  test("a removal faces the addition that replaced it, old numbers on the left and new on the right", () => {
    const rows = renderSplitDiffRows(parseDiff(DIFF)!.rows, 160).map(plain)
    const returned = rows.find((row) => row.includes("return sum"))!
    expect(returned).toMatch(/15 -   return sum +│ 14 \+   return Math\.round/)
    const kept = rows.find((row) => row.includes("export function"))!
    expect(kept).toMatch(/12   export function total.*│ 12   export function total/)
    // Two removals and one addition before `return`: the second removal faces an empty half.
    expect(rows.find((row) => row.includes("for (const item"))!).toMatch(/14 -   for \(const item of items\) sum \+= item\.price +│ +$/)
  })

  test("a line too long for its half wraps under its own indentation, and no row passes the width", () => {
    for (const width of [60, 100, 160]) {
      const rows = renderSplitDiffRows(parseDiff(DIFF)!.rows, width).map(plain)
      expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
      expect(rows.every((row) => row.includes("│"))).toBe(true)
    }
    const narrow = renderSplitDiffRows(parseDiff(DIFF)!.rows, 100).map(plain)
    const at = narrow.findIndex((row) => row.includes("const sum = items.reduce"))
    const continued = narrow[at + 1]!.split("│").at(-1)!
    expect(continued).toMatch(/^ {8}\S/)
  })

  test("split needs 100 columns and auto 160; unified never splits", () => {
    expect([SPLIT_DIFF_MIN_WIDTH, SPLIT_DIFF_AUTO_WIDTH]).toEqual([100, 160])
    expect(splitDiffAt("split", 99)).toBe(false)
    expect(splitDiffAt("split", 100)).toBe(true)
    expect(splitDiffAt("auto", 159)).toBe(false)
    expect(splitDiffAt("auto", 160)).toBe(true)
    expect(splitDiffAt("unified", 400)).toBe(false)
  })

  test("a file that only gains lines stays unified even when split is asked", () => {
    const added = "@@ -0,0 +1,2 @@\n+one\n+two"
    // The card's rail is one `│`; a split row has the gutter as a second.
    const halves = (row: string) => row.split("│").length - 1 === 2
    expect(card(160, true, added).some(halves)).toBe(false)
    expect(card(160, true).filter(halves).length).toBeGreaterThan(3)
  })

  test("the profile keeps a known value and drops anything else to unified", () => {
    expect(DEFAULT_TUI_PROFILE.diffView).toBe("unified")
    expect(normalizeTuiProfile({ diffView: "split" }).diffView).toBe("split")
    expect(normalizeTuiProfile({ diffView: "sideways" }).diffView).toBe("unified")
  })
})

describe("diffView in the running app", () => {
  test("split draws an edit side by side once the chat column has 100 columns and falls back to unified below", async () => {
    // The chat column is the terminal less its margins and scrollbar: a 100 column terminal gives the transcript fewer than 100.
    for (const [width, split] of [[80, false], [100, false], [160, true]] as const) {
      const dir = scratch()
      dirs.push(dir)
      writeTuiProfile(dir.dataDir, { ...DEFAULT_TUI_PROFILE, diffView: "split" })
      const h = await extensionsApp({ dataDir: dir.dataDir, width, height: 30 })
      await h.start()
      h.tool("edit: src/cart.ts", DIFF)
      const rows = h.rows()
      expect(rows.some((row) => /return sum +│ +\d+ \+ +return Math/.test(row))).toBe(split)
      expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
    }
  })

  test("/customize: the row cycles unified, split, auto, saves the choice and its preview fits 40 to 160 columns", async () => {
    const row = CUSTOMIZE_ROWS.indexOf("diffView")
    const action = customizePageKey({ ...createCustomizePageState(), row }, "\x1b[C", DEFAULT_TUI_PROFILE).action
    expect(action).toEqual({ type: "set", patch: { diffView: "split" } })
    for (const [width, height] of [[40, 20], [60, 24], [80, 24], [100, 30], [160, 40]] as const) {
      const dataDir = tempDir()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
      const h = appHarness({ dataDir, width, height })
      apps.push(h)
      await h.type("/customize\r")
      for (let i = 0; i < row; i++) await h.app.onKey("\x1b[B")
      expect(h.text().join("\n")).toMatch(/Diff view +‹ unified ›/)
      expect(h.text().join("\n")).toContain("Diff preview")
      await h.app.onKey("\x1b[C")
      const text = h.text().join("\n")
      expect(text).toMatch(/Diff view +‹ split ›/)
      // The note wraps inside the pane: read it as one line.
      const note = text.replace(/[│\n]/g, " ").replace(/ +/g, " ")
      const side = /Side by side: the chat is (\d+) columns/.exec(note)
      const unified = /Unified here: split needs 100 chat columns, the chat is (\d+)/.exec(note)
      expect(Boolean(side) !== Boolean(unified)).toBe(true)
      const chat = Number((side ?? unified)![1])
      expect(Boolean(side)).toBe(chat >= SPLIT_DIFF_MIN_WIDTH)
      expect(Boolean(side)).toBe(width >= 100)
      expect(h.text()).toHaveLength(height)
      expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
      expect(readTuiProfile(dataDir).diffView).toBe("split")
    }
  }, 30_000)
})
