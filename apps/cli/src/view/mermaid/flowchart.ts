import { graphScene, horizontalScene } from "./graph-scene"
import { parseFlowchartNodeExpression, flowchartShapeMarker, splitMermaidTopLevel } from "./legacy-shared"
import type { Line } from "../../ui/theme"
import { textWidth, cells, wrap } from "../wrap"
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
        groups.push(parsed?.label ?? group[1]!)
        continue
      }
      const previous = new Map([...flow.nodes].map(([id, node]) => [id, node.explicit]))
      if (!parseFlowStatement(text, flow)) return undefined
      if (flow.nodes.size > 120 || flow.edges.length > 240) return undefined
      if (groups.length) for (const [id, node] of flow.nodes) {
        // A forward reference outside the subgraph must not steal its later declaration.
        if (!previous.has(id) || (!previous.get(id) && node.explicit)) flow.groups!.set(id, groups.join(" / "))
      }
    }
  }
  return flow.nodes.size && groups.length === 0 ? flow : undefined
}

// ---------------------------------------------------------------------------------------------
// Flowchart: layout (layered, longest-path layers, barycenter ordering, orthogonal channel routing)

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

type Layout = { layers: LNode[][]; nodes: LNode[]; segs: Seg[]; chains: { edge: FlowEdge; segs: Seg[]; reversed: boolean }[] } | undefined

function buildLayers(flow: Flow, vertical: boolean): Layout {
  const ids = [...flow.nodes.keys()]
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
    }
    real.set(id, node)
    add(node)
  }

  const segs: Seg[] = []
  const chains: { edge: FlowEdge; segs: Seg[]; reversed: boolean }[] = []
  for (const { edge, reversed, u, v } of oriented) {
    const top = real.get(u)!
    const bottom = real.get(v)!
    const chain: LNode[] = [top]
    for (let layer = top.layer + 1; layer < bottom.layer; layer++) {
      const dummy: LNode = { flow: undefined, layer, along: 1, across: 1, cross: 0, along0: 0, order: 0, ups: [], downs: [], inset: 0 }
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
  return { layers, nodes, segs, chains }
}

function orderLayers(layers: LNode[][]) {
  const sortLayer = (layer: LNode[], neighbors: (n: LNode) => LNode[]) => {
    const keyed = layer.map((node, index) => {
      const near = neighbors(node)
      return { node, index, key: near.length ? near.reduce((sum, n) => sum + n.order, 0) / near.length : node.order }
    })
    keyed.sort((a, b) => a.key - b.key || a.index - b.index)
    keyed.forEach(({ node }, index) => {
      node.order = index
      layer[index] = node
    })
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < layers.length; l++) sortLayer(layers[l]!, (n) => n.ups.map((s) => s.upper))
    for (let l = layers.length - 2; l >= 0; l--) sortLayer(layers[l]!, (n) => n.downs.map((s) => s.lower))
  }
}

const centerOf = (n: LNode) => n.cross + Math.floor((n.across - 1) / 2)

function placeAcross(layers: LNode[][], spacing: number) {
  const layerWidth = layers.map((layer) => layer.reduce((sum, n) => sum + n.across, 0) + spacing * Math.max(0, layer.length - 1))
  const widest = Math.max(...layerWidth, 1)
  layers.forEach((layer, l) => {
    let cursor = Math.floor((widest - layerWidth[l]!) / 2)
    for (const node of layer) {
      node.cross = cursor
      cursor += node.across + spacing
    }
  })
  const settle = (layer: LNode[], neighbors: (n: LNode) => LNode[]) => {
    let cursor = Number.NEGATIVE_INFINITY
    for (const node of layer) {
      const near = neighbors(node)
      const want = near.length ? Math.round(near.reduce((sum, n) => sum + centerOf(n), 0) / near.length) - Math.floor((node.across - 1) / 2) : node.cross
      node.cross = Math.max(want, cursor)
      cursor = node.cross + node.across + spacing
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let l = 1; l < layers.length; l++) settle(layers[l]!, (n) => n.ups.map((s) => s.upper))
    for (let l = layers.length - 2; l >= 0; l--) settle(layers[l]!, (n) => n.downs.map((s) => s.lower))
  }
  const min = Math.min(...layers.flat().map((n) => n.cross))
  for (const node of layers.flat()) node.cross -= min
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

export function renderFlowchart(flow: Flow, maxWidth: number): { lines: Line[] } | { note: string } {
  if (flow.groups?.size) {
    const nodes = [...flow.nodes.values()].map((node) => ({ id: node.id, label: node.lines.join(" "), draw: (canvas: Canvas, rect: { x: number; y: number; w: number; h: number }) => drawBox(canvas, rect, { ...node, lines: wrap(node.lines.join(" "), rect.w - 4) }), ...(flow.groups?.get(node.id) ? { group: flow.groups.get(node.id)! } : {}) }))
    const edges = flow.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}), style: edge.line, head: edge.head === "none" ? "─" : edge.head === "x" ? "✕" : edge.head === "o" ? "○" : "◀", ...(edge.tail !== "none" ? { tail: headGlyph(edge.tail, -1, 0) } : {}) }))
    if (flow.direction === "LR" || flow.direction === "RL") return horizontalScene(nodes, edges, maxWidth, flow.direction === "RL")
    return graphScene(flow.direction === "BT" ? [...nodes].reverse() : nodes, edges, maxWidth)
  }
  if (flow.nodes.size > MAX_NODES) return { note: MERMAID_NOTES.tooComplex }
  const vertical = flow.direction === "TD" || flow.direction === "BT"
  const mirrored = flow.direction === "BT" || flow.direction === "RL"
  const layout = buildLayers(flow, vertical)
  if (!layout) return { note: MERMAID_NOTES.unsupported }
  const { layers, nodes, segs, chains } = layout

  orderLayers(layers)
  const widestLabel = Math.max(0, ...flow.edges.map((e) => (e.label ? textWidth(e.label) : 0)))
  placeAcross(layers, vertical ? Math.min(14, Math.max(3, widestLabel + 2)) : 1)
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
  const thickness = layers.map((layer) => Math.max(1, ...layer.filter((n) => n.flow).map((n) => n.along)))
  const layerStart: number[] = []
  let cursor = 0
  layers.forEach((_, l) => {
    layerStart.push(cursor)
    cursor += thickness[l]! + (bandSize[l] ?? 0)
  })
  const total = cursor
  for (const node of nodes) node.along0 = layerStart[node.layer]! + Math.floor((thickness[node.layer]! - node.along) / 2)

  const crossExtent = Math.max(...nodes.map((n) => n.cross + n.across))
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
      const bandStart = layerStart[g]! + thickness[g]!
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

// ---------------------------------------------------------------------------------------------
// Sequence diagrams
