// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, mermaidIndentWidth, parseFlowchartNodeExpression, cleanMermaidLabel, centerVisual } from "./legacy-shared"
import { wrap } from "../wrap"

export function renderKanbanDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^kanban$/i.test(lines[0]!?.trim() ?? "")) return undefined

  const columns: Array<{ title: string; tasks: string[] }> = []
  let current: { title: string; tasks: string[] } | undefined
  const bodyLines = lines.slice(1).filter((line) => line.trim())
  if (bodyLines.length === 0) return undefined
  const baseIndent = Math.min(...bodyLines.map(mermaidIndentWidth))
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (!line || /^(?:classDef|style|click|linkStyle)\b/i.test(line)) continue
    const indent = mermaidIndentWidth(raw) - baseIndent
    const node = parseFlowchartNodeExpression(line.replace(/\s*@\{[^}]*\}\s*$/, ""))
    const bracketOnly = /^\[([^\]]+)\](?:\s*@\{[^}]*\})?$/.exec(line)
    // A column written as bare words (`In progress`) is its whole line, not its first word.
    const bare = /[\[\](){}]/.test(line) ? undefined : cleanMermaidLabel(line.replace(/\s*@\{[^}]*\}\s*$/, ""))
    const label = bracketOnly ? cleanMermaidLabel(bracketOnly[1]!) : bare || node?.label
    if (!label) continue
    if (indent <= 0 || !current) {
      current = { title: label, tasks: [] }
      columns.push(current)
      continue
    }
    const metadata = /@\{(.+)\}$/.exec(line)?.[1]!
    current.tasks.push(metadata ? `${label} · ${cleanMermaidLabel(metadata)}` : label)
  }
  if (columns.length === 0) return undefined
  // More columns than fit side by side at a readable width continue on a second row of columns, and a third.
  const perRow = Math.max(1, Math.floor((width + 2) / (MIN_COLUMN + 4)))
  if (columns.length > perRow) {
    const bands: string[] = []
    for (let at = 0; at < columns.length; at += perRow) {
      const band = kanbanBand(columns.slice(at, at + perRow), width)
      if (!band) return undefined
      bands.push(...(bands.length ? [""] : []), ...band)
    }
    return ["Kanban", ...bands].join("\n")
  }
  const band = kanbanBand(columns, width)
  return band ? ["Kanban", ...band].join("\n") : undefined
}

/** The narrowest column that still reads; with less room per column, the board wraps onto more rows of columns. */
const MIN_COLUMN = 18

/** Columns side by side, as tall as the one with most tasks. */
function kanbanBand(visible: Array<{ title: string; tasks: string[] }>, width: number): string[] | undefined {
  const columnWidth = Math.min(42, Math.floor((width - (visible.length - 1) * 2) / visible.length) - 2, Math.max(18, ...visible.map((column) => Bun.stringWidth(column.title) + 4), ...visible.flatMap((column) => column.tasks.map((task) => Bun.stringWidth(task) + 6))))
  if (columnWidth < 10) return undefined
  const maxTasks = Math.max(1, ...visible.map((column) => column.tasks.length))
  const titleHeight = Math.max(...visible.map((column) => wrap(column.title, columnWidth).length))
  const taskHeights = Array.from({ length: maxTasks }, (_, index) => Math.max(1, ...visible.map((column) => wrap(column.tasks[index] ?? "", columnWidth - 4).length)))
  const renderedColumns = visible.map((column) => {
    const title = wrap(column.title, columnWidth)
    const rows = [`╭${"─".repeat(columnWidth)}╮`, ...Array.from({ length: titleHeight }, (_, i) => `│${centerVisual(title[i] ?? "", columnWidth)}│`), `├${"─".repeat(columnWidth)}┤`]
    for (let index = 0; index < maxTasks; index++) {
      const task = column.tasks[index]!
      if (!task) {
        rows.push(...Array.from({ length: taskHeights[index]! + 2 }, () => `│${" ".repeat(columnWidth)}│`))
        continue
      }
      const inner = columnWidth - 4
      rows.push(
        `│ ╭${"─".repeat(inner)}╮ │`,
        ...Array.from({ length: taskHeights[index]! }, (_, i) => `│ │${centerVisual(wrap(task, inner)[i] ?? "", inner)}│ │`),
        `│ ╰${"─".repeat(inner)}╯ │`,
      )
    }
    rows.push(`╰${"─".repeat(columnWidth)}╯`)
    return rows
  })
  return renderedColumns[0]!.map((_, row) => renderedColumns.map((column) => column[row]!).join("  "))
}
