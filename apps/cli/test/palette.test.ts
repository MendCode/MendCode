import { describe, expect, test } from "bun:test"
import { composeOverlay, createPaletteState, filterPalette, fuzzyMatch, paletteKey, renderPalette, type PaletteItem, type PaletteState } from "../src/view/palette"
import type { Line } from "../src/ui/theme"
import { glyphs } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const items: PaletteItem[] = [
  { id: "command:new", kind: "command", title: "new", hint: "start a new session" },
  { id: "command:sessions", kind: "command", title: "sessions", hint: "switch session", keywords: "resume" },
  { id: "command:usage", kind: "command", title: "usage", hint: "usage and quota", keywords: "stats" },
  { id: "command:help", kind: "command", title: "help", hint: "keys and commands", keywords: "?" },
  { id: "session:a", kind: "session", title: "fix flaky reconnect", hint: "open", keywords: "/Users/dev/Code/MendCodeV2" },
  { id: "theme:mint", kind: "theme", title: "mint", hint: "current" },
  { id: "view:full", kind: "view", title: "full" },
  { id: "permission:ask", kind: "permission", title: "ask before edits" },
]
const many: PaletteItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `command:c${i}`, kind: "command", title: `command ${i}`, hint: `hint ${i}` }))

const text = (line: Line) => line.map((span) => span.text).join("")
const type = (state: PaletteState, keys: string) => keys.split("").reduce((s, k) => paletteKey(s, k, items).state, state)

describe("fuzzyMatch", () => {
  test("requires an ordered subsequence, case-insensitively", () => {
    expect(fuzzyMatch("USG", "usage")).toBeDefined()
    expect(fuzzyMatch("gsu", "usage")).toBeUndefined()
    expect(fuzzyMatch("xyz", "usage")).toBeUndefined()
    expect(fuzzyMatch("usagee", "usage")).toBeUndefined()
  })
  test("reports the matched positions", () => {
    expect(fuzzyMatch("use", "usage")?.positions).toEqual([0, 1, 4])
    expect(fuzzyMatch("fl", "fix flaky")?.positions).toEqual([0, 5])
  })
  test("spaces in the query are ignored", () => expect(fuzzyMatch("fix fl", "fix flaky")?.positions).toEqual([0, 1, 2, 4, 5]))
  test("prefix and word starts beat mid-word and scattered matches", () => {
    const score = (q: string, t: string) => fuzzyMatch(q, t)!.score
    expect(score("us", "usage")).toBeGreaterThan(score("us", "focus"))
    expect(score("fr", "fix reconnect")).toBeGreaterThan(score("fr", "afraid"))
    expect(score("use", "usage")).toBeGreaterThan(score("use", "uxsxe"))
  })
  test("contiguous runs beat gaps", () => expect(fuzzyMatch("ses", "sessions")!.score).toBeGreaterThan(fuzzyMatch("ses", "sxexs")!.score))
  test("an empty query matches everything", () => expect(fuzzyMatch("", "x")).toEqual({ score: 0, positions: [] }))
})

describe("filterPalette", () => {
  test("no query keeps the original order", () => expect(filterPalette(items, "").map((m) => m.item.id)).toEqual(items.map((i) => i.id)))
  test("best match first, ties by original order", () => {
    expect(filterPalette(items, "use")[0]!.item.id).toBe("command:usage")
    const same = filterPalette([{ id: "a", kind: "view", title: "same" }, { id: "b", kind: "view", title: "same" }], "same")
    expect(same.map((m) => m.item.id)).toEqual(["a", "b"])
  })
  test("falls back to keywords, hints and kind with a lower rank and no highlight", () => {
    const resume = filterPalette(items, "resume")
    expect(resume[0]!.item.id).toBe("command:sessions")
    expect(resume[0]!.positions).toEqual([])
    const title = filterPalette([{ id: "x", kind: "view", title: "resume now" }, { id: "y", kind: "view", title: "other", keywords: "resume" }], "resume")
    expect(title.map((m) => m.item.id)).toEqual(["x", "y"])
  })
  test("directory keywords find sessions", () => expect(filterPalette(items, "mendcodev2").map((m) => m.item.id)).toContain("session:a"))
  test("no match returns nothing", () => expect(filterPalette(items, "zzzz")).toEqual([]))
})

describe("paletteKey", () => {
  const start = createPaletteState()
  test("typing filters and resets the selection; multi-character chunks append", () => {
    const typed = paletteKey({ query: "u", selected: 3 }, "s", items)
    expect(typed.state).toEqual({ query: "us", selected: 0 })
    expect(paletteKey(start, "usa", items).state.query).toBe("usa")
  })
  test("backspace edits, ctrl+u clears, both no-ops when empty", () => {
    expect(paletteKey({ query: "ab", selected: 2 }, "\x7f", items).state).toEqual({ query: "a", selected: 0 })
    expect(paletteKey(start, "\x7f", items).state).toBe(start)
    expect(paletteKey({ query: "abc", selected: 1 }, "\x15", items).state).toEqual({ query: "", selected: 0 })
    expect(paletteKey(start, "\x15", items).state).toBe(start)
  })
  test("arrows, ctrl+n and ctrl+p move and clamp", () => {
    expect(paletteKey(start, "\x1b[B", items).state.selected).toBe(1)
    expect(paletteKey(start, "\x0e", items).state.selected).toBe(1)
    expect(paletteKey(start, "\x1b[A", items).state).toBe(start)
    expect(paletteKey({ query: "", selected: 1 }, "\x10", items).state.selected).toBe(0)
    expect(paletteKey({ query: "", selected: items.length - 1 }, "\x1b[B", items).state.selected).toBe(items.length - 1)
  })
  test("enter runs the selected filtered item", () => {
    expect(paletteKey(start, "\r", items).action).toEqual({ type: "run", item: items[0]! })
    const filtered = type(start, "use")
    expect(paletteKey(filtered, "\r", items).action).toEqual({ type: "run", item: items[2]! })
    expect(paletteKey({ query: "", selected: 2 }, "\r", items).action).toEqual({ type: "run", item: items[2]! })
  })
  test("enter with no match does nothing and esc closes", () => {
    expect(paletteKey({ query: "zzzz", selected: 0 }, "\r", items).action).toEqual({ type: "none" })
    expect(paletteKey(start, "\x1b", items).action).toEqual({ type: "close" })
  })
  test("control and escape sequences are ignored", () => {
    for (const key of ["\x1b[C", "\x03", "\t", "\x1b[<0;10;5M"]) expect(paletteKey(start, key, items).state).toBe(start)
  })
  test("an empty item list never throws", () => {
    for (const key of ["\x1b[B", "\r", "a"]) expect(() => paletteKey(start, key, [])).not.toThrow()
  })
})

describe("renderPalette", () => {
  const g = glyphs({})
  test.each([
    [60, 20],
    [100, 30],
    [160, 50],
    [30, 12],
    [100, 6],
    [100, 5],
  ])("overlay stays inside %ix%i", (width, height) => {
    for (const query of ["", "use", "zzz"]) {
      const overlay = renderPalette({ items: many, state: { query, selected: 30 }, width, height, glyphs: g })
      expect(overlay.top + overlay.rows.length).toBeLessThanOrEqual(height)
      for (const row of overlay.rows) {
        expect(textWidth(text(row))).toBe(textWidth(text(overlay.rows[0]!)))
        expect(overlay.left + textWidth(text(row))).toBeLessThanOrEqual(width)
      }
      expect(overlay.left).toBeGreaterThanOrEqual(0)
    }
  })
  test("tiny screens render no overlay", () => {
    expect(renderPalette({ items, state: createPaletteState(), width: 10, height: 20, glyphs: g }).rows).toEqual([])
    expect(renderPalette({ items, state: createPaletteState(), width: 100, height: 4, glyphs: g }).rows).toEqual([])
  })
  test("the card is v1's command dialog width (72% of the screen, at least 96, at most 148), centered", () => {
    const at = (width: number) => renderPalette({ items: many, state: createPaletteState(), width, height: 50, glyphs: g })
    expect(textWidth(text(at(120).rows[0]!))).toBe(96)
    expect(at(120).left).toBe(12)
    expect(textWidth(text(at(160).rows[0]!))).toBe(115)
    expect(textWidth(text(at(300).rows[0]!))).toBe(148)
    expect(textWidth(text(at(80).rows[0]!))).toBe(78)
  })
  test("the card sits on the panel fill: every cell has the panel or primary background, no box drawing", () => {
    const rows = renderPalette({ items, state: { query: "", selected: 1 }, width: 120, height: 35, glyphs: g }).rows
    for (const row of rows) {
      for (const span of row) expect(["panel", "primary"]).toContain(span.bg as string)
      expect(text(row)).not.toMatch(/[╭╮╰╯│├┤─]/)
    }
  })
  test("title row, search line and key hints", () => {
    const rows = renderPalette({ items, state: createPaletteState(), width: 120, height: 35, glyphs: g }).rows
    expect(text(rows[1]!)).toMatch(/^ {3}Commands +esc {3}$/)
    expect(rows[1]!.find((span) => span.text === "Commands")).toMatchObject({ fg: "text", bold: true })
    expect(text(rows[3]!)).toContain("search commands, /slash, shortcut...")
    expect(text(rows[3]!)).toContain(`1/${items.length}`)
    const hints = rows.map(text).find((row) => row.includes("Run enter"))!
    expect(hints).toContain("Move ↑↓")
    expect(hints).toContain("Close esc")
  })
  test("the search line shows the query in text color and the cursor sits after it", () => {
    const overlay = renderPalette({ items, state: { query: "use", selected: 0 }, width: 120, height: 35, glyphs: g })
    expect(text(overlay.rows[3]!)).toContain("use")
    expect(text(overlay.rows[3]!)).not.toContain("search commands")
    expect(text(overlay.rows[3]!)).toContain("1/")
    expect(overlay.cursor).toEqual({ row: overlay.top + 3, col: overlay.left + 3 + 3 })
    const compact = renderPalette({ items, state: { query: "use", selected: 0 }, width: 120, height: 14, glyphs: g })
    expect(compact.cursor.row).toBe(compact.top + 1)
  })
  test("without a query the list has category headings in accent bold and a gap between groups", () => {
    const rows = renderPalette({ items, state: createPaletteState(), width: 120, height: 35, glyphs: g }).rows
    const lines = rows.map(text)
    const headings = lines.map((line) => line.trim()).filter((line) => ["Commands", "Sessions", "Themes", "Views", "Permissions"].includes(line))
    expect(headings).toEqual(["Commands", "Sessions", "Themes", "Views"])
    const sessions = lines.findIndex((line) => line.trim() === "Sessions")
    expect(lines[sessions - 1]!.trim()).toBe("")
    expect(rows[sessions]!.find((span) => span.text === "Sessions")).toMatchObject({ fg: "accent", bold: true })
  })
  test("a search is one flat list with the kind as a muted footer", () => {
    const lines = renderPalette({ items, state: { query: "th", selected: 0 }, width: 120, height: 35, glyphs: g }).rows.map(text)
    expect(lines.filter((line) => line.trim() === "Themes")).toHaveLength(0)
    const theme = lines.find((line) => line.includes("mint"))
    expect(theme).toMatch(/mint +theme {3}$/)
  })
  test("rows show the title, the hint as a muted description, and the current item with ●", () => {
    const rows = renderPalette({ items, state: createPaletteState(), width: 120, height: 35, glyphs: g }).rows
    const lines = rows.map(text)
    expect(lines.find((line) => line.includes("new") && line.includes("start a new session"))).toMatch(/new {2}start a new session/)
    const mint = lines.findIndex((line) => line.includes("mint"))
    expect(lines[mint]).toContain("●")
    expect(lines[mint]).not.toContain("current")
    expect(rows[mint]!.find((span) => span.text === "●")).toMatchObject({ fg: "primary" })
    const flagged = renderPalette({ items: [{ id: "a", kind: "view", title: "full", current: true }, { id: "b", kind: "view", title: "minimal" }], state: { query: "", selected: 1 }, width: 120, height: 35, glyphs: g }).rows.map(text)
    expect(flagged.find((line) => line.includes("full"))).toContain("●")
    expect(flagged.find((line) => line.includes("minimal"))).not.toContain("●")
  })
  test("the selected row is a full-width primary bar with background text; only that row", () => {
    const overlay = renderPalette({ items, state: { query: "", selected: 1 }, width: 120, height: 35, glyphs: g })
    const bars = overlay.rows.filter((row) => row.some((span) => span.bg === "primary"))
    expect(bars).toHaveLength(1)
    const bar = bars[0]!
    expect(text(bar)).toContain("sessions")
    expect(bar.every((span) => span.bg === "primary")).toBe(true)
    expect(bar.filter((span) => span.text.trim()).every((span) => span.fg === "background")).toBe(true)
    expect(textWidth(text(bar))).toBe(textWidth(text(overlay.rows[0]!)))
  })
  test("matched characters are primary bold on plain rows and bold on the bar", () => {
    const overlay = renderPalette({ items, state: { query: "use", selected: 0 }, width: 120, height: 35, glyphs: g })
    const bar = overlay.rows.find((row) => row.some((span) => span.bg === "primary"))!
    expect(bar.find((span) => span.text === "us")).toMatchObject({ fg: "background", bold: true })
    const other = renderPalette({ items, state: { query: "us", selected: 1 }, width: 120, height: 35, glyphs: g }).rows
    const row = other.find((r) => text(r).includes("usage") && !r.some((span) => span.bg === "primary"))!
    expect(row.find((span) => span.text === "us")).toMatchObject({ fg: "primary", bold: true })
  })
  test("the window follows the selection through headings", () => {
    const groups: PaletteItem[] = [...many, ...Array.from({ length: 10 }, (_, i): PaletteItem => ({ id: `theme:t${i}`, kind: "theme", title: `theme ${i}` }))]
    const overlay = renderPalette({ items: groups, state: { query: "", selected: 45 }, width: 120, height: 40, glyphs: g })
    const rows = overlay.rows
    const bar = rows.filter((row) => row.some((span) => span.bg === "primary"))
    expect(bar).toHaveLength(1)
    expect(text(bar[0]!)).toContain("theme 5")
    expect(text(rows[3]!)).toContain("46/50")
    expect(text(rows[4]!).trim()).toBe("")
    expect(text(rows[5]!).trim()).not.toBe("")
  })
  test("no match shows v1's message", () => {
    const lines = renderPalette({ items, state: { query: "zzzz", selected: 0 }, width: 120, height: 35, glyphs: g }).rows.map(text)
    expect(lines.some((line) => line.includes("No results found"))).toBe(true)
    expect(lines.filter((line) => line.includes("Run enter"))).toHaveLength(1)
  })
  test("long titles are truncated and never break the card", () => {
    const long: PaletteItem[] = [{ id: "s", kind: "session", title: "x".repeat(300), hint: "h".repeat(100) }]
    const overlay = renderPalette({ items: long, state: createPaletteState(), width: 60, height: 20, glyphs: g })
    for (const row of overlay.rows) expect(textWidth(text(row))).toBe(textWidth(text(overlay.rows[0]!)))
    expect(overlay.rows.map(text).some((line) => line.includes("…"))).toBe(true)
  })
  test("narrow cards drop the key hints that do not fit", () => {
    const overlay = renderPalette({ items, state: createPaletteState(), width: 30, height: 20, glyphs: g })
    for (const row of overlay.rows) expect(textWidth(text(row))).toBe(textWidth(text(overlay.rows[0]!)))
    expect(overlay.rows.map(text).some((line) => line.includes("Run enter"))).toBe(true)
  })
})

describe("paletteKey paging", () => {
  const start = createPaletteState()
  test("page down and up move by ten and clamp; home and end jump", () => {
    expect(paletteKey(start, "\x1b[6~", many).state.selected).toBe(10)
    expect(paletteKey({ query: "", selected: 35 }, "\x1b[6~", many).state.selected).toBe(39)
    expect(paletteKey({ query: "", selected: 12 }, "\x1b[5~", many).state.selected).toBe(2)
    expect(paletteKey({ query: "", selected: 5 }, "\x1b[5~", many).state.selected).toBe(0)
    expect(paletteKey({ query: "", selected: 12 }, "\x1b[H", many).state.selected).toBe(0)
    expect(paletteKey(start, "\x1b[F", many).state.selected).toBe(39)
    expect(paletteKey(start, "\x1bOF", many).state.selected).toBe(39)
  })
})

describe("composeOverlay", () => {
  const page = (width: number, height: number): Line[] => Array.from({ length: height }, (_, y) => [{ text: `${String(y % 10).repeat(width)}`, fg: "body" as const }])
  test("paints the box over the page and leaves other rows untouched", () => {
    const base = page(80, 20)
    const overlay = renderPalette({ items, state: createPaletteState(), width: 80, height: 20, glyphs: glyphs({}) })
    const out = composeOverlay(base, overlay, 80)
    expect(out).toHaveLength(20)
    for (let y = 0; y < 20; y++) {
      const inside = y >= overlay.top && y < overlay.top + overlay.rows.length
      if (inside) {
        const line = text(out[y]!)
        expect(textWidth(line)).toBe(80)
        expect(line.startsWith(String(y % 10).repeat(overlay.left))).toBe(true)
        expect(line.endsWith(String(y % 10).repeat(80 - overlay.left - textWidth(text(overlay.rows[0]!))))).toBe(true)
      } else expect(out[y]).toEqual(base[y]!)
    }
  })
  test("short page rows are padded so the box stays in place", () => {
    const overlay = renderPalette({ items, state: createPaletteState(), width: 80, height: 20, glyphs: glyphs({}) })
    const out = composeOverlay(Array.from({ length: 20 }, (): Line => []), overlay, 80)
    const row = text(out[overlay.top]!)
    expect(row.indexOf("Commands")).toBe(overlay.left + 3)
    expect(textWidth(row)).toBeLessThanOrEqual(80)
  })
  test("wide characters cut by the box edge become spaces", () => {
    const base: Line[] = [[{ text: "日本語".repeat(20) }]]
    const overlay = { rows: [[{ text: "[]" }]], top: 0, left: 5, cursor: { row: 0, col: 0 } }
    const line = text(composeOverlay(base, overlay, 60)[0]!)
    expect(textWidth(line)).toBe(60)
    expect(line).toContain("[]")
    expect(line.startsWith("日本 []")).toBe(true)
  })
  test("an empty overlay returns the page unchanged", () => {
    const base = page(10, 3)
    expect(composeOverlay(base, { rows: [], top: 0, left: 0, cursor: { row: 0, col: 0 } }, 10)).toBe(base)
  })
})
