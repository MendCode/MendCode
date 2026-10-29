import type { Line, Span } from "../ui/theme"
import { deck, deckChrome, fit } from "./deck"
import type { MermaidResult } from "./mermaid"
import { cells, textWidth } from "./wrap"

/**
 * `/diagram`: one mermaid diagram full screen, from the transcript's answers. The transcript draws a diagram at the
 * chat width (and shows the source when it does not fit); here it is laid out at its natural size and you move over it.
 * v1 has the same controls on its inline card: zoom out/in, pan, center. v1 has no rotate or flip, so neither does this.
 *
 * Zoom is a view transform of the drawn diagram, since the layout has no scale: `overview` folds 2x4 cells into one
 * braille cell (structure, not text), 100% is the natural size, 200% and 300% spread it horizontally (lines lengthen,
 * spaces widen, labels stay whole). Pure; the mermaid renderer is passed in, so this module stays out of the startup graph.
 */

export type DiagramZoom = -1 | 0 | 1 | 2
export type DiagramViewState = { index: number; zoom: DiagramZoom; x: number; y: number }
export type DiagramAction = "none" | "close"
export type DiagramBounds = { maxX: number; maxY: number; viewWidth: number; viewHeight: number }
export type DiagramSource = { source: string; itemId: string }

export type DiagramLayout = { lines: Line[]; width: number; height: number; note?: string }

const ZOOMS: readonly DiagramZoom[] = [-1, 0, 1, 2]
const ZOOM_LABEL: Record<DiagramZoom, string> = { [-1]: "overview", 0: "100%", 1: "200%", 2: "300%" }
/** How much a zoom changes the drawn size on each axis, relative to 100%. */
const ZOOM_SCALE: Record<DiagramZoom, { x: number; y: number }> = { [-1]: { x: 0.5, y: 0.25 }, 0: { x: 1, y: 1 }, 1: { x: 2, y: 1 }, 2: { x: 3, y: 1 } }
/** The layout cap: wider than the chat, so a diagram the transcript showed as source can be viewed here. */
export const DIAGRAM_MAX_WIDTH = 1600
const HINTS = ["←↑↓→ / hjkl pan · shift = page · + − zoom · 0 reset · n p next/prev · esc back", "arrows pan · +/− zoom · 0 reset · n/p · esc", "esc back"]
const COL_STEP = 6
const ROW_STEP = 2

const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l"])
const PAGE_UP = new Set(["\x1b[5~", "K", "\x1b[1;2A"])
const PAGE_DOWN = new Set(["\x1b[6~", "J", "\x1b[1;2B"])
const PAGE_LEFT = new Set(["H", "\x1b[1;2D"])
const PAGE_RIGHT = new Set(["L", "\x1b[1;2C"])

export function createDiagramView(index = 0): DiagramViewState {
  return { index, zoom: 0, x: 0, y: 0 }
}

// ─── Finding diagrams ───────────────────────────────────────────────────────────────────────────────────────────────

/** The ```mermaid fences of a markdown text, in order (an unclosed fence is still streaming and is skipped). */
export function mermaidSources(markdown: string): string[] {
  const out: string[] = []
  const lines = markdown.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const open = /^\s*(`{3,}|~{3,})\s*mermaid\b/i.exec(lines[index]!)
    if (!open) continue
    const char = open[1]![0]!
    const size = open[1]!.length
    const closing = lines.findIndex((line, at) => {
      const match = at > index ? /^\s*(`{3,}|~{3,})\s*$/.exec(line) : null
      return !!match && match[1]![0] === char && match[1]!.length >= size
    })
    if (closing < 0) break
    out.push(lines.slice(index + 1, closing).join("\n"))
    index = closing
  }
  return out
}

/** Every diagram of the session's answers, oldest first. */
export function transcriptDiagrams(blocks: ReadonlyArray<{ kind: string; text: string; itemId: string }>): DiagramSource[] {
  return blocks.flatMap((block) => (block.kind === "agent_message" ? mermaidSources(block.text).map((source) => ({ source, itemId: block.itemId })) : []))
}

// ─── Layout and zoom ────────────────────────────────────────────────────────────────────────────────────────────────

const cellsOf = (line: Line) => line.reduce((sum, span) => sum + textWidth(span.text), 0)

/** What a structural glyph extends with when it is stretched sideways: the horizontal stroke it joins to its east. */
const H_FILL: Readonly<Record<string, string>> = {
  "─": "─", "┌": "─", "└": "─", "├": "─", "┬": "─", "┴": "─", "┼": "─", "╭": "─", "╰": "─",
  "━": "━", "┏": "━", "┗": "━", "┣": "━", "┳": "━", "┻": "━", "╋": "━",
  "┄": "┄", "═": "═", "╔": "═", "╚": "═", "╠": "═", "╦": "═", "╩": "═", "╬": "═",
}
/** Glyphs with a stroke to their west: an arrowhead or corner before one of these is joined to it. */
const WEST_JOIN = new Set("─┐┘┤┬┴┼╮╯━┓┛┫┳┻╋┄═╗╝╣╦╩╬")
const STRUCTURE = /[\u2190-\u21ff\u2500-\u257f\u25a0-\u25ff]/u

const sameStyle = (a: Span, b: Span) => a.fg === b.fg && a.bold === b.bold && a.dim === b.dim

/** Strokes, corners, arrowheads and a diamond's tips: what a stretch extends. Everything else is text. */
const isStructure = (text: string) => STRUCTURE.test(text) || text === "<" || text === ">"

/**
 * One row stretched `factor` times horizontally, every cell keeping its place in the grid so the borders of a box still
 * line up row to row: a stroke extends (a corner or junction extends along its horizontal stroke), a run of text
 * keeps its letters whole and is centered in the room it is given, and blanks widen.
 */
function stretchRow(line: Line, factor: number): Line {
  const flat: Array<{ text: string; width: number; span: Span }> = []
  for (const span of line) for (const cell of cells(span.text)) flat.push({ text: cell.text, width: cell.width, span })
  const out: Line = []
  const push = (text: string, span: Span) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && sameStyle(last, span)) last.text += text
    else out.push({ ...span, text })
  }
  let at = 0
  /** Blanks the previous cell (a wall) put after itself: the text that follows is shifted back by half of them, so it stays centered between its walls. */
  let wallFill = 0
  while (at < flat.length) {
    const cell = flat[at]!
    if (isStructure(cell.text)) {
      const next = flat[at + 1]?.text
      const fill = H_FILL[cell.text] ?? (next !== undefined && WEST_JOIN.has(next) ? "─" : " ")
      push(cell.text, cell.span)
      push(fill.repeat(factor - 1), cell.span)
      wallFill = fill === " " ? factor - 1 : 0
      at++
      continue
    }
    let end = at
    while (end < flat.length && !isStructure(flat[end]!.text)) end++
    const segment = flat.slice(at, end)
    let lead = 0
    while (lead < segment.length && segment[lead]!.text === " ") lead++
    let trail = 0
    while (trail < segment.length - lead && segment[segment.length - 1 - trail]!.text === " ") trail++
    const core = segment.slice(lead, segment.length - trail)
    const extra = core.reduce((sum, item) => sum + item.width, 0) * (factor - 1)
    const room = lead * factor + trail * factor + extra
    const left = Math.max(0, Math.min(room, lead * factor + Math.floor(extra / 2) - Math.floor(wallFill / 2)))
    push(" ".repeat(left), segment[0]!.span)
    for (const item of core) push(item.text, item.span)
    push(" ".repeat(room - left), segment[segment.length - 1]!.span)
    wallFill = 0
    at = end
  }
  return out
}

const BRAILLE_DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const

/** 2 columns by 4 rows of the drawing folded into one braille cell; a dot where the drawing has ink. */
function foldBraille(lines: Line[]): Line[] {
  const grid = lines.map((line) => {
    const row: Array<{ ink: boolean; span: Span }> = []
    for (const span of line) for (const cell of cells(span.text)) for (let i = 0; i < Math.max(1, cell.width); i++) row.push({ ink: cell.text.trim() !== "", span })
    return row
  })
  const width = Math.max(0, ...grid.map((row) => row.length))
  const out: Line[] = []
  for (let top = 0; top < grid.length; top += 4) {
    const line: Line = []
    for (let left = 0; left < width; left += 2) {
      let bits = 0
      let ink: Span | undefined
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cell = grid[top + dy]?.[left + dx]
          if (!cell?.ink) continue
          bits |= BRAILLE_DOT[dy]![dx]!
          ink ??= cell.span
        }
      }
      const span: Span = { text: String.fromCodePoint(0x2800 + bits), ...(ink?.fg ? { fg: ink.fg } : { fg: "muted" as const }), ...(ink?.bold ? { bold: true } : {}) }
      const last = line[line.length - 1]
      if (last && sameStyle(last, span)) last.text += span.text
      else line.push(span)
    }
    out.push(line)
  }
  return out
}

/** The diagram drawn at the natural size, then zoomed. A diagram the renderer cannot draw shows its note and its source. */
export function layoutDiagram(input: { source: string; zoom: DiagramZoom; render: (source: string, width: number) => MermaidResult }): DiagramLayout {
  const result = input.render(input.source, DIAGRAM_MAX_WIDTH)
  if (!("lines" in result)) {
    const lines: Line[] = [[{ text: result.note, fg: "muted", dim: true }], [], ...input.source.split("\n").map((text): Line => [{ text, fg: "code" }])]
    return { lines, width: Math.max(...lines.map(cellsOf)), height: lines.length, note: result.note }
  }
  const natural = result.lines
  const lines = input.zoom === -1 ? foldBraille(natural) : input.zoom === 0 ? natural : natural.map((line) => stretchRow(line, input.zoom + 1))
  return { lines, width: Math.max(0, ...lines.map(cellsOf)), height: lines.length }
}

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The body area of the page at `width` × `height`: what a layout is panned over. */
export function diagramViewport(width: number, height: number): { viewWidth: number; viewHeight: number } {
  return { viewWidth: Math.max(1, width - 2), viewHeight: Math.max(1, height - deckChrome(HINTS[0]!, width)) }
}

export function diagramBounds(layout: DiagramLayout, width: number, height: number): DiagramBounds {
  const { viewWidth, viewHeight } = diagramViewport(width, height)
  return { maxX: Math.max(0, layout.width - viewWidth), maxY: Math.max(0, layout.height - viewHeight), viewWidth, viewHeight }
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.round(value), max))

/** Handles one raw key. `bounds` are the current layout's; a zoom change keeps the point at the middle of the view in place. */
export function diagramViewKey(state: DiagramViewState, key: string, input: { count: number; bounds: DiagramBounds }): { state: DiagramViewState; action: DiagramAction } {
  const { bounds, count } = input
  if (key === "\x1b" || key === "q") return { state, action: "close" }
  const pan = (dx: number, dy: number) => {
    const x = clamp(state.x + dx, bounds.maxX)
    const y = clamp(state.y + dy, bounds.maxY)
    return x === state.x && y === state.y ? { state, action: "none" as const } : { state: { ...state, x, y }, action: "none" as const }
  }
  if (LEFT.has(key)) return pan(-COL_STEP, 0)
  if (RIGHT.has(key)) return pan(COL_STEP, 0)
  if (UP.has(key)) return pan(0, -ROW_STEP)
  if (DOWN.has(key)) return pan(0, ROW_STEP)
  if (PAGE_LEFT.has(key)) return pan(-Math.max(1, Math.floor(bounds.viewWidth * 0.75)), 0)
  if (PAGE_RIGHT.has(key)) return pan(Math.max(1, Math.floor(bounds.viewWidth * 0.75)), 0)
  if (PAGE_UP.has(key)) return pan(0, -Math.max(1, Math.floor(bounds.viewHeight * 0.75)))
  if (PAGE_DOWN.has(key)) return pan(0, Math.max(1, Math.floor(bounds.viewHeight * 0.75)))
  if (key === "\x1b[H" || key === "\x1b[1~" || key === "g") return pan(-state.x, -state.y)
  if (key === "\x1b[F" || key === "\x1b[4~" || key === "G") return pan(bounds.maxX - state.x, bounds.maxY - state.y)
  if (key === "0" || key === "r") return state.zoom === 0 && state.x === 0 && state.y === 0 ? { state, action: "none" } : { state: { ...state, zoom: 0, x: 0, y: 0 }, action: "none" }
  const zoomBy = (step: 1 | -1) => {
    const next = ZOOMS[ZOOMS.indexOf(state.zoom) + step]
    if (next === undefined) return { state, action: "none" as const }
    const from = ZOOM_SCALE[state.zoom]
    const to = ZOOM_SCALE[next]
    const centerX = (state.x + bounds.viewWidth / 2) * (to.x / from.x)
    const centerY = (state.y + bounds.viewHeight / 2) * (to.y / from.y)
    // The new bounds are not known here; the renderer clamps the pan to them, so the keeper is the unclamped estimate.
    return { state: { ...state, zoom: next, x: Math.max(0, Math.round(centerX - bounds.viewWidth / 2)), y: Math.max(0, Math.round(centerY - bounds.viewHeight / 2)) }, action: "none" as const }
  }
  if (key === "+" || key === "=") return zoomBy(1)
  if (key === "-" || key === "_") return zoomBy(-1)
  const go = (index: number) => (count > 0 && index >= 0 && index < count && index !== state.index ? { state: { ...createDiagramView(index) }, action: "none" as const } : { state, action: "none" as const })
  if (key === "n" || key === "]") return go(state.index + 1)
  if (key === "p" || key === "[") return go(state.index - 1)
  return { state, action: "none" }
}

// ─── Render ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `line` from cell `from`, `width` cells wide; a wide character cut by the left edge becomes a blank. */
function sliceLine(line: Line, from: number, width: number): Line {
  const out: Line = []
  let at = 0
  let used = 0
  for (const span of line) {
    let text = ""
    for (const cell of cells(span.text)) {
      const end = at + cell.width
      if (end <= from) {
        at = end
        continue
      }
      if (at < from || used + cell.width > width) {
        if (at < from && used < width) {
          text += " ".repeat(Math.min(end - from, width - used))
          used += Math.min(end - from, width - used)
        }
        at = end
        if (used >= width) break
        continue
      }
      text += cell.text
      used += cell.width
      at = end
    }
    if (text) out.push({ ...span, text })
    if (used >= width) break
  }
  return out
}

/** Renders exactly `height` lines of at most `width` cells. A diagram smaller than the view is centered. */
export function renderDiagramView(input: { layout: DiagramLayout | undefined; state: DiagramViewState; count: number; width: number; height: number }): Line[] {
  const { layout, state, count, width, height } = input
  if (height <= 0) return []
  const hints = HINTS.find((text) => textWidth(text) <= Math.max(20, width - 2))!
  const subtitle = count > 0 ? `${Math.min(state.index, count - 1) + 1} of ${count}` : "none"
  if (!layout) return deck({ page: "Diagram", subtitle, body: [[{ text: count === 0 ? "no diagram in this session yet" : "loading diagram…", fg: "muted" }]], hints, width, height })
  const { viewWidth, viewHeight } = diagramViewport(width, height)
  const maxX = Math.max(0, layout.width - viewWidth)
  const maxY = Math.max(0, layout.height - viewHeight)
  const x = clamp(state.x, maxX)
  const y = clamp(state.y, maxY)
  const left = Math.max(0, Math.floor((viewWidth - layout.width) / 2))
  const top = Math.max(0, Math.floor((viewHeight - layout.height) / 2))
  const body: Line[] = []
  for (let row = 0; row < viewHeight; row++) {
    const source = layout.lines[y + row - top]
    body.push(source && row >= top ? fit([{ text: " ".repeat(left) }, ...sliceLine(source, x, viewWidth - left)], viewWidth) : [])
  }
  const span = [maxX > 0 ? `cols ${x + 1}-${Math.min(layout.width, x + viewWidth)}/${layout.width}` : "", maxY > 0 ? `rows ${y + 1}-${Math.min(layout.height, y + viewHeight)}/${layout.height}` : ""].filter(Boolean).join(" · ")
  const summary = [layout.note ? "source" : `zoom ${ZOOM_LABEL[state.zoom]}`, span].filter(Boolean).join(" · ")
  return deck({ page: "Diagram", subtitle, summary, body, hints, width, height })
}
