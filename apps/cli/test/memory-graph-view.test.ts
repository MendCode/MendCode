import { describe, expect, test } from "bun:test"
import type { MemoryEntry, MemoryGraphReport, MemoryLink } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { nearestNode } from "../src/view/ascii-graph"
import { createMemoryGraphState, memoryGraphKey, memoryGraphLayout, memoryGraphMetrics, renderMemoryGraph, selectedMemoryId, type MemoryGraphState } from "../src/view/memory-graph-view"
import { textWidth } from "../src/view/wrap"

const NOW = Date.UTC(2026, 8, 26, 12)
const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
const rowWidth = (line: Line) => line.reduce((sum, span) => sum + textWidth(span.text), 0)

function memory(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { memoryId: id, scope: "project", directory: "/work/app", text: `text of ${id}`, category: "", status: "saved", source: "user", createdAt: NOW, updatedAt: NOW, ...patch } as MemoryEntry
}

function link(from: string, to: string, kind: MemoryLink["kind"] = "related"): MemoryLink {
  return { from, to, kind, createdAt: NOW } as MemoryLink
}

function report(nodes: MemoryEntry[], links: MemoryLink[], health?: Partial<MemoryGraphReport["health"]>): MemoryGraphReport {
  const linked = new Set(links.flatMap((item) => [item.from as string, item.to as string]))
  const connected = nodes.filter((node) => linked.has(node.memoryId)).length
  const isolated = nodes.length - connected
  const state = nodes.length === 0 ? "empty" : links.length === 0 ? "disconnected" : isolated > 0 ? "partial" : "connected"
  return { nodes, links, health: { nodes: nodes.length, links: links.length, connected, isolated, conflicts: links.filter((item) => item.kind === "conflicts").length, state, ...health } }
}

const SAMPLE = report(
  [
    memory("a", { text: "Use pnpm, never npm, in this repository", category: "tooling" }),
    memory("b", { scope: "user", text: "Prefers terse answers without filler", category: "style", profile: "work" }),
    memory("c", { text: "Tests run with bun test" }),
    memory("d", { text: "Deploys go through the release workflow" }),
    memory("e", { text: "Old rule: use npm everywhere" }),
    memory("f", { text: "An isolated note nobody links to" }),
  ],
  [link("a", "b", "supports"), link("a", "c"), link("a", "d", "supports"), link("a", "e", "conflicts"), link("c", "e", "supersedes")],
)

const state = (patch: Partial<MemoryGraphState> = {}): MemoryGraphState => ({ ...createMemoryGraphState(), ...patch })
const SIZE = { width: 60, height: 14 }

function big(count: number): MemoryGraphReport {
  const nodes = Array.from({ length: count }, (_, index) => memory(`m${index}`, { scope: index % 3 === 0 ? "user" : "project", text: `memory number ${index} with some longer text` }))
  const links = Array.from({ length: count - 1 }, (_, index) => link(`m${Math.floor(index / 3)}`, `m${index + 1}`, index % 5 === 0 ? "supports" : "related"))
  return report(nodes, links)
}

describe("state and selection", () => {
  test("starts in ego mode with nothing chosen", () => {
    expect(createMemoryGraphState()).toEqual({ mode: "ego" })
  })

  test("the selection defaults to the first (most linked) memory and survives a stale id", () => {
    expect(selectedMemoryId(SAMPLE, state())).toBe("a")
    expect(selectedMemoryId(SAMPLE, state({ selected: "c" }))).toBe("c")
    expect(selectedMemoryId(SAMPLE, state({ selected: "gone" }))).toBe("a")
    expect(selectedMemoryId(report([], []), state())).toBeUndefined()
  })
})

describe("memoryGraphKey", () => {
  test("esc closes", () => {
    expect(memoryGraphKey(state(), "\x1b", SAMPLE, SIZE).action).toEqual({ type: "close" })
    expect(memoryGraphKey(state(), "\x1b", report([], []), SIZE).action).toEqual({ type: "close" })
  })

  test("arrows and hjkl move to the neighbor in that direction on the current layout", () => {
    const layout = memoryGraphLayout(SAMPLE, state({ selected: "a", mode: "all" }), SIZE)
    let moves = 0
    for (const [keys, direction] of [[["\x1b[A", "k"], "up"], [["\x1b[B", "j"], "down"], [["\x1b[C", "l"], "right"], [["\x1b[D", "h"], "left"]] as const) {
      const expected = nearestNode(layout, "a", direction)
      if (expected) moves++
      for (const key of keys) {
        const moved = memoryGraphKey(state({ selected: "a", mode: "all" }), key, SAMPLE, SIZE)
        expect(moved.state.selected).toBe(expected ?? "a")
        expect(moved.action).toEqual({ type: "none" })
      }
    }
    expect(moves).toBeGreaterThanOrEqual(2)
  })

  test("application-mode arrows (ESC O A) also move", () => {
    const moved = memoryGraphKey(state({ selected: "a", mode: "all" }), "\x1bOB", SAMPLE, SIZE)
    expect(moved.state.selected).toBeDefined()
    expect(moved.state.selected).not.toBe("a")
  })

  test("a move with nowhere to go keeps the same state object", () => {
    const only = report([memory("solo")], [])
    const start = state({ selected: "solo" })
    const result = memoryGraphKey(start, "\x1b[A", only, SIZE)
    expect(result.state).toBe(start)
    expect(result.action).toEqual({ type: "none" })
  })

  test("walking from the default selection reaches every visible memory in all mode", () => {
    const layout = memoryGraphLayout(SAMPLE, state({ mode: "all" }), SIZE)
    const seen = new Set<string>(["a"])
    const queue = ["a"]
    while (queue.length) {
      const id = queue.shift()!
      for (const key of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]) {
        const next = memoryGraphKey(state({ selected: id, mode: "all" }), key, SAMPLE, SIZE).state.selected
        if (next && !seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    expect(seen.size).toBe(layout.nodes.length)
  })

  test("enter and f toggle ego and all, pinning the effective selection", () => {
    const toAll = memoryGraphKey(state(), "\r", SAMPLE, SIZE)
    expect(toAll.state).toEqual({ mode: "all", selected: "a" })
    const back = memoryGraphKey(toAll.state, "f", SAMPLE, SIZE)
    expect(back.state.mode).toBe("ego")
    expect(memoryGraphKey(state({ selected: "c" }), "\n", SAMPLE, SIZE).state).toEqual({ mode: "all", selected: "c" })
  })

  test("c links the marked memory to the selection; without a mark it asks for one; an existing pair is left alone", () => {
    expect(memoryGraphKey(state({ selected: "c" }), "c", SAMPLE, SIZE).action).toEqual({ type: "link", from: "c" })
    expect(memoryGraphKey(state(), "c", SAMPLE, SIZE).action).toEqual({ type: "link", from: "a" })
    const linked = memoryGraphKey({ ...state({ selected: "f" }), marked: "b" }, "c", SAMPLE, SIZE)
    expect(linked.action).toEqual({ type: "link", from: "b", to: "f" })
    expect(linked.state.marked).toBeUndefined()
    expect(memoryGraphKey({ ...state({ selected: "b" }), marked: "a" }, "c", SAMPLE, SIZE).action).toEqual({ type: "none" })
  })

  test("m marks, and x unlinks the marked pair using the stored direction", () => {
    const marked = memoryGraphKey(state({ selected: "c" }), "m", SAMPLE, SIZE).state
    expect(marked.marked).toBe("c")
    const onE = { ...marked, selected: "e" }
    const unlinked = memoryGraphKey(onE, "x", SAMPLE, SIZE)
    expect(unlinked.action).toEqual({ type: "unlink", from: "c", to: "e" })
    expect(unlinked.state.marked).toBeUndefined()
    const reversed = memoryGraphKey({ ...state({ selected: "a" }), marked: "e" }, "x", SAMPLE, SIZE)
    expect(reversed.action).toEqual({ type: "unlink", from: "a", to: "e" })
    expect(memoryGraphKey(marked, "m", SAMPLE, SIZE).state.marked).toBeUndefined()
  })

  test("x does nothing without a mark, on the marked memory itself, or when the pair is not linked", () => {
    expect(memoryGraphKey(state({ selected: "c" }), "x", SAMPLE, SIZE).action).toEqual({ type: "none" })
    expect(memoryGraphKey({ ...state({ selected: "c" }), marked: "c" }, "x", SAMPLE, SIZE).action).toEqual({ type: "none" })
    expect(memoryGraphKey({ ...state({ selected: "f" }), marked: "c" }, "x", SAMPLE, SIZE).action).toEqual({ type: "none" })
  })

  test("other keys and an empty graph change nothing", () => {
    const start = state()
    expect(memoryGraphKey(start, "z", SAMPLE, SIZE).state).toBe(start)
    expect(memoryGraphKey(start, "\r", report([], []), SIZE).state).toBe(start)
    expect(memoryGraphKey(start, "c", report([], []), SIZE).action).toEqual({ type: "none" })
  })

  test("in ego mode a move re-centers the layout on the new selection", () => {
    const moved = memoryGraphKey(state({ selected: "a" }), "\x1b[C", SAMPLE, SIZE).state
    expect(moved.selected).not.toBe("a")
    expect(memoryGraphLayout(SAMPLE, moved, SIZE).center).toBe(moved.selected)
  })
})

describe("renderMemoryGraph", () => {
  test("loading and empty states", () => {
    expect(plain(renderMemoryGraph({ report: undefined, state: state(), width: 60, height: 5 }))[0]).toBe("loading graph…")
    const empty = plain(renderMemoryGraph({ report: report([], []), state: state(), width: 80, height: 5 }))
    expect(empty[0]).toBe("no saved memories yet — approve some in the Saved tab")
    expect(empty).toHaveLength(5)
  })

  test("the message is clipped in a narrow body", () => {
    const rows = renderMemoryGraph({ report: report([], []), state: state(), width: 20, height: 3 })
    expect(rowWidth(rows[0]!)).toBeLessThanOrEqual(20)
  })

  test("exactly height rows, none wider than width, across sizes and graphs", () => {
    for (const graph of [SAMPLE, big(1), big(2), big(10), big(200), report([], []), undefined]) {
      for (const [width, height] of [[20, 3], [20, 8], [40, 6], [60, 14], [99, 30], [100, 20], [120, 24], [200, 60]] as Array<[number, number]>) {
        for (const mode of ["ego", "all"] as const) {
          const rows = renderMemoryGraph({ report: graph, state: state({ mode }), width, height })
          expect(rows).toHaveLength(height)
          for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
    expect(renderMemoryGraph({ report: SAMPLE, state: state(), width: 60, height: 0 })).toEqual([])
  })

  test("the health line shows the state, counts, isolated and conflicts", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state(), width: 120, height: 24 }))
    expect(rows[0]).toContain("partial · 6 memories · 5 links · 1 isolated · 1 conflict")
    expect(rows[0]).toMatch(/ego · 5\/6 shown$/)
  })

  test("the health line uses singular forms and drops zero counts", () => {
    const one = report([memory("x"), memory("y")], [link("x", "y")])
    expect(plain(renderMemoryGraph({ report: one, state: state(), width: 100, height: 24 }))[0]).toContain("connected · 2 memories · 1 link")
    expect(plain(renderMemoryGraph({ report: one, state: state(), width: 100, height: 24 }))[0]).not.toContain("isolated")
    const solo = report([memory("x")], [])
    expect(plain(renderMemoryGraph({ report: solo, state: state(), width: 100, height: 24 }))[0]).toContain("disconnected · 1 memory · 0 links")
  })

  test("the state word is colored by health: connected success, partial warning, disconnected muted, conflicts error", () => {
    const tone = (graph: MemoryGraphReport) => renderMemoryGraph({ report: graph, state: state(), width: 100, height: 24 })[0]![0]!
    const pair = report([memory("x"), memory("y")], [link("x", "y")])
    expect(tone(pair)).toMatchObject({ text: "connected", fg: "success" })
    expect(tone(report([memory("x"), memory("y"), memory("z")], [link("x", "y")]))).toMatchObject({ text: "partial", fg: "warning" })
    expect(tone(report([memory("x")], []))).toMatchObject({ text: "disconnected", fg: "muted" })
    const conflicted = report([memory("x"), memory("y")], [link("x", "y", "conflicts")])
    expect(tone(conflicted)).toMatchObject({ text: "connected", fg: "error" })
    const spans = renderMemoryGraph({ report: conflicted, state: state(), width: 100, height: 24 })[0]!
    expect(spans.find((span) => span.text === "1 conflict")).toMatchObject({ fg: "error" })
  })

  test("the health line says how many memories the canvas shows when some do not fit", () => {
    const row = plain(renderMemoryGraph({ report: big(200), state: state({ mode: "all" }), width: 120, height: 30 }))[0]!
    expect(row).toMatch(/all · \d+\/200 shown$/)
  })

  test("a wide body puts the detail beside the graph, a narrow one below it", () => {
    const wide = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "a" }), width: 120, height: 24 }))
    const textRow = wide.findIndex((row) => row.includes("Use pnpm, never npm, in this repository") && row.indexOf("Use pnpm") > 70)
    expect(textRow).toBeGreaterThan(1)
    const narrow = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "a" }), width: 80, height: 30 }))
    const below = narrow.findIndex((row) => row.startsWith("project · tooling"))
    expect(below).toBeGreaterThan(narrow.length / 2)
  })

  test("the detail panel shows scope, category, profile, the full text and the links", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "b" }), width: 140, height: 24 }))
    const joined = rows.map((row) => row.slice(memoryGraphMetrics({ width: 140, height: 24 }).canvas.width + 3)).join("\n")
    expect(joined).toContain("user · style · profile work")
    expect(joined).toContain("Prefers terse answers without filler")
    expect(joined).toContain("Links 1")
    expect(joined).toContain("supports ← Use pnpm, never npm, in this repository")
  })

  test("links are listed with arrows by kind and conflicts first", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "a" }), width: 140, height: 30 })).join("\n")
    expect(rows).toContain("Links 4")
    expect(rows).toMatch(/conflicts ↔ Old rule: use npm everywhere/)
    expect(rows).toMatch(/supports → Prefers terse answers without filler/)
    expect(rows).toMatch(/supports → Deploys go through the release workflow/)
    expect(rows).toMatch(/related ↔ Tests run with bun test/)
    expect(rows.indexOf("conflicts ↔")).toBeLessThan(rows.indexOf("supports →"))
    const e = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "e" }), width: 140, height: 30 })).join("\n")
    expect(e).toMatch(/supersedes ← Tests run with bun test/)
  })

  test("a memory without links says so", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "f" }), width: 140, height: 24 })).join("\n")
    expect(rows).toContain("no links · c to link")
  })

  test("long text wraps and many links are cut with a count", () => {
    const hub = memory("hub", { text: "word ".repeat(120).trim() })
    const others = Array.from({ length: 30 }, (_, index) => memory(`o${index}`, { text: `other ${index}` }))
    const graph = report([hub, ...others], others.map((other) => link("hub", other.memoryId as string)))
    const rows = plain(renderMemoryGraph({ report: graph, state: state({ selected: "hub" }), width: 120, height: 24 }))
    expect(rows.join("\n")).toMatch(/\+\d+ more/)
    expect(rows.join("\n")).toContain("word word")
    expect(rows).toHaveLength(24)
  })

  test("edges take their tone from the link kind", () => {
    const flat = renderMemoryGraph({ report: SAMPLE, state: state({ selected: "a", mode: "all" }), width: 120, height: 24 }).flat()
    const line = /[─│╱╲→←↑↓↗↘↙↖]/
    for (const tone of ["success", "error", "warning", "muted"]) expect(flat.some((span) => span.fg === tone && line.test(span.text))).toBe(true)
  })

  test("supports and supersedes are directed (arrows), related and conflicts are not", () => {
    const arrows = /[→←↑↓↗↘↙↖]/
    const undirected = report([memory("x"), memory("y")], [link("x", "y", "conflicts")])
    const graphOf = (graph: MemoryGraphReport) => plain(renderMemoryGraph({ report: graph, state: state({ selected: "x", mode: "all" }), width: 80, height: 24 })).slice(2).map((row) => row.slice(0, 50)).join("\n")
    expect(graphOf(undirected)).not.toMatch(arrows)
    expect(graphOf(report([memory("x"), memory("y")], [link("x", "y", "supports")]))).toMatch(arrows)
    expect(graphOf(report([memory("x"), memory("y")], [link("x", "y", "supersedes")]))).toMatch(arrows)
  })

  test("project and user memories get different dot tones", () => {
    const flat = renderMemoryGraph({ report: SAMPLE, state: state({ selected: "c", mode: "all" }), width: 120, height: 24 }).flat()
    const dots = flat.filter((span) => span.text.includes("●"))
    expect(dots.some((span) => span.fg === "heading")).toBe(true)
    expect(dots.some((span) => span.fg === "link")).toBe(true)
  })

  test("the selected memory is drawn with the selected glyph and the marked one with a ring", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: { ...state({ selected: "a", mode: "all" }), marked: "c" }, width: 120, height: 24 })).join("\n")
    expect(rows).toContain("◉")
    expect(rows).toContain("◎")
  })

  test("ego mode centers the selection; all mode keeps the most linked memory central", () => {
    const layoutEgo = memoryGraphLayout(SAMPLE, state({ selected: "e" }), { width: 70, height: 20 })
    expect(layoutEgo.center).toBe("e")
    const layoutAll = memoryGraphLayout(SAMPLE, state({ selected: "e", mode: "all" }), { width: 70, height: 20 })
    expect(layoutAll.center).toBe("a")
  })

  test("the ASCII glyph set can be passed through", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state({ mode: "all" }), width: 120, height: 24, glyphs: { node: "o", selected: "@", h: "-", v: "|", up: "/", down: "\\" } })).join("\n")
    expect(rows).toContain("@")
    expect(rows).not.toContain("●")
  })

  test("a short body still shows the selection as one line under the graph", () => {
    const rows = plain(renderMemoryGraph({ report: SAMPLE, state: state({ selected: "a" }), width: 70, height: 9 }))
    expect(rows[rows.length - 1]).toBe("project · Use pnpm, never npm, in this repository")
  })

  test("layout metrics: side detail from 100 columns, below under, none when tiny", () => {
    expect(memoryGraphMetrics({ width: 120, height: 24 })).toMatchObject({ head: 2, detail: { placement: "side" } })
    expect(memoryGraphMetrics({ width: 99, height: 24 }).detail.placement).toBe("below")
    expect(memoryGraphMetrics({ width: 60, height: 8 }).detail.placement).toBe("line")
    expect(memoryGraphMetrics({ width: 60, height: 4 })).toMatchObject({ head: 1, detail: { placement: "none" } })
    const wide = memoryGraphMetrics({ width: 120, height: 24 })
    expect(wide.canvas.width + wide.detail.width + 3).toBe(120)
    const below = memoryGraphMetrics({ width: 80, height: 30 })
    expect(below.head + below.canvas.height + 1 + below.detail.height).toBe(30)
  })

  test("rendering is deterministic", () => {
    const input = { report: big(60), state: state({ selected: "m7" }), width: 120, height: 30 }
    expect(renderMemoryGraph(input)).toEqual(renderMemoryGraph(input))
  })
})
