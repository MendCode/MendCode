// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { assertCanvas } from "./core"
import { preparedMermaidSourceLines, cleanMermaidLabel, parseFlowchartEdgeLine, flowchartLayoutEdges, flowchartRanks, renderFlowchartBox, blankRow, writeVisual, drawHorizontalConnector, drawVerticalConnector, putOverlay, cleanConnectorLabel, connectorGlyph } from "./legacy-shared"
import type { FlowchartNodeShape, FlowchartEdge, ConnectorDirection } from "./legacy-shared"

export function renderSwimlaneDiagram(input: string, width = 1600): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  const head = /^swimlane-beta(?:\s+(TB|TD|BT|LR|RL))?$/i.exec(lines[0]!?.trim() ?? "")
  if (!head) return undefined

  const labels = new Map<string, string>()
  const shapes = new Map<string, FlowchartNodeShape>()
  const nodes = new Set<string>()
  const edges: FlowchartEdge[] = []
  const lanes = new Map<string, string[]>()
  let lane: string | undefined
  let laneNumber = 0
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const subgraph = /^subgraph\s+([^\s\[]+)(?:\s*\[?\"?([^\]\"]+)\"?\]?)?$/i.exec(line)
    if (subgraph) {
      lane = cleanMermaidLabel(subgraph[2]! || subgraph[1]!) || `Lane ${laneNumber + 1}`
      laneNumber++
      if (!lanes.has(lane)) lanes.set(lane, [])
      continue
    }
    if (/^end$/i.test(line)) {
      lane = undefined
      continue
    }
    if (/^(?:accTitle|accDescr|classDef|style|click|linkStyle)\b/i.test(line)) continue
    const before = new Set(nodes)
    const parsed = parseFlowchartEdgeLine(line, labels, shapes, nodes)
    edges.push(...parsed)
    if (lane) {
      for (const node of nodes) {
        if (!before.has(node) && !lanes.get(lane)?.includes(node)) lanes.set(lane, [...(lanes.get(lane) ?? []), node])
      }
    }
  }

  if (nodes.size === 0) return undefined
  const laneByNode = new Map<string, string>()
  for (const [laneName, laneNodes] of lanes) for (const node of laneNodes) laneByNode.set(node, laneName)
  const unassigned = [...nodes].filter((node) => !laneByNode.has(node))
  if (unassigned.length > 0) {
    lanes.set("General", unassigned)
    for (const node of unassigned) laneByNode.set(node, "General")
  }

  const nodeList = [...nodes]
  const { layoutEdges } = flowchartLayoutEdges(nodeList, edges)
  const ranks = flowchartRanks(nodeList, layoutEdges) ?? new Map(nodeList.map((node, index) => [node, index]))
  const maxRank = Math.max(...nodeList.map((node) => ranks.get(node) ?? 0), 0)
  const boxes = new Map(nodeList.map((node) => [node, renderFlowchartBox(labels.get(node) ?? node, shapes.get(node))]))
  const boxWidth = Math.max(...[...boxes.values()].flatMap((box) => box.map((line) => Bun.stringWidth(line))), 12)
  const laneLabelWidth = Math.max(12, ...[...lanes.keys()].map((name) => Bun.stringWidth(name) + 4))
  const rankStride = boxWidth + 10
  const canvasWidth = laneLabelWidth + 4 + (maxRank + 1) * rankStride
  const laneLayouts: Array<{ name: string; top: number; bottom: number }> = []
  let nextTop = 0
  for (const [laneName, laneNodes] of lanes) {
    const counts = new Map<number, number>()
    for (const node of laneNodes) counts.set(ranks.get(node) ?? 0, (counts.get(ranks.get(node) ?? 0) ?? 0) + 1)
    const slots = Math.max(1, ...counts.values())
    const height = slots * 4 + 1
    laneLayouts.push({ name: laneName, top: nextTop, bottom: nextTop + height })
    nextTop += height
  }

  const rowCount = nextTop + 1
  assertCanvas(canvasWidth, rowCount)
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectorCells = Array.from({ length: rowCount }, () =>
    Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()),
  )
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const positions = new Map<string, { left: number; right: number; centerRow: number }>()

  for (const [laneIndex, layout] of laneLayouts.entries()) {
    const border = laneIndex === 0 ? "┌" : "├"
    rows[layout.top]![0]! = border
    for (let column = 1; column < canvasWidth - 1; column++) rows[layout.top]![column]! = "─"
    rows[layout.top]![canvasWidth - 1]! = laneIndex === 0 ? "┐" : "┤"
    writeVisual(rows[layout.top]!, 2, ` ${layout.name} `)
    for (let row = layout.top + 1; row < layout.bottom; row++) {
      rows[row]![0]! = "│"
      rows[row]![canvasWidth - 1]! = "│"
    }

    const slotsByRank = new Map<number, number>()
    for (const node of lanes.get(layout.name) ?? []) {
      const rank = ranks.get(node) ?? 0
      const slot = slotsByRank.get(rank) ?? 0
      slotsByRank.set(rank, slot + 1)
      const box = boxes.get(node) ?? renderFlowchartBox(labels.get(node) ?? node, shapes.get(node))
      const nodeWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
      const left = laneLabelWidth + 2 + rank * rankStride + Math.floor((boxWidth - nodeWidth) / 2)
      const top = layout.top + 1 + slot * 4
      for (const [rowOffset, line] of box.entries()) {
        writeVisual(rows[top + rowOffset]!, left, line)
        for (let column = 0; column < nodeWidth; column++) boxCells.add((top + rowOffset) * canvasWidth + left + column)
      }
      positions.set(node, { left, right: left + nodeWidth - 1, centerRow: top + 1 })
    }
  }

  const bottom = laneLayouts.at(-1)?.bottom ?? rowCount - 1
  rows[bottom]![0]! = "└"
  for (let column = 1; column < canvasWidth - 1; column++) rows[bottom]![column]! = "─"
  rows[bottom]![canvasWidth - 1]! = "┘"

  for (const [edgeIndex, edge] of edges.entries()) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    const forward = to.left > from.right
    const sourceColumn = forward ? from.right + 1 : from.left - 1
    const targetColumn = forward ? to.left - 1 : to.right + 1
    const routeColumn = forward
      ? Math.max(sourceColumn, Math.floor((sourceColumn + targetColumn) / 2))
      : Math.min(canvasWidth - 2, Math.max(from.right, to.right) + 3 + edgeIndex * 2)
    drawHorizontalConnector(connectorCells, from.centerRow, sourceColumn, routeColumn)
    drawVerticalConnector(connectorCells, routeColumn, from.centerRow, to.centerRow)
    drawHorizontalConnector(connectorCells, to.centerRow, routeColumn, targetColumn)
    putOverlay(overlays, canvasWidth, to.centerRow, targetColumn, forward ? "▶" : "◀")
    const label = cleanConnectorLabel(edge.label)
    if (label) {
      const labelStart = Math.max(1, Math.min(canvasWidth - Bun.stringWidth(label) - 1, sourceColumn + 1))
      putOverlay(overlays, canvasWidth, from.centerRow - 1, labelStart, label)
    }
  }

  const rendered = rows.map((row, rowIndex) =>
    row.map((character, column) => {
      const cell = rowIndex * canvasWidth + column
      if (boxCells.has(cell)) return character
      const overlay = overlays.get(cell)
      if (overlay) return overlay
      const directions = connectorCells[rowIndex]!?.[column]!
      if (!directions?.size) return character
      const merged = new Set(directions)
      if (character === "─") {
        merged.add("left")
        merged.add("right")
      } else if (character === "│") {
        merged.add("up")
        merged.add("down")
      }
      return connectorGlyph(merged)
    }).join("").trimEnd(),
  )

  return [`Swimlane · ${(head[1]! ?? "LR").toUpperCase()}`, ...rendered].join("\n")
}
