import { assertCanvas } from "./core"
import { graphScene } from "./graph-scene"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidLines, cleanMermaidLabel, renderEntityBox, renderBox, blankRow, writeVisual, putOverlay, drawHorizontalConnector, drawVerticalConnector, connectorGlyph } from "./legacy-shared"
import type { ConnectorDirection } from "./legacy-shared"

type ErRelation = { from: string; to: string; relation: string; label: string; dotted: boolean }

export function renderErDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  if (lines[0]!?.toLowerCase() !== "erdiagram") return undefined

  const relationDefinitions: ErRelation[] = []
  const attributes = new Map<string, string[]>()
  let currentEntity: string | undefined

  for (const line of lines.slice(1)) {
    const entity = /^([A-Za-z_][\w.-]*)\s*\{$/.exec(line)
    if (entity) {
      currentEntity = entity[1]!
      attributes.set(currentEntity, [])
      continue
    }

    if (line === "}") {
      currentEntity = undefined
      continue
    }

    if (currentEntity) {
      attributes.set(currentEntity, [...(attributes.get(currentEntity) ?? []), cleanMermaidLabel(line)])
      continue
    }

    const relation = /^([A-Za-z_][\w.-]*)\s+([|o}{]{1,2}(?:--|\.\.)[|o}{]{1,2})\s+([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!relation) {
      if (/^(?:direction|classDef|class|style)\b/.test(line)) continue
      return undefined
    }
    relationDefinitions.push({
      from: relation[1]!,
      to: relation[3]!,
      relation: relation[2]!,
      label: cleanMermaidLabel(relation[4]!),
      dotted: relation[2]!.includes(".."),
    })
  }

  if (currentEntity || (relationDefinitions.length === 0 && attributes.size === 0)) return undefined
  if (relationDefinitions.length > 0) {
    const entityOrder = [...new Set([
      ...relationDefinitions.flatMap((relation) => [relation.from, relation.to]),
      ...attributes.keys(),
    ])]
    const incoming = new Map(entityOrder.map((entity) => [entity, 0]))
    const outgoing = new Map(entityOrder.map((entity) => [entity, [] as string[]]))
    for (const relation of relationDefinitions) {
      incoming.set(relation.to, (incoming.get(relation.to) ?? 0) + 1)
      outgoing.set(relation.from, [...(outgoing.get(relation.from) ?? []), relation.to])
    }
    const ranks = new Map(entityOrder.map((entity) => [entity, 0]))
    const remainingIncoming = new Map(incoming)
    const queue = entityOrder.filter((entity) => remainingIncoming.get(entity) === 0)
    for (let index = 0; index < queue.length; index++) {
      const entity = queue[index]!
      for (const target of outgoing.get(entity) ?? []) {
        ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(entity) ?? 0) + 1))
        remainingIncoming.set(target, (remainingIncoming.get(target) ?? 1) - 1)
        if (remainingIncoming.get(target) === 0) queue.push(target)
      }
    }
    const maxResolvedRank = Math.max(...ranks.values(), 0)
    for (const entity of entityOrder) {
      if ((remainingIncoming.get(entity) ?? 0) > 0 && (ranks.get(entity) ?? 0) === 0 && incoming.get(entity)) {
        ranks.set(entity, maxResolvedRank + 1)
      }
    }

    const boxes = new Map(entityOrder.map((entity) => [entity, renderEntityBox(entity, attributes.get(entity) ?? [])]))
    const rankGroups = new Map<number, string[]>()
    for (const entity of entityOrder) {
      const rank = ranks.get(entity) ?? 0
      rankGroups.set(rank, [...(rankGroups.get(rank) ?? []), entity])
    }
    const orderedRanks = [...rankGroups.keys()].sort((a, b) => a - b)
    const horizontalGap = Math.max(16, Math.min(26, Math.floor(width / 4)), ...relationDefinitions.map((relation) => Bun.stringWidth(relation.label) + 6))
    const verticalGap = 5
    const columnLeft = new Map<number, number>()
    const columnWidth = new Map<number, number>()
    let canvasWidth = 0
    for (const rank of orderedRanks) {
      const rankWidth = Math.max(...(rankGroups.get(rank) ?? []).map((entity) => Bun.stringWidth(boxes.get(entity)?.[0]! ?? "")), 10)
      columnLeft.set(rank, canvasWidth)
      columnWidth.set(rank, rankWidth)
      canvasWidth += rankWidth + horizontalGap
    }
    canvasWidth = Math.max(40, canvasWidth - horizontalGap)
    if (canvasWidth > width) {
      const result = graphScene(entityOrder.map((entity) => ({ id: entity, label: entity, fields: attributes.get(entity) ?? [] })), relationDefinitions.map((relation) => ({ from: relation.from, to: relation.to, label: `${relation.relation} · ${relation.label}`, dashed: relation.dotted })), width)
      if (!("lines" in result)) throw new Error(result.note)
      return ["ER diagram", ...result.lines.map((line) => line.map((span) => span.text).join(""))].join("\n")
    }
    const positions = new Map<string, { left: number; right: number; top: number; bottom: number; centerRow: number }>()
    const firstRowHeight = Math.max(...entityOrder.map((entity) => boxes.get(entity)?.length ?? 3), 3)
    let canvasHeight = 1
    for (const rank of orderedRanks) {
      let top = 0
      const leftBase = columnLeft.get(rank) ?? 0
      const rankWidth = columnWidth.get(rank) ?? 10
      for (const [entityIndex, entity] of (rankGroups.get(rank) ?? []).entries()) {
        const box = boxes.get(entity) ?? renderBox(entity)
        if (entityIndex === 0) top = Math.floor(firstRowHeight / 2) - Math.floor(box.length / 2)
        const boxWidth = Bun.stringWidth(box[0]! ?? "")
        const left = leftBase + Math.floor((rankWidth - boxWidth) / 2)
        positions.set(entity, { left, right: left + boxWidth - 1, top, bottom: top + box.length - 1, centerRow: top + Math.floor(box.length / 2) })
        top += box.length + verticalGap
      }
      canvasHeight = Math.max(canvasHeight, top - verticalGap)
    }
    canvasHeight += relationDefinitions.length * 2 + 2
    assertCanvas(canvasWidth, canvasHeight)
    const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
    const boxCells = new Set<number>()
    for (const entity of entityOrder) {
      const position = positions.get(entity)
      const box = boxes.get(entity)
      if (!position || !box) continue
      box.forEach((line, offset) => {
        writeVisual(canvas[position.top + offset]!, position.left, line)
        for (let column = position.left; column <= position.right; column++) boxCells.add((position.top + offset) * canvasWidth + column)
      })
    }
    const connectors = Array.from({ length: canvasHeight }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
    const overlays = new Map<number, string>()
    const dottedCells = new Set<number>()
    const markDottedHorizontal = (row: number, start: number, end: number) => {
      for (let column = Math.min(start, end); column <= Math.max(start, end); column++) dottedCells.add(row * canvasWidth + column)
    }
    const markDottedVertical = (column: number, start: number, end: number) => {
      for (let row = Math.min(start, end); row <= Math.max(start, end); row++) dottedCells.add(row * canvasWidth + column)
    }
    relationDefinitions.slice(0).forEach((relation, index) => {
      const from = positions.get(relation.from)
      const to = positions.get(relation.to)
      if (!from || !to) return
      const cardinality = /^([|o}{]{1,2})(--|\.\.)([|o}{]{1,2})$/.exec(relation.relation)
      const fromMark = cardinality?.[1]! ?? ""
      const toMark = cardinality?.[3]! ?? ""
      const fromColumn = from.right + 1
      const toColumn = to.left - 1
      const forward = fromColumn < toColumn
      const sourceMarkStart = forward ? fromColumn : from.left - Bun.stringWidth(fromMark)
      const targetMarkStart = forward ? toColumn - Bun.stringWidth(toMark) + 1 : to.right + 1
      putOverlay(overlays, canvasWidth, from.centerRow, sourceMarkStart, fromMark)
      putOverlay(overlays, canvasWidth, to.centerRow, targetMarkStart, toMark)
      const sourceRouteColumn = forward ? sourceMarkStart + Bun.stringWidth(fromMark) : sourceMarkStart - 1
      const targetRouteColumn = forward ? targetMarkStart - 1 : targetMarkStart + Bun.stringWidth(toMark)
      if (from.centerRow === to.centerRow) {
        drawHorizontalConnector(connectors, from.centerRow, sourceRouteColumn, targetRouteColumn)
        if (relation.dotted) markDottedHorizontal(from.centerRow, sourceRouteColumn, targetRouteColumn)
        const labelColumn = Math.floor((sourceRouteColumn + targetRouteColumn - Bun.stringWidth(relation.label)) / 2)
        putOverlay(overlays, canvasWidth, Math.max(0, from.centerRow - 1), labelColumn, relation.label)
      } else {
        const laneRow = Math.min(canvasHeight - 1, Math.max(from.bottom, to.bottom) + 2 + index * 2)
        drawVerticalConnector(connectors, sourceRouteColumn, from.centerRow, laneRow)
        drawHorizontalConnector(connectors, laneRow, sourceRouteColumn, targetRouteColumn)
        drawVerticalConnector(connectors, targetRouteColumn, laneRow, to.centerRow)
        if (relation.dotted) {
          markDottedVertical(sourceRouteColumn, from.centerRow, laneRow)
          markDottedHorizontal(laneRow, sourceRouteColumn, targetRouteColumn)
          markDottedVertical(targetRouteColumn, laneRow, to.centerRow)
        }
        putOverlay(overlays, canvasWidth, Math.max(0, laneRow - 1), Math.max(0, Math.min(canvasWidth - Bun.stringWidth(relation.label), Math.floor((sourceRouteColumn + targetRouteColumn - Bun.stringWidth(relation.label)) / 2))), relation.label)
      }
    })
    const rendered = canvas.map((row, rowIndex) => row.map((character, column) => {
      const cell = rowIndex * canvasWidth + column
      const overlay = overlays.get(cell)
      if (overlay) return overlay
      const directions = connectors[rowIndex]!?.[column]!
      if (!boxCells.has(cell) && directions?.size) return dottedCells.has(cell) ? "╌" : connectorGlyph(directions)
      return character
    }).join("").trimEnd())
    while (rendered.at(-1) === "") rendered.pop()
    return rendered.join("\n")
  }

  const renderedAttributes = [...attributes.entries()].flatMap(([entity, fields], index) => {
    const lines = renderEntityBox(entity, fields)
    return index === 0 ? lines : ["", ...lines]
  })

  return renderedAttributes.join("\n")
}
