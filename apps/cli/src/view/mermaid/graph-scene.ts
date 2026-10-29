import { textWidth, wrap } from "../wrap"
import { Canvas, MERMAID_NOTES } from "./core"
import type { LineStyle, MermaidResult } from "./core"

export type SceneNode = { id: string; label: string; fields?: string[]; group?: string; draw?: (canvas: Canvas, rect: { x: number; y: number; w: number; h: number }) => void }
export type SceneEdge = { from: string; to: string; label?: string; dashed?: boolean; style?: LineStyle; head?: string; tail?: string }

/** A compact routed graph for entity/cluster families. Unique side channels cannot run through a box.
 * Each relationship gets a row immediately below its source, not below the entire graph. */
export function graphScene(nodes: SceneNode[], edges: SceneEdge[], width: number): MermaidResult {
  if (nodes.length > 120 || edges.length > 120) return { note: MERMAID_NOTES.tooComplex }
  const channels = edges.length * 2 + 2
  const inner = Math.min(48, width - channels - 8, Math.max(8, ...nodes.flatMap((node) => [node.label, node.group ?? "", ...(node.fields ?? [])]).map(textWidth)))
  if (inner < 8) return { note: MERMAID_NOTES.tooWide }
  const grouped = new Map<string | SceneNode, SceneNode[]>()
  const degrees = new Map<string, number>()
  for (const edge of edges) for (const id of [edge.from, edge.to]) degrees.set(id, (degrees.get(id) ?? 0) + 1)
  for (const node of nodes) {
    const key = node.group || node
    grouped.set(key, [...(grouped.get(key) ?? []), node])
  }
  const positions = new Map<string, { y: number; right: number }>()
  const content: Array<{ y: number; h: number; label: string[]; fields: string[]; group: string; draw?: SceneNode["draw"] }> = []
  const groups: Array<{ top: number; bottom: number; label: string }> = []
  const labels = edges.map((edge) => wrap(edge.label ?? "", inner))
  const tracks: number[] = []
  let row = 0
  for (const [key, members] of grouped) {
    const group = typeof key === "string" ? key : ""
    const top = row
    if (group) row += wrap(group, inner).length + 2
    for (const node of members) {
      const label = wrap(node.label, inner)
      const fields = (node.fields ?? []).flatMap((field) => wrap(field, inner))
      const h = Math.max(label.length + fields.length + (fields.length ? 3 : 2), (degrees.get(node.id) ?? 0) + 2)
      content.push({ y: row, h, label, fields, group, ...(node.draw ? { draw: node.draw } : {}) })
      positions.set(node.id, { y: row + 1, right: inner + 5 })
      row += h + 2
      for (const [index, edge] of edges.entries()) {
        if (edge.from !== node.id) continue
        tracks[index] = row
        if (edge.label) row += labels[index]!.length + 2
      }
    }
    if (group) {
      groups.push({ top, bottom: row - 1, label: group })
      row++
    }
  }
  if (row > 600) return { note: MERMAID_NOTES.tooComplex }
  const canvas = new Canvas(inner + channels + 8, Math.max(1, row))
  const box = (x: number, y: number, w: number, h: number, role: "box" | "frame") => {
    for (let dy = 0; dy < h; dy++) {
      canvas.glyph(x, y + dy, dy === 0 ? "┌" : dy === h - 1 ? "└" : "│", role)
      canvas.glyph(x + w - 1, y + dy, dy === 0 ? "┐" : dy === h - 1 ? "┘" : "│", role)
      if (dy === 0 || dy === h - 1) for (let dx = 1; dx < w - 1; dx++) canvas.glyph(x + dx, y + dy, "─", role)
    }
  }
  for (const group of groups) {
    box(0, group.top, inner + 8, group.bottom - group.top + 1, "frame")
    wrap(group.label, inner).forEach((text, i) => canvas.text(2, group.top + 1 + i, text, "keyword"))
  }
  for (const node of content) {
    const h = node.h
    if (node.draw) {
      node.draw(canvas, { x: 2, y: node.y, w: inner + 4, h })
      continue
    }
    box(2, node.y, inner + 4, h, "box")
    node.label.forEach((text, i) => canvas.text(4, node.y + 1 + i, text, "text"))
    if (node.fields.length) {
      const y = node.y + node.label.length + 1
      canvas.glyph(2, y, "├", "box")
      canvas.glyph(inner + 5, y, "┤", "box")
      for (let x = 3; x < inner + 5; x++) canvas.glyph(x, y, "─", "box")
      node.fields.forEach((text, i) => canvas.text(4, y + 1 + i, text, "text"))
    }
  }
  const ports = new Map<string, number>()
  const port = (id: string) => {
    const offset = ports.get(id) ?? 0
    ports.set(id, offset + 1)
    return positions.get(id)!.y + offset
  }
  for (const [index, edge] of edges.entries()) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) return { note: MERMAID_NOTES.unsupported }
    const sourceRow = port(edge.from)
    const targetRow = port(edge.to)
    const x = inner + 8 + index * 2
    const track = tracks[index]!
    const style = edge.style ?? (edge.dashed ? "dashed" : "solid")
    canvas.path([{ x: from.right + 1, y: sourceRow }, { x, y: sourceRow }, { x, y: track }], style)
    canvas.path([{ x, y: track }, { x: x + 1, y: track }, { x: x + 1, y: targetRow }, { x: to.right + 1, y: targetRow }], style)
    canvas.glyph(to.right + 1, targetRow, edge.head ?? "◀", "edge")
    if (edge.tail) canvas.glyph(from.right + 1, sourceRow, edge.tail, "edge")
    // A labelled branch reaches into its reserved gap; unlabelled edges have no dangling rail.
    if (edge.label) {
      canvas.path([{ x: 2, y: track }, { x, y: track }], style)
      labels[index]!.forEach((text, i) => canvas.text(2, track + 1 + i, text, "label"))
    }
  }
  return { lines: canvas.toLines() }
}

export function sceneText(result: MermaidResult): string | undefined {
  return "lines" in result ? result.lines.map((row) => row.map((span) => span.text).join("")).join("\n") : undefined
}

/** Horizontal clusters use bottom channels, leaving every box and its label clear. */
export function horizontalScene(nodes: SceneNode[], edges: SceneEdge[], width: number, reverse = false): MermaidResult {
  if (nodes.length > 120 || edges.length > 120) return { note: MERMAID_NOTES.tooComplex }
  const ordered = reverse ? [...nodes].reverse() : nodes
  const groups = new Map<string, SceneNode[]>()
  for (const node of ordered) groups.set(node.group ?? "", [...(groups.get(node.group ?? "") ?? []), node])
  const inner = Math.min(24, Math.floor((width - groups.size * 4) / Math.max(1, nodes.length)) - 6)
  if (inner < 4) return { note: MERMAID_NOTES.tooWide }
  const content = ordered.map((node) => ({ node, lines: [node.label, ...(node.fields ?? [])].flatMap((text) => wrap(text, inner)) }))
  const nodeHeight = Math.max(3, ...content.map((node) => node.lines.length + 2))
  const positions = new Map<string, { x: number; y: number }>()
  const bounds: Array<{ x: number; w: number; label: string }> = []
  const starts = new Map<string, number>()
  let x = 0
  for (const [label, members] of groups) {
    const start = x
    x += 2
    for (const node of members) {
      starts.set(node.id, x)
      positions.set(node.id, { x: x + Math.floor((inner + 3) / 2), y: nodeHeight + 2 })
      x += inner + 6
    }
    bounds.push({ x: start, w: x - start, label })
    x += 2
  }
  if (x > width) return { note: MERMAID_NOTES.tooWide }
  let height = nodeHeight + 6
  const tracks: number[] = []
  const labels = edges.map((edge) => wrap(edge.label ?? "", Math.max(2, x - 4)))
  for (const label of labels) {
    tracks.push(height)
    height += label.length + 2
  }
  if (height > 600) return { note: MERMAID_NOTES.tooComplex }
  const canvas = new Canvas(x, height)
  const box = (left: number, top: number, w: number, h: number, frame = false) => {
    const role = frame ? "frame" : "box"
    for (let y = top; y < top + h; y++) {
      canvas.glyph(left, y, y === top ? "┌" : y === top + h - 1 ? "└" : "│", role)
      canvas.glyph(left + w - 1, y, y === top ? "┐" : y === top + h - 1 ? "┘" : "│", role)
      if (y === top || y === top + h - 1) for (let col = left + 1; col < left + w - 1; col++) canvas.glyph(col, y, "─", role)
    }
  }
  for (const bound of bounds) {
    if (!bound.label) continue
    box(bound.x, 0, bound.w, nodeHeight + 5, true)
    const title = wrap(bound.label, bound.w - 4)
    if (title.length > 2) return { note: MERMAID_NOTES.tooWide }
    title.forEach((text, i) => canvas.text(bound.x + 2, i, text, "keyword"))
  }
  for (const item of content) {
    const left = starts.get(item.node.id)!
    if (item.node.draw) {
      item.node.draw(canvas, { x: left, y: 3, w: inner + 4, h: nodeHeight })
      continue
    }
    box(left, 3, inner + 4, nodeHeight)
    item.lines.forEach((text, i) => canvas.text(left + 2, i + 4, text, "text"))
  }
  for (const [i, edge] of edges.entries()) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) return { note: MERMAID_NOTES.unsupported }
    const y = tracks[i]!
    canvas.path([{ x: from.x, y: from.y + 1 }, { x: from.x, y }, { x: to.x, y }, { x: to.x, y: to.y + 1 }], edge.style ?? (edge.dashed ? "dashed" : "solid"))
    canvas.junction(from.x, nodeHeight + 4, "S")
    canvas.junction(to.x, nodeHeight + 4, "S")
    canvas.glyph(to.x, to.y + 1, edge.head === "─" ? "│" : edge.head && "✕○◆◇".includes(edge.head) ? edge.head : edge.head === "◁" ? "△" : "▲", "edge")
    if (edge.tail) canvas.glyph(from.x, from.y + 1, edge.tail === "◀" ? "▲" : edge.tail === "◁" ? "△" : edge.tail, "edge")
    labels[i]!.forEach((text, row) => canvas.text(2, y + 1 + row, text, "label"))
  }
  return { lines: canvas.toLines() }
}
