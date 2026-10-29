import { assertCanvas } from "./core"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, parseFlowchartNodeExpression, renderFlowchartBox, renderBox, blankRow, writeVisual, drawHorizontalConnector, putOverlay, drawVerticalConnector, connectorGlyph } from "./legacy-shared"
import type { FlowchartNodeShape, FlowchartEdge, ConnectorDirection } from "./legacy-shared"

export function renderBlockDiagram(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^block(?:-beta)?$/i.test(lines[0]! ?? "")) return undefined

  const body = lines.slice(1)
  const columns = Math.min(12, Math.max(1, Number(/^columns\s+(\d+)/i.exec(body.find((line) => /^columns\s+/i.test(line)) ?? "")?.[1]! ?? 1)))
  const labels = new Map<string, string>()
  const shapes = new Map<string, FlowchartNodeShape>()
  const order: string[] = []
  const edges: FlowchartEdge[] = []
  const nodePattern = /([A-Za-z][\w-]*)(?:\[\s*"?([^\]"]+)"?\s*\])?(?::\d+)?/g
  const parseNodes = (line: string) => {
    const nodes: string[] = []
    for (const match of line.matchAll(nodePattern)) {
      const id = match[1]!
      if (!id || id.toLowerCase() === "space") continue
      labels.set(id, cleanLabel(match[2]! || labels.get(id) || id))
      if (!order.includes(id)) order.push(id)
      nodes.push(id)
    }
    return nodes
  }
  for (const raw of body) {
    const line = raw.split("%%", 1)[0]!?.trim() ?? ""
    if (!line || /^columns\s+/i.test(line) || /^(?:space|\{|\})/i.test(line)) continue
    const edge = /^(.+?)\s+(<-->|-->|<--|---|--)\s+(.+?)$/.exec(line)
    if (edge) {
      const from = parseNodes(edge[1]! ?? "")[0]!
      const to = parseNodes(edge[3]! ?? "")[0]!
      if (from && to) {
        edges.push(edge[2]! === "<--" ? { from: to, to: from } : { from, to })
        continue
      }
    }
    for (const node of parseNodes(line)) {
      const expression = new RegExp(`${node}[^\\s]*`).exec(line)?.[0]!
      const parsed = expression ? parseFlowchartNodeExpression(expression) : undefined
      if (parsed) shapes.set(node, parsed.shape)
    }
  }
  if (order.length === 0) return undefined

  const boxes = new Map(order.map((node) => [node, renderFlowchartBox(labels.get(node) ?? node, shapes.get(node))]))
  const cellWidth = Math.max(...[...boxes.values()].flatMap((box) => box.map((line) => Bun.stringWidth(line))), 12)
  const columnStride = cellWidth + 10
  const rowStride = 7
  const rowGroups = Math.ceil(order.length / columns)
  const canvasWidth = columns * columnStride - 10
  const rowCount = rowGroups * rowStride - 3
  assertCanvas(canvasWidth, rowCount)
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectors = Array.from({ length: rowCount }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const positions = new Map<string, { left: number; right: number; top: number; center: number; bottom: number }>()
  order.forEach((node, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const box = boxes.get(node) ?? renderBox(node)
    const nodeWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    const left = column * columnStride + Math.floor((cellWidth - nodeWidth) / 2)
    const top = row * rowStride
    box.forEach((line, offset) => {
      writeVisual(rows[top + offset]!, left, line)
      for (let cell = 0; cell < nodeWidth; cell++) boxCells.add((top + offset) * canvasWidth + left + cell)
    })
    positions.set(node, { left, right: left + nodeWidth - 1, top, center: top + 1, bottom: top + 2 })
  })
  for (const edge of edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    if (from.center === to.center && Math.abs(order.indexOf(edge.from) - order.indexOf(edge.to)) === 1) {
      const forward = to.left > from.right
      drawHorizontalConnector(connectors, from.center, forward ? from.right + 1 : from.left - 1, forward ? to.left - 1 : to.right + 1)
      putOverlay(overlays, canvasWidth, to.center, forward ? to.left - 1 : to.right + 1, forward ? "▶" : "◀")
      continue
    }
    const fromCenter = Math.floor((from.left + from.right) / 2)
    const toCenter = Math.floor((to.left + to.right) / 2)
    const elbowRow = from.center === to.center ? from.bottom + 2 : Math.floor((from.bottom + to.top) / 2)
    drawVerticalConnector(connectors, fromCenter, from.bottom + 1, elbowRow)
    drawHorizontalConnector(connectors, elbowRow, fromCenter, toCenter)
    drawVerticalConnector(connectors, toCenter, elbowRow, to.top - 1)
    putOverlay(overlays, canvasWidth, to.top - 1, toCenter, "▼")
  }
  const rendered = rows.map((row, rowIndex) => row.map((character, column) => {
    const cell = rowIndex * canvasWidth + column
    if (boxCells.has(cell)) return character
    const overlay = overlays.get(cell)
    if (overlay) return overlay
    const directions = connectors[rowIndex]!?.[column]!
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return ["Block diagram", ...rendered].join("\n")
}
