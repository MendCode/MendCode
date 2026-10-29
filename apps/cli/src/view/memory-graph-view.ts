import type { MemoryEntry, MemoryGraphHealth, MemoryGraphReport, MemoryLink, MemoryLinkKind } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { layoutGraph, nearestNode, renderGraph, type GraphEdge, type GraphGlyphs, type GraphNode, type Layout } from "./ascii-graph"
import { beside, clip, lineWidth, spread } from "./deck"
import { truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The Graph tab body of /memory: a health line, the graph canvas (radial ego view around the selection, or the
 * whole graph) and a detail panel for the selected memory. Pure: the page owns the tab strip and footer.
 * In ego mode the layout is centered on the selection, so an arrow key walks along the links and re-centers.
 */

export type MemoryGraphState = {
  /** memoryId; absent = the most linked memory. */
  selected?: string | undefined
  mode: "ego" | "all"
  /** A memory marked with `m`; `c` on another memory links the pair, `x` unlinks it. */
  marked?: string | undefined
}

/** `link` without `to` means nothing was marked yet: the page says to mark one first. */
export type MemoryGraphAction = { type: "none" } | { type: "close" } | { type: "unlink"; from: string; to: string } | { type: "link"; from: string; to?: string }

/** Footer hints for the page to show while the Graph tab is active. */
export const MEMORY_GRAPH_HINTS = "arrows move · enter focus/all · m mark · c link to mark · x unlink · tab tabs · esc back"

const WIDE_WIDTH = 100
const GUTTER = 3
const NONE: MemoryGraphAction = { type: "none" }
const DIRECTIONS: Record<string, "up" | "down" | "left" | "right"> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  k: "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  j: "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  l: "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  h: "left",
}

const KIND_TONE: Record<MemoryLinkKind, ColorName> = { related: "muted", supports: "success", conflicts: "error", supersedes: "warning" }
const KIND_DIRECTED: Record<MemoryLinkKind, boolean> = { related: false, supports: true, conflicts: false, supersedes: true }
const KIND_ORDER: MemoryLinkKind[] = ["conflicts", "supersedes", "supports", "related"]
const SCOPE_TONE: Record<MemoryEntry["scope"], ColorName> = { project: "heading", user: "link", session: "accent" }
const STATE_TONE: Record<MemoryGraphHealth["state"], ColorName> = { connected: "success", partial: "warning", disconnected: "muted", empty: "muted" }

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function createMemoryGraphState(): MemoryGraphState {
  return { mode: "ego" }
}

/** The selection actually in effect: the chosen memory when it still exists, else the most linked one. */
export function selectedMemoryId(report: MemoryGraphReport, state: MemoryGraphState): string | undefined {
  if (state.selected !== undefined && report.nodes.some((node) => node.memoryId === state.selected)) return state.selected
  return report.nodes[0]?.memoryId
}

/** Where the canvas and the detail panel go inside a `width` x `height` body. */
export function memoryGraphMetrics(input: { width: number; height: number }) {
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  const head = height >= 8 ? 2 : Math.min(1, height)
  const room = height - head
  if (width >= WIDE_WIDTH) {
    const canvasWidth = Math.floor((width - GUTTER) * 0.62)
    return { head, canvas: { width: canvasWidth, height: room }, detail: { placement: "side" as const, width: width - GUTTER - canvasWidth, height: room } }
  }
  if (room >= 12) {
    const detailHeight = Math.min(9, Math.floor(room * 0.4))
    return { head, canvas: { width, height: room - detailHeight - 1 }, detail: { placement: "below" as const, width, height: detailHeight } }
  }
  if (room >= 5) return { head, canvas: { width, height: room - 1 }, detail: { placement: "line" as const, width, height: 1 } }
  return { head, canvas: { width, height: room }, detail: { placement: "none" as const, width, height: 0 } }
}

/** The layout both keys and render use, so a move always lands on a node that is on screen. */
export function memoryGraphLayout(report: MemoryGraphReport, state: MemoryGraphState, size: { width: number; height: number }): Layout {
  const nodes: GraphNode[] = report.nodes.map((memory) => ({ id: memory.memoryId, label: oneLine(memory.text), tone: SCOPE_TONE[memory.scope] }))
  const edges: GraphEdge[] = report.links.map((link) => ({ from: link.from, to: link.to, directed: KIND_DIRECTED[link.kind], tone: KIND_TONE[link.kind] }))
  const focus = state.mode === "ego" ? selectedMemoryId(report, state) : undefined
  return layoutGraph({ nodes, edges, width: size.width, height: size.height, focus })
}

/**
 * One raw key. Arrows (and hjkl) move to the nearest node that way; enter or f toggles ego/all; m marks;
 * x unlinks the marked pair; c asks the page to link from the selection; esc closes. Returns the same state
 * object when nothing changed.
 */
export function memoryGraphKey(
  state: MemoryGraphState,
  key: string,
  report: MemoryGraphReport,
  layoutSize: { width: number; height: number },
): { state: MemoryGraphState; action: MemoryGraphAction } {
  if (key === "\x1b") return { state, action: { type: "close" } }
  const current = selectedMemoryId(report, state)
  if (current === undefined) return { state, action: NONE }
  const stay = (next: Partial<MemoryGraphState>, action: MemoryGraphAction = NONE) => ({ state: { ...state, ...next }, action })

  const direction = DIRECTIONS[key]
  if (direction) {
    const layout = memoryGraphLayout(report, state, layoutSize)
    const onScreen = layout.nodes.some((node) => node.id === current)
    const from = onScreen ? current : (layout.center ?? layout.nodes[0]?.id)
    if (from === undefined) return { state, action: NONE }
    const target = onScreen ? (nearestNode(layout, from, direction) ?? current) : from
    return target === state.selected ? { state, action: NONE } : stay({ selected: target })
  }
  switch (key) {
    case "\r":
    case "\n":
    case "f":
      return stay({ selected: current, mode: state.mode === "ego" ? "all" : "ego" })
    case "m":
      return stay({ selected: current, marked: state.marked === current ? undefined : current })
    case "c": {
      const marked = state.marked
      if (marked === undefined || marked === current) return { state, action: { type: "link", from: current } }
      const linked = report.links.some((candidate) => (candidate.from === marked && candidate.to === current) || (candidate.from === current && candidate.to === marked))
      return linked ? { state, action: NONE } : stay({ marked: undefined }, { type: "link", from: marked, to: current })
    }
    case "x": {
      const marked = state.marked
      if (marked === undefined || marked === current) return { state, action: NONE }
      const link = report.links.find((candidate) => (candidate.from === marked && candidate.to === current) || (candidate.from === current && candidate.to === marked))
      return link ? stay({ marked: undefined }, { type: "unlink", from: link.from, to: link.to }) : { state, action: NONE }
    }
  }
  return { state, action: NONE }
}

function healthLine(health: MemoryGraphHealth, shown: { visible: number; total: number } | undefined, mode: MemoryGraphState["mode"], width: number): Line {
  const stateTone: ColorName = health.conflicts > 0 ? "error" : STATE_TONE[health.state]
  const left: Line = [
    { text: health.state, fg: stateTone, bold: true },
    { text: " · ", fg: "muted" },
    { text: plural(health.nodes, "memory", "memories"), fg: "muted" },
    { text: " · ", fg: "muted" },
    { text: plural(health.links, "link", "links"), fg: "muted" },
  ]
  if (health.isolated > 0) left.push({ text: " · ", fg: "muted" }, { text: `${health.isolated} isolated`, fg: "muted" })
  if (health.conflicts > 0) left.push({ text: " · ", fg: "muted" }, { text: plural(health.conflicts, "conflict", "conflicts"), fg: "error", bold: true })
  const right: Line = [{ text: mode, fg: "text", bold: true }]
  if (shown && shown.visible < shown.total) right.push({ text: ` · ${shown.visible}/${shown.total} shown`, fg: "muted" })
  return lineWidth(left) + lineWidth(right) + 1 <= width ? spread(left, right, width) : clip(left, width)
}

function linksOf(memoryId: string, links: MemoryLink[]) {
  return links
    .filter((link) => link.from === memoryId || link.to === memoryId)
    .map((link) => ({ link, otherId: link.from === memoryId ? link.to : link.from, incoming: link.to === memoryId && link.from !== memoryId }))
    .sort((a, b) => KIND_ORDER.indexOf(a.link.kind) - KIND_ORDER.indexOf(b.link.kind) || a.otherId.localeCompare(b.otherId))
}

function linkArrow(kind: MemoryLinkKind, incoming: boolean) {
  return KIND_DIRECTED[kind] ? (incoming ? "←" : "→") : "↔"
}

/** The selected memory in full: scope, category, profile, its text wrapped, then its links. Exactly `height` rows. */
function detailRows(input: { report: MemoryGraphReport; selected: string | undefined; width: number; height: number }): Line[] {
  const { report, selected, width, height } = input
  if (height <= 0 || width <= 0) return []
  const memory = report.nodes.find((node) => node.memoryId === selected)
  const rows: Line[] = []
  if (!memory) rows.push([{ text: "no memory selected", fg: "muted", dim: true }])
  else {
    const meta: Line = [{ text: memory.scope, fg: SCOPE_TONE[memory.scope], bold: true }]
    if (memory.category) meta.push({ text: " · ", fg: "muted" }, { text: memory.category, fg: "muted" })
    if (memory.profile) meta.push({ text: " · ", fg: "muted" }, { text: `profile ${memory.profile}`, fg: "muted" })
    rows.push(clip(meta, width))
    if (memory.directory) rows.push(clip([{ text: memory.directory, fg: "muted" }], width))
    rows.push(clip([{ text: `origin ${memory.source === "agent" ? "agent" : "manual"}`, fg: "muted" }], width), [])

    const byId = new Map(report.nodes.map((node) => [node.memoryId as string, node]))
    const links = linksOf(memory.memoryId, report.links)
    const text = wrap(oneLine(memory.text), width)
    const textRoom = links.length > 0 ? Math.max(3, Math.floor((height - rows.length) * 0.5)) : height - rows.length
    const shownText = text.slice(0, Math.max(1, textRoom))
    if (text.length > shownText.length) shownText[shownText.length - 1] = truncateEnd(`${shownText[shownText.length - 1]}…`, width)
    for (const line of shownText) rows.push([{ text: line, fg: "text" }])

    rows.push([])
    if (links.length === 0) rows.push(clip([{ text: "no links · c to link", fg: "muted", dim: true }], width))
    else {
      rows.push([{ text: "Links", fg: "text", bold: true }, { text: ` ${links.length}`, fg: "muted" }])
      const room = Math.max(0, height - rows.length)
      const shown = links.length > room ? Math.max(0, room - 1) : links.length
      for (const { link, otherId, incoming } of links.slice(0, shown)) {
        const other = byId.get(otherId)
        const prefix: Line = [{ text: link.kind, fg: KIND_TONE[link.kind], bold: true }, { text: ` ${linkArrow(link.kind, incoming)} `, fg: "muted" }]
        const label = other ? oneLine(other.text) : "(not shown)"
        rows.push([...prefix, { text: truncateEnd(label, Math.max(1, width - lineWidth(prefix))), fg: "body" }])
      }
      if (shown < links.length) rows.push([{ text: `+${links.length - shown} more`, fg: "muted", dim: true }])
    }
  }
  const clipped = rows.slice(0, height).map((row) => clip(row, width))
  while (clipped.length < height) clipped.push([])
  return clipped
}

function summaryRow(report: MemoryGraphReport, selected: string | undefined, width: number): Line {
  const memory = report.nodes.find((node) => node.memoryId === selected)
  if (!memory) return []
  const head: Line = [{ text: memory.scope, fg: SCOPE_TONE[memory.scope], bold: true }, { text: " · ", fg: "muted" }]
  return [...head, { text: truncateEnd(oneLine(memory.text), Math.max(1, width - lineWidth(head))), fg: "text" }]
}

function messageBody(message: string, width: number, height: number): Line[] {
  const rows: Line[] = Array.from({ length: Math.max(0, height) }, () => [])
  if (rows.length > 0) rows[0] = clip([{ text: message, fg: "muted" }], width)
  return rows
}

/** Exactly `height` rows of at most `width` cells. */
export function renderMemoryGraph(input: {
  report: MemoryGraphReport | undefined
  state: MemoryGraphState
  width: number
  height: number
  glyphs?: Partial<GraphGlyphs> | undefined
}): Line[] {
  const { report, state } = input
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  if (height === 0) return []
  if (!report) return messageBody("loading graph…", width, height)
  if (report.nodes.length === 0) return messageBody("no saved memories yet — approve some in the Saved tab", width, height)

  const metrics = memoryGraphMetrics({ width, height })
  const selected = selectedMemoryId(report, state)
  const layout = memoryGraphLayout(report, state, metrics.canvas)
  const canvas = renderGraph({ layout, width: metrics.canvas.width, height: metrics.canvas.height, selected, marked: state.marked, glyphs: input.glyphs })

  const rows: Line[] = []
  if (metrics.head > 0) rows.push(healthLine(report.health, { visible: layout.nodes.length, total: report.nodes.length }, state.mode, width))
  if (metrics.head > 1) rows.push([])

  const { detail } = metrics
  if (detail.placement === "side") {
    const panel = detailRows({ report, selected, width: detail.width, height: detail.height })
    rows.push(...beside([{ lines: canvas, width: metrics.canvas.width }, { lines: panel, width: detail.width }], GUTTER))
  } else if (detail.placement === "below") {
    rows.push(...canvas, [], ...detailRows({ report, selected, width: detail.width, height: detail.height }))
  } else if (detail.placement === "line") {
    rows.push(...canvas, summaryRow(report, selected, width))
  } else rows.push(...canvas)

  const out = rows.slice(0, height).map((row) => clip(row, width))
  while (out.length < height) out.push([])
  return out
}
