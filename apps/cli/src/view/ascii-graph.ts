import type { ColorName, Line, Span } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { cells, textWidth } from "./wrap"

/**
 * A generic ASCII graph: `layoutGraph` places nodes on a character grid (pure, deterministic), `renderGraph`
 * draws that layout as styled rows, `nearestNode` moves a cursor across it. Nothing here knows about memories,
 * so a code graph can reuse it. Terminal cells are about twice as tall as wide; ring radii and the direction
 * metric account for that.
 */

export type GraphNode = { id: string; label: string; tone?: ColorName }
export type GraphEdge = { from: string; to: string; label?: string; directed?: boolean; tone?: ColorName }

/** `x`/`y` is the dot; the label sits to the right (`● label`), the left (`label ●`) or, for a centered hub, after the dot. */
export type PlacedNode = {
  id: string
  label: string
  tone?: ColorName
  x: number
  y: number
  /** Occupied cells on row `y` are `x0` (inclusive) to `x1` (exclusive): the dot and its label. */
  x0: number
  x1: number
  side: "left" | "right" | "center"
  degree: number
  /** 0 = the hub, 1 = its neighbors, 2 = the next ring; laid-out lists use 1. */
  ring: number
}
export type PlacedEdge = { from: string; to: string; label?: string; directed: boolean; tone?: ColorName }
export type Layout = {
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  width: number
  /** Rows the graph uses; one less than asked when a `+N hidden` row was reserved. */
  height: number
  /** Nodes that did not fit (or, with a focus, are out of reach). */
  hidden: number
  /** The hub (the focus, or the most connected node of the largest component). */
  center?: string
}

export type GraphGlyphs = {
  node: string
  selected: string
  marked: string
  h: string
  v: string
  up: string
  down: string
  cross: string
  crossDiag: string
  arrow: { right: string; downRight: string; down: string; downLeft: string; left: string; upLeft: string; up: string; upRight: string }
}

export const GRAPH_GLYPHS_UNICODE: GraphGlyphs = {
  node: "●",
  selected: "◉",
  marked: "◎",
  h: "─",
  v: "│",
  up: "╱",
  down: "╲",
  cross: "┼",
  crossDiag: "╳",
  arrow: { right: "→", downRight: "↘", down: "↓", downLeft: "↙", left: "←", upLeft: "↖", up: "↑", upRight: "↗" },
}

export const GRAPH_GLYPHS_ASCII: GraphGlyphs = {
  node: "o",
  selected: "@",
  marked: "*",
  h: "-",
  v: "|",
  up: "/",
  down: "\\",
  cross: "+",
  crossDiag: "x",
  arrow: { right: ">", downRight: ">", down: "v", downLeft: "<", left: "<", upLeft: "<", up: "^", upRight: ">" },
}

type Rect = { x: number; y: number; w: number; h: number }
type Graph = {
  ids: string[]
  nodes: Map<string, GraphNode>
  adjacency: Map<string, string[]>
  edges: PlacedEdge[]
  degree: (id: string) => number
}

const DY_TRIES = [0, 1, -1, 2, -2, 3, -3]
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const byId = new Map<string, GraphNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  const neighbors = new Map<string, Set<string>>([...byId.keys()].map((id) => [id, new Set<string>()]))
  const kept: PlacedEdge[] = []
  for (const edge of edges) {
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) continue
    neighbors.get(edge.from)!.add(edge.to)
    neighbors.get(edge.to)!.add(edge.from)
    kept.push({ from: edge.from, to: edge.to, directed: edge.directed === true, ...(edge.label ? { label: edge.label } : {}), ...(edge.tone ? { tone: edge.tone } : {}) })
  }
  const adjacency = new Map([...neighbors].map(([id, set]) => [id, [...set].sort()]))
  return { ids: [...byId.keys()], nodes: byId, adjacency, edges: kept, degree: (id) => adjacency.get(id)?.length ?? 0 }
}

/** Distance from `start` to every node it reaches, in discovery order. */
function distances(graph: Graph, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    for (const next of graph.adjacency.get(id) ?? []) {
      if (dist.has(next)) continue
      dist.set(next, dist.get(id)! + 1)
      queue.push(next)
    }
  }
  return dist
}

class Placer {
  readonly placed: PlacedNode[] = []
  private readonly rows = new Map<number, PlacedNode[]>()
  constructor(readonly graph: Graph) {}

  private free(y: number, x0: number, x1: number) {
    return (this.rows.get(y) ?? []).every((other) => x0 >= other.x1 + 1 || other.x0 >= x1 + 1)
  }

  /**
   * Puts a node as near (x, y) as it fits: labels are cut to the room, rows above and below are tried when a
   * neighbor's label is in the way, then a short label. Returns undefined when nothing fits.
   */
  place(input: { id: string; x: number; y: number; side: PlacedNode["side"]; maxLabel: number; rect: Rect; ring: number }): PlacedNode | undefined {
    const { id, side, rect, ring } = input
    const source = this.graph.nodes.get(id)
    if (!source) return undefined
    const text = oneLine(source.label) || id
    const right = rect.x + rect.w
    for (const maxLabel of [input.maxLabel, Math.min(input.maxLabel, 5)]) {
      const want = Math.min(textWidth(text), maxLabel)
      const smallest = Math.min(want, 3)
      for (const dy of DY_TRIES) {
        const y = input.y + dy
        if (y < rect.y || y >= rect.y + rect.h) continue
        let dot: number
        let room: number
        if (side === "left") {
          dot = clamp(input.x, rect.x + 1 + smallest, right - 1)
          room = dot - 1 - rect.x
        } else if (side === "right") {
          dot = clamp(input.x, rect.x, right - 2 - smallest)
          room = right - dot - 2
        } else {
          room = Math.min(want, rect.w - 2)
          dot = 0
        }
        if (room < 1) continue
        const label = truncateEnd(text, Math.min(want, room))
        const used = textWidth(label)
        let x0: number
        let x1: number
        if (side === "left") {
          x0 = dot - 1 - used
          x1 = dot + 1
        } else if (side === "right") {
          x0 = dot
          x1 = dot + 2 + used
        } else {
          const total = 2 + used
          x0 = clamp(input.x - Math.floor(total / 2), rect.x, right - total)
          x1 = x0 + total
          dot = x0
        }
        if (x0 < rect.x || x1 > right || !this.free(y, x0, x1)) continue
        const placed: PlacedNode = { id, label, x: dot, y, x0, x1, side, degree: this.graph.degree(id), ring, ...(source.tone ? { tone: source.tone } : {}) }
        this.placed.push(placed)
        const row = this.rows.get(y)
        if (row) row.push(placed)
        else this.rows.set(y, [placed])
        return placed
      }
    }
    return undefined
  }
}

function byDegree(graph: Graph, ids: string[]) {
  const order = new Map(graph.ids.map((id, index) => [id, index]))
  return [...ids].sort((a, b) => graph.degree(b) - graph.degree(a) || order.get(a)! - order.get(b)!)
}

/** A hub in the middle of `rect`, its neighbors on an inner ellipse, the next degree on an outer one near their parents. */
function egoLayout(placer: Placer, center: string, dist: Map<string, number>, rect: Rect) {
  if (rect.w < 4 || rect.h < 1) return
  const graph = placer.graph
  const labelMax = clamp(Math.floor(rect.w * 0.36), 8, 32)
  const cx = rect.x + Math.floor(rect.w / 2)
  const cy = rect.y + Math.floor((rect.h - 1) / 2)
  const hub = placer.place({ id: center, x: cx, y: cy, side: "center", maxLabel: Math.min(labelMax + 6, rect.w - 2), rect, ring: 0 })
  if (!hub) return
  const half = Math.ceil((hub.x1 - hub.x0) / 2)
  const first = byDegree(graph, [...dist].filter(([, d]) => d === 1).map(([id]) => id))
  const orderIndex = new Map(graph.ids.map((id, index) => [id, index]))
  const rest = [...dist]
    .filter(([, d]) => d >= 2)
    .sort((a, b) => a[1] - b[1] || graph.degree(b[0]) - graph.degree(a[0]) || orderIndex.get(a[0])! - orderIndex.get(b[0])!)
    .map(([id]) => id)

  const reserve = Math.min(labelMax + 3, Math.floor(rect.w * 0.34))
  const rxLimit = Math.max(2, Math.floor(rect.w / 2) - 5)
  const rxOuter = clamp(Math.floor(rect.w / 2) - 1 - reserve, 2, rxLimit)
  const ryOuter = Math.max(0, (rect.h - 1) / 2)
  const rings2 = rest.length > 0
  const rx1 = clamp(rings2 ? Math.max(half + 4, Math.round(rxOuter * 0.55)) : Math.max(half + 4, rxOuter), 2, rxLimit)
  const ry1 = rect.h >= 3 ? Math.max(1, Math.round(ryOuter * (rings2 ? 0.5 : 0.9))) : 0
  const cap1 = Math.min(first.length, Math.max(2, 2 * (2 * ry1 + 1)))

  const angles = new Map<string, number>()
  const at = (angle: number, rx: number, ry: number) => ({ x: cx + Math.round(rx * Math.cos(angle)), y: cy + Math.round(ry * Math.sin(angle)) })
  const sideOf = (angle: number): "left" | "right" => (Math.cos(angle) >= 0 ? "right" : "left")

  first.slice(0, cap1).forEach((id, index) => {
    const angle = cap1 === 1 ? 0 : -Math.PI / 2 + (2 * Math.PI * (index + 0.5)) / cap1
    const spot = at(angle, rx1, ry1)
    if (placer.place({ id, x: spot.x, y: spot.y, side: sideOf(angle), maxLabel: labelMax, rect, ring: 1 })) angles.set(id, angle)
  })

  const cap2 = Math.min(rest.length, 2 * (2 * Math.floor(ryOuter) + 1))
  if (cap2 === 0) return
  const rx2 = clamp(Math.max(rx1 + 4, Math.floor(rect.w / 2) - 1 - reserve), 2, rxLimit + 3)
  const wanted = rest.slice(0, cap2).map((id, index) => {
    const parents = (graph.adjacency.get(id) ?? []).filter((parent) => angles.has(parent))
    if (parents.length === 0) return { id, angle: -Math.PI / 2 + (2 * Math.PI * (index + 0.5)) / cap2 }
    const sx = parents.reduce((sum, parent) => sum + Math.cos(angles.get(parent)!), 0)
    const sy = parents.reduce((sum, parent) => sum + Math.sin(angles.get(parent)!), 0)
    return { id, angle: Math.atan2(sy, sx) }
  })
  wanted.sort((a, b) => a.angle - b.angle)
  const separation = Math.min(0.5, (2 * Math.PI * 0.9) / cap2)
  let previous = -Infinity
  for (const item of wanted) {
    const angle = Math.max(item.angle, previous + separation)
    previous = angle
    const spot = at(angle, rx2, ryOuter)
    placer.place({ id: item.id, x: spot.x, y: spot.y, side: sideOf(angle), maxLabel: labelMax, rect, ring: 2 })
  }
}

/** `● label` cells stacked in columns, column-major: the shelf for nodes with no links. */
function listNodes(placer: Placer, ids: string[], rect: Rect) {
  if (ids.length === 0 || rect.w < 4 || rect.h < 1) return
  const columnWidth = clamp(rect.w, 6, 24)
  const columns = Math.max(1, Math.floor((rect.w + 1) / (columnWidth + 1)))
  const rows = Math.min(rect.h, Math.ceil(ids.length / columns))
  ids.slice(0, columns * rows).forEach((id, index) => {
    const x = rect.x + Math.floor(index / rows) * (columnWidth + 1)
    const column: Rect = { x, y: rect.y, w: Math.min(columnWidth, rect.x + rect.w - x), h: rect.h }
    placer.place({ id, x, y: rect.y + (index % rows), side: "right", maxLabel: columnWidth - 2, rect: column, ring: 1 })
  })
}

function componentsLayout(placer: Placer, rect: Rect) {
  const graph = placer.graph
  const seen = new Set<string>()
  const components: string[][] = []
  for (const id of graph.ids) {
    if (seen.has(id)) continue
    const members = [...distances(graph, id).keys()]
    for (const member of members) seen.add(member)
    components.push(members)
  }
  components.sort((a, b) => b.length - a.length)
  const linked = components.filter((members) => members.length > 1)
  const alone = components.filter((members) => members.length === 1).map((members) => members[0]!)
  const hubOf = (members: string[]) => members.reduce((best, id) => (graph.degree(id) > graph.degree(best) ? id : best))
  const egoOf = (members: string[], into: Rect) => {
    const hub = hubOf(members)
    egoLayout(placer, hub, distances(graph, hub), into)
  }

  if (components.length === 1) return egoOf(components[0]!, rect)
  if (linked.length === 0) return listNodes(placer, alone, rect)
  const [main, ...others] = linked as [string[], ...string[][]]
  if (others.length === 0 && alone.length === 0) return egoOf(main, rect)

  let mainRect: Rect
  let side: Rect
  if (rect.w >= 60) {
    const mainWidth = Math.ceil(rect.w * 0.6)
    mainRect = { ...rect, w: mainWidth }
    side = { x: rect.x + mainWidth + 2, y: rect.y, w: rect.w - mainWidth - 2, h: rect.h }
  } else if (rect.h >= 10) {
    const mainHeight = Math.ceil(rect.h * 0.6)
    mainRect = { ...rect, h: mainHeight }
    side = { x: rect.x, y: rect.y + mainHeight + 1, w: rect.w, h: rect.h - mainHeight - 1 }
  } else return egoOf(main, rect)

  egoOf(main, mainRect)
  const shelfRows = alone.length === 0 ? 0 : Math.min(Math.ceil(alone.length / Math.max(1, Math.floor((side.w + 1) / (clamp(side.w, 6, 24) + 1)))), others.length ? Math.floor(side.h / 3) : side.h)
  const zoneHeight = side.h - shelfRows - (shelfRows > 0 && others.length > 0 ? 1 : 0)
  const shown = others.slice(0, Math.max(0, Math.floor(zoneHeight / 3)))
  let top = side.y
  shown.forEach((members, index) => {
    const height = Math.floor(zoneHeight / shown.length) + (index < zoneHeight % shown.length ? 1 : 0)
    egoOf(members, { x: side.x, y: top, w: side.w, h: height })
    top += height
  })
  listNodes(placer, alone, { x: side.x, y: side.y + side.h - shelfRows, w: side.w, h: shelfRows })
}

/** Past this many nodes every link would be a hairball: keep the hub's edges and one edge per outer node. */
const TREE_ABOVE = 24

function simplified(edges: PlacedEdge[], nodes: PlacedNode[]): PlacedEdge[] {
  if (nodes.length <= TREE_ABOVE) return edges
  const ring = new Map(nodes.map((node) => [node.id, node.ring]))
  const claimed = new Set<string>()
  return edges.filter((edge) => {
    const a = ring.get(edge.from)!
    const b = ring.get(edge.to)!
    if (a === 0 || b === 0) return true
    if (Math.abs(a - b) !== 1) return false
    const child = a > b ? edge.from : edge.to
    if (claimed.has(child)) return false
    claimed.add(child)
    return true
  })
}

function layoutIn(graph: Graph, width: number, height: number, focus: string | undefined): Layout {
  const placer = new Placer(graph)
  const whole: Rect = { x: 0, y: 0, w: width, h: height }
  if (width >= 1 && height >= 1 && graph.ids.length > 0) {
    if (focus !== undefined && graph.nodes.has(focus)) egoLayout(placer, focus, distances(graph, focus), whole)
    else componentsLayout(placer, whole)
  }
  const ids = new Set(placer.placed.map((node) => node.id))
  const center = placer.placed.find((node) => node.ring === 0)?.id
  return {
    nodes: placer.placed,
    edges: simplified(graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), placer.placed),
    width,
    height,
    hidden: graph.ids.length - placer.placed.length,
    ...(center ? { center } : {}),
  }
}

/**
 * Deterministic layout in `width` x `height` cells. With `focus`: an ego view (the focus in the middle, its
 * neighbors on a ring, their neighbors on an outer ring). Without: the largest component around its most
 * connected node, other components stacked beside it, unlinked nodes on a shelf. Nodes that do not fit are
 * counted in `hidden` (most connected / nearest first are kept), and a row is reserved for saying so.
 */
export function layoutGraph(input: { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number; focus?: string | undefined }): Layout {
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  const graph = buildGraph(input.nodes, input.edges)
  const full = layoutIn(graph, width, height, input.focus)
  if (full.hidden === 0 || height < 4) return full
  return layoutIn(graph, width, height - 1, input.focus)
}

type Kind = "h" | "v" | "u" | "d"
type Cell = { t: string; fg?: ColorName; bold?: boolean; dim?: boolean; bg?: ColorName; kind?: Kind; arrow?: boolean }

function bresenham(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const points: Array<[number, number]> = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    points.push([x, y])
    if (x === x1 && y === y1) return points
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

const ARROW_ORDER = ["right", "downRight", "down", "downLeft", "left", "upLeft", "up", "upRight"] as const

function arrowFor(glyphs: GraphGlyphs, dx: number, dy: number) {
  const octant = (((Math.round(Math.atan2(dy * 2, dx) / (Math.PI / 4)) % 8) + 8) % 8) as number
  return glyphs.arrow[ARROW_ORDER[octant]!]
}

function spansOf(row: Cell[]): Line {
  const line: Line = []
  let last = -1
  row.forEach((cell, index) => {
    if (cell.t !== " " && cell.t !== "") last = index
  })
  let run: (Span & { key: string }) | undefined
  for (let index = 0; index <= last; index++) {
    const cell = row[index]!
    if (cell.t === "") continue
    const key = `${cell.fg ?? ""}|${cell.bg ?? ""}|${cell.bold ? 1 : 0}${cell.dim ? 1 : 0}`
    if (run && run.key === key) run.text += cell.t
    else {
      if (run) line.push(strip(run))
      run = { key, text: cell.t, ...(cell.fg ? { fg: cell.fg } : {}), ...(cell.bg ? { bg: cell.bg } : {}), ...(cell.bold ? { bold: true } : {}), ...(cell.dim ? { dim: true } : {}) }
    }
  }
  if (run) line.push(strip(run))
  return line
}

function strip({ key: _key, ...span }: Span & { key: string }): Span {
  return span
}

/**
 * Draws `layout` as exactly `height` rows, none wider than `width`: edges first (box lines, arrows on directed
 * ones, edge labels where they fit), then the nodes on top. `selected` is bold with a highlighted label; edges
 * touching it are bold too. `marked` is a second, quieter highlight.
 */
export function renderGraph(input: { layout: Layout; width: number; height: number; selected?: string | undefined; marked?: string | undefined; glyphs?: Partial<GraphGlyphs> | undefined }): Line[] {
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  if (height === 0) return []
  const glyphs: GraphGlyphs = { ...GRAPH_GLYPHS_UNICODE, ...input.glyphs, arrow: { ...GRAPH_GLYPHS_UNICODE.arrow, ...input.glyphs?.arrow } }
  const { layout, selected, marked } = input
  const canvas: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ t: " " })))
  const put = (x: number, y: number, cell: Cell) => {
    if (x >= 0 && x < width && y >= 0 && y < height) canvas[y]![x] = cell
  }
  const cellAt = (x: number, y: number) => (x >= 0 && x < width && y >= 0 && y < height ? canvas[y]![x] : undefined)
  const blocked = new Set<number>()
  const key = (x: number, y: number) => y * (width + 1) + x
  for (const node of layout.nodes) for (let x = node.x0; x < node.x1; x++) blocked.add(key(x, node.y))
  const byId = new Map(layout.nodes.map((node) => [node.id, node]))
  const anchor = (node: PlacedNode) => (node.side === "center" ? { x: Math.floor((node.x0 + node.x1 - 1) / 2), y: node.y } : { x: node.x, y: node.y })
  const touches = (edge: PlacedEdge) => selected !== undefined && (edge.from === selected || edge.to === selected)

  const chars: Record<Kind, string> = { h: glyphs.h, v: glyphs.v, u: glyphs.up, d: glyphs.down }
  const ordered = [...layout.edges.filter((edge) => !touches(edge)), ...layout.edges.filter(touches)]
  const labels: Array<{ edge: PlacedEdge; x: number; y: number; length: number }> = []
  for (const edge of ordered) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const a = anchor(from)
    const b = anchor(to)
    const points = bresenham(a.x, a.y, b.x, b.y)
    const style = { fg: edge.tone ?? ("muted" as ColorName), ...(touches(edge) ? { bold: true } : {}) }
    let lastFree = -1
    points.forEach(([x, y], index) => {
      if (blocked.has(key(x, y))) return
      lastFree = index
      const next = points[index + 1] ?? points[index - 1] ?? [x, y]
      const sign = index === points.length - 1 && index > 0 ? -1 : 1
      const sx = Math.sign((next[0] - x) * sign)
      const sy = Math.sign((next[1] - y) * sign)
      const kind: Kind = sy === 0 ? "h" : sx === 0 ? "v" : sx * sy < 0 ? "u" : "d"
      const existing = cellAt(x, y)
      let t = chars[kind]
      if (existing?.kind && existing.kind !== kind && !existing.arrow) {
        const pair = [existing.kind, kind].sort().join("")
        if (pair === "hv") t = glyphs.cross
        else if (pair === "du") t = glyphs.crossDiag
      }
      put(x, y, { t, ...style, kind })
    })
    if (edge.directed && lastFree >= 0) {
      const [x, y] = points[lastFree]!
      put(x, y, { t: arrowFor(glyphs, b.x - a.x, b.y - a.y), ...style, arrow: true })
    }
    if (edge.label) {
      let best: Array<[number, number]> = []
      let run: Array<[number, number]> = []
      for (const point of points) {
        if (blocked.has(key(point[0], point[1]))) run = []
        else {
          run.push(point)
          if (run.length > best.length) best = [...run]
        }
      }
      const middle = best[Math.floor(best.length / 2)]
      if (middle) labels.push({ edge, x: middle[0], y: middle[1], length: best.length })
    }
  }

  const taken = new Set<number>()
  for (const { edge, x, y, length } of labels) {
    const text = oneLine(edge.label!)
    const w = textWidth(text)
    const left = x - Math.floor(w / 2)
    if (w === 0 || length < w + 2) continue
    const spots = Array.from({ length: w }, (_, index) => left + index)
    if (spots.some((cx) => blocked.has(key(cx, y)) || taken.has(key(cx, y)) || cx < 0 || cx >= width || y < 0 || y >= height || cellAt(cx, y)?.arrow)) continue
    let cx = left
    for (const piece of cells(text)) {
      put(cx, y, { t: piece.text, fg: edge.tone ?? "muted" })
      if (piece.width === 2) put(cx + 1, y, { t: "", fg: edge.tone ?? "muted" })
      for (let step = 0; step < piece.width; step++) taken.add(key(cx + step, y))
      cx += piece.width
    }
  }

  for (const node of layout.nodes) {
    const isSelected = node.id === selected
    const isMarked = node.id === marked
    const dot: Cell = isSelected ? { t: glyphs.selected, fg: "primary", bold: true } : isMarked ? { t: glyphs.marked, fg: "warning", bold: true } : { t: glyphs.node, fg: node.tone ?? "text" }
    const label: Omit<Cell, "t"> = isSelected ? { fg: "primary", bold: true, bg: "element" } : isMarked ? { fg: "warning", bold: true } : { fg: "body" }
    let x = node.side === "left" ? node.x0 : node.side === "center" ? node.x0 + 2 : node.x + 2
    if (node.side === "center") put(node.x0, node.y, dot)
    else put(node.x, node.y, dot)
    if (node.side === "center") put(node.x0 + 1, node.y, { t: " " })
    for (const piece of cells(node.label)) {
      put(x, node.y, { t: piece.text, ...label })
      if (piece.width === 2) put(x + 1, node.y, { t: "", ...label })
      x += piece.width
    }
    if (node.side === "left") put(node.x - 1, node.y, { t: " " })
    if (node.side === "right") put(node.x + 1, node.y, { t: " " })
  }

  if (layout.hidden > 0 && height > layout.height) {
    const note = `+${layout.hidden} hidden`
    let x = width - textWidth(note)
    if (x >= 0) for (const piece of cells(note)) put(x++, height - 1, { t: piece.text, fg: "muted", dim: true })
  }
  return canvas.map(spansOf)
}

/**
 * The node nearest to `from` in `direction` (screen space: cells are counted twice as tall as wide), or
 * undefined when none lies that way. Nodes within 45 degrees of the direction win; only when there is none,
 * the nearest node anywhere in that half-plane. Nodes straight ahead beat nodes off to the side.
 */
export function nearestNode(layout: Layout, from: string, direction: "up" | "down" | "left" | "right"): string | undefined {
  const origin = layout.nodes.find((node) => node.id === from)
  if (!origin) return undefined
  let inCone: { id: string; score: number } | undefined
  let inHalf: { id: string; score: number } | undefined
  for (const node of layout.nodes) {
    if (node.id === from) continue
    const dx = node.x - origin.x
    const dy = (node.y - origin.y) * 2
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy
    if (along <= 0) continue
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx)
    const score = along + 2 * across
    if (across <= along && (!inCone || score < inCone.score)) inCone = { id: node.id, score }
    if (!inHalf || score < inHalf.score) inHalf = { id: node.id, score }
  }
  return (inCone ?? inHalf)?.id
}
