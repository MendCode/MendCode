// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { registerChart } from "../chart-picture"
import type { CellTint, PlotPicture } from "./xychart"
import { preparedMermaidSourceLines, cleanMermaidLabel, splitMermaidTopLevel, blankRow, placeLabel, padVisual } from "./legacy-shared"

type RadarCurve = { id: string; label: string; values: string[] }

/** One colour per curve, in the order the curves are written (the pie's order of colours). */
const CURVE_COLORS = ["info", "warning", "success", "synType", "error", "accent", "primary", "secondary"] as const

export function renderRadarDiagram(input: string): string | { text: string; picture?: PlotPicture; tint?: CellTint[] } | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^radar-beta$/i.test(lines[0]!?.trim() ?? "")) return undefined
  let title = "Radar"
  let min = "0"
  let max = "auto"
  const axes: Array<{ id: string; label: string }> = []
  const curves: RadarCurve[] = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]!) || title
      continue
    }
    const minMatch = /^min\s+(.+)$/i.exec(line)
    if (minMatch) {
      min = cleanMermaidLabel(minMatch[1]!)
      continue
    }
    const maxMatch = /^max\s+(.+)$/i.exec(line)
    if (maxMatch) {
      max = cleanMermaidLabel(maxMatch[1]!)
      continue
    }
    if (/^(?:showLegend|graticule|ticks)\b/i.test(line)) continue
    const axis = /^axis\s+(.+)$/i.exec(line)
    if (axis) {
      for (const token of splitMermaidTopLevel(axis[1]!, ",")) {
        const labeled = /^([A-Za-z_][\w-]*)\s*\[\s*\"?(.+?)\"?\s*\]$/.exec(token)
        const id = cleanMermaidLabel(labeled?.[1]! || token)
        axes.push({ id, label: cleanMermaidLabel(labeled?.[2]! || labeled?.[1]! || token) })
      }
      continue
    }
    const curve = /^curve\s+(.+)$/i.exec(line)
    if (curve) {
      for (const match of curve[1]!.matchAll(/([A-Za-z_][\w-]*)(?:\s*\[\s*\"?([^\]]+?)\"?\s*\])?\s*\{([^}]*)\}/g)) {
        const id = match[1]!
        const label = cleanMermaidLabel(match[2]! || id)
        const values = splitMermaidTopLevel(match[3]!, ",").map(cleanMermaidLabel)
        curves.push({ id, label, values })
      }
    }
  }
  if (axes.length === 0 || curves.length === 0) return undefined
  if (curves.some((curve) => curve.values.some((value) => !/^(?:[A-Za-z_][\w-]*\s*:\s*)?-?\d+(?:\.\d+)?$/.test(value)))) return undefined
  if (!Number.isFinite(Number(min)) || (max !== "auto" && !Number.isFinite(Number(max)))) return undefined
  const valuesForCurve = (curve: RadarCurve) => {
    const keyed = new Map<string, number>()
    for (const value of curve.values) {
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)$/.exec(value)
      if (pair) keyed.set(pair[1]!, Number(pair[2]!))
    }
    if (keyed.size > 0) return axes.map((axis) => keyed.get(axis.id) ?? 0)
    return axes.map((_, index) => Number(curve.values[index]!) || 0)
  }
  const resolvedCurves = curves.map((curve) => ({ ...curve, numericValues: valuesForCurve(curve) }))
  const numericValues = resolvedCurves.flatMap((curve) => curve.numericValues.filter(Number.isFinite))
  const minimum = Number.isFinite(Number(min)) ? Number(min) : 0
  const maximum = Number.isFinite(Number(max)) ? Number(max) : Math.max(...numericValues, minimum + 1)
  const span = Math.max(1, maximum - minimum)
  const legend = resolvedCurves.map((curve, index) => `${["●", "○", "◆", "◇"][index % 4]!} ${curve.label}`).join("  ")
  const colorOf = (index: number) => CURVE_COLORS[index % CURVE_COLORS.length]!
  if (axes.length === 2) {
    const halfWidth = 22
    const axisWidth = halfWidth * 2 + 1
    const rows = resolvedCurves.map((curve, curveIndex) => {
      const row = blankRow(axisWidth)
      const left = Math.max(0, Math.min(halfWidth, Math.round(((curve.numericValues[0]! ?? minimum) - minimum) / span * halfWidth)))
      const right = Math.max(0, Math.min(halfWidth, Math.round(((curve.numericValues[1]! ?? minimum) - minimum) / span * halfWidth)))
      for (let column = halfWidth - left; column <= halfWidth + right; column++) row[column]! = curveIndex === 0 ? "─" : "·"
      row[halfWidth]! = "┼"
      row[halfWidth - left]! = curveIndex === 0 ? "●" : "○"
      row[halfWidth + right]! = curveIndex === 0 ? "●" : "○"
      return `${padVisual(curve.label, Math.max(10, ...resolvedCurves.map((item) => Bun.stringWidth(item.label) + 2)))}${row.join("")}`
    })
    return [
      title,
      `Scale ${minimum}–${maximum} · two opposing axes`,
      `${axes[0]!?.label ?? "axis 1"}${" ".repeat(Math.max(3, axisWidth - Bun.stringWidth(axes[0]!?.label ?? "") - Bun.stringWidth(axes[1]!?.label ?? "")))}${axes[1]!?.label ?? "axis 2"}`,
      ...rows,
    ].join("\n")
  }
  const canvasWidth = 64
  const canvasHeight = 25
  const centerX = Math.floor(canvasWidth / 2)
  const centerY = Math.floor(canvasHeight / 2)
  const radiusX = 20
  const radiusY = 8
  const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
  const line = (fromX: number, fromY: number, toX: number, toY: number, glyph: string) => {
    const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1)
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(fromX + (toX - fromX) * step / steps)
      const y = Math.round(fromY + (toY - fromY) * step / steps)
      if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight) continue
      if (canvas[y]![x]! === " " || canvas[y]![x]! === "·") canvas[y]![x]! = glyph
    }
  }
  const pointsAt = (values: number[], scale = 1) => axes.map((_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    const ratio = Math.max(0, Math.min(1, ((values[index]! ?? minimum) - minimum) / span)) * scale
    return { x: Math.round(centerX + Math.cos(angle) * radiusX * ratio), y: Math.round(centerY + Math.sin(angle) * radiusY * ratio) }
  })
  const outer = pointsAt(axes.map(() => maximum))
  const rings = [0.5, 1].map((scale) => pointsAt(axes.map(() => maximum), scale))
  const axisLabels: Array<{ row: number; column: number; label: string }> = []
  for (let index = 0; index < axes.length; index++) {
    const point = outer[index]!
    line(centerX, centerY, point.x, point.y, "·")
    for (const ring of rings) {
      const next = ring[(index + 1) % ring.length]!
      line(ring[index]!.x, ring[index]!.y, next.x, next.y, "·")
    }
    const axis = axes[index]! ?? { id: "axis", label: "axis" }
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    const labelX = Math.round(centerX + Math.cos(angle) * (radiusX + 5))
    const labelY = Math.round(centerY + Math.sin(angle) * (radiusY + 2))
    const labelWidth = Bun.stringWidth(axis.label)
    // A label beside the web stands clear of it (two cells), so the web's box holds no letters; one above or below is centred on its axis.
    const centred = labelX - Math.floor(labelWidth / 2)
    const beside = Math.cos(angle) > 0.3 ? Math.max(centred, centerX + radiusX + 3) : Math.cos(angle) < -0.3 ? Math.min(centred, centerX - radiusX - 2 - labelWidth) : centred
    axisLabels.push({
      row: Math.max(0, Math.min(canvasHeight - 1, labelY)),
      column: Math.max(0, Math.min(canvasWidth - labelWidth, beside)),
      label: axis.label,
    })
  }
  const curveMarkers = ["●", "○", "◆", "◇"]
  resolvedCurves.forEach((curve, curveIndex) => {
    const points = pointsAt(curve.numericValues)
    const marker = curveMarkers[curveIndex % curveMarkers.length]! ?? "●"
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!
      const next = points[(index + 1) % points.length]!
      const deltaX = next.x - point.x
      const deltaY = next.y - point.y
      const glyph = curveIndex % 2 === 1 ? "·" : Math.abs(deltaX) > Math.abs(deltaY) * 2 ? "─" : Math.abs(deltaY) > Math.abs(deltaX) * 2 ? "│" : deltaX * deltaY > 0 ? "╲" : "╱"
      line(point.x, point.y, next.x, next.y, glyph)
      canvas[point.y]![point.x]! = marker
    }
  })
  for (const label of axisLabels) placeLabel(canvas, label.column, label.row, label.label)
  const scale = `Scale ${minimum}–${maximum} · `
  const text = [title, `${scale}${legend}`, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
  // The web's box, one cell past the outer ring on every side. A label that reaches into it (a long one at the left edge) keeps the
  // chart as text: a picture there would cut the label.
  const box = { col: centerX - radiusX - 1, cols: radiusX * 2 + 3, row: centerY - radiusY - 1, rows: radiusY * 2 + 3 }
  const inBox = (label: { row: number; column: number; label: string }) => label.row >= box.row && label.row < box.row + box.rows && label.column < box.col + box.cols && label.column + Bun.stringWidth(label.label) > box.col
  // The legend's marks take their curve's colour, the one the picture draws it in.
  let cursor = Bun.stringWidth(scale)
  const tint = resolvedCurves.map((curve, index) => {
    const mark = { row: 1, col: cursor, cols: 1, fg: colorOf(index) }
    cursor += 2 + Bun.stringWidth(curve.label) + 2
    return mark
  })
  if (axisLabels.some(inBox)) return { text, tint }
  const ratio = (value: number | undefined) => Math.max(0, Math.min(1, ((value ?? minimum) - minimum) / span))
  const key = registerChart({ kind: "radar", cols: box.cols, rows: box.rows, cx: radiusX + 1, cy: radiusY + 1, rx: radiusX, ry: radiusY, axes: axes.length, curves: resolvedCurves.map((curve, index) => ({ ratios: curve.numericValues.map(ratio), color: colorOf(index) })) })
  // Two rows above the canvas: the title and the scale.
  return { text, tint, picture: { key, row: box.row + 2, rows: box.rows, col: box.col, cols: box.cols } }
}
