import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { meter } from "../src/view/panel-card"
import { ORBIT_CARD_ROWS, orbitDetails, renderOrbit, type OrbitCamera, type OrbitGraph } from "../src/view/panel-orbit"
import { textWidth } from "../src/view/wrap"

/** The Galaxy panel's Top card: one meter column for every row, whatever the count's width; the rest of the panel fits the sheet it has. */
const NOW = new Date(2026, 9, 8, 15, 40).getTime()
const plain = (line: Line) => line.map((span) => span.text).join("")
const node = (id: string, kind: OrbitGraph["nodes"][number]["kind"], label: string, activity: number, at = NOW - 60_000) => ({ id, kind, label, target: label, activity, at })
/** A session's code graph: files and the symbols the session looked up in them, with the tool that used each link. */
const graph: OrbitGraph = {
  nodes: [node("a", "symbol", "renderToolCard", 38), node("t1", "symbol", "cardRows", 8), node("t2", "symbol", "parseDiff", 8), node("t3", "symbol", "defaultBody", 5), node("t4", "symbol", "chatView", 4), node("f1", "file", "apps/cli/src/view/a-very-long-file-name-for-a-narrow-sheet.ts", 6), node("m1", "file", "apps/cli/src/view/footer.ts", 0)],
  edges: [["a", "t1"], ["a", "t2"], ["t3", "a"], ["f1", "t3"]],
  touches: [{ from: "f1", to: "t3", at: NOW - 20_000, tool: "graph_callers" }, { from: "a", to: "t2", at: NOW - 90_000, tool: "graph_callers" }],
}
const camera: OrbitCamera = { yaw: 0.6, pitch: 0.2, selected: 0, focused: true }
const details = (width: number, options: { ascii?: boolean; graph?: OrbitGraph } = {}) => orbitDetails({ graph: options.graph ?? graph, camera, width, now: NOW, ascii: options.ascii ?? false, rows: ORBIT_CARD_ROWS })

/** The cells of a row that are the meter: spans made of block glyphs (or `#` / `-` in ASCII), and where they start and end. */
function meterOf(line: Line, ascii = false) {
  let col = 0
  let start = -1
  let end = -1
  for (const span of line) {
    const isMeter = ascii ? /^[#-]+$/.test(span.text) && span.text.length > 1 || (span.fg !== "muted" && /^[#-]$/.test(span.text)) : /^[█▏▎▍▌▋▊▉░]+$/.test(span.text)
    if (isMeter) {
      if (start < 0) start = col
      end = col + textWidth(span.text)
    }
    col += textWidth(span.text)
  }
  return { start, end }
}

describe("the Top card's meters", () => {
  for (const width of [54, 40, 30, 22]) {
    test(`every row has its meter at the same column and width at ${width} columns`, () => {
      const rows = details(width).top
      expect(rows.length).toBeGreaterThanOrEqual(5)
      const first = meterOf(rows[0]!)
      expect(first.start).toBeGreaterThan(0)
      for (const row of rows) {
        expect(textWidth(plain(row))).toBe(width)
        expect(meterOf(row)).toEqual(first)
      }
    })
  }

  test("counts are right-aligned in a column as wide as the widest count", () => {
    const rows = details(54).top.map(plain)
    expect(rows.map((row) => row.slice(-3))).toEqual([" 38", "  8", "  8", "  6", "  5"])
  })

  test("a bar uses eighths of a cell, so 4 and 5 are not the same bar", () => {
    const cells = (activity: number) => meter({ ratio: activity / 38, cells: 10, color: "info" }).map((span) => span.text).join("")
    expect(cells(5)).not.toBe(cells(4))
    expect(cells(38)).toBe("██████████")
    expect(cells(1)).toMatch(/^[▏▎▍▌▋▊▉]/)
    expect(textWidth(cells(5))).toBe(10)
    expect(meter({ ratio: 0, cells: 6, color: "info" }).map((span) => span.text).join("")).toBe("░░░░░░")
  })

  test("the track is a glyph of its own in the border role, so a bar reads with no colour at all", () => {
    const spans = meter({ ratio: 0.34, cells: 10, color: "info" })
    expect(spans[0]).toMatchObject({ text: "███", fg: "info" })
    expect(spans[1]).toMatchObject({ text: "▍", fg: "info" })
    expect(spans[2]).toMatchObject({ text: "░░░░░░", fg: "border" })
    for (const span of spans) expect(span.dim).toBeUndefined()
    const bare = (activity: number) => meter({ ratio: activity / 38, cells: 10, color: "info" }).map((span) => span.text).join("")
    expect(bare(4)).toBe("█░░░░░░░░░")
    expect(bare(5)).toBe("█▍░░░░░░░░")
  })

  test("ASCII mode keeps the same columns with # and -", () => {
    const rows = details(40, { ascii: true }).top
    const first = meterOf(rows[0]!, true)
    for (const row of rows) {
      expect(plain(row)).toMatch(/^[\x20-\x7e]+$/)
      expect(textWidth(plain(row))).toBe(40)
      expect(meterOf(row, true)).toEqual(first)
    }
    expect(plain(rows[0]!)).toContain("######## 38")
    expect(plain(rows[1]!)).toContain("##------  8")
  })

  test("the label is cut to what the meter and count leave", () => {
    const rows = details(30).top.map(plain)
    expect(rows[3]).toContain("a-very-long")
    expect(rows[3]!.includes("…")).toBe(true)
    expect(meterOf(details(30).top[3]!)).toEqual(meterOf(details(30).top[0]!))
  })
})

describe("the rest of the Galaxy panel fits the sheet it has", () => {
  test("a recent row keeps its age when the name is long", () => {
    for (const width of [30, 24]) {
      const rows = details(width).recent.map(plain)
      for (const row of rows) {
        expect(textWidth(row)).toBe(width)
        expect(row).toMatch(/\d+[sm] ago$/)
      }
    }
  })

  test("at rest the one status row counts files, symbols and links, dropping the nouns before cutting a count", () => {
    const resting = { ...camera, focused: false }
    for (const width of [80, 56, 40, 30, 22]) {
      const rows = renderOrbit(graph, width, 20, resting).map(plain)
      expect(rows).toHaveLength(20)
      const legend = rows.at(-1)!
      expect(textWidth(legend)).toBe(width)
      for (const glyph of ["▣", "◆"]) expect(legend).toContain(glyph)
      // No key hints and no node details while the panel is not focused.
      expect(rows.join("\n")).not.toMatch(/hjkl|tab|enter|zoom|\d+%/)
    }
    expect(plain(renderOrbit(graph, 56, 20, resting).at(-1)!).trimEnd()).toBe("▣ 2 files · ◆ 5 symbols · 4 links")
    expect(plain(renderOrbit(graph, 22, 20, resting).at(-1)!).trimEnd()).toBe("▣ 2 · ◆ 5 · 4")
  })

  test("focused, the same one row names the selected node and the keys in the longest wording that fits", () => {
    const wide = renderOrbit(graph, 56, 20, camera).map(plain)
    expect(wide.at(-1)!.trimEnd()).toBe("renderToolCard · hjkl · tab · enter · f type · m code")
    const narrow = renderOrbit(graph, 30, 20, camera).map(plain)
    expect(narrow.at(-1)!.trimEnd()).toBe("hjkl · tab · enter · f · m")
    for (const rows of [wide, narrow]) expect(rows.filter((row) => /hjkl/.test(row))).toHaveLength(1)
  })
})

describe("the galaxy is round at the terminal's own cell shape", () => {
  // Braille dots of a cell, as [bit, column, row]: two columns of four.
  const DOTS = [[1, 0, 0], [2, 0, 1], [4, 0, 2], [64, 0, 3], [8, 1, 0], [16, 1, 1], [32, 1, 2], [128, 1, 3]] as const
  /**
   * The dust seen from above (`pitch: Math.PI / 2`) over half a turn, measured in braille dots and in cells. One frame is not enough:
   * two arms do not fill their circle, so a single yaw is wider than tall or the reverse; turning them sweeps the whole disc.
   */
  const extent = (aspect?: number) => {
    const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
    const cells = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
    for (let turn = 0; turn < 8; turn++) {
      const rows = renderOrbit(graph, 52, 27, { ...camera, yaw: turn * Math.PI / 8, pitch: Math.PI / 2, aspect }, false, { now: NOW, reduced: true }).slice(0, 26).map(plain)
      rows.forEach((row, y) => [...row].forEach((char, x) => {
        if (char < "⠁" || char > "⣿") return
        cells.left = Math.min(cells.left, x); cells.right = Math.max(cells.right, x); cells.top = Math.min(cells.top, y); cells.bottom = Math.max(cells.bottom, y)
        for (const [bit, dx, dy] of DOTS) if ((char.charCodeAt(0) - 0x2800) & bit) {
          box.left = Math.min(box.left, x * 2 + dx); box.right = Math.max(box.right, x * 2 + dx); box.top = Math.min(box.top, y * 4 + dy); box.bottom = Math.max(box.bottom, y * 4 + dy)
        }
      }))
    }
    return { cols: cells.right - cells.left + 1, rows: cells.bottom - cells.top + 1, dotsWide: box.right - box.left + 1, dotsTall: box.bottom - box.top + 1, cells }
  }
  /** Width and height of the dust in pixels at a cell of `width` x `height` pixels (a dot is half a cell wide and a quarter tall). */
  const pixels = (width: number, height: number) => {
    const seen = extent(height / width)
    return { wide: seen.dotsWide * width / 2, tall: seen.dotsTall * height / 4, seen }
  }
  test("a taller cell gets fewer rows for the same width, so the disc spans as many pixels wide as tall", () => {
    const tall = pixels(14, 32), even = pixels(8, 16)
    expect(Math.abs(tall.wide - tall.tall)).toBeLessThanOrEqual(32)
    expect(Math.abs(even.wide - even.tall)).toBeLessThanOrEqual(16)
    expect(tall.seen.cols).toBe(even.seen.cols)
    expect(tall.seen.rows).toBeLessThan(even.seen.rows)
    // No cell size given is the 1:2 cell.
    expect(extent()).toEqual(even.seen)
    // Centred in the 52x26 canvas and inside it, at both cell shapes.
    for (const { cells } of [tall.seen, even.seen]) {
      expect(Math.abs(cells.left + cells.right - 51)).toBeLessThanOrEqual(1)
      expect(Math.abs(cells.top + cells.bottom - 25)).toBeLessThanOrEqual(1)
      expect(cells.left).toBeGreaterThanOrEqual(0)
      expect(cells.right).toBeLessThanOrEqual(51)
    }
    // A wild report is clamped: the galaxy never collapses or overflows its sheet.
    expect(extent(40).rows).toBe(extent(3).rows)
    expect(extent(.2).rows).toBe(extent(1.5).rows)
  })
})
