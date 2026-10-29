// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel, blankRow, writeVisual, drawHorizontalConnector, drawVerticalConnector, putOverlay, connectorGlyph, centerVisual } from "./legacy-shared"
import type { ConnectorDirection } from "./legacy-shared"

export function renderCynefinDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^cynefin-beta$/i.test(lines[0]!?.trim() ?? "")) return undefined
  const domains = new Map<string, string[]>()
  const transitions: Array<{ from: string; to: string; label?: string | undefined }> = []
  let title = "Cynefin framework"
  let current: string | undefined
  const domainNames = new Set(["complex", "complicated", "clear", "chaotic", "confusion"])
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]!) || title
      continue
    }
    const domain = /^(complex|complicated|clear|chaotic|confusion)$/i.exec(line)
    if (domain) {
      current = domain[1]!.toLowerCase()
      if (!domains.has(current)) domains.set(current, [])
      continue
    }
    const transition = /^(complex|complicated|clear|chaotic|confusion)\s*-->\s*(complex|complicated|clear|chaotic|confusion)\s*(?::\s*\"?(.+?)\"?)?$/i.exec(line)
    if (transition) {
      transitions.push({ from: transition[1]!.toLowerCase(), to: transition[2]!.toLowerCase(), label: cleanMermaidLabel(transition[3]!) })
      current = undefined
      continue
    }
    if (current && !domainNames.has(line.toLowerCase()) && !/^(?:accTitle|accDescr)\s*:/i.test(line)) domains.set(current, [...(domains.get(current) ?? []), cleanMermaidLabel(line)])
  }
  if (domains.size === 0 && transitions.length === 0) return undefined
  const canvasWidth = 84
  const rowCount = 27
  const midColumn = Math.floor(canvasWidth / 2)
  const midRow = 13
  const canvas = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  canvas[0]![0]! = "╭"
  canvas[0]![canvasWidth - 1]! = "╮"
  canvas[rowCount - 1]![0]! = "╰"
  canvas[rowCount - 1]![canvasWidth - 1]! = "╯"
  for (let column = 1; column < canvasWidth - 1; column++) {
    canvas[0]![column]! = "─"
    canvas[rowCount - 1]![column]! = "─"
    canvas[midRow]![column]! = column % 4 === 0 ? "≈" : "─"
  }
  for (let row = 1; row < rowCount - 1; row++) {
    canvas[row]![0]! = "│"
    canvas[row]![canvasWidth - 1]! = "│"
    canvas[row]![midColumn]! = row % 3 === 0 ? "≈" : "│"
  }
  canvas[0]![midColumn]! = "┬"
  canvas[midRow]![0]! = "├"
  canvas[midRow]![midColumn]! = "┼"
  canvas[midRow]![canvasWidth - 1]! = "┤"
  canvas[rowCount - 1]![midColumn]! = "┴"

  const domainMeta = new Map<string, { title: string; description: string; practice: string; left: number; top: number }>([
    ["complex", { title: "COMPLEX", description: "Probe → Sense → Respond", practice: "Emergent practices", left: 3, top: 2 }],
    ["complicated", { title: "COMPLICATED", description: "Sense → Analyse → Respond", practice: "Good practices", left: midColumn + 3, top: 2 }],
    ["chaotic", { title: "CHAOTIC", description: "Act → Sense → Respond", practice: "Novel practices", left: 3, top: midRow + 2 }],
    ["clear", { title: "CLEAR", description: "Sense → Categorise → Respond", practice: "Best practices", left: midColumn + 3, top: midRow + 2 }],
  ])
  for (const [name, meta] of domainMeta) {
    writeVisual(canvas[meta.top]!, meta.left, meta.title)
    writeVisual(canvas[meta.top + 1]!, meta.left, meta.description)
    writeVisual(canvas[meta.top + 2]!, meta.left, meta.practice)
    ;(domains.get(name) ?? []).slice(0, 4).forEach((item, index) => {
      const available = midColumn - 7
      writeVisual(canvas[meta.top + 4 + index]!, meta.left, `[${cleanMermaidLabel(item).slice(0, available - 2)}]`)
    })
  }

  const transitionAnchors = new Map<string, { row: number; column: number }>([
    ["complex", { row: midRow - 4, column: Math.floor(midColumn / 2) }],
    ["complicated", { row: midRow - 4, column: midColumn + Math.floor((canvasWidth - midColumn) / 2) }],
    ["chaotic", { row: midRow + 5, column: Math.floor(midColumn / 2) }],
    ["clear", { row: midRow + 5, column: midColumn + Math.floor((canvasWidth - midColumn) / 2) }],
    ["confusion", { row: midRow, column: midColumn }],
  ])
  const connectors = Array.from({ length: rowCount }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
  const overlays = new Map<number, string>()
  transitions.forEach((transition, index) => {
    const from = transitionAnchors.get(transition.from)
    const to = transitionAnchors.get(transition.to)
    if (!from || !to || transition.from === transition.to) return
    const sameBand = Math.abs(from.row - to.row) <= 1
    if (sameBand) {
      drawHorizontalConnector(connectors, from.row, from.column, to.column)
    } else {
      const lane = to.column >= midColumn ? canvasWidth - 3 - index : 2 + index
      drawHorizontalConnector(connectors, from.row, from.column, lane)
      drawVerticalConnector(connectors, lane, from.row, to.row)
      drawHorizontalConnector(connectors, to.row, lane, to.column)
    }
    const finalDirectionRight = sameBand ? to.column >= from.column : to.column >= (to.column >= midColumn ? canvasWidth - 3 - index : 2 + index)
    putOverlay(overlays, canvasWidth, to.row, to.column, finalDirectionRight ? "▶" : "◀")
    if (transition.label) putOverlay(overlays, canvasWidth, from.row, Math.max(1, Math.min(canvasWidth - Bun.stringWidth(transition.label) - 1, from.column + (to.column >= from.column ? 2 : -Bun.stringWidth(transition.label) - 2))), transition.label)
  })
  for (let row = 1; row < rowCount - 1; row++) {
    for (let column = 1; column < canvasWidth - 1; column++) {
      const overlay = overlays.get(row * canvasWidth + column)
      if (overlay) {
        canvas[row]![column]! = overlay
        continue
      }
      const directions = connectors[row]!?.[column]!
      if (directions?.size && canvas[row]![column]! === " ") canvas[row]![column]! = connectorGlyph(directions)
    }
  }

  const confusionWidth = 30
  const confusionLeft = midColumn - Math.floor(confusionWidth / 2)
  const confusionTop = midRow - 3
  const confusionItems = domains.get("confusion") ?? []
  const confusionBox = [
    `╭${"≈".repeat(confusionWidth - 2)}╮`,
    `│${centerVisual("CONFUSION / DISORDER", confusionWidth - 2)}│`,
    `│${centerVisual(confusionItems[0]! ? `[${confusionItems[0]!}]` : "Move unknowns outward", confusionWidth - 2)}│`,
    `│${centerVisual(confusionItems[1]! ? `[${confusionItems[1]!}]` : "", confusionWidth - 2)}│`,
    `╰${"≈".repeat(confusionWidth - 2)}╯`,
  ]
  confusionBox.forEach((line, offset) => writeVisual(canvas[confusionTop + offset]!, confusionLeft, line))
  const rendered = canvas.map((row) => row.join("").trimEnd())
  return [title, ...rendered].join("\n")
}
