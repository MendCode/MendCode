import { graphScene, horizontalScene } from "./graph-scene"
import { parseFlowchartNodeExpression, flowchartShapeMarker, splitMermaidTopLevel } from "./legacy-shared"
import type { Line } from "../../ui/theme"
import { textWidth, truncateEnd, wrap } from "../wrap"
import { Canvas, E, W, decodeLabel, MAX_NODES, MAX_ROWS, MERMAID_NOTES } from "./core"
import type { LineStyle, Point } from "./core"

type Shape = "rect" | "round" | "circle" | "diamond" | "cylinder" | "subroutine" | "hexagon" | "parallelogram" | "trapezoid" | "asymmetric" | "double-circle"
type Head = "none" | "arrow" | "x" | "o"
export type Direction = "TD" | "LR" | "BT" | "RL"
type FlowNode = { id: string; lines: string[]; shape: Shape; order: number; explicit: boolean }
type FlowEdge = { from: string; to: string; label: string | undefined; line: LineStyle; head: Head; tail: Head }
type Flow = { direction: Direction; nodes: Map<string, FlowNode>; edges: FlowEdge[]; groups?: Map<string, string> }

const ID = /^[\wÀ-￿]+(?:[.:-](?=[\wÀ-￿])[\wÀ-￿]+)*/
const SHAPES: [string, string, Shape][] = [
  ["(((", ")))", "double-circle"],
  ["((", "))", "circle"],
  ["([", "])", "round"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "parallelogram"],
  ["[/", "\\]", "parallelogram"],
  ["[\\", "\\]", "trapezoid"],
  ["[\\", "/]", "trapezoid"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "asymmetric"],
]
const IGNORED_STATEMENT = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title|callback|link)\b/i

function parseShape(source: string, pos: number): { text: string; shape: Shape; end: number } | undefined {
  for (const [open, close, shape] of SHAPES) {
    if (!source.startsWith(open, pos)) continue
    const from = pos + open.length
    let searchFrom = from
    if (source[from] === '"') {
      const quote = source.indexOf('"', from + 1)
      if (quote < 0) continue
      searchFrom = quote + 1
    }
    const end = source.indexOf(close, searchFrom)
    if (end < 0) continue
    return { text: source.slice(from, end), shape, end: end + close.length }
  }
  return undefined
}

function skipSpaces(source: string, pos: number) {
  while (pos < source.length && /\s/.test(source[pos]!)) pos++
  return pos
}

function headOf(marker: string | undefined): Head {
  return marker === ">" || marker === "<" ? "arrow" : marker === "x" ? "x" : marker === "o" ? "o" : "none"
}

function parseOperator(source: string, pos: number): { line: LineStyle; head: Head; tail: Head; label: string | undefined; end: number } | undefined {
  const rest = source.slice(pos)
  const inline = /^(<)?(--|==|-\.)\s+(.+?)\s+(-{2,}[>xo]?|={2,}>?|\.-+>?)(?=\s|$)/.exec(rest)
  if (inline) {
    const opener = inline[2]!
    const closer = inline[4]!
    const last = closer[closer.length - 1]
    return {
      line: opener === "==" ? "thick" : opener === "-." ? "dashed" : "solid",
      head: headOf(last),
      tail: inline[1] ? "arrow" : "none",
      label: inline[3]!,
      end: pos + inline[0].length,
    }
  }
  const unicode = /^[—–-]*→/.exec(rest)
  if (unicode) return { line: "solid", head: "arrow", tail: "none", label: undefined, end: pos + unicode[0].length }
  const plain = /^([<xo])?(?:(-{2,})|(={2,})|(-\.+-))(!?>|[xo](?=\s|$))?/.exec(rest)
  if (!plain) return undefined
  let end = pos + plain[0].length
  let label: string | undefined
  const piped = /^\s*\|([^|]*)\|/.exec(source.slice(end))
  if (piped) {
    label = piped[1]!
    end += piped[0].length
  }
  return { line: plain[3] ? "thick" : plain[4] ? "dashed" : "solid", head: headOf(plain[5]?.replace("!", "")), tail: headOf(plain[1]), label, end }
}

function registerNode(flow: Flow, id: string, text: string | undefined, shape: Shape | undefined) {
  const existing = flow.nodes.get(id)
  if (!existing) {
    flow.nodes.set(id, { id, lines: text === undefined ? [id] : decodeLabel(text), shape: shape ?? "rect", order: flow.nodes.size, explicit: text !== undefined })
    return
  }
  if (text !== undefined && !existing.explicit) {
    existing.lines = decodeLabel(text)
    existing.shape = shape ?? existing.shape
    existing.explicit = true
  }
}

function parseGroup(source: string, pos: number, flow: Flow): { ids: string[]; end: number } | undefined {
  const ids: string[] = []
  let cursor = pos
  while (true) {
    cursor = skipSpaces(source, cursor)
    const id = ID.exec(source.slice(cursor))
    if (!id) return undefined
    cursor += id[0].length
    let shape = parseShape(source, cursor)
    const extended = /^\s*@\{[^}]+\}/.exec(source.slice(cursor))
    if (extended) {
      const parsed = parseFlowchartNodeExpression(id[0] + extended[0])
      if (!parsed) return undefined
      const marker = flowchartShapeMarker(parsed.shape)
      const shapes: Record<string, Shape> = { rect: "rect", round: "round", stadium: "round", circle: "circle", "double-circle": "double-circle", diamond: "diamond", diam: "diamond", cylinder: "cylinder", subroutine: "subroutine", hexagon: "hexagon", parallelogram: "parallelogram", trapezoid: "trapezoid", asymmetric: "asymmetric" }
      shape = { text: `${!shapes[parsed.shape] && marker ? marker + " " : ""}${parsed.label}`, shape: shapes[parsed.shape] ?? "rect", end: cursor + extended[0].length }
    }
    if (shape) cursor = shape.end
    const klass = /^:::[\w-]+/.exec(source.slice(cursor))
    if (klass) cursor += klass[0].length
    registerNode(flow, id[0], shape?.text, shape?.shape)
    ids.push(id[0])
    const after = skipSpaces(source, cursor)
    if (source[after] === "&") {
      cursor = after + 1
      continue
    }
    return { ids, end: cursor }
  }
}

function parseFlowStatement(source: string, flow: Flow): boolean {
  let group = parseGroup(source, 0, flow)
  if (!group) return false
  while (true) {
    const pos = skipSpaces(source, group.end)
    if (pos >= source.length) return true
    const op = parseOperator(source, pos)
    if (!op) return false
    const next = parseGroup(source, op.end, flow)
    if (!next) return false
    const label = op.label === undefined ? undefined : decodeLabel(op.label).join(" ")
    for (const from of group.ids) for (const to of next.ids) flow.edges.push({ from, to, label: label || undefined, line: op.line, head: op.head, tail: op.tail })
    group = next
  }
}

/** Nested subgraph titles are joined with this separator in `Flow.groups`; the layout splits them back into a path. */
export const GROUP_SEPARATOR = " / "

export function parseFlowchart(lines: string[], direction: Direction): Flow | undefined {
  const flow: Flow = { direction, nodes: new Map(), edges: [], groups: new Map() }
  const groups: string[] = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("%%")) continue
    for (const statement of splitMermaidTopLevel(trimmed, ";")) {
      const text = statement.trim()
      if (!text || IGNORED_STATEMENT.test(text)) continue
      if (/^end$/i.test(text)) {
        if (!groups.pop()) return undefined
        continue
      }
      const group = /^subgraph\s+(.+)$/i.exec(text)
      if (group) {
        const parsed = parseFlowchartNodeExpression(group[1]!)
        groups.push((parsed?.label ?? group[1]!).trim())
        continue
      }
      const previous = new Map([...flow.nodes].map(([id, node]) => [id, node.explicit]))
      if (!parseFlowStatement(text, flow)) return undefined
      if (flow.nodes.size > 120 || flow.edges.length > 240) return undefined
      if (groups.length) for (const [id, node] of flow.nodes) {
        // A forward reference outside the subgraph must not steal its later declaration.
        if (!previous.has(id) || (!previous.get(id) && node.explicit)) flow.groups!.set(id, groups.join(GROUP_SEPARATOR))
      }
    }
  }
  return flow.nodes.size && groups.length === 0 ? flow : undefined
}

// ---------------------------------------------------------------------------------------------
// Flowchart: layout (layered, longest-path layers, barycenter ordering, orthogonal channel routing).
// Subgraphs are clusters: their members stay contiguous in every layer they span, a rectangle of
// columns belongs to the cluster alone, and a frame with the title in its border is drawn around it.

type Seg = {
  upper: LNode
  lower: LNode
  headUpper: Head
  headLower: Head
  label: string | undefined
  style: LineStyle
  upperPort: number
  lowerPort: number
  track: number
}

type LNode = {
  flow: FlowNode | undefined
  layer: number
  along: number
  across: number
  cross: number
  along0: number
  order: number
  ups: Seg[]
  downs: Seg[]
  inset: number
  /** Subgraph chain, outermost first; empty outside every subgraph. */
  path: string[]
  /** An invisible placeholder keeping a cluster present in a layer where it has no member. */
  spacer: boolean
}

type Cluster = {
  key: string
  path: string[]
  title: string
  depth: number
  minLayer: number
  maxLayer: number
  /** Inclusive cross-axis extent of the frame, border included. Valid after `measureFrames`. */
  lo: number
  hi: number
}

/** Rows (vertical) or columns (horizontal) a frame border needs beyond its content on the along axis: the border and a gap. */
const FRAME_ALONG = 2
/** Widest subgraph title kept in a frame border. */
const MAX_TITLE_WIDTH = 36

const pathKey = (path: readonly string[]) => path.join("\u0000")

function startsWithPath(path: readonly string[], prefix: readonly string[]) {
  if (prefix.length > path.length) return false
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false
  return true
}

function commonPrefixLength(a: readonly string[], b: readonly string[]) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** Frames crossed when stepping from one node to its neighbour: every subgraph one is inside and the other is not. */
function boundariesBetween(a: LNode, b: LNode) {
  const common = commonPrefixLength(a.path, b.path)
  return a.path.length - common + (b.path.length - common)
}

function boxSize(node: FlowNode) {
  const text = Math.max(...node.lines.map(textWidth), 1)
  const w = text + (node.shape === "diamond" ? 6 : node.shape === "circle" || node.shape === "subroutine" || node.shape === "double-circle" ? 6 : 4)
  return { w, h: node.lines.length + 2 }
}

function drawBox(canvas: Canvas, rect: { x: number; y: number; w: number; h: number }, node: FlowNode) {
  const { x, y, w, h } = rect
  const set = node.shape === "round" ? "╭─╮│╰╯" : node.shape === "circle" || node.shape === "double-circle" ? "╔═╗║╚╝" : node.shape === "cylinder" ? "╭─╮│╰╯" : "┌─┐│└┘"
  const inner = w - 2
  const mid = Math.floor((h - 1) / 2)
  for (let row = 0; row < h; row++) {
    const top = row === 0
    const bottom = row === h - 1
    if (node.shape === "diamond" || node.shape === "hexagon") {
      if (top || bottom) {
        canvas.glyph(x + 1, y + row, top ? "╱" : "╲", "box")
        canvas.glyph(x + w - 2, y + row, top ? "╲" : "╱", "box")
        for (let k = 2; k < w - 2; k++) canvas.glyph(x + k, y + row, "─", "box")
        continue
      }
      canvas.glyph(x, y + row, row === mid ? "<" : "│", "box")
      canvas.glyph(x + w - 1, y + row, row === mid ? ">" : "│", "box")
    } else if (top || bottom) {
      canvas.glyph(x, y + row, top ? set[0]! : set[4]!, "box")
      canvas.glyph(x + w - 1, y + row, top ? set[2]! : set[5]!, "box")
      for (let k = 1; k < w - 1; k++) canvas.glyph(x + k, y + row, set[1]!, "box")
      continue
    } else {
      canvas.glyph(x, y + row, set[3]!, "box")
      canvas.glyph(x + w - 1, y + row, set[3]!, "box")
    }
    for (let k = 1; k < w - 1; k++) canvas.glyph(x + k, y + row, " ", "text")
    if (node.shape === "subroutine" || node.shape === "double-circle") {
      canvas.glyph(x + 1, y + row, "│", "box")
      canvas.glyph(x + w - 2, y + row, "│", "box")
    }
    if (node.shape === "parallelogram" || node.shape === "trapezoid") {
      canvas.glyph(x, y + row, "╱", "box")
      canvas.glyph(x + w - 1, y + row, node.shape === "trapezoid" ? "╲" : "╱", "box")
    }
    if (node.shape === "asymmetric") canvas.glyph(x, y + row, ">", "box")
    const line = node.lines[row - 1] ?? ""
    canvas.text(x + 1 + Math.floor((inner - textWidth(line)) / 2), y + row, line, "text")
  }
}

function lineCells(line: Line) {
  return line.reduce((sum, span) => sum + textWidth(span.text), 0)
}

/** Drops blank rows at both ends and the blank columns shared by every row on the left. */
function cropLines(lines: Line[]): Line[] {
  let start = 0
  let end = lines.length
  while (start < end && lineCells(lines[start]!) === 0) start++
  while (end > start && lineCells(lines[end - 1]!) === 0) end--
  const rows = lines.slice(start, end)
  const indent = (line: Line) => {
    const first = line[0]
    return first && first.fg === undefined ? first.text.length : 0
  }
  const cut = Math.min(...rows.filter((line) => lineCells(line) > 0).map(indent), Number.POSITIVE_INFINITY)
  if (!Number.isFinite(cut) || cut === 0) return rows
  return rows.map((line) => (line.length === 0 ? line : [{ ...line[0]!, text: line[0]!.fg === undefined ? line[0]!.text.slice(cut) : line[0]!.text }, ...line.slice(1)].filter((s) => s.text !== "")))
}

function headGlyph(head: Head, dx: number, dy: number) {
  if (head === "x") return "✕"
  if (head === "o") return "○"
  return dy > 0 ? "▼" : dy < 0 ? "▲" : dx > 0 ? "▶" : "◀"
}

function dedupe(points: Point[]) {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y)
}

type Layout = { layers: LNode[][]; nodes: LNode[]; segs: Seg[]; chains: { edge: FlowEdge; segs: Seg[]; reversed: boolean }[]; clusters: Cluster[] } | undefined

function buildLayers(flow: Flow, vertical: boolean): Layout {
  const ids = [...flow.nodes.keys()]
  const pathOf = (id: string) => (flow.groups?.get(id) ?? "").split(GROUP_SEPARATOR).map((part) => part.trim()).filter(Boolean)
  const out = new Map<string, number[]>()
  flow.edges.forEach((edge, i) => {
    if (edge.from === edge.to) return
    const list = out.get(edge.from) ?? []
    list.push(i)
    out.set(edge.from, list)
  })
  const state = new Map<string, 0 | 1 | 2>()
  const back = new Set<number>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const i of out.get(id) ?? []) {
      const to = flow.edges[i]!.to
      const s = state.get(to) ?? 0
      if (s === 1) back.add(i)
      else if (s === 0) visit(to)
    }
    state.set(id, 2)
  }
  for (const id of ids) if (!state.get(id)) visit(id)

  const oriented = flow.edges
    .map((edge, i) => ({ edge, i, reversed: back.has(i) }))
    .filter(({ edge }) => edge.from !== edge.to)
    .map(({ edge, reversed }) => ({ edge, reversed, u: reversed ? edge.to : edge.from, v: reversed ? edge.from : edge.to }))
  const incoming = new Map<string, string[]>()
  for (const { u, v } of oriented) incoming.set(v, [...(incoming.get(v) ?? []), u])
  const layerOf = new Map<string, number>()
  const resolve = (id: string): number => {
    const known = layerOf.get(id)
    if (known !== undefined) return known
    const value = Math.max(-1, ...(incoming.get(id) ?? []).map(resolve)) + 1
    layerOf.set(id, value)
    return value
  }
  for (const id of ids) resolve(id)

  const nodes: LNode[] = []
  const layers: LNode[][] = []
  const real = new Map<string, LNode>()
  const add = (node: LNode) => {
    while (layers.length <= node.layer) layers.push([])
    node.order = layers[node.layer]!.length
    layers[node.layer]!.push(node)
    nodes.push(node)
  }
  const placeholder = (layer: number, path: string[], spacer: boolean): LNode => ({ flow: undefined, layer, along: 1, across: 1, cross: 0, along0: 0, order: 0, ups: [], downs: [], inset: 0, path, spacer })
  for (const id of ids) {
    const flowNode = flow.nodes.get(id)!
    const size = boxSize(flowNode)
    const node: LNode = {
      flow: flowNode,
      layer: layerOf.get(id)!,
      along: vertical ? size.h : size.w,
      across: vertical ? size.w : size.h,
      cross: 0,
      along0: 0,
      order: 0,
      ups: [],
      downs: [],
      inset: flowNode.shape === "diamond" && vertical ? 2 : 1,
      path: pathOf(id),
      spacer: false,
    }
    real.set(id, node)
    add(node)
  }

  const segs: Seg[] = []
  const chains: { edge: FlowEdge; segs: Seg[]; reversed: boolean }[] = []
  for (const { edge, reversed, u, v } of oriented) {
    const top = real.get(u)!
    const bottom = real.get(v)!
    // A long edge travels inside the deepest subgraph shared by both ends, so it leaves a frame only when it must.
    const shared = top.path.slice(0, commonPrefixLength(top.path, bottom.path))
    const chain: LNode[] = [top]
    for (let layer = top.layer + 1; layer < bottom.layer; layer++) {
      const dummy = placeholder(layer, shared, false)
      add(dummy)
      chain.push(dummy)
    }
    chain.push(bottom)
    const chainSegs: Seg[] = []
    for (let k = 0; k + 1 < chain.length; k++) {
      const seg: Seg = {
        upper: chain[k]!,
        lower: chain[k + 1]!,
        headUpper: k === 0 ? (reversed ? edge.head : edge.tail) : "none",
        headLower: k + 2 === chain.length ? (reversed ? edge.tail : edge.head) : "none",
        label: k === 0 ? edge.label : undefined,
        style: edge.line,
        upperPort: 0,
        lowerPort: 0,
        track: -1,
      }
      seg.upper.downs.push(seg)
      seg.lower.ups.push(seg)
      chainSegs.push(seg)
      segs.push(seg)
    }
    chains.push({ edge, segs: chainSegs, reversed })
  }

  // Every subgraph prefix is a cluster spanning the layers of its members.
  const clusters = new Map<string, Cluster>()
  for (const node of nodes) {
    for (let depth = 1; depth <= node.path.length; depth++) {
      const path = node.path.slice(0, depth)
      const key = pathKey(path)
      const existing = clusters.get(key)
      if (existing) {
        existing.minLayer = Math.min(existing.minLayer, node.layer)
        existing.maxLayer = Math.max(existing.maxLayer, node.layer)
      } else clusters.set(key, { key, path, title: truncateEnd(path[depth - 1]!, MAX_TITLE_WIDTH), depth, minLayer: node.layer, maxLayer: node.layer, lo: 0, hi: 0 })
    }
  }
  for (const cluster of clusters.values()) {
    for (let layer = cluster.minLayer; layer <= cluster.maxLayer; layer++) {
      if (layers[layer]!.some((node) => startsWithPath(node.path, cluster.path))) continue
      add(placeholder(layer, cluster.path, true))
    }
  }
  const ordered = [...clusters.values()].sort((a, b) => a.depth - b.depth || a.minLayer - b.minLayer)
  return { layers, nodes, segs, chains, clusters: ordered }
}

/**
 * Barycenter sweeps keep each cluster contiguous inside a layer; a final pass orders clusters by one key
 * shared by all their layers, so a cluster is a rectangle of columns instead of a staircase.
 */
function orderLayers(layers: LNode[][], clusters: Cluster[]) {
  const sortLayer = (layer: LNode[], base: (n: LNode) => number, clusterKey?: (key: string) => number | undefined) => {
    const own = new Map(layer.map((node) => [node, base(node)]))
    const local = new Map<string, { sum: number; n: number }>()
    for (const node of layer) {
      for (let depth = 1; depth <= node.path.length; depth++) {
        const key = pathKey(node.path.slice(0, depth))
        const slot = local.get(key) ?? { sum: 0, n: 0 }
        slot.sum += own.get(node)!
        slot.n++
        local.set(key, slot)
      }
    }
    const keyOf = (key: string) => {
      const shared = clusterKey?.(key)
      if (shared !== undefined) return shared
      const slot = local.get(key)!
      return slot.sum / slot.n
    }
    const compare = (a: LNode, b: LNode) => {
      for (let level = 0; ; level++) {
        const ga = a.path[level]
        const gb = b.path[level]
        if (ga !== undefined && gb !== undefined && ga === gb) continue
        const ka = ga === undefined ? own.get(a)! : keyOf(pathKey(a.path.slice(0, level + 1)))
        const kb = gb === undefined ? own.get(b)! : keyOf(pathKey(b.path.slice(0, level + 1)))
        if (ka !== kb) return ka - kb
        return a.order - b.order
      }
    }
    const sorted = [...layer].sort(compare)
    sorted.forEach((node, index) => {
      node.order = index
      layer[index] = node
    })
  }
  const barycenter = (neighbors: (n: LNode) => LNode[]) => (node: LNode) => {
    const near = neighbors(node)
    return near.length ? near.reduce((sum, n) => sum + n.order, 0) / near.length : node.order
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < layers.length; l++) sortLayer(layers[l]!, barycenter((n) => n.ups.map((s) => s.upper)))
    for (let l = layers.length - 2; l >= 0; l--) sortLayer(layers[l]!, barycenter((n) => n.downs.map((s) => s.lower)))
  }
  if (!clusters.length) return
  const normalized = (node: LNode) => node.order / Math.max(1, layers[node.layer]!.length - 1)
  const shared = new Map<string, number>()
  for (const cluster of clusters) {
    const members = layers.flat().filter((node) => startsWithPath(node.path, cluster.path))
    shared.set(cluster.key, members.reduce((sum, node) => sum + normalized(node), 0) / Math.max(1, members.length))
  }
  for (const layer of layers) sortLayer(layer, normalized, (key) => shared.get(key))
}

const centerOf = (n: LNode) => n.cross + Math.floor((n.across - 1) / 2)

/** Cross-axis padding a frame adds around its content: border plus a gap, and for horizontal diagrams a title row at the top. */
function framePads(vertical: boolean) {
  return vertical ? { lo: 2, hi: 2 } : { lo: 3, hi: 2 }
}

/** Recomputes every cluster's cross extent from the current node positions, innermost clusters first. */
function measureFrames(clusters: Cluster[], nodes: LNode[], vertical: boolean) {
  const pads = framePads(vertical)
  const byKey = new Map(clusters.map((cluster) => [cluster.key, cluster]))
  for (const cluster of [...clusters].sort((a, b) => b.depth - a.depth)) {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const node of nodes) {
      if (!startsWithPath(node.path, cluster.path)) continue
      if (node.path.length === cluster.depth) {
        lo = Math.min(lo, node.cross)
        hi = Math.max(hi, node.cross + node.across - 1)
        continue
      }
      const child = byKey.get(pathKey(node.path.slice(0, cluster.depth + 1)))!
      lo = Math.min(lo, child.lo)
      hi = Math.max(hi, child.hi)
    }
    if (!Number.isFinite(lo)) {
      lo = 0
      hi = 0
    }
    cluster.lo = lo - pads.lo
    cluster.hi = hi + pads.hi
    if (vertical) {
      // The title lives in the top border: `┌─ Title ─┐` needs the title, two spaces, a dash and both corners.
      const need = textWidth(cluster.title) + 5
      if (cluster.hi - cluster.lo + 1 < need) cluster.hi = cluster.lo + need - 1
    }
  }
}

function placeAcross(layers: LNode[][], spacing: number, vertical: boolean, clusters: Cluster[]) {
  const gap = (prev: LNode, node: LNode) => (prev.spacer || node.spacer ? 1 : spacing) + 3 * boundariesBetween(prev, node)
  const layerWidth = layers.map((layer) => layer.reduce((sum, n, i) => sum + n.across + (i ? gap(layer[i - 1]!, n) : 0), 0))
  const widest = Math.max(...layerWidth, 1)
  layers.forEach((layer, l) => {
    let cursor = Math.floor((widest - layerWidth[l]!) / 2)
    layer.forEach((node, i) => {
      if (i) cursor += gap(layer[i - 1]!, node)
      node.cross = cursor
      cursor += node.across
    })
  })
  const settle = (layer: LNode[], neighbors: (n: LNode) => LNode[]) => {
    let cursor = Number.NEGATIVE_INFINITY
    layer.forEach((node, i) => {
      const near = neighbors(node)
      const want = near.length ? Math.round(near.reduce((sum, n) => sum + centerOf(n), 0) / near.length) - Math.floor((node.across - 1) / 2) : node.cross
      node.cross = Math.max(want, i ? cursor + gap(layer[i - 1]!, node) : cursor)
      cursor = node.cross + node.across
    })
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let l = 1; l < layers.length; l++) settle(layers[l]!, (n) => n.ups.map((s) => s.upper))
    for (let l = layers.length - 2; l >= 0; l--) settle(layers[l]!, (n) => n.downs.map((s) => s.lower))
  }
  const all = layers.flat()
  if (clusters.length) separateClusters(layers, all, vertical, clusters)
  let min = Math.min(...all.map((n) => n.cross))
  if (clusters.length) {
    measureFrames(clusters, all, vertical)
    min = Math.min(min, ...clusters.map((cluster) => cluster.lo))
  }
  for (const node of all) node.cross -= min
  if (clusters.length) measureFrames(clusters, all, vertical)
}

/**
 * Makes every cluster a rectangle nothing else enters: in each layer a cluster spans, a node outside it (or the
 * outermost sibling cluster holding that node) must end a gap before the frame or start a gap after it.
 * Violations push the later block to the right, so positions only grow and the loop settles.
 */
function separateClusters(layers: LNode[][], nodes: LNode[], vertical: boolean, clusters: Cluster[]) {
  const byKey = new Map(clusters.map((cluster) => [cluster.key, cluster]))
  const shiftFrom = (layer: LNode[], firstOrder: number, delta: number) => {
    for (const node of layer) if (node.order >= firstOrder) node.cross += delta
  }
  const shiftCluster = (cluster: Cluster, delta: number) => {
    for (let l = cluster.minLayer; l <= cluster.maxLayer; l++) {
      const layer = layers[l]!
      const first = Math.min(...layer.filter((node) => startsWithPath(node.path, cluster.path)).map((node) => node.order))
      if (Number.isFinite(first)) shiftFrom(layer, first, delta)
    }
  }
  for (let pass = 0; pass < 40; pass++) {
    measureFrames(clusters, nodes, vertical)
    let changed = false
    for (const cluster of clusters) {
      for (let l = cluster.minLayer; l <= cluster.maxLayer; l++) {
        const layer = layers[l]!
        const inside = layer.filter((node) => startsWithPath(node.path, cluster.path)).map((node) => node.order)
        if (!inside.length) continue
        const first = Math.min(...inside)
        const last = Math.max(...inside)
        for (const node of layer) {
          if (startsWithPath(node.path, cluster.path)) continue
          const common = commonPrefixLength(node.path, cluster.path)
          const block = node.path.length > common ? byKey.get(pathKey(node.path.slice(0, common + 1))) : undefined
          const left = block ? block.lo : node.cross
          const right = block ? block.hi : node.cross + node.across - 1
          if (node.order < first) {
            const need = right + 2
            if (cluster.lo < need) {
              shiftCluster(cluster, need - cluster.lo)
              changed = true
              measureFrames(clusters, nodes, vertical)
            }
          } else if (node.order > last) {
            const need = cluster.hi + 2
            if (left < need) {
              if (block) shiftCluster(block, need - left)
              else shiftFrom(layer, node.order, need - left)
              changed = true
              measureFrames(clusters, nodes, vertical)
            }
          }
        }
      }
    }
    if (!changed) return
  }
}

/** Arrows of the same kind entering one node share a single port, so a merge reads as one joined arrow. */
function mergesIntoOnePort(segs: Seg[]) {
  const [first] = segs
  return segs.length > 1 && first!.headLower !== "none" && segs.every((s) => s.headLower === first!.headLower && s.style === first!.style)
}

function assignPorts(node: LNode, segs: Seg[], neighbor: (s: Seg) => LNode, set: (s: Seg, p: number) => void, merge = false) {
  const centers = new Map(segs.map((s) => [s, centerOf(neighbor(s))]))
  if (!node.flow) {
    for (const s of segs) set(s, centerOf(node))
    return
  }
  if (merge && mergesIntoOnePort(segs)) {
    const lo = node.cross + node.inset
    const hi = Math.max(lo, node.cross + node.across - 1 - node.inset)
    const port = Math.min(hi, Math.max(lo, centerOf(node)))
    for (const s of segs) set(s, port)
    return
  }
  const lo = node.cross + node.inset
  const hi = Math.max(lo, node.cross + node.across - 1 - node.inset)
  const sorted = [...segs].sort((a, b) => centers.get(a)! - centers.get(b)!)
  const ports = sorted.map((s) => Math.min(hi, Math.max(lo, centers.get(s)!)))
  const step = hi - lo >= 2 * (ports.length - 1) ? 2 : 1
  for (let i = 1; i < ports.length; i++) ports[i] = Math.max(ports[i]!, Math.min(hi, ports[i - 1]! + step))
  for (let i = ports.length - 2; i >= 0; i--) ports[i] = Math.min(ports[i]!, ports[i + 1]! - (ports[i + 1]! - step >= lo ? step : 0))
  sorted.forEach((s, i) => set(s, ports[i]!))
}

function assignTracks(segs: Seg[]) {
  const tracks: Seg[][] = []
  const span = (s: Seg): [number, number] => (s.upperPort < s.lowerPort ? [s.upperPort, s.lowerPort] : [s.lowerPort, s.upperPort])
  const bent = segs.filter((s) => s.upperPort !== s.lowerPort).sort((a, b) => span(a)[0] - span(b)[0])
  for (const seg of bent) {
    const [lo, hi] = span(seg)
    let index = tracks.findIndex((track) =>
      track.every((other) => {
        const [olo, ohi] = span(other)
        return other.upper === seg.upper || other.lower === seg.lower || hi < olo || ohi < lo
      }),
    )
    if (index < 0) {
      index = tracks.length
      tracks.push([])
    }
    tracks[index]!.push(seg)
    seg.track = index
  }
  return tracks.length
}

type Run = { a: Point; b: Point }

function labelCandidates(runs: Run[], width: number, vertical: boolean): Point[] {
  const out: Point[] = []
  const horizontal = runs.filter((r) => r.a.y === r.b.y && r.a.x !== r.b.x)
  const verticalRuns = runs.filter((r) => r.a.x === r.b.x && r.a.y !== r.b.y)
  const onLine = () => {
    for (const run of horizontal) {
      const xa = Math.min(run.a.x, run.b.x)
      const n = Math.abs(run.b.x - run.a.x) + 1
      if (n >= width + 2) out.push({ x: xa + 1 + Math.floor((n - 2 - width) / 2), y: run.a.y })
    }
  }
  const besideHorizontal = () => {
    for (const run of horizontal) {
      const xa = Math.min(run.a.x, run.b.x)
      const xb = Math.max(run.a.x, run.b.x)
      const n = xb - xa + 1
      for (const dy of [-1, 1]) {
        for (const x of [xa + Math.floor((n - width) / 2), xa + 1, xb - width]) out.push({ x, y: run.a.y + dy })
      }
    }
  }
  const fromVertical = () => {
    for (const run of verticalRuns) {
      const ya = Math.min(run.a.y, run.b.y)
      const yb = Math.max(run.a.y, run.b.y)
      const rows = Array.from({ length: yb - ya + 1 }, (_, k) => ya + k).sort((p, q) => Math.abs(p - (ya + yb) / 2) - Math.abs(q - (ya + yb) / 2))
      for (const y of rows) out.push({ x: run.a.x + 2, y }, { x: run.a.x - 1 - width, y })
    }
  }
  if (vertical) {
    onLine()
    fromVertical()
    besideHorizontal()
  } else {
    besideHorizontal()
    fromVertical()
  }
  return out
}

/** A frame border cell: lines already routed through it become crossings, and nothing drawn before it is overwritten. */
function frameCell(canvas: Canvas, x: number, y: number, ch: string) {
  if (canvas.charAt(x, y) !== "") return
  const mask = canvas.maskAt(x, y)
  if (mask === 0) {
    canvas.glyph(x, y, ch, "frame")
    return
  }
  const vertical = (mask & 5) !== 0
  const horizontal = (mask & (E | W)) !== 0
  const crossing = (ch === "─" && vertical) || (ch === "│" && horizontal) || (vertical && horizontal)
  canvas.glyph(x, y, crossing ? "┼" : ch, "frame")
}

function drawFrame(canvas: Canvas, rect: { x0: number; y0: number; x1: number; y1: number }, title: string, titleInBorder: boolean) {
  const { x0, y0, x1, y1 } = rect
  if (x1 - x0 < 2 || y1 - y0 < 1) return
  for (let x = x0 + 1; x < x1; x++) {
    frameCell(canvas, x, y0, "─")
    frameCell(canvas, x, y1, "─")
  }
  for (let y = y0 + 1; y < y1; y++) {
    frameCell(canvas, x0, y, "│")
    frameCell(canvas, x1, y, "│")
  }
  frameCell(canvas, x0, y0, "┌")
  frameCell(canvas, x1, y0, "┐")
  frameCell(canvas, x0, y1, "└")
  frameCell(canvas, x1, y1, "┘")
  // In the border the title sits between two spaces and must leave the corner alone; inside it uses the inner width.
  const room = titleInBorder ? x1 - x0 - 4 : x1 - x0 - 3
  if (room < 1) return
  const text = truncateEnd(title, room)
  if (!text) return
  if (titleInBorder) canvas.text(x0 + 2, y0, ` ${text} `, "keyword")
  else canvas.text(x0 + 2, y0 + 1, text, "keyword")
}

type LayoutOptions = { spacing: number }

function layeredFlowchart(flow: Flow, maxWidth: number, options: LayoutOptions): { lines: Line[] } | { note: string } {
  if (flow.nodes.size > MAX_NODES) return { note: MERMAID_NOTES.tooComplex }
  const vertical = flow.direction === "TD" || flow.direction === "BT"
  const mirrored = flow.direction === "BT" || flow.direction === "RL"
  const layout = buildLayers(flow, vertical)
  if (!layout) return { note: MERMAID_NOTES.unsupported }
  const { layers, nodes, segs, chains, clusters } = layout

  orderLayers(layers, clusters)
  const widestLabel = Math.max(0, ...flow.edges.map((e) => (e.label ? textWidth(e.label) : 0)))
  placeAcross(layers, vertical ? Math.min(options.spacing, Math.max(3, widestLabel + 2)) : 1, vertical, clusters)
  for (const node of nodes) {
    assignPorts(node, node.downs, (s) => s.lower, (s, p) => (s.upperPort = p))
    assignPorts(node, node.ups, (s) => s.upper, (s, p) => (s.lowerPort = p), true)
  }

  const gaps = layers.length - 1
  const bandSize: number[] = []
  for (let g = 0; g < gaps; g++) {
    const inGap = segs.filter((s) => s.upper.layer === g)
    const tracks = assignTracks(inGap)
    const labeled = inGap.filter((s) => s.label)
    const widest = Math.max(0, ...labeled.map((s) => textWidth(s.label!)))
    bandSize.push(vertical ? 2 + tracks + (labeled.length ? Math.min(2, labeled.length) : 0) : Math.max(4, 2 + Math.max(tracks, 1), labeled.length ? widest + 4 : 0))
  }
  // Frames opening at a layer take rows above its boxes (outermost first); frames closing take rows below (innermost first).
  const opening = layers.map((_, l) => clusters.filter((c) => c.minLayer === l).sort((a, b) => a.depth - b.depth))
  const closing = layers.map((_, l) => clusters.filter((c) => c.maxLayer === l).sort((a, b) => b.depth - a.depth))
  const before = opening.map((list) => list.length * FRAME_ALONG)
  const after = closing.map((list) => list.length * FRAME_ALONG)
  const thickness = layers.map((layer) => Math.max(1, ...layer.filter((n) => n.flow).map((n) => n.along)))
  const layerStart: number[] = []
  const boxesAt: number[] = []
  let cursor = 0
  layers.forEach((_, l) => {
    layerStart.push(cursor)
    boxesAt.push(cursor + before[l]!)
    cursor += before[l]! + thickness[l]! + after[l]! + (bandSize[l] ?? 0)
  })
  const total = cursor
  for (const node of nodes) node.along0 = boxesAt[node.layer]! + Math.floor((thickness[node.layer]! - node.along) / 2)

  const crossExtent = Math.max(...nodes.map((n) => n.cross + n.across), ...clusters.map((c) => c.hi + 1))
  const width = vertical ? crossExtent : total
  const height = vertical ? total : crossExtent
  if (width > maxWidth) return { note: MERMAID_NOTES.tooWide }
  if (height > MAX_ROWS) return { note: MERMAID_NOTES.tooComplex }

  const flip = (s: number) => (mirrored ? total - 1 - s : s)
  const pad = widestLabel ? widestLabel + 3 : 0
  const toReal = (s: number, c: number): Point => (vertical ? { x: c + pad, y: flip(s) + 1 } : { x: flip(s) + pad, y: c + 1 })
  const canvas = new Canvas(width + 2 * pad, height + 2)

  for (const node of nodes) {
    if (!node.flow) continue
    const s0 = mirrored ? flip(node.along0 + node.along - 1) : node.along0
    const rect = vertical
      ? { x: node.cross + pad, y: s0 + 1, w: node.across, h: node.along }
      : { x: s0 + pad, y: node.cross + 1, w: node.along, h: node.across }
    drawBox(canvas, rect, node.flow)
  }

  const runsByEdge = new Map<FlowEdge, Run[]>()
  for (const chain of chains) {
    const abstract: { s: number; c: number }[] = []
    for (const seg of chain.segs) {
      const g = seg.upper.layer
      const bandStart = boxesAt[g]! + thickness[g]! + after[g]!
      const arrow = layerStart[g + 1]! - 1
      const s0 = seg.upper.flow ? seg.upper.along0 + seg.upper.along : bandStart
      const s1 = seg.lower.flow ? seg.lower.along0 - 1 : arrow
      if (seg.upperPort === seg.lowerPort) abstract.push({ s: s0, c: seg.upperPort }, { s: s1, c: seg.lowerPort })
      else {
        const track = bandStart + 1 + seg.track
        abstract.push({ s: s0, c: seg.upperPort }, { s: track, c: seg.upperPort }, { s: track, c: seg.lowerPort }, { s: s1, c: seg.lowerPort })
      }
    }
    const points = dedupe(abstract.map(({ s, c }) => toReal(s, c)))
    const first = chain.segs[0]!
    const last = chain.segs[chain.segs.length - 1]!
    canvas.path(points, first.style)
    if (points.length < 2) continue
    const p0 = points[0]!
    const p1 = points[1]!
    const pn = points[points.length - 1]!
    const pm = points[points.length - 2]!
    const startSide = { N: p1.y < p0.y, S: p1.y > p0.y, W: p1.x < p0.x, E: p1.x > p0.x }
    const endSide = { N: pm.y < pn.y, S: pm.y > pn.y, W: pm.x < pn.x, E: pm.x > pn.x }
    const sideOf = (t: typeof startSide): "N" | "E" | "S" | "W" => (t.S ? "S" : t.N ? "N" : t.E ? "E" : "W")
    const startHead = first.headUpper
    const endHead = last.headLower
    // Points at the box-adjacent cells; `start` runs away from its box, `end` runs into its box.
    const startBox = first.upper.flow ? { x: p0.x - (p1.x - p0.x === 0 ? 0 : Math.sign(p1.x - p0.x)), y: p0.y - (p1.y - p0.y === 0 ? 0 : Math.sign(p1.y - p0.y)) } : undefined
    const endBox = last.lower.flow ? { x: pn.x + (pn.x - pm.x === 0 ? 0 : Math.sign(pn.x - pm.x)), y: pn.y + (pn.y - pm.y === 0 ? 0 : Math.sign(pn.y - pm.y)) } : undefined
    if (startHead !== "none") canvas.glyph(p0.x, p0.y, headGlyph(startHead, p0.x - p1.x, p0.y - p1.y), "edge")
    else if (startBox) canvas.junction(startBox.x, startBox.y, sideOf(startSide))
    if (endHead !== "none") canvas.glyph(pn.x, pn.y, headGlyph(endHead, pn.x - pm.x, pn.y - pm.y), "edge")
    else if (endBox) canvas.junction(endBox.x, endBox.y, sideOf(endSide))
    const runs: Run[] = []
    for (let k = 0; k + 1 < points.length; k++) runs.push({ a: points[k]!, b: points[k + 1]! })
    runsByEdge.set(chain.edge, runs)
  }

  // Frames go on after the edges so a line through a border reads as a crossing, and before the labels so no label lands on a border.
  for (const cluster of [...clusters].sort((a, b) => a.depth - b.depth)) {
    const alongLo = layerStart[cluster.minLayer]! + opening[cluster.minLayer]!.indexOf(cluster) * FRAME_ALONG
    const alongHi = boxesAt[cluster.maxLayer]! + thickness[cluster.maxLayer]! + 1 + closing[cluster.maxLayer]!.indexOf(cluster) * FRAME_ALONG
    const a = toReal(alongLo, cluster.lo)
    const b = toReal(alongHi, cluster.hi)
    drawFrame(canvas, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, cluster.title, vertical)
  }

  for (const chain of chains) {
    const label = chain.edge.label
    if (!label) continue
    const runs = runsByEdge.get(chain.edge) ?? []
    const first = chain.segs[0]!
    const own = runs.slice(0, first.upperPort === first.lowerPort ? 1 : 3)
    const w = textWidth(label)
    const pure = (x: number, y: number) => {
      const m = canvas.maskAt(x, y)
      return m === (E | W) && canvas.charAt(x, y) === ""
    }
    const spot = labelCandidates(own, w, vertical).find(({ x, y }) => {
      if (canvas.isFreeRun(x, y, w)) return true
      for (let k = 0; k < w; k++) if (!pure(x + k, y)) return false
      return true
    })
    if (!spot) return { note: MERMAID_NOTES.tooComplex }
    canvas.text(spot.x, spot.y, label, "label")
  }
  const lines = cropLines(canvas.toLines())
  return lines.some((line) => lineCells(line) > maxWidth) ? { note: MERMAID_NOTES.tooWide } : { lines }
}

/** The same flow with every node label re-wrapped to a narrower column, for a second attempt at a tight width. */
function narrowed(flow: Flow, labelWidth: number): Flow {
  const nodes = new Map<string, FlowNode>()
  for (const [id, node] of flow.nodes) nodes.set(id, { ...node, lines: wrap(node.lines.join(" "), labelWidth) })
  return { ...flow, nodes }
}

/** The single-column scene: every box stacked, every connection on a side channel. The last resort when layers do not fit. */
function sceneFlowchart(flow: Flow, maxWidth: number): { lines: Line[] } | { note: string } {
  const nodes = [...flow.nodes.values()].map((node) => ({ id: node.id, label: node.lines.join(" "), draw: (canvas: Canvas, rect: { x: number; y: number; w: number; h: number }) => drawBox(canvas, rect, { ...node, lines: wrap(node.lines.join(" "), rect.w - 4) }), ...(flow.groups?.get(node.id) ? { group: flow.groups.get(node.id)! } : {}) }))
  const edges = flow.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}), style: edge.line, head: edge.head === "none" ? "─" : edge.head === "x" ? "✕" : edge.head === "o" ? "○" : "◀", ...(edge.tail !== "none" ? { tail: headGlyph(edge.tail, -1, 0) } : {}) }))
  if (flow.direction === "LR" || flow.direction === "RL") return horizontalScene(nodes, edges, maxWidth, flow.direction === "RL")
  return graphScene(flow.direction === "BT" ? [...nodes].reverse() : nodes, edges, maxWidth)
}

/**
 * Layered layout first, at the usual spacing; when that overflows the width, once more with tight spacing and
 * narrower boxes. A flowchart without subgraphs that still does not fit keeps the note: the chat shows its source
 * and `/diagram` draws it at full size. One with subgraphs was always drawn in the chat (the stacked scene, before
 * clusters were laid out), so it goes on: a left-to-right flow is laid out top-down (RL as BT), which needs the
 * width of one layer instead of the whole chain, and the stacked single-column scene comes only when nothing
 * layered fits. A diagram that cannot be drawn at all keeps the first attempt's note.
 */
export function renderFlowchart(flow: Flow, maxWidth: number): { lines: Line[] } | { note: string } {
  if (flow.nodes.size > MAX_NODES) return { note: MERMAID_NOTES.tooComplex }
  const first = layeredFlowchart(flow, maxWidth, { spacing: 14 })
  if ("lines" in first) return first
  const retry = first.note === MERMAID_NOTES.tooWide || first.note === MERMAID_NOTES.tooComplex
  if (!retry) return first
  const compact = layeredFlowchart(narrowed(flow, 16), maxWidth, { spacing: 3 })
  if ("lines" in compact) return compact
  if (!flow.groups?.size) return first
  if (flow.direction === "LR" || flow.direction === "RL") {
    const turned: Flow = { ...flow, direction: flow.direction === "LR" ? "TD" : "BT" }
    for (const attempt of [layeredFlowchart(turned, maxWidth, { spacing: 14 }), layeredFlowchart(narrowed(turned, 16), maxWidth, { spacing: 3 })]) if ("lines" in attempt) return attempt
  }
  const stacked = sceneFlowchart(narrowed(flow, 24), maxWidth)
  return "lines" in stacked ? stacked : first
}

// ---------------------------------------------------------------------------------------------
// Sequence diagrams
