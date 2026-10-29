import { assertCanvas } from "./core"
import { registerChart } from "../chart-picture"

/** The cells of a chart's text that a picture replaces: `rows` rows from row `row` of the text, `cols` cells from cell `col`. */
/** Cells of a chart's text that take a colour of their own (a legend's mark): `cols` cells from cell `col` of row `row`. */
export type CellTint = { row: number; col: number; cols: number; fg: "info" | "warning" | "success" | "synType" | "error" | "accent" | "primary" | "secondary" }
export type PlotPicture = { key: string; row: number; rows: number; col: number; cols: number }
import { wrap } from "../wrap"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, splitMermaidTopLevel, cleanMermaidLabel, blankRow, padVisual, centerVisual } from "./legacy-shared"

/** One colour per series, in the order the series are written (the pie's order of colours). */
const SERIES_COLORS = ["info", "warning", "success", "synType", "error", "accent", "primary", "secondary"] as const

/**
 * A bar and line chart as text: axes, ticks and labels around a plot of block bars and box-drawn lines. The upright chart also says
 * which cells are its plot (`picture`): a terminal that draws pictures paints the bars and lines there, smooth and one colour per
 * series, and the axes, ticks and labels stay text.
 */
export function renderXyChart(input: string, width: number): string | { text: string; picture?: PlotPicture; tint?: CellTint[] } | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const head = /^xychart(?:-beta)?(?:\s+(horizontal|vertical))?$/i.exec(lines[0]! ?? "")
  if (!head) return undefined

  let title = "XY chart"
  let yTitle = "value"
  let yMin: number | undefined
  let yMax: number | undefined
  let categories: string[] = []
  const series: Array<{ kind: "bar" | "line"; values: number[] }> = []
  for (const line of lines.slice(1)) {
    const titleMatch = /^title\s+"?([^"]+)"?$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]!) || title
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      if (axis[1]!.toLowerCase() === "x-axis") {
        const list = /\[([^\]]+)\]/.exec(axis[2]!)
        if (list) categories = splitMermaidTopLevel(list[1]!, ",").map(cleanMermaidLabel)
      } else {
        const range = /^(?:"([^"]+)"|(.*?))?\s*(-?[0-9.]+)\s*-->\s*(-?[0-9.]+)$/.exec(axis[2]!)
        if (range) {
          yTitle = cleanMermaidLabel(range[1]! || range[2]!) || yTitle
          yMin = Number(range[3]!)
          yMax = Number(range[4]!)
        } else yTitle = cleanMermaidLabel(axis[2]!) || yTitle
      }
      continue
    }
    const seriesMatch = /^(bar|line)\s+\[([^\]]+)\]$/i.exec(line)
    if (seriesMatch) {
      const values = splitMermaidTopLevel(seriesMatch[2]!, ",").map(Number)
      if (!values.length || values.some((value) => !Number.isFinite(value))) return undefined
      series.push({ kind: seriesMatch[1]!.toLowerCase() as "bar" | "line", values })
    }
  }
  if (series.length === 0) return undefined
  if ((yMin !== undefined && !Number.isFinite(yMin)) || (yMax !== undefined && !Number.isFinite(yMax)) || (yMin !== undefined && yMax !== undefined && yMax <= yMin)) return undefined
  const count = Math.max(...series.map((item) => item.values.length), categories.length, 1)
  if (categories.length === 0) categories = Array.from({ length: count }, (_, index) => String(index + 1))
  const values = series.flatMap((item) => item.values)
  const minimum = yMin ?? Math.min(0, ...values)
  const maximum = yMax ?? Math.max(0, ...values)
  const span = Math.max(1, maximum - minimum)
  if (head[1]!?.toLowerCase() === "horizontal") {
    const labelWidth = Math.max(8, ...categories.map((category) => Bun.stringWidth(category)))
    const plotWidth = Math.max(36, Math.min(72, width - labelWidth - 8))
    const rows = Array.from({ length: count * 2 - 1 }, () => blankRow(plotWidth))
    const valueColumn = (value: number) => Math.max(0, Math.min(plotWidth - 1, Math.round((value - minimum) / span * (plotWidth - 1))))
    const zeroColumn = valueColumn(Math.max(minimum, Math.min(maximum, 0)))
    const barSeries = series.find((item) => item.kind === "bar")
    barSeries?.values.forEach((value, index) => {
      const end = valueColumn(value)
      for (let column = Math.min(zeroColumn, end); column <= Math.max(zeroColumn, end); column++) rows[index * 2]![column]! = "█"
    })
    const lineSeries = series.filter((item) => item.kind === "line")
    lineSeries.forEach((item, seriesIndex) => {
      item.values.forEach((value, index) => {
        const column = valueColumn(value)
        const row = index * 2
        rows[row]![column]! = seriesIndex === 0 ? "●" : "◆"
        if (index === 0) return
        const previous = valueColumn(item.values[index - 1]! ?? 0)
        const bridgeRow = row - 1
        for (let x = Math.min(previous, column); x <= Math.max(previous, column); x++) if (rows[bridgeRow]![x]! === " ") rows[bridgeRow]![x]! = "─"
        rows[bridgeRow]![previous]! = "┐"
        rows[bridgeRow]![column]! = "└"
      })
    })
    return [
      title,
      ...rows.map((row, index) => `${padVisual(index % 2 === 0 ? categories[index / 2]! ?? "" : "", labelWidth)} │${row.join("")}`),
      `${" ".repeat(labelWidth + 2)}└${"─".repeat(plotWidth)}▶ ${yTitle}`,
    ].join("\n")
  }
  const plotHeight = 14
  const plotWidth = Math.max(42, Math.min(84, width - 14))
  const stride = Math.max(3, Math.floor(plotWidth / count))
  const actualWidth = stride * count
  assertCanvas(actualWidth, plotHeight)
  const rows = Array.from({ length: plotHeight }, () => blankRow(actualWidth))
  const valueRow = (value: number) => Math.max(0, Math.min(plotHeight - 1, Math.round((maximum - value) / span * (plotHeight - 1))))
  const zeroRow = valueRow(Math.max(minimum, Math.min(maximum, 0)))
  for (let column = 0; column < actualWidth; column++) rows[zeroRow]![column]! = "─"

  const bars = series.filter((item) => item.kind === "bar")
  for (const [seriesIndex, item] of bars.entries()) {
    item.values.forEach((value, index) => {
      const center = index * stride + Math.floor(stride / 2)
      const column = Math.min(actualWidth - 1, center + seriesIndex - Math.floor(bars.length / 2))
      const row = valueRow(value)
      for (let y = Math.min(row, zeroRow); y <= Math.max(row, zeroRow); y++) rows[y]![column]! = "█"
    })
  }
  for (const [seriesIndex, item] of series.filter((entry) => entry.kind === "line").entries()) {
    for (let index = 0; index < item.values.length; index++) {
      const x = index * stride + Math.floor(stride / 2)
      const y = valueRow(item.values[index]! ?? 0)
      rows[y]![x]! = seriesIndex === 0 ? "●" : "◆"
      if (index === 0) continue
      const previousX = (index - 1) * stride + Math.floor(stride / 2)
      const previousY = valueRow(item.values[index - 1]! ?? 0)
      const elbow = Math.floor((previousX + x) / 2)
      for (let column = previousX + 1; column <= elbow; column++) if (rows[previousY]![column]! === " ") rows[previousY]![column]! = "─"
      for (let row = Math.min(previousY, y); row <= Math.max(previousY, y); row++) if (rows[row]![elbow]! === " ") rows[row]![elbow]! = "│"
      for (let column = elbow + 1; column < x; column++) if (rows[y]![column]! === " ") rows[y]![column]! = "─"
    }
  }
  const output = [title, `${yTitle} ↑`]
  rows.forEach((row, index) => {
    const value = maximum - index / (plotHeight - 1) * span
    const tick = index === 0 || index === plotHeight - 1 || index === zeroRow ? String(Math.round(value * 100) / 100) : ""
    output.push(`${padVisual(tick, 7)}│${row.join("")}`)
  })
  output.push(`${" ".repeat(7)}└${"─".repeat(actualWidth)}▶`)
  const labels = categories.map((category) => wrap(category, Math.max(2, stride - 1)))
  for (let row = 0; row < Math.max(...labels.map((label) => label.length)); row++) output.push(`${" ".repeat(8)}${labels.map((label) => centerVisual(label[row] ?? "", stride)).join("")}`)
  const key = registerChart({ kind: "xy", cols: actualWidth, rows: plotHeight, stride, min: minimum, max: maximum, series: series.map((item, index) => ({ kind: item.kind, values: item.values, color: SERIES_COLORS[index % SERIES_COLORS.length]! })) })
  // Two rows above the plot (title, axis title) and eight cells before it (the tick and the axis).
  return { text: output.join("\n"), picture: { key, row: 2, rows: plotHeight, col: 8, cols: actualWidth } }
}
