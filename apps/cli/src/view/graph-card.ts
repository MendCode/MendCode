import type { RenderGraphEdge } from "@mendcode/protocol"
import type { Line, Span } from "../ui/theme"
import { GRAPH_GLYPHS_ASCII, GRAPH_GLYPHS_UNICODE, layoutGraph, renderGraph, type GraphEdge, type GraphNode, type Layout } from "./ascii-graph"
import { fit, lineWidth } from "./deck"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/**
 * A renderSpec `graph` node: the root centred with its neighbours around it inside a rounded frame, edge labels
 * from `relation`, arrows from -> to. Below `MIN_FRAMED` columns it falls back to one `a --rel--> b` row per edge.
 * Pure: rows are exactly `width` cells.
 */

export const GRAPH_CARD = { minFramed: 58, neighbours: 8, secondRing: 0, minRows: 7, maxRows: 15 } as const

const STRETCH = 2

const FRAME_UNICODE = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const
const FRAME_ASCII = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" } as const

export type GraphCardInput = { root: string; edges: readonly RenderGraphEdge[]; title?: string | undefined; width: number; ascii?: boolean | undefined }

type Picked = { neighbours: string[]; extra: number; /** Edges between the root and its shown neighbours. */ edges: RenderGraphEdge[]; /** Those plus every other edge that touches a shown neighbour. */ touching: RenderGraphEdge[] }

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** The root's neighbours in edge order, at most `neighbours` of them; the rest are counted in `extra`. */
function pick(root: string, edges: readonly RenderGraphEdge[]): Picked {
  const usable = edges.filter((edge) => edge.from !== edge.to)
  const all = [...new Set(usable.flatMap((edge) => (edge.from === root ? [edge.to] : edge.to === root ? [edge.from] : [])))]
  const neighbours = all.slice(0, GRAPH_CARD.neighbours)
  const shown = new Set([root, ...neighbours])
  const dropped = new Set(all.slice(GRAPH_CARD.neighbours))
  return {
    neighbours,
    extra: all.length - neighbours.length,
    edges: usable.filter((edge) => shown.has(edge.from) && shown.has(edge.to)),
    touching: usable.filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to) && (shown.has(edge.from) || shown.has(edge.to))),
  }
}

function rowText(edge: RenderGraphEdge, ascii: boolean) {
  const arrow = ascii ? "->" : "→"
  return edge.relation ? `${oneLine(edge.from)} --${oneLine(edge.relation)}--> ${oneLine(edge.to)}` : `${oneLine(edge.from)} ${arrow} ${oneLine(edge.to)}`
}

/** One row per edge, root's own edges first, cut to `width`; `+N more` past the neighbour cap. */
function listRows(input: GraphCardInput, width: number): Line[] {
  const ascii = input.ascii === true
  const root = oneLine(input.root)
  const { touching: edges, extra } = pick(input.root, input.edges)
  const own = edges.filter((edge) => edge.from === input.root || edge.to === input.root)
  const rest = edges.filter((edge) => !own.includes(edge))
  const title: Line[] = input.title ? [fit([{ text: oneLine(input.title), fg: "primary", bold: true }], width)] : []
  const rows: Line[] = [...own, ...rest].map((edge) => {
    const text = rowText(edge, ascii)
    if (textWidth(text) > width) return fit([{ text: truncateEnd(text, width), fg: "text" }], width)
    const spans: Span[] = []
    const relation = edge.relation ? `--${oneLine(edge.relation)}-->` : ascii ? "->" : "→"
    const from = oneLine(edge.from)
    const to = oneLine(edge.to)
    spans.push({ text: from, fg: from === root ? "primary" : "text", ...(from === root ? { bold: true } : {}) }, { text: ` ${relation} `, fg: "muted" }, { text: to, fg: to === root ? "primary" : "text", ...(to === root ? { bold: true } : {}) })
    return fit(spans, width)
  })
  const head: Line[] = rows.length === 0 ? [fit([{ text: truncateEnd(root, width), fg: "primary", bold: true }], width)] : []
  const more: Line[] = extra > 0 ? [fit([{ text: `+${extra} more`, fg: "muted", dim: true }], width)] : []
  return [...title, ...head, ...rows, ...more]
}

/**
 * The layout keeps spokes short so labels stay readable; edge labels need room, so ring nodes are pushed
 * outward from the hub horizontally (cells are twice as tall as wide) as far as the width allows.
 */
function stretched(layout: Layout, width: number): Layout {
  const hub = layout.nodes.find((node) => node.ring === 0)
  if (!hub) return layout
  const cx = Math.floor((hub.x0 + hub.x1 - 1) / 2)
  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      if (node.ring === 0) return node
      const wanted = Math.round((node.x - cx) * (STRETCH - 1))
      const delta = wanted >= 0 ? Math.max(0, Math.min(wanted, width - node.x1)) : Math.min(0, Math.max(wanted, -node.x0))
      return { ...node, x: node.x + delta, x0: node.x0 + delta, x1: node.x1 + delta }
    }),
  }
}

function frameTop(input: { title: string | undefined; width: number; frame: typeof FRAME_UNICODE | typeof FRAME_ASCII }): Line {
  const { frame, width } = input
  const fill = width - 2
  const title = input.title ? oneLine(input.title) : ""
  if (!title || fill < 6) return [{ text: `${frame.tl}${frame.h.repeat(fill)}${frame.tr}`, fg: "border" }]
  const shown = truncateEnd(title, fill - 4)
  const rest = fill - 3 - textWidth(shown)
  return [{ text: `${frame.tl}${frame.h} `, fg: "border" }, { text: shown, fg: "primary", bold: true }, { text: ` ${frame.h.repeat(rest)}${frame.tr}`, fg: "border" }]
}

export function renderGraphCard(input: GraphCardInput): Line[] {
  const width = Math.max(4, Math.floor(input.width))
  if (width < GRAPH_CARD.minFramed) return listRows(input, width)
  const ascii = input.ascii === true
  const frame = ascii ? FRAME_ASCII : FRAME_UNICODE
  const picked = pick(input.root, input.edges)
  const nodeIds = [input.root, ...picked.neighbours]
  const nodes: GraphNode[] = nodeIds.map((id) => ({ id, label: oneLine(id) }))
  const edges: GraphEdge[] = picked.edges.map((edge) => ({ from: edge.from, to: edge.to, directed: true, ...(edge.relation ? { label: oneLine(edge.relation) } : {}) }))
  const inner = width - 4
  const more = picked.extra > 0 ? 1 : 0
  const total = Math.max(GRAPH_CARD.minRows, Math.min(GRAPH_CARD.maxRows, nodeIds.length + 4 + more))
  const canvasRows = total - 2 - more
  const laid = layoutGraph({ nodes, edges, width: inner, height: canvasRows, focus: input.root })
  const layout = stretched(laid, inner)
  const canvas = renderGraph({ layout, width: inner, height: canvasRows, selected: input.root, glyphs: ascii ? GRAPH_GLYPHS_ASCII : GRAPH_GLYPHS_UNICODE })
  const side = (text: string): Span => ({ text, fg: "border" })
  const row = (line: Line): Line => [side(`${frame.v} `), ...fit(line, inner), side(` ${frame.v}`)]
  const moreRow: Line[] = more ? [row([{ text: `+${picked.extra} more`, fg: "muted", dim: true }])] : []
  const bottom: Line = [{ text: `${frame.bl}${frame.h.repeat(width - 2)}${frame.br}`, fg: "border" }]
  const rows = [frameTop({ title: input.title, width, frame }), ...canvas.map(row), ...moreRow, bottom]
  return rows.map((line) => (lineWidth(line) === width ? line : fit(line, width)))
}
