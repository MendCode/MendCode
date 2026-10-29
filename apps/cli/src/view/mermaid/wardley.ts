// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel } from "./legacy-shared"

type WardleyNode = { name: string; visibility: number; evolution: number; kind: "anchor" | "component"; decorator?: string | undefined }

export function renderWardleyDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^wardley-beta$/i.test(lines[0]!?.trim() ?? "")) return undefined
  let title = "Wardley map"
  const nodes = new Map<string, WardleyNode>()
  const links: Array<{ from: string; to: string; label?: string | undefined; flow: boolean }> = []
  const notes: Array<{ text: string; visibility: number; evolution: number }> = []
  const evolutions: Array<{ name: string; target: number }> = []
  const annotations: string[] = []

  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]!) || title
      continue
    }
    if (/^(?:size|evolution|pipeline|accelerator|deaccelerator|annotations)\b/i.test(line)) {
      continue
    }
    const node = /^(anchor|component)\s+(?:\"([^\"]+)\"|(.+?))\s+\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\](.*)$/i.exec(line)
    if (node) {
      const name = cleanMermaidLabel(node[2]! || node[3]!)
      if (!name) continue
      const decorator = /\((inertia|build|buy|outsource|market)\)/i.exec(node[6]! ?? "")?.[1]!
      nodes.set(name, { name, visibility: Number(node[4]!), evolution: Number(node[5]!), kind: node[1]!.toLowerCase() === "anchor" ? "anchor" : "component", decorator })
      continue
    }
    const note = /^note\s+\"(.+?)\"\s+\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]$/i.exec(line)
    if (note) {
      notes.push({ text: cleanMermaidLabel(note[1]!), visibility: Number(note[2]!), evolution: Number(note[3]!) })
      continue
    }
    const annotation = /^annotation\s+(.+)$/i.exec(line)
    if (annotation) {
      annotations.push(cleanMermaidLabel(annotation[1]!))
      continue
    }
    const evolve = /^evolve\s+(?:\"([^\"]+)\"|(.+?))\s+([0-9.]+)$/i.exec(line)
    if (evolve) {
      evolutions.push({ name: cleanMermaidLabel(evolve[1]! || evolve[2]!), target: Number(evolve[3]!) })
      continue
    }
    const link = /^(.+?)\s*(\+<>|\+'([^']+)'>|\+>|\+<|-\.->|-->|->)\s*(.+?)(?:\s*;\s*(.+))?$/i.exec(line)
    if (link) {
      const from = cleanMermaidLabel(link[1]!)
      const to = cleanMermaidLabel(link[4]!)
      if (from && to) links.push({ from, to, label: cleanMermaidLabel(link[3]! || link[5]!), flow: link[2]!.includes("+") })
    }
  }

  if (nodes.size === 0 && links.length === 0 && notes.length === 0) return undefined
  const mapWidth = Math.max(68, Math.min(104, Math.max(68, ...[...nodes.values()].map((node) => Bun.stringWidth(node.name) + Math.round(node.evolution * 64) + 8))))
  const mapHeight = 20
  const canvas = Array.from({ length: mapHeight }, () => Array.from({ length: mapWidth }, () => " "))
  const put = (row: number, column: number, text: string) => {
    for (const [index, char] of [...text].entries()) {
      if (row < 0 || row >= mapHeight || column + index < 0 || column + index >= mapWidth) continue
      canvas[row]![column + index]! = char
    }
  }
  const plotLeft = 3
  const plotRight = mapWidth - 2
  const plotTop = 1
  const plotBottom = mapHeight - 3
  put(0, plotLeft, "Visibility ↑")
  for (let row = plotTop; row <= plotBottom; row++) canvas[row]![plotLeft]! = "│"
  canvas[plotBottom]![plotLeft]! = "└"
  for (let column = plotLeft + 1; column <= plotRight; column++) canvas[plotBottom]![column]! = "─"
  for (const ratio of [0.25, 0.5, 0.75]) {
    const column = plotLeft + Math.round((plotRight - plotLeft) * ratio)
    for (let row = plotTop; row < plotBottom; row++) if (canvas[row]![column]! === " ") canvas[row]![column]! = "┆"
  }
  const stages = ["Genesis", "Custom built", "Product", "Commodity"]
  stages.forEach((stage, index) => {
    const center = plotLeft + Math.round((plotRight - plotLeft) * ((index + 0.5) / stages.length))
    put(mapHeight - 2, Math.max(plotLeft, center - Math.floor(Bun.stringWidth(stage) / 2)), stage)
  })
  put(mapHeight - 1, Math.max(plotLeft, Math.floor((mapWidth - Bun.stringWidth("Evolution →")) / 2)), "Evolution →")
  const positions = new Map<string, { row: number; column: number }>()
  for (const node of nodes.values()) {
    const row = Math.max(plotTop, Math.min(plotBottom - 1, plotTop + Math.round((1 - Math.max(0, Math.min(1, node.visibility))) * (plotBottom - plotTop - 1))))
    const column = Math.max(plotLeft + 1, Math.min(plotRight - 2, plotLeft + 1 + Math.round(Math.max(0, Math.min(1, node.evolution)) * (plotRight - plotLeft - 3))))
    positions.set(node.name, { row, column })
  }
  const dependencyGlyph = (from: { row: number; column: number }, to: { row: number; column: number }) => {
    const deltaX = to.column - from.column
    const deltaY = to.row - from.row
    return Math.abs(deltaX) > Math.abs(deltaY) * 2 ? "─" : Math.abs(deltaY) > Math.abs(deltaX) * 2 ? "│" : deltaX * deltaY > 0 ? "╲" : "╱"
  }
  for (const link of links) {
    const from = positions.get(link.from)
    const to = positions.get(link.to)
    if (!from || !to) continue
    const steps = Math.max(Math.abs(to.column - from.column), Math.abs(to.row - from.row), 1)
    const glyph = link.flow ? "┄" : dependencyGlyph(from, to)
    for (let step = 0; step <= steps; step++) {
      const row = Math.round(from.row + (to.row - from.row) * step / steps)
      const column = Math.round(from.column + (to.column - from.column) * step / steps)
      if (canvas[row]!?.[column]! === " " || canvas[row]!?.[column]! === "┆") canvas[row]![column]! = glyph
    }
    canvas[to.row]![to.column]! = to.column >= from.column ? "▶" : "◀"
    if (link.label) put(Math.round((from.row + to.row) / 2), Math.round((from.column + to.column) / 2) + 1, link.label)
  }
  for (const evolution of evolutions) {
    const from = positions.get(evolution.name)
    if (!from) continue
    const targetColumn = Math.max(plotLeft + 1, Math.min(plotRight - 1, plotLeft + 1 + Math.round(evolution.target * (plotRight - plotLeft - 3))))
    for (let column = Math.min(from.column, targetColumn) + 1; column < Math.max(from.column, targetColumn); column++) canvas[from.row]![column]! = "╌"
    canvas[from.row]![targetColumn]! = targetColumn >= from.column ? "▶" : "◀"
  }
  for (const note of notes) {
    const row = Math.max(plotTop, Math.min(plotBottom - 1, plotTop + Math.round((1 - note.visibility) * (plotBottom - plotTop - 1))))
    const column = Math.max(plotLeft + 1, Math.min(plotRight - Bun.stringWidth(note.text) - 2, plotLeft + 1 + Math.round(note.evolution * (plotRight - plotLeft - 3))))
    put(row, column, `⟦${note.text}⟧`)
  }
  for (const node of nodes.values()) {
    const position = positions.get(node.name)
    if (!position) continue
    const marker = node.kind === "anchor" ? "◆" : node.decorator === "build" ? "△" : node.decorator === "buy" ? "◇" : node.decorator === "outsource" ? "□" : node.decorator === "market" ? "○" : "●"
    put(position.row, position.column, `${marker} ${node.name}`)
  }
  const output = [title, ...canvas.map((row) => row.join("").replace(/ +$/g, ""))]
  if (annotations.length > 0) output.push("Annotations", ...annotations.map((annotation) => `• ${annotation}`))
  return output.join("\n")
}
