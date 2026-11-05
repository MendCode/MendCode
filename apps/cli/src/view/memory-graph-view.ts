import type { MemoryEntry, MemoryGraphHealth, MemoryGraphReport, MemoryLink, MemoryLinkKind } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { GRAPH_GLYPHS_ASCII, layoutGraph, nearestNode, renderGraph, type EdgeStyle, type GraphEdge, type GraphGlyphs, type GraphNode, type Layout } from "./ascii-graph"
import { clip, columns, fit, lineWidth, panelGrid, spread } from "./deck"
import { truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The Graph tab body of /memory, in the page standard of /changes: a "Graph" panel (health line, the canvas, a legend)
 * beside a "Memory" panel for the selected memory, each a titled bordered box. The canvas is a radial ego view around
 * the selection, or the whole graph; edges are braille lines (sub-cell resolution, dotted/solid/dashed by link kind)
 * and the dots take the color of their category. Pure: the page owns the header, tab strip and footer.
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

/** Side by side from this width; stacked (graph over memory) from `STACK_WIDTH`; one panel under that. */
const SPLIT_WIDTH = 90
const SPLIT_HEIGHT = 9
const STACK_WIDTH = 50
const STACK_HEIGHT = 24
const SINGLE_WIDTH = 30
const SINGLE_HEIGHT = 7
/** Cells of a panel taken by its border and side padding. */
const SIDES = 4
/** Rows of a panel taken by its border and padding (the boxed look); a compact panel keeps the two border rows only. */
const PADDED = 4
const COMPACT = 2
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
const KIND_STYLE: Record<MemoryLinkKind, EdgeStyle> = { related: "dotted", supports: "solid", conflicts: "dashed", supersedes: "solid" }
const KIND_ORDER: MemoryLinkKind[] = ["conflicts", "supersedes", "supports", "related"]
const SCOPE_TONE: Record<MemoryEntry["scope"], ColorName> = { project: "heading", user: "link", session: "accent" }
const STATE_TONE: Record<MemoryGraphHealth["state"], ColorName> = { connected: "success", partial: "warning", disconnected: "muted", empty: "muted" }
/** Dot colors by category, most used category first; a memory with no category keeps the plain text color. */
const CATEGORY_TONES: ColorName[] = ["link", "warning", "synType", "success", "synNumber", "synFunction"]
const UNCATEGORIZED = "uncategorized"
/** A short sample of each kind's edge for the legend: braille, or ASCII when the glyphs are. */
const KIND_SAMPLE: Record<MemoryLinkKind, { braille: string; ascii: string }> = {
  related: { braille: "⠄⠄⠄", ascii: "..." },
  supports: { braille: "⠤⠤→", ascii: "-->" },
  conflicts: { braille: "⠤⠀⠤", ascii: "x x" },
  supersedes: { braille: "⠤⠤→", ascii: "==>" },
}

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

/** Each category with how many memories carry it and its dot color, most used first (ties alphabetical). */
export function memoryGraphCategories(report: MemoryGraphReport): Array<{ category: string; count: number; tone: ColorName }> {
  const counts = new Map<string, number>()
  for (const node of report.nodes) {
    const category = node.category || UNCATEGORIZED
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const named = [...counts].filter(([category]) => category !== UNCATEGORIZED).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const rows = named.map(([category, count], index) => ({ category, count, tone: CATEGORY_TONES[index % CATEGORY_TONES.length]! }))
  const rest = counts.get(UNCATEGORIZED)
  return rest ? [...rows, { category: UNCATEGORIZED, count: rest, tone: "text" as ColorName }] : rows
}

/** Rows the legend takes under the canvas for a panel body of `room` rows. */
function legendRows(room: number) {
  return room >= 14 ? 2 : room >= 9 ? 1 : 0
}

export type MemoryGraphFrame = "split" | "stack" | "single" | "bare"

/**
 * Where the panels, the canvas and the detail go inside a `width` x `height` body. `split` is two panels side by side,
 * `stack` graph over memory, `single` the graph panel with the selection as one line under it, `bare` no frame at all
 * (a head row and the canvas) for bodies too small to box.
 */
export function memoryGraphMetrics(input: { width: number; height: number }) {
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  if (width >= SPLIT_WIDTH && height >= SPLIT_HEIGHT) {
    const [left = 0, right = 0] = columns(width, [3, 2], 1)
    const room = height - PADDED
    const legend = legendRows(room)
    return { frame: "split" as const, legend, summary: false, panels: { graph: { width: left, height }, detail: { width: right, height } }, canvas: { width: left - SIDES, height: room - 1 - legend }, detail: { width: right - SIDES, height: room } }
  }
  if (width >= STACK_WIDTH && height >= STACK_HEIGHT) {
    const detailHeight = Math.min(14, Math.floor((height - 1) * 0.45))
    const graphHeight = height - 1 - detailHeight
    const room = graphHeight - PADDED
    const legend = legendRows(room)
    return { frame: "stack" as const, legend, summary: false, panels: { graph: { width, height: graphHeight }, detail: { width, height: detailHeight } }, canvas: { width: width - SIDES, height: room - 1 - legend }, detail: { width: width - SIDES, height: detailHeight - PADDED } }
  }
  if (width >= SINGLE_WIDTH && height >= SINGLE_HEIGHT) {
    const room = height - COMPACT
    return { frame: "single" as const, legend: 0, summary: room >= 5, panels: { graph: { width, height }, detail: { width: 0, height: 0 } }, canvas: { width: width - SIDES, height: room - 1 - (room >= 5 ? 1 : 0) }, detail: { width: 0, height: 0 } }
  }
  const head = Math.min(1, height)
  return { frame: "bare" as const, legend: 0, summary: false, panels: { graph: { width, height }, detail: { width: 0, height: 0 } }, canvas: { width, height: height - head }, detail: { width: 0, height: 0 } }
}

/** The layout both keys and render use, so a move always lands on a node that is on screen. */
export function memoryGraphLayout(report: MemoryGraphReport, state: MemoryGraphState, size: { width: number; height: number }): Layout {
  const tones = new Map(memoryGraphCategories(report).map((entry) => [entry.category, entry.tone]))
  const nodes: GraphNode[] = report.nodes.map((memory) => ({ id: memory.memoryId, label: oneLine(memory.text), tone: tones.get(memory.category || UNCATEGORIZED) ?? "text" }))
  const edges: GraphEdge[] = report.links.map((link) => ({ from: link.from, to: link.to, directed: KIND_DIRECTED[link.kind], tone: KIND_TONE[link.kind], style: KIND_STYLE[link.kind] }))
  const focus = state.mode === "ego" ? selectedMemoryId(report, state) : undefined
  return layoutGraph({ nodes, edges, width: size.width, height: size.height, focus, firstRing: "cross" })
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

function healthLine(health: MemoryGraphHealth, shown: { visible: number; total: number } | undefined, width: number): Line {
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
  const right: Line = shown && shown.visible < shown.total ? [{ text: `${shown.visible}/${shown.total} shown`, fg: "muted" }] : []
  return lineWidth(left) + lineWidth(right) + 1 <= width ? spread(left, right, width) : clip(left, width)
}

/** The legend under the canvas: what each dot color and each edge style stands for (only what the graph has). */
function legend({ report, width, rows, ascii }: { report: MemoryGraphReport; width: number; rows: number; ascii: boolean }): Line[] {
  if (rows <= 0) return []
  const dot = ascii ? "o" : "●"
  const categories: Line = []
  for (const { category, count, tone } of memoryGraphCategories(report)) {
    if (categories.length) categories.push({ text: "  " })
    categories.push({ text: dot, fg: tone }, { text: ` ${category} ${count}`, fg: "muted" })
  }
  const present = new Set(report.links.map((link) => link.kind))
  const kinds: Line = []
  for (const kind of KIND_ORDER.slice().reverse()) {
    if (!present.has(kind)) continue
    if (kinds.length) kinds.push({ text: "  " })
    kinds.push({ text: ascii ? KIND_SAMPLE[kind].ascii : KIND_SAMPLE[kind].braille, fg: KIND_TONE[kind] }, { text: ` ${kind}`, fg: "muted" })
  }
  const out = rows >= 2 ? [categories, kinds] : [categories.length ? categories : kinds]
  return out.map((line) => clip(line, width))
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

const FACT_LABEL = 10

/** The selected memory in full: its text wrapped, labeled facts (scope, category, area, project, origin), then its links. Exactly `height` rows. */
function detailRows(input: { report: MemoryGraphReport; selected: string | undefined; width: number; height: number }): Line[] {
  const { report, selected, width, height } = input
  if (height <= 0 || width <= 0) return []
  const memory = report.nodes.find((node) => node.memoryId === selected)
  const rows: Line[] = []
  if (!memory) rows.push([{ text: "no memory selected", fg: "muted", dim: true }])
  else {
    const tones = new Map(memoryGraphCategories(report).map((entry) => [entry.category, entry.tone]))
    const byId = new Map(report.nodes.map((node) => [node.memoryId as string, node]))
    const links = linksOf(memory.memoryId, report.links)
    const text = wrap(oneLine(memory.text), width)
    const textRoom = Math.max(2, Math.floor(height * 0.4))
    const shownText = text.slice(0, textRoom)
    if (text.length > shownText.length) shownText[shownText.length - 1] = truncateEnd(`${shownText[shownText.length - 1]}…`, width)
    for (const line of shownText) rows.push([{ text: line, fg: "text" }])

    const fact = (label: string, value: string, tone: ColorName = "text"): Line => clip([{ text: label.padEnd(FACT_LABEL), fg: "muted" }, { text: truncateEnd(value, Math.max(1, width - FACT_LABEL)), fg: tone }], width)
    const facts: Line[] = [fact("Scope", memory.scope, SCOPE_TONE[memory.scope])]
    if (memory.category) facts.push(fact("Category", memory.category, tones.get(memory.category) ?? "text"))
    if (memory.profile) facts.push(fact("Area", memory.profile))
    if (memory.directory) facts.push(fact("Project", memory.directory))
    facts.push(fact("Origin", memory.source === "agent" ? "agent" : "manual"))

    const left = height - rows.length - 1
    const factRoom = left >= 12 ? facts.length : left >= 6 ? Math.min(facts.length, 3) : left >= 3 ? Math.min(facts.length, 2) : 0
    if (factRoom > 0) rows.push([], ...facts.slice(0, factRoom))

    if (links.length === 0) {
      if (height - rows.length >= 2) rows.push([], clip([{ text: "no links · c to link", fg: "muted", dim: true }], width))
    } else if (height - rows.length >= 3) {
      rows.push([], [{ text: "Links", fg: "text", bold: true }, { text: ` ${links.length}`, fg: "muted" }])
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
  /** ASCII glyphs and box-line edges instead of braille. */
  ascii?: boolean | undefined
}): Line[] {
  const { report, state } = input
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  if (height === 0) return []
  if (!report) return messageBody("loading graph…", width, height)
  if (report.nodes.length === 0) return messageBody("no saved memories yet — approve some in the Saved tab", width, height)

  const ascii = input.ascii === true
  const metrics = memoryGraphMetrics({ width, height })
  const selected = selectedMemoryId(report, state)
  const layout = memoryGraphLayout(report, state, metrics.canvas)
  const glyphs = input.glyphs ?? (ascii ? GRAPH_GLYPHS_ASCII : undefined)
  const plainText = ascii || input.glyphs !== undefined
  const edges = plainText ? "lines" : "braille"
  const canvas = renderGraph({ layout, width: metrics.canvas.width, height: metrics.canvas.height, selected, marked: state.marked, glyphs, edges })
  const shown = { visible: layout.nodes.length, total: report.nodes.length }
  const mode = state.mode === "ego" ? "ego" : "all"

  let rows: Line[]
  if (metrics.frame === "bare") {
    rows = [healthLine(report.health, shown, width), ...canvas]
  } else {
    const graphPanel = {
      title: `Graph · ${mode}`,
      active: true,
      body: (inner: number): Line[] => [
        healthLine(report.health, shown, inner),
        ...canvas,
        ...legend({ report, width: inner, rows: metrics.legend, ascii: plainText }),
        ...(metrics.summary ? [summaryRow(report, selected, inner)] : []),
      ],
    }
    const detailPanel = { title: "Memory", body: (inner: number) => detailRows({ report, selected, width: inner, height: metrics.detail.height }) }
    if (metrics.frame === "split") rows = panelGrid({ width, compact: false, padding: true, heights: [height], rows: [[{ ...graphPanel, weight: 3 }, { ...detailPanel, weight: 2 }]] })
    else if (metrics.frame === "stack") rows = panelGrid({ width, compact: false, padding: true, heights: [metrics.panels.graph.height, metrics.panels.detail.height], rows: [[graphPanel], [detailPanel]] })
    else rows = panelGrid({ width, compact: false, heights: [height], rows: [[graphPanel]] })
  }

  const out = rows.slice(0, height).map((row) => fit(row, width))
  while (out.length < height) out.push([])
  return out
}
