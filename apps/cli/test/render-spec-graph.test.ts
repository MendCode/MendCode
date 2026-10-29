import { describe, expect, test } from "bun:test"
import type { RenderNode } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { renderSpecLines } from "../src/view/render-spec"

const plain = (line: Line) => line.map((span) => span.text).join("")

const edges = [
  { from: "app", to: "router", relation: "uses" },
  { from: "app", to: "store", relation: "reads" },
  { from: "cache", to: "app", relation: "feeds" },
  { from: "app", to: "logger" },
  { from: "store", to: "db", relation: "writes" },
]

const graph = (overrides: Partial<Extract<RenderNode, { type: "graph" }>> = {}): RenderNode => ({ type: "graph", root: "app", edges, title: "Dependencies", ...overrides })
const render = (node: RenderNode, width: number, ascii = false) => renderSpecLines(node, width, { ascii }).map(plain)

describe("renderSpec graph", () => {
  for (const width of [60, 80, 120]) {
    test(`every row is exactly ${width} cells wide inside a rounded frame`, () => {
      const rows = render(graph(), width)
      for (const row of rows) expect(Bun.stringWidth(row)).toBe(width)
      expect(rows.length).toBeGreaterThanOrEqual(7)
      expect(rows.length).toBeLessThanOrEqual(15)
      expect(rows[0]!.startsWith("╭─ Dependencies ")).toBe(true)
      expect(rows[0]!.endsWith("╮")).toBe(true)
      expect(rows.at(-1)!.startsWith("╰")).toBe(true)
      expect(rows.at(-1)!.endsWith("╯")).toBe(true)
      const text = rows.join("\n")
      for (const name of ["app", "router", "store", "cache", "logger"]) expect(text).toContain(name)
    })
  }

  test("the root is drawn with its relation labels", () => {
    const text = render(graph(), 100).join("\n")
    expect(text).toContain("◉")
    expect(text).toContain("uses")
  })

  test("below 58 columns it lists one a --rel--> b row per edge, root first", () => {
    const rows = render(graph(), 50)
    expect(rows[0]).toBe("Dependencies".padEnd(50))
    expect(rows.slice(1, 5).map((row) => row.trimEnd())).toEqual(["app --uses--> router", "app --reads--> store", "cache --feeds--> app", "app → logger"])
    expect(rows[5]!.trimEnd()).toBe("store --writes--> db")
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(50)
  })

  test("narrow rows are truncated to the width", () => {
    const rows = render({ type: "graph", root: "a", edges: [{ from: "a", to: "b".repeat(80), relation: "long" }] }, 30)
    expect(rows).toHaveLength(1)
    expect(Bun.stringWidth(rows[0]!)).toBe(30)
    expect(rows[0]).toContain("…")
  })

  test("more than eight neighbours shows the first eight and a +N more row", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ from: "hub", to: `n${index + 1}` }))
    const wide = render({ type: "graph", root: "hub", edges: many }, 80)
    expect(wide.length).toBeLessThanOrEqual(15)
    expect(wide.some((row) => row.includes("+4 more"))).toBe(true)
    const text = wide.join("\n")
    expect(text).toContain("n8")
    expect(text).not.toContain("n9")
    for (const row of wide) expect(Bun.stringWidth(row)).toBe(80)
    const narrow = render({ type: "graph", root: "hub", edges: many }, 40)
    expect(narrow).toHaveLength(9)
    expect(narrow.at(-1)!.trimEnd()).toBe("+4 more")
  })

  test("ASCII glyph mode draws with plain ASCII only", () => {
    const rows = render(graph(), 80, true)
    expect(rows[0]!.startsWith("+- Dependencies ")).toBe(true)
    for (const row of rows) {
      expect(Bun.stringWidth(row)).toBe(80)
      expect(row).toMatch(/^[\x20-\x7e]*$/)
    }
    expect(rows.join("\n")).toContain("@")
    expect(rows.at(-1)).toBe(`+${"-".repeat(78)}+`)
  })

  test("no edges draws just the root", () => {
    const rows = render({ type: "graph", root: "solo", edges: [] }, 80)
    expect(rows).toHaveLength(7)
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(80)
    const text = rows.join("\n")
    expect(text).toContain("solo")
    expect(text).toContain("◉")
    expect(text.match(/[●◉]/g)).toHaveLength(1)
    expect(render({ type: "graph", root: "solo", edges: [] }, 40)).toEqual(["solo".padEnd(40)])
  })

  test("a graph with a title-less frame and a graph inside a box stay in width", () => {
    const rows = render({ type: "box", title: "deps", children: [graph({ title: undefined })] }, 70)
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(70)
    expect(rows.join("\n")).toContain("╭")
  })

  test("the frame never overflows with a very long title", () => {
    const rows = render(graph({ title: "t".repeat(200) }), 60)
    for (const row of rows) expect(Bun.stringWidth(row)).toBe(60)
  })
})
