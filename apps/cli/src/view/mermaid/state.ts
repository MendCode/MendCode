import { assertCanvas } from "./core"
import { graphScene, horizontalScene, sceneText } from "./graph-scene"
import { terminalText as stripAnsi } from "../wrap"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidLines, cleanMermaidLabel, cleanLabel, centerVisual, padVisual, cleanConnectorLabel, flowchartLayoutEdges, flowchartRanks, renderFlowchartBox, writeVisual, drawVerticalConnector, drawHorizontalConnector, putOverlay, connectorGlyph, blankRow } from "./legacy-shared"
import type { FlowchartEdge, FlowchartNodeShape, ConnectorDirection } from "./legacy-shared"

function renderStateBox(label: string) {
  const display = cleanMermaidLabel(label) || cleanLabel(label)
  const width = display === "●" || display === "◉" ? 5 : Math.max(12, Bun.stringWidth(display) + 2)
  return [`╭${"─".repeat(width)}╮`, `│${centerVisual(display, width)}│`, `╰${"─".repeat(width)}╯`]
}

function cleanInlineMarkdownForText(input: string) {
  return stripAnsi(input)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .trim()
}

function wrapTextLine(prefix: string, text: string, width: number) {
  const maxWidth = Math.max(48, Math.min(100, width - 8))
  const cleanText = cleanInlineMarkdownForText(text)
  const words = cleanText.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = prefix

  for (const word of words) {
    const separator = current === prefix ? "" : " "
    const next = `${current}${separator}${word}`
    if (Bun.stringWidth(next) <= maxWidth) {
      current = next
      continue
    }

    if (current !== prefix) lines.push(current)
    current = `${" ".repeat(Bun.stringWidth(prefix))}${word}`
  }

  lines.push(current === prefix ? `${prefix}${cleanText}` : current)
  return lines
}

type FlowchartRoutedEdge = { edge: FlowchartEdge; backward: boolean }

type FlowchartLayoutNode = {
  rank: number
  center: number
}

const FLOWCHART_MAX_LAYOUT_NODES = 128

const FLOWCHART_MAX_LAYOUT_RANKS = 32

const FLOWCHART_MAX_CANVAS_WIDTH = 240

const FLOWCHART_NODE_GAP = 5

const FLOWCHART_CONNECTOR_GAP = 4

function renderRankedVerticalFlowchart(input: {
  edges: FlowchartEdge[]
  labels: Map<string, string>
  shapes?: Map<string, FlowchartNodeShape> | undefined
  nodes?: string[] | undefined
  direction: "td" | "tb" | "bt"
  width: number
  renderNode?: (node: string) => string[]
}) {
  const orientedEdges =
    input.direction === "bt"
      ? input.edges.map((edge) => ({ from: edge.to, to: edge.from, label: edge.label }))
      : input.edges
  const nodes = [...new Set([...(input.nodes ?? []), ...orientedEdges.flatMap((edge) => [edge.from, edge.to])])]
  if (nodes.length === 0 || nodes.length > FLOWCHART_MAX_LAYOUT_NODES) return undefined

  const { layoutEdges, deferredEdges } = flowchartLayoutEdges(nodes, orientedEdges)
  const ranks = flowchartRanks(nodes, layoutEdges)
  if (!ranks) return undefined
  const maxRank = Math.max(...nodes.map((node) => ranks.get(node) ?? 0))
  if (maxRank >= FLOWCHART_MAX_LAYOUT_RANKS) return undefined

  const byRank = new Map<number, string[]>()
  for (const node of nodes) byRank.set(ranks.get(node) ?? 0, [...(byRank.get(ranks.get(node) ?? 0) ?? []), node])

  const incoming = new Map<string, string[]>()
  for (const edge of orientedEdges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])

  const orderByNode = new Map<string, number>()
  for (let rank = 0; rank <= maxRank; rank++) {
    const current = byRank.get(rank) ?? []
    if (rank > 0) {
      const previous = new Map((byRank.get(rank - 1) ?? []).map((node, index) => [node, index]))
      current.sort((left, right) => {
        const leftParents = incoming.get(left) ?? []
        const rightParents = incoming.get(right) ?? []
        const leftCenter = leftParents.length
          ? leftParents.reduce((sum, parent) => sum + (previous.get(parent) ?? 0), 0) / leftParents.length
          : Number.POSITIVE_INFINITY
        const rightCenter = rightParents.length
          ? rightParents.reduce((sum, parent) => sum + (previous.get(parent) ?? 0), 0) / rightParents.length
          : Number.POSITIVE_INFINITY
        return leftCenter - rightCenter || (orderByNode.get(left) ?? 0) - (orderByNode.get(right) ?? 0)
      })
    }
    current.forEach((node, index) => orderByNode.set(node, index))
  }

  const layoutNodes = new Map<string, FlowchartLayoutNode>()
  const boxes = new Map<string, string[]>()
  const renderNode =
    input.renderNode ?? ((node: string) => renderFlowchartBox(input.labels.get(node) ?? node, input.shapes?.get(node)))
  let canvasWidth = 0
  for (let rank = 0; rank <= maxRank; rank++) {
    const rankNodes = byRank.get(rank) ?? []
    const rankWidth = rankNodes.reduce((sum, node, index) => {
      const box = renderNode(node)
      boxes.set(node, box)
      return sum + Math.max(...box.map((line) => Bun.stringWidth(line))) + (index === 0 ? 0 : FLOWCHART_NODE_GAP)
    }, 0)
    canvasWidth = Math.max(canvasWidth, rankWidth)
  }

  const availableWidth = Math.max(40, Math.min(FLOWCHART_MAX_CANVAS_WIDTH, input.width - 4))
  canvasWidth = Math.max(40, canvasWidth)
  const backEdges: FlowchartRoutedEdge[] = deferredEdges
    .map((edge) => ({ edge, backward: true }))
  const spanningEdges: FlowchartRoutedEdge[] = layoutEdges
    .filter((edge) => (ranks.get(edge.to) ?? 0) !== (ranks.get(edge.from) ?? 0) + 1)
    .map((edge) => ({ edge, backward: false }))
  const allRoutedEdges = [...backEdges, ...spanningEdges]
  const requestedLanePadding = allRoutedEdges.length ? 2 : 0
  const requestedRouteWidth = canvasWidth + requestedLanePadding * 2
  const canRouteEdges = requestedRouteWidth <= availableWidth
  const compactEdges = canRouteEdges ? [] : allRoutedEdges
  const routedEdges = canRouteEdges ? allRoutedEdges : []
  const directEdges = layoutEdges.filter((edge) => !routedEdges.some((routed) => routed.edge === edge))
  const cycleLanePadding = canRouteEdges ? requestedLanePadding : 0
  canvasWidth += cycleLanePadding * 2

  const rowStride = 3 + FLOWCHART_CONNECTOR_GAP
  const compactEdgesByRank = new Map<number, FlowchartRoutedEdge[]>()
  for (const routed of compactEdges) {
    const rank = ranks.get(routed.edge.from) ?? 0
    compactEdgesByRank.set(rank, [...(compactEdgesByRank.get(rank) ?? []), routed])
  }
  const routedRanks = new Set(routedEdges.map(({ edge }) => ranks.get(edge.from) ?? 0))
  const extraRowsByRank = new Map<number, number>()
  for (const [rank, edges] of compactEdgesByRank) {
    extraRowsByRank.set(rank, edges.length + (routedRanks.has(rank) ? 2 : 0))
  }
  for (const rank of routedRanks) {
    extraRowsByRank.set(rank, Math.max(extraRowsByRank.get(rank) ?? 0, 2))
  }
  const rankOffsets = new Map<number, number>()
  let rankOffset = 0
  for (let rank = 0; rank <= maxRank; rank++) {
    rankOffsets.set(rank, rankOffset)
    rankOffset += extraRowsByRank.get(rank) ?? 0
  }
  const rankTop = (rank: number) => rank * rowStride + (rankOffsets.get(rank) ?? 0)
  const rowCount = (maxRank + 1) * rowStride + rankOffset + 2
  assertCanvas(canvasWidth, rowCount)
  const rows = Array.from({ length: rowCount }, () => Array.from({ length: canvasWidth }, () => " "))
  const connectorCells = Array.from({ length: rowCount }, () =>
    Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()),
  )
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const rankBounds = new Map<number, { left: number; right: number }>()

  for (let rank = 0; rank <= maxRank; rank++) {
    const rankNodes = byRank.get(rank) ?? []
    const rankWidth = rankNodes.reduce(
      (sum, node, index) => sum + (boxes.get(node)?.[0]! ? Bun.stringWidth(boxes.get(node)![0]!) : 0) + (index === 0 ? 0 : FLOWCHART_NODE_GAP),
      0,
    )
    let column =
      rankNodes.length === 1
        ? Math.floor(canvasWidth / 2) - Math.floor(rankWidth / 2)
        : Math.floor((canvasWidth - rankWidth) / 2)
    const top = rankTop(rank)
    for (const node of rankNodes) {
      const box = boxes.get(node) ?? renderNode(node)
      const nodeWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
      for (const [index, line] of box.entries()) {
        writeVisual(rows[top + index]!, column, padVisual(line, nodeWidth))
        for (let boxColumn = 0; boxColumn < nodeWidth; boxColumn++) {
          boxCells.add((top + index) * canvasWidth + column + boxColumn)
        }
      }
      layoutNodes.set(node, {
        rank,
        center: column + Math.floor(nodeWidth / 2),
      })
      const currentBounds = rankBounds.get(rank)
      rankBounds.set(rank, {
        left: Math.min(currentBounds?.left ?? column, column),
        right: Math.max(currentBounds?.right ?? column + nodeWidth - 1, column + nodeWidth - 1),
      })
      column += nodeWidth + FLOWCHART_NODE_GAP
    }
  }

  for (const edge of directEdges) {
    const from = layoutNodes.get(edge.from)
    const to = layoutNodes.get(edge.to)
    if (!from || !to || to.rank !== from.rank + 1) return undefined

    const connectorTop = rankTop(from.rank) + 3
    const horizontalRow = connectorTop + 1
    const labelRow = connectorTop + 2
    const targetAnchorRow = rankTop(to.rank) - 1
    drawVerticalConnector(connectorCells, from.center, connectorTop, horizontalRow)
    drawHorizontalConnector(connectorCells, horizontalRow, from.center, to.center)
    drawVerticalConnector(connectorCells, to.center, horizontalRow, targetAnchorRow)

    const targetArrow = input.direction === "bt" ? "▲" : "▼"
    const arrowRowForEdge = input.direction === "bt" ? connectorTop : targetAnchorRow
    putOverlay(overlays, canvasWidth, arrowRowForEdge, input.direction === "bt" ? from.center : to.center, targetArrow)

    const label = cleanConnectorLabel(edge.label)
    if (!label) continue
    const labelWidth = Bun.stringWidth(label)
    const leftLabelStart = to.center - labelWidth - 3
    const rightLabelStart = to.center + 3
    const labelStart =
      leftLabelStart >= 0
        ? leftLabelStart
        : Math.min(canvasWidth - labelWidth, Math.max(0, rightLabelStart))
    const labelEnd = labelStart + labelWidth - 1
    if (labelEnd < to.center) drawHorizontalConnector(connectorCells, labelRow, labelEnd + 2, to.center)
    else if (labelStart > to.center) drawHorizontalConnector(connectorCells, labelRow, to.center, labelStart - 2)
    putOverlay(overlays, canvasWidth, labelRow, labelStart, label)
  }

  const compactEdgeOffsets = new Map<number, number>()
  for (const routed of compactEdges) {
    const from = layoutNodes.get(routed.edge.from)
    if (!from) continue

    const rank = ranks.get(routed.edge.from) ?? from.rank
    const compactIndex = compactEdgeOffsets.get(rank) ?? 0
    compactEdgeOffsets.set(rank, compactIndex + 1)
    const labelRow = rankTop(rank) + 3 + FLOWCHART_CONNECTOR_GAP + compactIndex
    const edgeLabel = cleanConnectorLabel(routed.edge.label)
    const targetLabel = cleanLabel(input.labels.get(routed.edge.to) ?? routed.edge.to)
    const text = edgeLabel ? `${edgeLabel} ${targetLabel}` : targetLabel
    const textWidth = Bun.stringWidth(text)
    const rightStart = from.center + 3
    const leftStart = from.center - textWidth - 3
    const labelStart =
      rightStart + textWidth <= canvasWidth
        ? rightStart
        : Math.max(0, Math.min(canvasWidth - textWidth, leftStart))
    const labelEnd = labelStart + textWidth - 1
    const sourceRow = rankTop(rank) + 3
    drawVerticalConnector(connectorCells, from.center, sourceRow, labelRow)
    if (labelStart > from.center) drawHorizontalConnector(connectorCells, labelRow, from.center, labelStart - 2)
    else if (labelEnd < from.center) drawHorizontalConnector(connectorCells, labelRow, labelEnd + 2, from.center)
    putOverlay(overlays, canvasWidth, labelRow, labelStart, text)
  }

  let leftLaneIndex = 0
  let rightLaneIndex = 0
  for (const [edgeIndex, routed] of routedEdges.entries()) {
    const edge = routed.edge
    const from = layoutNodes.get(edge.from)
    const to = layoutNodes.get(edge.to)
    const label = cleanConnectorLabel(edge.label)
    if (!from || !to) continue

    const goesLeft = from.center < to.center || (from.center === to.center && edgeIndex % 2 === 0)
    const rankNodes = byRank.get(from.rank) ?? []
    const sourceIndex = rankNodes.indexOf(edge.from)
    const sourceWidth = Math.max(...(boxes.get(edge.from) ?? []).map((line) => Bun.stringWidth(line)), 10)
    const sourceLeft = from.center - Math.floor(sourceWidth / 2)
    const sourceRight = sourceLeft + sourceWidth - 1
    const neighborNode =
      goesLeft && sourceIndex > 0
        ? rankNodes[sourceIndex - 1]!
        : !goesLeft && sourceIndex < rankNodes.length - 1
          ? rankNodes[sourceIndex + 1]!
          : undefined
    const neighbor = neighborNode ? layoutNodes.get(neighborNode) : undefined
    const neighborWidth = neighborNode
      ? Math.max(...(boxes.get(neighborNode) ?? []).map((line) => Bun.stringWidth(line)), 10)
      : 0
    const neighborLeft = neighbor ? neighbor.center - Math.floor(neighborWidth / 2) : 0
    const neighborRight = neighborLeft + neighborWidth - 1
    const gapLane = neighbor
      ? goesLeft
        ? Math.floor((neighborRight + sourceLeft) / 2)
        : Math.floor((sourceRight + neighborLeft) / 2)
      : undefined
    const sourceBounds = rankBounds.get(from.rank)
    const lane =
      gapLane ??
      (goesLeft
        ? Math.max(1, (sourceBounds?.left ?? from.center) - 3 - leftLaneIndex++ * 3)
        : Math.min(canvasWidth - 2, (sourceBounds?.right ?? from.center) + 3 + rightLaneIndex++ * 3))
    const sourceAnchorRow = rankTop(from.rank) + 3
    const sourceEscapeRow = rankTop(from.rank) + 3 + FLOWCHART_CONNECTOR_GAP
    const targetAnchorRow = routed.backward ? rankTop(to.rank) + 3 : rankTop(to.rank) - 1

    drawVerticalConnector(connectorCells, from.center, sourceAnchorRow, sourceEscapeRow)
    drawHorizontalConnector(connectorCells, sourceEscapeRow, from.center, lane)
    drawVerticalConnector(connectorCells, lane, sourceEscapeRow, targetAnchorRow)
    drawHorizontalConnector(connectorCells, targetAnchorRow, lane, to.center)
    putOverlay(
      overlays,
      canvasWidth,
      targetAnchorRow,
      to.center,
      routed.backward || input.direction === "bt" ? "▲" : "▼",
    )

    if (label) {
      const labelWidth = Bun.stringWidth(label)
      const low = Math.min(from.center, lane)
      const high = Math.max(from.center, lane)
      const labelStart = Math.max(0, Math.min(canvasWidth - labelWidth, Math.floor((low + high - labelWidth) / 2)))
      putOverlay(overlays, canvasWidth, sourceEscapeRow, labelStart, label)
    }
  }

  const rendered = rows
    .map((row, rowIndex) => {
      const rendered = row.map((character, column) => {
        const cell = rowIndex * canvasWidth + column
        if (boxCells.has(cell)) return character
        const overlay = overlays.get(rowIndex * canvasWidth + column)
        if (overlay) return overlay
        const directions = connectorCells[rowIndex]!?.[column]!
        return character === " " && directions?.size ? connectorGlyph(directions) : character
      })
      return rendered.join("").trimEnd()
    })
    .join("\n")

  return rendered
}

function flowchartOutputFits(input: string, width: number) {
  return Math.max(...input.split("\n").map((line) => Bun.stringWidth(line)), 0) <= Math.max(40, width)
}

function renderCompactRankedVerticalFlowchart(input: {
  edges: FlowchartEdge[]
  labels: Map<string, string>
  shapes?: Map<string, FlowchartNodeShape> | undefined
  nodes?: string[] | undefined
  direction: "td" | "tb" | "bt"
  width: number
  renderNode?: (node: string) => string[]
}) {
  const orientedEdges =
    input.direction === "bt"
      ? input.edges.map((edge) => ({ from: edge.to, to: edge.from, label: edge.label }))
      : input.edges
  const nodes = [...new Set([...(input.nodes ?? []), ...orientedEdges.flatMap((edge) => [edge.from, edge.to])])]
  if (nodes.length === 0 || nodes.length > FLOWCHART_MAX_LAYOUT_NODES) return undefined

  const { layoutEdges, deferredEdges } = flowchartLayoutEdges(nodes, orientedEdges)
  const ranks = flowchartRanks(nodes, layoutEdges)
  if (!ranks) return undefined
  const maxRank = Math.max(...nodes.map((node) => ranks.get(node) ?? 0))
  if (maxRank >= FLOWCHART_MAX_LAYOUT_RANKS) return undefined

  const byRank = new Map<number, string[]>()
  for (const node of nodes) {
    const rank = ranks.get(node) ?? 0
    byRank.set(rank, [...(byRank.get(rank) ?? []), node])
  }

  const incoming = new Map<string, FlowchartEdge[]>()
  for (const edge of orientedEdges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge])

  const orderByNode = new Map<string, number>()
  for (let rank = 0; rank <= maxRank; rank++) {
    const current = byRank.get(rank) ?? []
    if (rank > 0) {
      const previous = new Map((byRank.get(rank - 1) ?? []).map((node, index) => [node, index]))
      current.sort((left, right) => {
        const leftParents = incoming.get(left) ?? []
        const rightParents = incoming.get(right) ?? []
        const leftCenter = leftParents.length
          ? leftParents.reduce((sum, edge) => sum + (previous.get(edge.from) ?? 0), 0) / leftParents.length
          : Number.POSITIVE_INFINITY
        const rightCenter = rightParents.length
          ? rightParents.reduce((sum, edge) => sum + (previous.get(edge.from) ?? 0), 0) / rightParents.length
          : Number.POSITIVE_INFINITY
        return leftCenter - rightCenter || (orderByNode.get(left) ?? 0) - (orderByNode.get(right) ?? 0)
      })
    }
    current.forEach((node, index) => orderByNode.set(node, index))
  }

  const availableWidth = Math.max(40, Math.min(FLOWCHART_MAX_CANVAS_WIDTH, input.width - 4))
  const boxes = new Map<string, string[]>()
  const boxWidths = new Map<string, number>()
  const renderNode =
    input.renderNode ?? ((node: string) => renderFlowchartBox(input.labels.get(node) ?? node, input.shapes?.get(node)))
  for (const node of nodes) {
    const box = renderNode(node)
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    if (boxWidth > availableWidth) return undefined
    boxes.set(node, box)
    boxWidths.set(node, boxWidth)
  }

  const groups: Array<{ rank: number; nodes: string[]; width: number }> = []
  for (let rank = 0; rank <= maxRank; rank++) {
    let current: string[] = []
    let currentWidth = 0
    for (const node of byRank.get(rank) ?? []) {
      const nodeWidth = boxWidths.get(node) ?? 0
      const nextWidth = current.length ? currentWidth + FLOWCHART_NODE_GAP + nodeWidth : nodeWidth
      if (current.length > 0 && nextWidth > availableWidth) {
        groups.push({ rank, nodes: current, width: currentWidth })
        current = []
        currentWidth = 0
      }
      current.push(node)
      currentWidth = current.length === 1 ? nodeWidth : currentWidth + FLOWCHART_NODE_GAP + nodeWidth
    }
    if (current.length > 0) groups.push({ rank, nodes: current, width: currentWidth })
  }

  if (groups.length === 0) return undefined
  const output: string[] = []
  let previousRank = -1
  for (const group of groups) {
    if (previousRank >= 0) {
      if (group.rank !== previousRank) output.push("│", input.direction === "bt" ? "▲" : "▼")
      else output.push("")
    }
    previousRank = group.rank

    for (const node of group.nodes) {
      for (const edge of incoming.get(node) ?? []) {
        const label = cleanConnectorLabel(edge.label)
        if (label) output.push(`${label} ─▶`)
      }
    }

    const rows = Array.from({ length: 3 }, () => blankRow(group.width))
    let column = 0
    for (const node of group.nodes) {
      const box = boxes.get(node) ?? renderNode(node)
      const nodeWidth = boxWidths.get(node) ?? group.width
      for (const [index, line] of box.entries()) writeVisual(rows[index]!, column, padVisual(line, nodeWidth))
      column += nodeWidth + FLOWCHART_NODE_GAP
    }
    output.push(...rows.map((row) => row.join("").trimEnd()))
  }

  const deferred = deferredEdges.flatMap((edge) => {
    const label = cleanConnectorLabel(edge.label)
    const to = cleanLabel(input.labels.get(edge.to) ?? edge.to)
    const span = (ranks.get(edge.from) ?? 0) - (ranks.get(edge.to) ?? 0)
    const text = span > 1 ? `└─ ${label ? `${label} ` : ""}${to}` : `${label ? `${label} ` : ""}${to} ──┘`
    return wrapTextLine("", text, availableWidth)
  })
  if (deferred.length > 0) output.push("", ...deferred)
  return output.join("\n")
}

export function renderStateDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  if (!/^stateDiagram(?:-v2)?$/i.test(lines[0]! ?? "")) return undefined

  const aliases = new Map<string, string>()
  const transitions: FlowchartEdge[] = []
  const knownStates = new Set<string>()
  const containers: string[] = []
  const groups = new Map<string, string>()
  const fields = new Map<string, string[]>()
  let noteState: string | undefined
  const touch = (id: string) => {
    knownStates.add(id)
    if (containers.length) groups.set(id, containers.join(" / "))
  }
  const markerKinds = new Map<string, "start" | "end">()
  let markerIndex = 0
  let direction: "td" | "bt" | "lr" | "rl" = "td"

  for (const line of lines.slice(1)) {
    if (line.startsWith("%%") || /^(?:classDef|class|style)\b/i.test(line)) continue
    if (noteState) {
      if (/^end note$/i.test(line)) noteState = undefined
      else fields.set(noteState, [...(fields.get(noteState) ?? []), cleanMermaidLabel(line)])
      continue
    }
    const note = /^note\s+(?:left|right)\s+of\s+([\w.-]+)(?:\s*:\s*(.+))?$/i.exec(line)
    if (note) {
      touch(note[1]!)
      if (note[2]) fields.set(note[1]!, [...(fields.get(note[1]!) ?? []), `Note: ${cleanMermaidLabel(note[2])}`])
      else noteState = note[1]!
      continue
    }
    const directionLine = /^direction\s+(TD|TB|BT|LR|RL)$/i.exec(line)
    if (directionLine) {
      const parsedDirection = directionLine[1]!.toLowerCase()
      direction = parsedDirection === "tb" ? "td" : (parsedDirection as "td" | "bt" | "lr" | "rl")
      continue
    }
    if (line === "}") {
      containers.pop()
      continue
    }

    const composite = /^state\s+(?:"([^"]+)"\s+as\s+)?([A-Za-z_][\w.:-]*)\s*\{$/i.exec(line)
    if (composite) {
      const id = composite[2]!
      aliases.set(id, cleanMermaidLabel(composite[1]) || id)
      containers.push(aliases.get(id)!)
      continue
    }

    const stateAlias = /^state\s+"([^"]+)"\s+as\s+([A-Za-z][\w-]*)$/i.exec(line)
    if (stateAlias) {
      aliases.set(stateAlias[2]!, cleanMermaidLabel(stateAlias[1]!))
      touch(stateAlias[2]!)
      continue
    }

    const stereotype = /^state\s+([A-Za-z_][\w.:-]*)\s+<<(fork|join|choice)>>$/i.exec(line)
    if (stereotype) {
      touch(stereotype[1]!)
      aliases.set(stereotype[1]!, `${stereotype[2]!.toLowerCase()} · ${stereotype[1]!}`)
      continue
    }

    const transition = /^(\[\*\]|[A-Za-z_][\w.:-]*)\s*-->\s*(\[\*\]|[A-Za-z_][\w.:-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (!transition) {
      const description = /^([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(line)
      if (description) {
        touch(description[1]!)
        fields.set(description[1]!, [...(fields.get(description[1]!) ?? []), cleanMermaidLabel(description[2])])
        continue
      }
      if (line === "--") continue
      return undefined
    }
    const from = transition[1]! === "[*]" ? `__state_start_${markerIndex++}` : transition[1]!
    const to = transition[2]! === "[*]" ? `__state_end_${markerIndex++}` : transition[2]!
    if (transition[1]! === "[*]") markerKinds.set(from, "start")
    if (transition[2]! === "[*]") markerKinds.set(to, "end")
    touch(from)
    touch(to)
    transitions.push({
      from,
      to,
      label: cleanMermaidLabel(transition[3]!) || undefined,
    })
  }

  if (noteState || containers.length || (transitions.length === 0 && knownStates.size === 0)) return undefined
  const labels = new Map<string, string>()
  for (const state of knownStates) labels.set(state, aliases.get(state) ?? state)
  if (groups.size || fields.size) {
    const nodes = [...knownStates].map((id) => ({ id, label: markerKinds.get(id) === "start" ? "●" : markerKinds.get(id) === "end" ? "◉" : labels.get(id)!, ...(groups.has(id) ? { group: groups.get(id)! } : {}), ...(fields.has(id) ? { fields: fields.get(id)! } : {}) }))
    const edges = transitions.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) }))
    return sceneText(direction === "lr" || direction === "rl" ? horizontalScene(nodes, edges, width, direction === "rl") : graphScene(direction === "bt" ? nodes.reverse() : nodes, edges, width))
  }
  const renderNode = (state: string) => {
    const marker = markerKinds.get(state)
    if (marker) return [" ", marker === "start" ? "●" : "◉", " "]
    return renderStateBox(labels.get(state) ?? state)
  }
  if (direction === "lr" || direction === "rl") {
    const outgoing = new Map<string, FlowchartEdge[]>()
    const incoming = new Set<string>()
    for (const edge of transitions) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
      incoming.add(edge.to)
    }
    const starts = [...knownStates].filter((state) => !incoming.has(state))
    const paths: Array<{ nodes: string[]; edges: FlowchartEdge[] }> = []
    let work = 0
    const walk = (state: string, pathNodes: string[], pathEdges: FlowchartEdge[], seen: Set<string>) => {
      if (++work > 512) throw new Error("layout budget")
      const next = outgoing.get(state) ?? []
      if (next.length === 0) {
        paths.push({ nodes: pathNodes, edges: pathEdges })
        return
      }
      for (const edge of next) {
        if (seen.has(edge.to)) {
          paths.push({ nodes: [...pathNodes, edge.to], edges: [...pathEdges, edge] })
          continue
        }
        walk(edge.to, [...pathNodes, edge.to], [...pathEdges, edge], new Set([...seen, edge.to]))
      }
    }
    for (const start of starts.length > 0 ? starts : [...knownStates].slice(0, 1)) walk(start, [start], [], new Set([start]))
    if (paths.length > 32) return undefined
    const rendered = paths.flatMap((path, pathIndex) => {
      const orderedNodes = direction === "rl" ? [...path.nodes].reverse() : path.nodes
      const orderedEdges = direction === "rl" ? [...path.edges].reverse() : path.edges
      const blocks = orderedNodes.map(renderNode)
      const rows = ["", "", ""]
      blocks.forEach((block, index) => {
        const blockWidth = Math.max(...block.map((line) => Bun.stringWidth(line)))
        for (let row = 0; row < 3; row++) rows[row]! += padVisual(block[row]! ?? "", blockWidth)
        const edge = orderedEdges[index]!
        if (!edge) return
        const label = cleanConnectorLabel(edge.label)
        const gap = Math.max(8, Bun.stringWidth(label) + 2)
        rows[0]! += centerVisual(label, gap)
        rows[1]! += centerVisual(direction === "rl" ? "◀────" : "────▶", gap)
        rows[2]! += " ".repeat(gap)
      })
      return pathIndex === 0 ? rows : ["", ...rows]
    })
    return rendered.join("\n")
  }
  const ranked = renderRankedVerticalFlowchart({
    edges: transitions,
    labels,
    nodes: [...knownStates],
    direction,
    width,
    renderNode,
  })
  if (ranked && flowchartOutputFits(ranked, width)) return ranked
  return renderCompactRankedVerticalFlowchart({
    edges: transitions,
    labels,
    nodes: [...knownStates],
    direction,
    width,
    renderNode,
  })
}
