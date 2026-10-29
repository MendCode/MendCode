// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, blankRow, placeLabel, writeVisual, centerVisual } from "./legacy-shared"

export function renderQuadrantChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^quadrantChart$/i.test(lines[0]! ?? "")) return undefined

  let title = "Quadrant chart"
  let xLow = "low"
  let xHigh = "high"
  let yLow = "low"
  let yHigh = "high"
  const quadrants = new Map<number, string>()
  const points: Array<{ label: string; x: number; y: number }> = []
  for (const line of lines.slice(1)) {
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]!) || title
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      const ends = axis[2]!.split("-->").map(cleanLabel)
      if (axis[1]!.toLowerCase() === "x-axis") [xLow, xHigh] = [ends[0]! || xLow, ends[1]! || xHigh]
      else [yLow, yHigh] = [ends[0]! || yLow, ends[1]! || yHigh]
      continue
    }
    const quadrant = /^quadrant-([1-4])\s+(.+)$/i.exec(line)
    if (quadrant) {
      quadrants.set(Number(quadrant[1]!), cleanLabel(quadrant[2]!))
      continue
    }
    const point = /^(.+?)\s*:\s*\[([^\]]+)\]$/.exec(line)
    if (point) {
      const [x, y] = point[2]!.split(",").map((value) => Number(value.trim()))
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ label: cleanLabel(point[1]!), x: Math.max(0, Math.min(1, x!)), y: Math.max(0, Math.min(1, y!)) })
    }
  }
  if (points.length === 0 && quadrants.size === 0) return undefined

  const chartWidth = Math.max(46, Math.min(72, width - 18))
  const chartHeight = 18
  const rows = Array.from({ length: chartHeight + 1 }, () => blankRow(chartWidth + 1))
  for (let column = 0; column <= chartWidth; column++) {
    rows[0]![column]! = "─"
    rows[chartHeight]![column]! = "─"
    rows[Math.floor(chartHeight / 2)]![column]! = "─"
  }
  for (let row = 0; row <= chartHeight; row++) {
    rows[row]![0]! = "│"
    rows[row]![chartWidth]! = "│"
    rows[row]![Math.floor(chartWidth / 2)]! = "│"
  }
  rows[0]![0]! = "┌"
  rows[0]![chartWidth]! = "┐"
  rows[chartHeight]![0]! = "└"
  rows[chartHeight]![chartWidth]! = "┘"
  rows[0]![Math.floor(chartWidth / 2)]! = "┬"
  rows[chartHeight]![Math.floor(chartWidth / 2)]! = "┴"
  rows[Math.floor(chartHeight / 2)]![0]! = "├"
  rows[Math.floor(chartHeight / 2)]![chartWidth]! = "┤"
  rows[Math.floor(chartHeight / 2)]![Math.floor(chartWidth / 2)]! = "┼"

  const quadrantPositions = new Map<number, { row: number; column: number }>([
    [1, { row: 1, column: Math.floor(chartWidth / 2) + 2 }],
    [2, { row: 1, column: 2 }],
    [3, { row: Math.floor(chartHeight / 2) + 1, column: 2 }],
    [4, { row: Math.floor(chartHeight / 2) + 1, column: Math.floor(chartWidth / 2) + 2 }],
  ])
  for (const [number, label] of quadrants) {
    const position = quadrantPositions.get(number)
    if (position) placeLabel(rows, position.column, position.row, label)
  }
  for (const point of points) {
    const column = 1 + Math.round(point.x * (chartWidth - 2))
    const row = chartHeight - 1 - Math.round(point.y * (chartHeight - 2))
    rows[row]![column]! = "●"
    const label = point.label
    const labelColumn = column + Bun.stringWidth(label) + 2 < chartWidth ? column + 2 : Math.max(1, column - Bun.stringWidth(label) - 1)
    placeLabel(rows, labelColumn, row, label)
  }

  return [
    centerVisual(title, chartWidth + 1),
    `${centerVisual(yHigh, chartWidth + 1)} ▲`,
    ...rows.map((row) => row.join("")),
    `${xLow} ◀${"─".repeat(Math.max(3, chartWidth - Bun.stringWidth(xLow) - Bun.stringWidth(xHigh) - 4))}▶ ${xHigh}`,
    `${centerVisual(yLow, chartWidth + 1)} ▼`,
  ].join("\n")
}
