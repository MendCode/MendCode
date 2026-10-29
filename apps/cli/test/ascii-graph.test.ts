import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { GRAPH_GLYPHS_ASCII, layoutGraph, nearestNode, renderGraph, type GraphEdge, type GraphNode, type Layout } from "../src/view/ascii-graph"
import { textWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

function ring(count: number, prefix = "n"): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, label: `${prefix}${index} label text` }))
  const edges = nodes.slice(1).map((node, index) => ({ from: `${prefix}${Math.floor(index / 3)}`, to: node.id }))
  return { nodes, edges }
}

const SIZES: Array<[number, number]> = [[20, 3], [20, 8], [40, 5], [60, 12], [80, 24], [120, 24], [200, 60]]
const COUNTS = [0, 1, 2, 10, 200]

describe("layoutGraph", () => {
  test("the same input gives the same layout and the same rows", () => {
    const { nodes, edges } = ring(30)
    const input = { nodes, edges, width: 100, height: 24 }
    expect(layoutGraph(input)).toEqual(layoutGraph(input))
    expect(plain(renderGraph({ layout: layoutGraph(input), width: 100, height: 24 }))).toEqual(plain(renderGraph({ layout: layoutGraph(input), width: 100, height: 24 })))
    expect(layoutGraph({ ...input, focus: "n4" })).toEqual(layoutGraph({ ...input, focus: "n4" }))
  })

  test("no nodes gives an empty layout and blank rows", () => {
    const layout = layoutGraph({ nodes: [], edges: [], width: 30, height: 5 })
    expect(layout.nodes).toEqual([])
    expect(layout.hidden).toBe(0)
    expect(plain(renderGraph({ layout, width: 30, height: 5 }))).toEqual(["", "", "", "", ""])
  })

  test("a single node sits in the middle", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "alone" }], edges: [], width: 40, height: 9 })
    expect(layout.nodes).toHaveLength(1)
    const node = layout.nodes[0]!
    expect(node.y).toBe(4)
    expect(node.x0).toBeGreaterThan(5)
    expect(node.x1).toBeLessThan(35)
    expect(plain(renderGraph({ layout, width: 40, height: 9 }))[4]).toContain("● alone")
  })

  test("with a focus, the focus is the hub and its neighbors surround it", () => {
    const { nodes, edges } = ring(10)
    const layout = layoutGraph({ nodes, edges, width: 100, height: 24, focus: "n1" })
    expect(layout.center).toBe("n1")
    const hub = layout.nodes.find((node) => node.id === "n1")!
    expect(hub.ring).toBe(0)
    expect(Math.abs(hub.y - 11)).toBeLessThanOrEqual(1)
    const neighbors = layout.nodes.filter((node) => node.ring === 1).map((node) => node.id)
    expect(neighbors.sort()).toEqual(["n0", "n4", "n5", "n6"])
  })

  test("without a focus, the most connected node is the hub", () => {
    const layout = layoutGraph({
      nodes: ["a", "b", "c", "d"].map((id) => ({ id, label: id })),
      edges: [{ from: "a", to: "b" }, { from: "c", to: "b" }, { from: "d", to: "b" }],
      width: 60,
      height: 15,
    })
    expect(layout.center).toBe("b")
  })

  test("a focus that is not in the graph falls back to the whole graph", () => {
    const { nodes, edges } = ring(5)
    expect(layoutGraph({ nodes, edges, width: 60, height: 12, focus: "nope" })).toEqual(layoutGraph({ nodes, edges, width: 60, height: 12 }))
  })

  test("unlinked nodes are kept on a shelf beside the main component", () => {
    const nodes = [...ring(6).nodes, { id: "x", label: "loner one" }, { id: "y", label: "loner two" }, { id: "p", label: "pair a" }, { id: "q", label: "pair b" }]
    const layout = layoutGraph({ nodes, edges: [...ring(6).edges, { from: "p", to: "q" }], width: 110, height: 20 })
    expect(layout.hidden).toBe(0)
    expect(layout.nodes.map((node) => node.id).sort()).toEqual(nodes.map((node) => node.id).sort())
  })

  test("200 nodes keep the best-connected ones and count the rest as hidden", () => {
    const { nodes, edges } = ring(200)
    const layout = layoutGraph({ nodes, edges, width: 120, height: 30 })
    expect(layout.hidden).toBe(200 - layout.nodes.length)
    expect(layout.hidden).toBeGreaterThan(0)
    expect(layout.height).toBe(29)
    expect(layout.center).toBe("n1")
    const rows = plain(renderGraph({ layout, width: 120, height: 30 }))
    expect(rows[29]).toContain(`+${layout.hidden} hidden`)
  })

  test("edges only join nodes that were placed", () => {
    const { nodes, edges } = ring(200)
    const layout = layoutGraph({ nodes, edges, width: 80, height: 20 })
    const ids = new Set(layout.nodes.map((node) => node.id))
    for (const edge of layout.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })

  test("duplicate ids, self loops and edges to unknown nodes are ignored", () => {
    const layout = layoutGraph({
      nodes: [{ id: "a", label: "a" }, { id: "a", label: "again" }, { id: "b", label: "b" }],
      edges: [{ from: "a", to: "a" }, { from: "a", to: "ghost" }, { from: "a", to: "b" }],
      width: 40,
      height: 9,
    })
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges).toHaveLength(1)
  })
})

describe("renderGraph bounds", () => {
  for (const [width, height] of SIZES) {
    for (const count of COUNTS) {
      test(`${count} nodes at ${width}x${height}: exactly ${height} rows, none wider than ${width}`, () => {
        const { nodes, edges } = ring(count)
        for (const focus of [undefined, "n0"]) {
          const layout = layoutGraph({ nodes, edges, width, height, focus })
          const lines = renderGraph({ layout, width, height, selected: "n0" })
          expect(lines).toHaveLength(height)
          for (const line of lines) expect(line.reduce((sum, span) => sum + textWidth(span.text), 0)).toBeLessThanOrEqual(width)
          for (const node of layout.nodes) {
            expect(node.x0).toBeGreaterThanOrEqual(0)
            expect(node.x1).toBeLessThanOrEqual(width)
            expect(node.y).toBeGreaterThanOrEqual(0)
            expect(node.y).toBeLessThan(layout.height)
          }
        }
      })
    }
  }

  test("a zero-height render is empty", () => {
    const layout = layoutGraph({ nodes: ring(3).nodes, edges: [], width: 20, height: 0 })
    expect(renderGraph({ layout, width: 20, height: 0 })).toEqual([])
  })

  test("wide labels are clipped to the cells they occupy", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字" }, { id: "b", label: "b" }], edges: [{ from: "a", to: "b" }], width: 24, height: 5 })
    for (const line of renderGraph({ layout, width: 24, height: 5 })) expect(line.reduce((sum, span) => sum + textWidth(span.text), 0)).toBeLessThanOrEqual(24)
  })
})

describe("labels", () => {
  test("no two node boxes overlap or touch on the same row", () => {
    for (const count of [10, 40, 200]) {
      for (const [width, height] of [[60, 12], [120, 24], [200, 60]] as Array<[number, number]>) {
        const { nodes, edges } = ring(count)
        for (const focus of [undefined, "n2"]) {
          const layout = layoutGraph({ nodes, edges, width, height, focus })
          const byRow = new Map<number, Layout["nodes"]>()
          for (const node of layout.nodes) byRow.set(node.y, [...(byRow.get(node.y) ?? []), node])
          for (const row of byRow.values()) {
            const sorted = [...row].sort((a, b) => a.x0 - b.x0)
            sorted.slice(1).forEach((node, index) => expect(node.x0).toBeGreaterThan(sorted[index]!.x1))
          }
        }
      }
    }
  })

  test("labels longer than the room are cut with an ellipsis", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "a very long label that cannot possibly fit in twenty cells" }], edges: [], width: 20, height: 3 })
    const rows = plain(renderGraph({ layout, width: 20, height: 3 }))
    expect(rows.join("\n")).toContain("…")
    expect(layout.nodes[0]!.x1 - layout.nodes[0]!.x0).toBeLessThanOrEqual(20)
  })

  test("labels are drawn as a dot, a space and the text", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "first" }, { id: "b", label: "second" }], edges: [{ from: "a", to: "b" }], width: 60, height: 9 })
    const text = plain(renderGraph({ layout, width: 60, height: 9 })).join("\n")
    expect(text).toMatch(/● first|first ●/)
    expect(text).toMatch(/● second|second ●/)
  })

  test("whitespace and newlines in labels collapse to one line", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "two\nlines\t here" }], edges: [], width: 40, height: 3 })
    expect(plain(renderGraph({ layout, width: 40, height: 3 })).join("\n")).toContain("two lines here")
  })
})

describe("edges", () => {
  const two = (directed: boolean) => layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }, { id: "c", label: "gamma" }], edges: [{ from: "a", to: "b", directed }, { from: "a", to: "c", directed }], width: 60, height: 11 })

  test("directed edges end in an arrow, plain ones do not", () => {
    const arrows = /[→←↑↓↗↘↙↖]/
    expect(plain(renderGraph({ layout: two(true), width: 60, height: 11 })).join("\n")).toMatch(arrows)
    expect(plain(renderGraph({ layout: two(false), width: 60, height: 11 })).join("\n")).not.toMatch(arrows)
  })

  test("the ASCII glyph set draws with - | / \\ > and o", () => {
    const rows = plain(renderGraph({ layout: two(true), width: 60, height: 11, glyphs: GRAPH_GLYPHS_ASCII, selected: "a" })).join("\n")
    expect(rows).toContain("@")
    expect(rows).toContain("o")
    expect(rows).toMatch(/[-|/\\]/)
    expect(rows).toMatch(/[<>v^]/)
    expect(rows).not.toMatch(/[●─│╱╲→]/)
  })

  test("edge tones reach the spans", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }], edges: [{ from: "a", to: "b", tone: "error" }], width: 60, height: 7 })
    const spans = renderGraph({ layout, width: 60, height: 7 }).flat()
    expect(spans.some((span) => span.fg === "error" && /[─│╱╲]/.test(span.text))).toBe(true)
  })

  test("edges touching the selection are bold", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }], edges: [{ from: "a", to: "b" }], width: 60, height: 7 })
    const picked = renderGraph({ layout, width: 60, height: 7, selected: "a" }).flat()
    const plainSpans = renderGraph({ layout, width: 60, height: 7 }).flat()
    expect(picked.some((span) => span.bold && /[─│╱╲]/.test(span.text))).toBe(true)
    expect(plainSpans.some((span) => span.bold && /[─│╱╲]/.test(span.text))).toBe(false)
  })

  test("an edge label is drawn on a long edge and left out where it does not fit", () => {
    const wide = layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }], edges: [{ from: "a", to: "b", label: "uses" }], width: 80, height: 9 })
    expect(plain(renderGraph({ layout: wide, width: 80, height: 9 })).join("\n")).toContain("uses")
    const tiny = layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }], edges: [{ from: "a", to: "b", label: "a-very-long-edge-label" }], width: 20, height: 3 })
    expect(plain(renderGraph({ layout: tiny, width: 20, height: 3 })).join("\n")).not.toContain("a-very-long-edge-label")
  })

  test("the selected node is drawn with the selected glyph, bold and highlighted", () => {
    const layout = layoutGraph({ nodes: [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }], edges: [{ from: "a", to: "b" }], width: 60, height: 7 })
    const lines = renderGraph({ layout, width: 60, height: 7, selected: "b" })
    expect(plain(lines).join("\n")).toContain("◉")
    const spans = lines.flat()
    expect(spans.find((span) => span.text === "◉")?.bold).toBe(true)
    expect(spans.find((span) => span.text.includes("beta"))).toMatchObject({ bold: true, bg: "element" })
    expect(spans.find((span) => span.text.includes("alpha"))?.bold).toBeUndefined()
  })
})

describe("nearestNode", () => {
  const layout: Layout = {
    width: 60,
    height: 11,
    hidden: 0,
    nodes: [
      { id: "mid", label: "mid", x: 30, y: 5, x0: 30, x1: 35, side: "right", degree: 4, ring: 0 },
      { id: "up", label: "up", x: 31, y: 1, x0: 31, x1: 35, side: "right", degree: 1, ring: 1 },
      { id: "down", label: "down", x: 28, y: 9, x0: 28, x1: 34, side: "right", degree: 1, ring: 1 },
      { id: "left", label: "left", x: 8, y: 5, x0: 8, x1: 14, side: "right", degree: 1, ring: 1 },
      { id: "right", label: "right", x: 52, y: 6, x0: 52, x1: 59, side: "right", degree: 1, ring: 1 },
      { id: "farUp", label: "farUp", x: 30, y: 0, x0: 30, x1: 37, side: "right", degree: 1, ring: 1 },
    ],
    edges: [],
  }

  test("moves to the closest node in each direction", () => {
    expect(nearestNode(layout, "mid", "up")).toBe("up")
    expect(nearestNode(layout, "mid", "down")).toBe("down")
    expect(nearestNode(layout, "mid", "left")).toBe("left")
    expect(nearestNode(layout, "mid", "right")).toBe("right")
  })

  test("comes back the way it went", () => {
    expect(nearestNode(layout, "up", "down")).toBe("mid")
    expect(nearestNode(layout, "left", "right")).toBe("mid")
  })

  test("returns undefined at the edge and for unknown nodes", () => {
    expect(nearestNode(layout, "farUp", "up")).toBeUndefined()
    expect(nearestNode(layout, "right", "right")).toBeUndefined()
    expect(nearestNode(layout, "ghost", "up")).toBeUndefined()
  })

  test("every node of a real layout can be reached from the hub by arrow moves", () => {
    const { nodes, edges } = ring(30)
    const real = layoutGraph({ nodes, edges, width: 120, height: 30 })
    const seen = new Set<string>([real.center!])
    const queue = [real.center!]
    while (queue.length) {
      const id = queue.shift()!
      for (const direction of ["up", "down", "left", "right"] as const) {
        const next = nearestNode(real, id, direction)
        if (next && !seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    expect(seen.size).toBe(real.nodes.length)
  })
})
