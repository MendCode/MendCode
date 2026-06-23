import { spawn } from "child_process"
import stripAnsi from "strip-ansi"
import { which } from "@/util/which"
import { normalizeHexColor } from "./hex-colors"

const MAX_MARKDOWN_BYTES = 50_000
const MAX_MERMAID_BLOCKS = 8
const MAX_MERMAID_BYTES = 8_000
const MAX_TERMAID_OUTPUT_BYTES = 20_000
const TERMAID_TIMEOUT_MS = 2_000
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
type TableRenderMode = "wide" | "preserve" | "grid"
type RenderPlanMarkdownOptions = {
  tableMode?: TableRenderMode
  markdownMode?: "all" | "tables-only"
}
export type StreamingPlanMarkdownState = {
  sourceCursor: number
  sourcePrefix: string
  renderedPrefix: string
  width: number
  optionsKey: string
}
const MERMAID_FENCE_PATTERN = /```[ \t]*mermaid[^\r\n]*\r?\n/i

function resolveTermaid() {
  const configured = process.env.MENDCODE_TERMAID_BIN?.trim()
  if (configured) return configured
  return which("termaid")
}

function cleanOutput(input: string) {
  return stripAnsi(input).replace(CONTROL_CHARS, "").trimEnd()
}

function cleanLabel(input: string | undefined) {
  return (input ?? "")
    .replace(/[`"'{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanConnectorLabel(input: string | undefined) {
  return (input ?? "")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function planReviewInlineTitle(input: string | undefined) {
  const title = cleanLabel(input).replace(/^Plan:\s*/i, "")
  return title || undefined
}

function renderBox(label: string) {
  const text = cleanLabel(label) || "step"
  const width = Math.min(52, Math.max(10, Bun.stringWidth(text) + 2))
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

function renderEntityBox(label: string, fields: string[]) {
  if (fields.length === 0) return renderBox(label)

  const name = cleanLabel(label) || "entity"
  const fieldLines = fields.slice(0, 8).map((field) => cleanLabel(field)).filter(Boolean)
  const width = Math.min(52, Math.max(10, Bun.stringWidth(name) + 2, ...fieldLines.map((field) => Bun.stringWidth(field) + 2)))
  const center = centerVisual(name, width)
  const rows = fieldLines.map((field) => {
    const padded = ` ${field} `
    return `│${padded}${" ".repeat(Math.max(0, width - Bun.stringWidth(padded)))}│`
  })

  return [
    `╭${"─".repeat(width)}╮`,
    `│${center}│`,
    `├${"─".repeat(width)}┤`,
    ...rows,
    `╰${"─".repeat(width)}╯`,
  ]
}

function renderInlineBox(label: string) {
  const text = cleanLabel(label) || "step"
  return `┌ ${text} ┐`
}

function renderCompactBox(label: string, minWidth = 8) {
  const text = cleanLabel(label) || "item"
  const width = Math.min(28, Math.max(minWidth, Bun.stringWidth(text) + 2))
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

function renderStateBox(label: string) {
  const display = cleanLabel(label)
  const width = display === "●" || display === "◉" ? 5 : Math.min(28, Math.max(12, Bun.stringWidth(display) + 2))
  return [`╭${"─".repeat(width)}╮`, `│${centerVisual(display, width)}│`, `╰${"─".repeat(width)}╯`]
}

function indentLines(lines: string[], depth: number) {
  const prefix = "  ".repeat(depth)
  return lines.map((line) => (line ? `${prefix}${line}` : line))
}

function popTrailingHeading(input: string) {
  const match = /(^|[\r\n])([ \t]{0,3}#{1,6}[ \t]+([^\r\n]+)[ \t]*)(?:\r?\n[ \t]*)*$/.exec(input)
  if (!match) return { prefix: input }
  const headingStart = (match.index ?? 0) + match[1].length
  const title = cleanLabel(match[3])
  if (!title.match(/\b(diagram|diagrama|mermaid|flowchart|flujo)\b/i)) return { prefix: input }
  return {
    prefix: input.slice(0, headingStart),
    title,
  }
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim()
  return trimmed.includes("|") && !trimmed.startsWith("```")
}

function isFenceLine(line: string) {
  return /^\s*```/.test(line)
}

type CompleteLine = {
  text: string
  start: number
  end: number
}

function completedLines(input: string): CompleteLine[] {
  const lines: CompleteLine[] = []
  let start = 0
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== "\n") continue
    const end = index + 1
    lines.push({ text: input.slice(start, index).replace(/\r$/, ""), start, end })
    start = end
  }
  return lines
}

export function streamingMarkdownCommitIndex(input: string) {
  const lines = completedLines(input)
  let safe = 0
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (isFenceLine(line.text)) {
      inFence = !inFence
      if (!inFence) safe = line.end
      continue
    }

    if (inFence) continue

    const next = lines[index + 1]
    if (next && isMarkdownTableRow(line.text) && isMarkdownTableSeparator(next.text)) {
      index += 2
      while (index < lines.length && isMarkdownTableRow(lines[index].text)) index++

      const tableTerminator = lines[index]
      if (!tableTerminator) break
      safe = tableTerminator.end
      continue
    }

    safe = line.end
  }

  return safe
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
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

function renderInlineMarkdownForStreaming(input: string) {
  return stripAnsi(input)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
}

function renderStreamingMarkdownText(markdown: string) {
  const structural = renderMarkdownHeadingsAsText(renderMarkdownListsAsText(markdown))
  const result: string[] = []
  let inFence = false

  for (const line of structural.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    result.push(inFence ? stripAnsi(line) : renderInlineMarkdownForStreaming(line))
  }

  return result.join("\n")
}

function renderLiveStreamingLine(line: string) {
  if (/^ {0,3}#{1,6}\s+\S/.test(line)) return line
  return renderInlineMarkdownForStreaming(line)
}

function wrapStreamingTextLine(line: string, width: number) {
  const maxWidth = Math.max(1, width)
  if (Bun.stringWidth(line) <= maxWidth) return [line]

  const lines: string[] = []
  let current = ""
  for (const word of line.split(/(\s+)/)) {
    if (!word) continue
    const next = `${current}${word}`
    if (!current || Bun.stringWidth(next) <= maxWidth) {
      current = next
      continue
    }
    lines.push(current.trimEnd())
    if (Bun.stringWidth(word) <= maxWidth) {
      current = word.trimStart()
      continue
    }
    let chunk = ""
    for (const char of word) {
      const chunkNext = `${chunk}${char}`
      if (Bun.stringWidth(chunkNext) <= maxWidth) {
        chunk = chunkNext
        continue
      }
      if (chunk) lines.push(chunk)
      chunk = char
    }
    current = chunk
  }
  if (current) lines.push(current.trimEnd())
  return lines.length > 0 ? lines : [line]
}

function wrapStreamingText(markdown: string, width: number) {
  return markdown
    .split("\n")
    .flatMap((line) => wrapStreamingTextLine(line, width))
    .join("\n")
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

function wrapTableCell(text: string, width: number) {
  const visualText = stripAnsi(text)
  if (visualText !== text && Bun.stringWidth(visualText) <= width) return [text]
  const cleanText = cleanInlineMarkdownForText(text)
  if (!cleanText) return [""]

  const lines: string[] = []
  let current = ""
  const pushChunk = (chunk: string) => {
    let remaining = chunk
    while (Bun.stringWidth(remaining) > width) {
      let cut = 0
      let measured = 0
      for (const char of remaining) {
        const charWidth = Bun.stringWidth(char)
        if (measured + charWidth > width) break
        measured += charWidth
        cut += char.length
      }
      lines.push(remaining.slice(0, Math.max(1, cut)))
      remaining = remaining.slice(Math.max(1, cut))
    }
    return remaining
  }

  for (const word of cleanText.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (Bun.stringWidth(next) <= width) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = pushChunk(word)
  }
  if (current || lines.length === 0) lines.push(current)
  return lines
}

function padCell(text: string, width: number) {
  return `${text}${" ".repeat(Math.max(0, width - Bun.stringWidth(stripAnsi(text))))}`
}

function renderHexTableCell(text: string, input: { header?: string; headers?: string[] }) {
  const clean = cleanInlineMarkdownForText(text)
  const hex = normalizeHexColor(clean)
  if (!hex) return text

  const header = cleanInlineMarkdownForText(input.header ?? "")
  if (/\bpreview\b/i.test(header)) return hex.toUpperCase()

  const hasPreviewColumn = input.headers?.some((item) => /\bpreview\b/i.test(cleanInlineMarkdownForText(item))) ?? false
  if (hasPreviewColumn) return clean.toUpperCase()
  return hex.toUpperCase()
}

function renderTableCellForGrid(text: string, input: { header?: string; headers?: string[] }) {
  return renderHexTableCell(text, input)
}

function renderMarkdownTableAsGrid(table: string[], width: number) {
  const headers = splitMarkdownTableRow(table[0])
  const rows = table.slice(2).map(splitMarkdownTableRow)
  const hexIndex = headers.findIndex((header) => /\bhex\b/i.test(cleanInlineMarkdownForText(header)))
  const previewIndex = headers.findIndex((header) => /\bpreview\b/i.test(cleanInlineMarkdownForText(header)))
  const displayRows = rows.map((row) => {
    const next = [...row]
    const hex = hexIndex >= 0 ? normalizeHexColor(cleanInlineMarkdownForText(next[hexIndex] ?? "")) : undefined
    if (previewIndex >= 0 && hex) {
      next[previewIndex] = hex
    }
    return next.map((cell, index) =>
      renderTableCellForGrid(cell, {
        header: headers[index],
        headers,
      }),
    )
  })
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length))
  const available = Math.max(40, Math.min(120, width))
  const borderWidth = columnCount + 1
  const paddingWidth = columnCount * 2
  const cellBudget = Math.max(columnCount * 8, available - borderWidth - paddingWidth)
  const naturalWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(
      Bun.stringWidth(cleanInlineMarkdownForText(headers[index] ?? "")),
      ...displayRows.map((row) => Bun.stringWidth(cleanInlineMarkdownForText(row[index] ?? ""))),
      8,
    ),
  )
  if (
    columnCount === 3 &&
    /\b(archivo|file|path)\b/i.test(cleanInlineMarkdownForText(headers[0] ?? "")) &&
    /\b(acción|accion|action)\b/i.test(cleanInlineMarkdownForText(headers[1] ?? ""))
  ) {
    const actionWidth = Math.min(Math.max(naturalWidths[1], 8), 12)
    const firstWidth = Math.min(naturalWidths[0], Math.max(24, Math.min(52, cellBudget - actionWidth - 24)))
    const lastWidth = Math.max(16, cellBudget - firstWidth - actionWidth)
    return renderGridRows(headers, displayRows, [firstWidth, actionWidth, lastWidth])
  }
  const baseWidth = Math.max(8, Math.floor(cellBudget / Math.max(1, columnCount)))
  const columns = naturalWidths.map((natural) => Math.min(natural, baseWidth))
  const totalCells = columns.reduce((sum, column) => sum + column, 0)
  let remaining = cellBudget - totalCells
  while (remaining > 0) {
    let changed = false
    for (let index = 0; index < columns.length && remaining > 0; index++) {
      const natural = naturalWidths[index]
      if (columns[index] >= natural) continue
      columns[index] += 1
      remaining -= 1
      changed = true
    }
    if (!changed) break
  }
  return renderGridRows(headers, displayRows, columns)
}

function liveGridColumns(headers: string[], rows: string[][], width: number) {
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1)
  const available = Math.max(40, Math.min(120, width))
  const borderWidth = columnCount + 1
  const paddingWidth = columnCount * 2
  const cellBudget = Math.max(columnCount * 8, available - borderWidth - paddingWidth)
  const headerWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(Bun.stringWidth(cleanInlineMarkdownForText(headers[index] ?? "")), 8),
  )

  if (
    columnCount === 3 &&
    /\b(archivo|file|path)\b/i.test(cleanInlineMarkdownForText(headers[0] ?? "")) &&
    /\b(acción|accion|action)\b/i.test(cleanInlineMarkdownForText(headers[1] ?? ""))
  ) {
    const actionWidth = Math.min(Math.max(headerWidths[1], 8), 12)
    const firstBudget = Math.max(24, Math.min(52, cellBudget - actionWidth - 24))
    const firstWidth = Math.min(Math.max(headerWidths[0], 24), firstBudget)
    const lastWidth = Math.max(16, cellBudget - firstWidth - actionWidth)
    return [firstWidth, actionWidth, lastWidth]
  }

  const baseWidth = Math.max(8, Math.floor(cellBudget / columnCount))
  const columns = headerWidths.map((natural) => Math.min(natural, baseWidth))
  let remaining = cellBudget - columns.reduce((sum, column) => sum + column, 0)
  while (remaining > 0) {
    for (let index = 0; index < columns.length && remaining > 0; index++) {
      columns[index] += 1
      remaining -= 1
    }
  }
  return columns
}

function renderLiveMarkdownTableAsGrid(table: string[], width: number) {
  const headers = splitMarkdownTableRow(table[0])
  const rows = table.slice(2).map(splitMarkdownTableRow)
  const hexIndex = headers.findIndex((header) => /\bhex\b/i.test(cleanInlineMarkdownForText(header)))
  const previewIndex = headers.findIndex((header) => /\bpreview\b/i.test(cleanInlineMarkdownForText(header)))
  const displayRows = rows.map((row) => {
    const next = [...row]
    const hex = hexIndex >= 0 ? normalizeHexColor(cleanInlineMarkdownForText(next[hexIndex] ?? "")) : undefined
    if (previewIndex >= 0 && hex) next[previewIndex] = hex
    return next.map((cell, index) =>
      renderTableCellForGrid(cell, {
        header: headers[index],
        headers,
      }),
    )
  })

  return renderGridRows(headers, displayRows, liveGridColumns(headers, displayRows, width), false)
}

function renderGridRows(headers: string[], rows: string[][], columns: number[], fenced = true) {
  const border = (left: string, middle: string, right: string) =>
    `${left}${columns.map((column) => "─".repeat(column + 2)).join(middle)}${right}`
  const renderRow = (row: string[]) => {
    const wrapped = columns.map((column, index) => wrapTableCell(row[index] ?? "", column))
    const height = Math.max(...wrapped.map((cell) => cell.length), 1)
    return Array.from({ length: height }, (_, lineIndex) =>
      `│${columns.map((column, columnIndex) => ` ${padCell(wrapped[columnIndex][lineIndex] ?? "", column)} `).join("│")}│`,
    )
  }

  const lines = [
    border("┌", "┬", "┐"),
    ...renderRow(headers),
    border("├", "┼", "┤"),
    ...rows.flatMap((row, index) => {
      const rendered = renderRow(row)
      return index === rows.length - 1 ? rendered : [...rendered, border("├", "┼", "┤")]
    }),
    border("└", "┴", "┘"),
  ]

  return fenced ? ["```text", ...lines, "```"] : lines
}

function renderWideTablesAsText(markdown: string, width: number, mode: TableRenderMode = "wide") {
  const lines = markdown.split("\n")
  const result: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const current = lines[index]
    const next = lines[index + 1]
    if (!current || !next || !isMarkdownTableRow(current) || !isMarkdownTableSeparator(next)) {
      result.push(current)
      continue
    }

    const table: string[] = [current, next]
    index += 2
    while (index < lines.length && isMarkdownTableRow(lines[index])) {
      table.push(lines[index])
      index++
    }
    index--

    if (mode === "preserve") {
      result.push(...table)
      continue
    }
    if (mode === "grid") {
      result.push(...renderMarkdownTableAsGrid(table, width))
      continue
    }

    const tableWidth = Math.max(...table.map((line) => Bun.stringWidth(line)))
    if (tableWidth < Math.max(40, width - 4)) {
      result.push(...table)
      continue
    }

    const headers = splitMarkdownTableRow(table[0])
    const rows = table.slice(2).map(splitMarkdownTableRow)
    result.push("```text")
    rows.forEach((row, rowIndex) => {
      const title = cleanInlineMarkdownForText(row[0] || `Fila ${rowIndex + 1}`)
      result.push(...wrapTextLine("", title, width))

      for (let cellIndex = 1; cellIndex < Math.max(headers.length, row.length); cellIndex++) {
        const header = cleanInlineMarkdownForText(headers[cellIndex] || `Campo ${cellIndex + 1}`)
        const cell = cleanInlineMarkdownForText(row[cellIndex] ?? "")
        if (!cell) continue
        result.push(...wrapTextLine(`  ${header}: `, cell, width))
      }

      if (rowIndex < rows.length - 1) result.push("")
    })
    result.push("```")
  }

  return result.join("\n")
}

function renderMarkdownListsAsText(markdown: string) {
  const lines = markdown.split("\n")
  const result: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      result.push(line)
      continue
    }

    if (inFence) {
      result.push(line)
      continue
    }

    const checklist = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line)
    if (checklist) {
      const depth = Math.floor(checklist[1].replace(/\t/g, "  ").length / 2)
      const glyph = checklist[2].toLowerCase() === "x" ? "☑" : "☐"
      result.push(`${"  ".repeat(depth)}${glyph} ${checklist[3]}`)
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line)
    if (bullet) {
      const depth = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2)
      const glyph = depth === 0 ? "•" : depth === 1 ? "◦" : "▪"
      result.push(`${"  ".repeat(depth)}${glyph} ${bullet[2]}`)
      continue
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line)
    if (numbered) {
      const depth = Math.floor(numbered[1].replace(/\t/g, "  ").length / 2)
      result.push(`${"  ".repeat(depth)}${numbered[2]}. ${numbered[3]}`)
      continue
    }

    result.push(line)
  }

  return result.join("\n")
}

function renderMarkdownHeadingsAsText(markdown: string) {
  const lines = markdown.split("\n")
  const result: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      result.push(line)
      continue
    }

    if (inFence) {
      result.push(line)
      continue
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) {
      result.push(line)
      continue
    }

    const level = heading[1].length
    const title = cleanLabel(heading[2])
    if (!title) {
      result.push(line)
      continue
    }

    if (level === 1) {
      result.push(title, "═".repeat(Math.min(72, Math.max(8, Bun.stringWidth(title)))))
      continue
    }
    if (level === 2) {
      result.push(title, "─".repeat(Math.min(72, Math.max(8, Bun.stringWidth(title)))))
      continue
    }

    const glyph = level === 3 ? "◆" : level === 4 ? "◇" : level === 5 ? "▪" : "·"
    result.push(`${glyph} ${title}`)
  }

  return result.join("\n")
}

function renderMarkdownForTui(markdown: string, width: number, options: RenderPlanMarkdownOptions = {}) {
  if (options.markdownMode === "tables-only") return renderWideTablesAsText(markdown, width, options.tableMode)
  return renderMarkdownHeadingsAsText(renderMarkdownListsAsText(renderWideTablesAsText(markdown, width, options.tableMode)))
}

function alignTextBlock(input: string, width: number) {
  const lines = input.split("\n")
  const contentWidth = Math.max(...lines.map((line) => Bun.stringWidth(line)), 0)
  const availableWidth = Math.max(40, width - 4)
  if (contentWidth >= availableWidth) return input

  const padding = " ".repeat(Math.floor((availableWidth - contentWidth) / 2))
  return lines.map((line) => (line ? `${padding}${line}` : line)).join("\n")
}

type FlowDirection = "td" | "tb" | "lr" | "rl" | "bt"

function parseFlowchartEdgeLine(line: string, labels: Map<string, string>) {
  const nodePattern = /([A-Za-z][\w-]*)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?/y
  const connectorPattern = /\s*(?:--\s*([^>|-]+?)\s*--!?>|--!?>\|([^|]+)\||==>\|([^|]+)\||--!?>|---|==>|-.->|[—–-]*→|→)\s*/y
  const edges: Array<{ from: string; to: string; label?: string }> = []
  let cursor = 0
  nodePattern.lastIndex = cursor
  const first = nodePattern.exec(line)
  if (!first) return edges

  let previous = first[1]
  labels.set(previous, cleanLabel(first[2] || first[3] || first[4] || labels.get(previous) || previous))
  cursor = nodePattern.lastIndex

  while (cursor < line.length) {
    connectorPattern.lastIndex = cursor
    const connector = connectorPattern.exec(line)
    if (!connector) break

    nodePattern.lastIndex = connectorPattern.lastIndex
    const next = nodePattern.exec(line)
    if (!next) break

    const target = next[1]
    labels.set(target, cleanLabel(next[2] || next[3] || next[4] || labels.get(target) || target))
    edges.push({
      from: previous,
      to: target,
      label: cleanLabel(connector[1] || connector[2] || connector[3]) || undefined,
    })
    previous = target
    cursor = nodePattern.lastIndex
  }

  return edges
}

type HorizontalPathSegment =
  | { type: "node"; label: string }
  | { type: "edge"; label?: string }
  | { type: "loop"; label: string }

function padVisual(input: string, width: number) {
  return input + " ".repeat(Math.max(0, width - Bun.stringWidth(input)))
}

function centerVisual(input: string, width: number) {
  const inputWidth = Bun.stringWidth(input)
  if (inputWidth >= width) return input
  const left = Math.floor((width - inputWidth) / 2)
  return `${" ".repeat(left)}${input}${" ".repeat(width - inputWidth - left)}`
}

function renderBoxConnection(input: {
  from: string
  to: string
  label?: string
  connector?: string
  width: number
}) {
  const left = renderBox(input.from)
  const right = renderBox(input.to)
  const leftWidth = Math.max(...left.map((line) => Bun.stringWidth(line)))
  const rightWidth = Math.max(...right.map((line) => Bun.stringWidth(line)))
  const connector = input.connector ?? "────▶"
  const label = cleanConnectorLabel(input.label)
  const connectorWidth =
    input.connector && !label ? Bun.stringWidth(connector) : Math.max(8, Math.min(28, Bun.stringWidth(label || connector) + 4))
  const availableWidth = Math.max(40, input.width - 4)
  const rowWidth = leftWidth + connectorWidth + rightWidth

  if (rowWidth > availableWidth) {
    const from = renderInlineBox(input.from)
    const to = renderInlineBox(input.to)
    const line = `${from} ${connector} ${to}${label ? `  ${label}` : ""}`
    return Bun.stringWidth(line) <= availableWidth ? [line] : [`${from} ${connector} ${to}`, ...(label ? [`  ${label}`] : [])]
  }

  return [
    `${padVisual(left[0], leftWidth)}${" ".repeat(connectorWidth)}${padVisual(right[0], rightWidth)}`,
    `${padVisual(left[1], leftWidth)}${centerVisual(connector, connectorWidth)}${padVisual(right[1], rightWidth)}`,
    `${padVisual(left[2], leftWidth)}${centerVisual(label, connectorWidth)}${padVisual(right[2], rightWidth)}`,
  ]
}

function writeVisual(target: string[], start: number, input: string) {
  const chars = [...input]
  for (let index = 0; index < chars.length && start + index < target.length; index++) {
    if (start + index >= 0) target[start + index] = chars[index]
  }
}

function blankRow(width: number) {
  return Array.from({ length: width }, () => " ")
}

function renderHorizontalPath(segments: HorizontalPathSegment[], direction: "lr" | "rl") {
  const rows = ["", "", ""]

  for (const segment of segments) {
    if (segment.type === "edge") {
      const connector =
        direction === "rl"
          ? segment.label
            ? `◀─ ${segment.label} ──`
            : "◀────"
          : segment.label
            ? `── ${segment.label} ─▶`
            : "────▶"
      const padding = " ".repeat(Bun.stringWidth(connector))
      rows[0] += padding
      rows[1] += connector
      rows[2] += padding
      continue
    }

    const box = segment.type === "loop" ? renderBox(`↺ ${segment.label}`) : renderBox(segment.label)
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    for (let index = 0; index < rows.length; index++) {
      rows[index] += padVisual(box[index] ?? "", boxWidth)
    }
  }

  return rows
}

function reverseHorizontalPath(segments: HorizontalPathSegment[]) {
  const reversed: HorizontalPathSegment[] = []
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]
    if (!segment) continue
    reversed.push(segment)
  }
  return reversed
}

function renderLayeredHorizontalFlowchart(input: {
  starts: string[]
  edges: Array<{ from: string; to: string; label?: string }>
  labels: Map<string, string>
  direction: "lr" | "rl"
  width: number
}) {
  const outgoing = new Map<string, Array<{ to: string; label?: string }>>()
  for (const { from, to, label } of input.edges) {
    outgoing.set(from, [...(outgoing.get(from) ?? []), { to, label }])
  }

  const paths: HorizontalPathSegment[][] = []
  const walk = (node: string, path: HorizontalPathSegment[], seen: Set<string>) => {
    const next = outgoing.get(node) ?? []
    if (next.length === 0 || path.length >= 8) {
      paths.push(path)
      return
    }

    for (const edge of next) {
      const nextLabel = input.labels.get(edge.to) ?? edge.to
      const connector = { type: "edge", label: edge.label } satisfies HorizontalPathSegment
      if (seen.has(edge.to)) {
        paths.push([...path, connector, { type: "loop", label: nextLabel }])
        continue
      }
      walk(edge.to, [...path, connector, { type: "node", label: nextLabel }], new Set([...seen, edge.to]))
    }
  }

  for (const start of input.starts) {
    walk(start, [{ type: "node", label: input.labels.get(start) ?? start }], new Set([start]))
    if (paths.length >= 6) break
  }

  const rendered = paths.slice(0, 6).flatMap((path, index) => {
    const rows = renderHorizontalPath(input.direction === "rl" ? reverseHorizontalPath(path) : path, input.direction)
    return index === 0 ? rows : ["", ...rows]
  })
  if (rendered.length === 0) return undefined

  const maxWidth = Math.max(...rendered.map((line) => Bun.stringWidth(line)))
  const availableWidth = Math.max(40, input.width - 4)
  return maxWidth <= availableWidth ? rendered.join("\n").trimEnd() : undefined
}

function renderSimpleFlowchart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const head = lines[0]?.toLowerCase()
  const headMatch = /^(flowchart|graph)\s+(td|tb|lr|rl|bt)\b/.exec(head ?? "")
  if (!headMatch) return undefined
  const direction = headMatch[2] as FlowDirection

  const labels = new Map<string, string>()
  const parsedEdges: Array<{ from: string; to: string; label?: string }> = []

  for (const line of lines.slice(1)) {
    parsedEdges.push(...parseFlowchartEdgeLine(line, labels))
  }

  if (parsedEdges.length === 0) return undefined
  const edges =
    direction === "bt" ? parsedEdges.map((edge) => ({ from: edge.to, to: edge.from, label: edge.label })) : parsedEdges

  const outgoing = new Map<string, Array<{ to: string; label?: string }>>()
  const incoming = new Set<string>()
  for (const { from, to, label } of edges) {
    outgoing.set(from, [...(outgoing.get(from) ?? []), { to, label }])
    incoming.add(to)
  }
  const starts = [...outgoing.keys()].filter((node) => !incoming.has(node))
  const start = starts[0] ?? edges[0]?.from

  if ((direction === "lr" || direction === "rl") && edges.length <= 24) {
    const horizontal = renderLayeredHorizontalFlowchart({
      starts: starts.length > 0 ? starts : start ? [start] : [],
      edges,
      labels,
      direction,
      width,
    })
    if (horizontal) return horizontal
  }

  if (start && edges.length <= 16) {
    const renderNode = (node: string, path: Set<string>, depth = 0): string[] => {
      const next = outgoing.get(node) ?? []
      const lines = indentLines(renderBox(labels.get(node) ?? node), depth)
      if (next.length === 0) return lines

      if (next.length === 1 && !next[0].label) {
        const target = next[0].to
        lines.push(`${"  ".repeat(depth)}        │`)
        lines.push(`${"  ".repeat(depth)}        ▼`)
        if (path.has(target)) {
          lines.push(`${"  ".repeat(depth)}        ↺ ${labels.get(target) ?? target}`)
          return lines
        }
        return [...lines, ...renderNode(target, new Set([...path, target]), depth)]
      }

      for (let index = 0; index < next.length; index++) {
        const edge = next[index]
        const isLast = index === next.length - 1
        const branch = isLast ? "└" : "├"
        const label = edge.label || `path ${index + 1}`
        const branchIndent = "  ".repeat(depth)
        const childPrefix = `${branchIndent}${isLast ? "   " : "│  "}`
        if (index > 0) lines.push("")
        lines.push(`${branchIndent}${branch}─ ${label}`)

        if (path.has(edge.to)) {
          lines.push(`${childPrefix}↺ ${labels.get(edge.to) ?? edge.to}`)
          continue
        }
        lines.push(
          ...renderNode(edge.to, new Set([...path, edge.to]), 0).map((line) => (line ? `${childPrefix}${line}` : line)),
        )
      }
      return lines
    }

    const rendered = renderNode(start, new Set([start]))
    if (rendered.length > 3) return rendered.join("\n")
  }

  return edges
    .map(({ from, to, label }) => {
      const connector = label ? ` ── ${label} ─▶ ` : " ──▶ "
      return `${renderInlineBox(labels.get(from) ?? from)}${connector}${renderInlineBox(labels.get(to) ?? to)}`
    })
    .join("\n")
}

function renderSequenceDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines[0]?.toLowerCase() !== "sequencediagram") return undefined

  const aliases = new Map<string, string>()
  const messages: Array<{ from: string; to: string; label: string; dashed: boolean }> = []
  const participants: string[] = []
  const addParticipant = (id: string, label?: string) => {
    aliases.set(id, cleanLabel(label || aliases.get(id) || id))
    if (!participants.includes(id)) participants.push(id)
  }

  for (const line of lines.slice(1)) {
    const participant = /^(?:participant|actor)\s+([A-Za-z][\w-]*)(?:\s+as\s+(.+))?$/i.exec(line)
    if (participant) {
      addParticipant(participant[1], participant[2] || participant[1])
      continue
    }

    const message = /^([A-Za-z][\w-]*?)\s*(-->>|->>|-->|->|--x|-x|==>>|=>>|==>|=>|-\)|--\))\s*([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!message) continue
    const from = message[1]
    const to = message[3]
    addParticipant(from)
    addParticipant(to)
    messages.push({
      from,
      to,
      label: cleanLabel(message[4]),
      dashed: message[2].startsWith("--") || message[2].startsWith("="),
    })
  }

  if (messages.length === 0) return undefined
  if (participants.length >= 2 && participants.length <= 5) {
    const labels = participants.map((id) => aliases.get(id) ?? id)
    const columnWidth = Math.max(12, Math.min(24, Math.max(...labels.map((label) => Bun.stringWidth(label) + 4))))
    const gap = Math.max(8, Math.min(18, Math.floor(width / Math.max(6, participants.length * 2))))
    const totalWidth = participants.length * columnWidth + (participants.length - 1) * gap
    const availableWidth = Math.max(40, width - 4)

    if (totalWidth <= availableWidth) {
      const centers = participants.map((_, index) => index * (columnWidth + gap) + Math.floor(columnWidth / 2))
      const renderParticipantRow = () => {
        const rows = [blankRow(totalWidth), blankRow(totalWidth), blankRow(totalWidth)]
        labels.forEach((label, index) => {
          const box = renderCompactBox(label, columnWidth - 2)
          const start = index * (columnWidth + gap)
          for (let row = 0; row < box.length; row++) writeVisual(rows[row], start, padVisual(box[row], columnWidth))
        })
        return rows.map((row) => row.join("").trimEnd())
      }
      const lifelineRow = () => {
        const row = blankRow(totalWidth)
        for (const center of centers) row[center] = "│"
        return row.join("").trimEnd()
      }

      const rows: string[] = [...renderParticipantRow(), lifelineRow()]
      for (const message of messages.slice(0, 10)) {
        const fromIndex = participants.indexOf(message.from)
        const toIndex = participants.indexOf(message.to)
        if (fromIndex < 0 || toIndex < 0) continue

        const start = centers[fromIndex]
        const end = centers[toIndex]
        const low = Math.min(start, end)
        const high = Math.max(start, end)
        const label = cleanLabel(message.label)
        const labelRow = blankRow(totalWidth)
        const arrowRow = blankRow(totalWidth)
        for (const center of centers) {
          labelRow[center] = "│"
          arrowRow[center] = "│"
        }

        const labelStart = Math.max(low + 1, low + Math.floor((high - low - Bun.stringWidth(label)) / 2))
        writeVisual(labelRow, labelStart, label)
        const lineGlyph = message.dashed ? "╌" : "─"
        for (let index = low + 1; index < high; index++) arrowRow[index] = lineGlyph
        arrowRow[start] = fromIndex < toIndex ? "├" : "┤"
        arrowRow[end] = fromIndex < toIndex ? "▶" : "◀"
        rows.push(labelRow.join("").trimEnd(), arrowRow.join("").trimEnd(), lifelineRow())
      }
      rows.push(...renderParticipantRow())
      return rows.join("\n")
    }
  }

  const rows: string[] = []

  for (const [index, message] of messages.slice(0, 10).entries()) {
    if (index > 0) rows.push("")
    rows.push(
      ...renderBoxConnection({
        from: aliases.get(message.from) ?? message.from,
        to: aliases.get(message.to) ?? message.to,
        label: message.label,
        connector: message.dashed ? "╌╌╌▶" : "────▶",
        width,
      }),
    )
  }

  return rows.join("\n")
}

type ErRelation = { from: string; to: string; relation: string; label: string; dotted: boolean }

function renderErTree(input: {
  relations: ErRelation[]
  attributes: Map<string, string[]>
}) {
  const outgoing = new Map<string, ErRelation[]>()
  const incoming = new Set<string>()
  const entities = new Set<string>()

  for (const relation of input.relations) {
    outgoing.set(relation.from, [...(outgoing.get(relation.from) ?? []), relation])
    incoming.add(relation.to)
    entities.add(relation.from)
    entities.add(relation.to)
  }
  for (const entity of input.attributes.keys()) entities.add(entity)

  const roots = [...entities].filter((entity) => !incoming.has(entity))
  const starts = roots.length > 0 ? roots : [...entities].slice(0, 1)
  const rendered = new Set<string>()

  const renderEntity = (entity: string, depth: number, path: Set<string>): string[] => {
    const prefix = "  ".repeat(depth)
    const lines = indentLines(renderEntityBox(entity, input.attributes.get(entity) ?? []), depth)
    rendered.add(entity)

    const children = outgoing.get(entity) ?? []
    children.slice(0, 6).forEach((relation, index) => {
      const branch = index === children.length - 1 ? "└" : "├"
      lines.push(`${prefix}${branch}─ ${relation.relation} ${relation.label}`)

      if (path.has(relation.to) || rendered.has(relation.to)) {
        lines.push(`${prefix}   ↺ ${relation.to}`)
        return
      }

      lines.push(...renderEntity(relation.to, depth + 1, new Set([...path, relation.to])))
    })

    return lines
  }

  const blocks = starts.slice(0, 6).flatMap((entity, index) => {
    const lines = rendered.has(entity) ? [`↺ ${entity}`] : renderEntity(entity, 0, new Set([entity]))
    return index === 0 ? lines : ["", ...lines]
  })

  const remaining = [...entities].filter((entity) => !rendered.has(entity))
  for (const entity of remaining.slice(0, 6)) {
    blocks.push("", ...renderEntity(entity, 0, new Set([entity])))
  }

  return blocks
}

function renderErDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines[0]?.toLowerCase() !== "erdiagram") return undefined

  const relationDefinitions: ErRelation[] = []
  const attributes = new Map<string, string[]>()
  let currentEntity: string | undefined

  for (const line of lines.slice(1)) {
    const entity = /^([A-Za-z][\w-]*)\s*\{$/.exec(line)
    if (entity) {
      currentEntity = entity[1]
      attributes.set(currentEntity, [])
      continue
    }

    if (line === "}") {
      currentEntity = undefined
      continue
    }

    if (currentEntity) {
      attributes.set(currentEntity, [...(attributes.get(currentEntity) ?? []), cleanLabel(line)])
      continue
    }

    const relation = /^([A-Za-z][\w-]*)\s+([|o}{]{1,2}(?:--|\.\.)[|o}{]{1,2})\s+([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!relation) continue
    relationDefinitions.push({
      from: relation[1],
      to: relation[3],
      relation: relation[2],
      label: cleanConnectorLabel(relation[4]),
      dotted: relation[2].includes(".."),
    })
  }

  if (relationDefinitions.length === 0 && attributes.size === 0) return undefined
  const availableWidth = Math.max(40, width - 4)
  if (relationDefinitions.length > 0) {
    const tree = renderErTree({ relations: relationDefinitions, attributes })
    const maxWidth = Math.max(...tree.map((line) => Bun.stringWidth(line)), 0)
    if (maxWidth <= availableWidth) return tree.join("\n")
    return tree.flatMap((line) => wrapTextLine("", line, width)).join("\n")
  }

  const renderedAttributes = [...attributes.entries()].slice(0, 6).flatMap(([entity, fields], index) => {
    const lines = renderEntityBox(entity, fields)
    return index === 0 ? lines : ["", ...lines]
  })

  return renderedAttributes.join("\n")
}

function renderStateDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^stateDiagram(?:-v2)?$/i.test(lines[0] ?? "")) return undefined

  const aliases = new Map<string, string>()
  const transitions: Array<{ from: string; to: string; label?: string }> = []

  for (const line of lines.slice(1)) {
    const stateAlias = /^state\s+"([^"]+)"\s+as\s+([A-Za-z][\w-]*)$/i.exec(line)
    if (stateAlias) {
      aliases.set(stateAlias[2], cleanLabel(stateAlias[1]))
      continue
    }

    const transition = /^(\[\*\]|[A-Za-z][\w-]*)\s*-->\s*(\[\*\]|[A-Za-z][\w-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (!transition) continue
    transitions.push({
      from: transition[1],
      to: transition[2],
      label: cleanLabel(transition[3]) || undefined,
    })
  }

  if (transitions.length === 0) return undefined
  let terminalSeen = false
  const labelFor = (id: string) => {
    if (id !== "[*]") return aliases.get(id) ?? id
    if (!terminalSeen) {
      terminalSeen = true
      return "●"
    }
    return "◉"
  }
  const availableWidth = Math.max(40, width - 4)
  const outgoing = new Map<string, Array<{ to: string; label?: string }>>()
  const incoming = new Set<string>()
  for (const transition of transitions) {
    outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), { to: transition.to, label: transition.label }])
    incoming.add(transition.to)
  }
  const starts = [...outgoing.keys()].filter((state) => !incoming.has(state) || state === "[*]")
  const first = starts[0] ?? transitions[0]?.from
  if (!first) return undefined

  const renderNode = (state: string, path: Set<string>, depth = 0): string[] => {
    const lines = indentLines(renderStateBox(labelFor(state)), depth)
    const next = outgoing.get(state) ?? []
    if (next.length === 0) return lines

    if (next.length === 1) {
      const edge = next[0]
      lines.push(`${"  ".repeat(depth)}      │`)
      if (edge.label) lines.push(`${"  ".repeat(depth)}      ${cleanConnectorLabel(edge.label)}`)
      lines.push(`${"  ".repeat(depth)}      ▼`)
      if (edge.to === "[*]" && state !== "[*]") return [...lines, ...renderNode(edge.to, new Set([...path, edge.to]), depth)]
      if (path.has(edge.to)) {
        lines.push(`${"  ".repeat(depth)}      ↺ ${aliases.get(edge.to) ?? edge.to}`)
        return lines
      }
      return [...lines, ...renderNode(edge.to, new Set([...path, edge.to]), depth)]
    }

    for (const [index, edge] of next.slice(0, 6).entries()) {
      const isLast = index === next.length - 1 || index === 5
      const branch = isLast ? "└" : "├"
      const label = edge.label ? cleanConnectorLabel(edge.label) : `path ${index + 1}`
      const prefix = "  ".repeat(depth)
      const childPrefix = `${prefix}${isLast ? "   " : "│  "}`
      if (index > 0) lines.push("")
      lines.push(`${prefix}${branch}─ ${label}`)
      if (edge.to === "[*]" && state !== "[*]") {
        lines.push(...renderNode(edge.to, new Set([...path, edge.to]), 0).map((line) => `${childPrefix}${line}`))
        continue
      }
      if (path.has(edge.to)) {
        lines.push(`${childPrefix}↺ ${aliases.get(edge.to) ?? edge.to}`)
        continue
      }
      lines.push(...renderNode(edge.to, new Set([...path, edge.to]), 0).map((line) => `${childPrefix}${line}`))
    }
    return lines
  }

  const rendered = renderNode(first, new Set([first])).slice(0, 60)
  const maxWidth = Math.max(...rendered.map((line) => Bun.stringWidth(line)), 0)
  if (maxWidth <= availableWidth) return rendered.join("\n")
  return rendered.flatMap((line) => (Bun.stringWidth(line) <= availableWidth ? [line] : wrapTextLine("", line, width))).join("\n")
}

function renderClassDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^classDiagram(?:-v2)?$/i.test(lines[0] ?? "")) return undefined

  const classes = new Map<string, string[]>()
  const relations: Array<{ from: string; to: string; relation: string; label?: string }> = []
  let currentClass: string | undefined

  const ensureClass = (name: string) => {
    if (!classes.has(name)) classes.set(name, [])
  }

  for (const line of lines.slice(1)) {
    if (line === "}") {
      currentClass = undefined
      continue
    }

    if (currentClass) {
      classes.set(currentClass, [...(classes.get(currentClass) ?? []), cleanLabel(line)])
      continue
    }

    const blockStart = /^class\s+([A-Za-z][\w-]*)\s*\{$/.exec(line)
    if (blockStart) {
      currentClass = blockStart[1]
      ensureClass(currentClass)
      continue
    }

    const relation = /^([A-Za-z][\w-]*)\s+([<|o*}.\-]+--?[|>o*{.\-]+)\s+([A-Za-z][\w-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (relation) {
      ensureClass(relation[1])
      ensureClass(relation[3])
      relations.push({ from: relation[1], to: relation[3], relation: relation[2], label: cleanLabel(relation[4]) || undefined })
      continue
    }

    const member = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(line)
    if (member) {
      ensureClass(member[1])
      classes.set(member[1], [...(classes.get(member[1]) ?? []), cleanLabel(member[2])])
      continue
    }

    const classLine = /^class\s+([A-Za-z][\w-]*)/.exec(line)
    if (classLine) ensureClass(classLine[1])
  }

  if (classes.size === 0 && relations.length === 0) return undefined
  const availableWidth = Math.max(40, width - 4)
  const childrenByParent = new Map<string, Array<{ child: string; relation: string; label?: string }>>()
  const incoming = new Set<string>()
  for (const relation of relations) {
    const parent = relation.relation.includes("<|") || relation.relation.includes("<--") ? relation.from : relation.to
    const child = parent === relation.from ? relation.to : relation.from
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), { child, relation: relation.relation, label: relation.label }])
    incoming.add(child)
  }

  const rendered = new Set<string>()
  const renderClass = (name: string, depth: number): string[] => {
    rendered.add(name)
    const prefix = "  ".repeat(depth)
    const lines = indentLines(renderEntityBox(name, classes.get(name) ?? []), depth)
    const children = childrenByParent.get(name) ?? []
    for (const [index, child] of children.slice(0, 6).entries()) {
      const isLast = index === children.length - 1 || index === 5
      lines.push(`${prefix}${isLast ? "└" : "├"}─△ ${child.label ? `${child.label} ` : ""}${child.child}`)
      if (rendered.has(child.child)) {
        lines.push(`${prefix}${isLast ? "   " : "│  "}↺ ${child.child}`)
        continue
      }
      lines.push(...renderClass(child.child, depth + 1))
    }
    return lines
  }

  const roots = [...classes.keys()].filter((name) => !incoming.has(name))
  const blocks = (roots.length ? roots : [...classes.keys()]).slice(0, 6).flatMap((name, index) => {
    const block = rendered.has(name) ? [`↺ ${name}`] : renderClass(name, 0)
    return index === 0 ? block : ["", ...block]
  })
  for (const name of [...classes.keys()].filter((item) => !rendered.has(item)).slice(0, 6)) blocks.push("", ...renderClass(name, 0))

  const output = blocks.slice(0, 80)
  const maxWidth = Math.max(...output.map((line) => Bun.stringWidth(line)), 0)
  if (maxWidth <= availableWidth) return output.join("\n")
  return output.flatMap((line) => (Bun.stringWidth(line) <= availableWidth ? [line] : wrapTextLine("", line, width))).join("\n")
}

function renderPieChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const head = /^pie(?:\s+showData)?(?:\s+title\s+(.+))?$/i.exec(lines[0] ?? "")
  if (!head) return undefined

  let title: string | undefined = cleanLabel(head[1])
  const slices: Array<{ label: string; value: number }> = []
  for (const line of lines.slice(1)) {
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1])
      continue
    }
    const slice = /^"?([^":]+)"?\s*:\s*([0-9.]+)$/.exec(line)
    if (slice) slices.push({ label: cleanLabel(slice[1]), value: Number(slice[2]) })
  }

  if (slices.length === 0) return undefined
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1
  const labelWidth = Math.min(22, Math.max(...slices.map((slice) => Bun.stringWidth(slice.label)), 8))
  const barWidth = Math.max(8, Math.min(28, width - labelWidth - 22))
  const rows = slices.slice(0, 12).map((slice) => {
    const percent = (slice.value / total) * 100
    const filled = Math.max(1, Math.round((percent / 100) * barWidth))
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled))
    return `${padVisual(slice.label, labelWidth)} │${bar}│ ${slice.value} (${percent.toFixed(1)}%)`
  })

  return [title, title ? "─".repeat(Math.min(Bun.stringWidth(title), width - 4)) : undefined, ...rows, `Total: ${total}`]
    .filter(Boolean)
    .join("\n")
}

type GanttTask = {
  section: string
  label: string
  id?: string
  start?: number
  end?: number
  after?: string
  duration: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function parseGanttDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(time) ? undefined : Math.floor(time / DAY_MS)
}

function formatGanttDate(day: number) {
  const date = new Date(day * DAY_MS)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

function parseGanttDuration(value: string) {
  const match = /^(\d+)\s*d(?:ays?)?$/i.exec(value)
  return match ? Math.max(1, Number(match[1])) : undefined
}

function renderGanttChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^gantt$/i.test(lines[0] ?? "")) return undefined

  let title = "Gantt"
  let dateFormat = ""
  let section = "Tasks"
  const tasks: GanttTask[] = []

  for (const line of lines.slice(1)) {
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]) || title
      continue
    }
    const dateFormatMatch = /^dateFormat\s+(.+)$/i.exec(line)
    if (dateFormatMatch) {
      dateFormat = cleanLabel(dateFormatMatch[1])
      continue
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(line)
    if (sectionMatch) {
      section = cleanLabel(sectionMatch[1]) || section
      continue
    }
    if (/^(axisFormat|tickInterval|todayMarker|excludes|inclusiveEndDates)\b/i.test(line)) continue

    const task = /^(.+?)\s*:\s*(.+)$/.exec(line)
    if (!task) continue
    const parts = task[2]
      .split(",")
      .map(cleanLabel)
      .filter(Boolean)
    let id: string | undefined
    let start: number | undefined
    let end: number | undefined
    let after: string | undefined
    let duration = 1

    for (const part of parts) {
      const lower = part.toLowerCase()
      if (/^(active|done|crit|milestone)$/.test(lower)) continue
      const parsedDate = parseGanttDate(part)
      if (parsedDate !== undefined) {
        if (start === undefined) start = parsedDate
        else end = parsedDate
        continue
      }
      const parsedDuration = parseGanttDuration(part)
      if (parsedDuration !== undefined) {
        duration = parsedDuration
        continue
      }
      const afterMatch = /^after\s+(.+)$/i.exec(part)
      if (afterMatch) {
        after = cleanLabel(afterMatch[1]).split(/\s+/)[0]
        continue
      }
      if (!id) id = part.split(/\s+/)[0]
    }

    tasks.push({ section, label: cleanLabel(task[1]), id, start, end, after, duration })
  }

  if (tasks.length === 0) return undefined

  const byID = new Map<string, GanttTask>()
  let cursor = tasks.find((task) => task.start !== undefined)?.start ?? Math.floor(Date.now() / DAY_MS)
  for (const task of tasks) {
    if (task.after && byID.has(task.after)) {
      const dependency = byID.get(task.after)
      if (dependency?.end !== undefined) task.start = dependency.end + 1
    }
    if (task.start === undefined) task.start = cursor
    if (task.end === undefined) task.end = task.start + task.duration - 1
    task.duration = Math.max(1, task.end - task.start + 1)
    cursor = task.end + 1
    if (task.id) byID.set(task.id, task)
  }

  const resolved = tasks.filter((task): task is GanttTask & { start: number; end: number } => task.start !== undefined && task.end !== undefined)
  if (resolved.length === 0) return undefined

  const start = Math.min(...resolved.map((task) => task.start))
  const end = Math.max(...resolved.map((task) => task.end))
  const totalDays = Math.max(1, end - start + 1)
  const available = Math.max(56, Math.min(120, width - 4))
  const nameWidth = Math.min(24, Math.max(10, ...resolved.map((task) => Bun.stringWidth(task.label))))
  const rangeWidth = 13
  const timelineWidth = Math.max(12, available - nameWidth - rangeWidth - 4)
  const scale = Math.max(1, timelineWidth / totalDays)
  const border = `${"─".repeat(nameWidth + 2)}┬${"─".repeat(timelineWidth + 2)}┬${"─".repeat(rangeWidth + 2)}`
  const top = `┌${border}┐`
  const mid = `├${border.replaceAll("┬", "┼")}┤`
  const bottom = `└${border.replaceAll("┬", "┴")}┘`
  const rulerCells = Array.from({ length: timelineWidth }, () => "─")
  for (let day = 1; day <= totalDays; day++) {
    if (day !== 1 && day !== totalDays && day % 5 !== 0) continue
    const label = String(day)
    const offset = Math.min(timelineWidth - label.length, Math.max(0, Math.round((day - 1) * scale)))
    for (let index = 0; index < label.length && offset + index < rulerCells.length; index++) {
      rulerCells[offset + index] = label[index]
    }
  }
  const ruler = rulerCells.join("")

  const output: string[] = [title]
  if (dateFormat) output.push(`dateFormat ${dateFormat}`)
  output.push(top)
  output.push(`│ ${padCell("Task", nameWidth)} │ ${ruler} │ ${padCell(`${formatGanttDate(start)}-${formatGanttDate(end)}`, rangeWidth)} │`)
  output.push(mid)

  let previousSection = ""
  for (const task of resolved.slice(0, 18)) {
    if (task.section !== previousSection) {
      previousSection = task.section
      output.push(`│ ${padCell(task.section, nameWidth)} │ ${" ".repeat(timelineWidth)} │ ${" ".repeat(rangeWidth)} │`)
    }
    const barStart = Math.max(0, Math.floor((task.start - start) * scale))
    const barEnd = Math.min(timelineWidth - 1, Math.max(barStart, Math.ceil((task.end - start + 1) * scale) - 1))
    const bar = Array.from({ length: timelineWidth }, (_, index) =>
      index >= barStart && index <= barEnd ? (index === barStart ? "█" : "▓") : " ",
    ).join("")
    const range = `${formatGanttDate(task.start)}-${formatGanttDate(task.end)}`
    output.push(`│ ${padCell(task.label, nameWidth)} │ ${bar} │ ${padCell(range, rangeWidth)} │`)
  }
  output.push(bottom)
  return output.join("\n")
}

function renderIndentedMermaid(input: string, heads: RegExp, title: string): string | undefined {
  const lines = input.split("\n")
  if (!heads.test(lines[0]?.trim() ?? "")) return undefined
  const body = lines
    .slice(1)
    .map((line) => line.replace(/\t/g, "  ").trimEnd())
    .filter((line) => line.trim() && !/^title\s+/i.test(line.trim()))
  if (body.length === 0) return undefined

  const baseIndent = Math.min(...body.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
  const output: string[] = [title]
  for (const line of body.slice(0, 24)) {
    const indent = Math.floor(Math.max(0, (line.match(/^\s*/)?.[0].length ?? 0) - baseIndent) / 2)
    const text = cleanLabel(line.trim().replace(/^section\s+/i, ""))
    const glyph = indent === 0 ? "•" : indent === 1 ? "◦" : "▪"
    output.push(`${"  ".repeat(indent)}${glyph} ${text}`)
  }
  return output.join("\n")
}

function stripMermaidCallArguments(input: string) {
  const inside = input.slice(input.indexOf("(") + 1, input.lastIndexOf(")"))
  const parts: string[] = []
  let current = ""
  let quoted = false
  for (const char of inside) {
    if (char === '"') quoted = !quoted
    if (char === "," && !quoted) {
      parts.push(cleanLabel(current))
      current = ""
      continue
    }
    current += char
  }
  if (current) parts.push(cleanLabel(current))
  return parts.filter(Boolean)
}

function renderQuadrantChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^quadrantChart$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Quadrant chart"]
  for (const line of lines.slice(1, 18)) {
    const title = /^title\s+(.+)$/i.exec(line)
    if (title) {
      output[0] = cleanLabel(title[1])
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      output.push(`${axis[1]}: ${cleanLabel(axis[2])}`)
      continue
    }
    const point = /^(.+?)\s*:\s*\[([^\]]+)\]$/.exec(line)
    if (point) output.push(`• ${cleanLabel(point[1])} (${cleanLabel(point[2])})`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderGitGraph(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^gitGraph\b/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Git graph"]
  let currentBranch = "main"
  for (const line of lines.slice(1, 24)) {
    const commit = /^commit(?:\s+id:\s*"?([^"]+)"?)?/i.exec(line)
    if (commit) {
      output.push(`${padVisual(currentBranch, 12)} ● ${cleanLabel(commit[1]) || "commit"}`)
      continue
    }
    const branch = /^branch\s+(.+)$/i.exec(line)
    if (branch) {
      output.push(`${padVisual(currentBranch, 12)} ├─ ${cleanLabel(branch[1])}`)
      continue
    }
    const checkout = /^checkout\s+(.+)$/i.exec(line)
    if (checkout) {
      currentBranch = cleanLabel(checkout[1]) || currentBranch
      output.push(`${padVisual(currentBranch, 12)} ↳ checkout`)
      continue
    }
    const merge = /^merge\s+(.+)$/i.exec(line)
    if (merge) output.push(`${padVisual(currentBranch, 12)} ⇄ merge ${cleanLabel(merge[1])}`)
  }
  return output.length > 1 ? output.join("\n") : undefined
}

function renderRequirementDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^requirementDiagram$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Requirement diagram"]
  let current: string | undefined
  for (const line of lines.slice(1, 32)) {
    const block = /^(requirement|functionalRequirement|performanceRequirement|interfaceRequirement|physicalRequirement|designConstraint)\s+([A-Za-z][\w-]*)\s*\{?$/i.exec(line)
    if (block) {
      current = block[2]
      output.push(renderInlineBox(current))
      continue
    }
    if (line === "}") {
      current = undefined
      continue
    }
    const field = /^(id|text|risk|verifymethod|verifyMethod):\s*(.+)$/i.exec(line)
    if (field && current) {
      output.push(`  ${field[1]}: ${cleanLabel(field[2])}`)
      continue
    }
    const relation = /^([A-Za-z][\w-]*)\s+-\s*([A-Za-z]+)\s*->\s*([A-Za-z][\w-]*)$/i.exec(line)
    if (relation) output.push(`${renderInlineBox(relation[1])} ── ${relation[2]} ─▶ ${renderInlineBox(relation[3])}`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderC4Diagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^C4/i.test(lines[0] ?? "")) return undefined

  const output: string[] = [cleanLabel(lines[0])]
  for (const line of lines.slice(1, 32)) {
    const entity = /^(Person|System|System_Boundary|Container|ContainerDb|Component|Boundary)\s*\((.+)\)$/i.exec(line)
    if (entity) {
      const args = stripMermaidCallArguments(entity[2])
      output.push(`${entity[1]}: ${renderInlineBox(args[1] || args[0] || "item")}${args[2] ? `  ${args[2]}` : ""}`)
      continue
    }
    const relation = /^Rel(?:_[A-Za-z]+)?\s*\((.+)\)$/i.exec(line)
    if (relation) {
      const args = stripMermaidCallArguments(relation[1])
      output.push(`${renderInlineBox(args[0] || "from")} ── ${args[2] || "relates"} ─▶ ${renderInlineBox(args[1] || "to")}`)
    }
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderXyChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^xychart-beta$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["XY chart"]
  for (const line of lines.slice(1, 24)) {
    const title = /^title\s+"?([^"]+)"?$/i.exec(line)
    if (title) {
      output[0] = cleanLabel(title[1])
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      output.push(`${axis[1]}: ${cleanLabel(axis[2])}`)
      continue
    }
    const series = /^(bar|line)\s+\[([^\]]+)\]$/i.exec(line)
    if (series) output.push(`${series[1]}: ${cleanLabel(series[2])}`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderSankeyDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^sankey-beta$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Sankey"]
  for (const line of lines.slice(1, 24)) {
    const parts = line.split(",").map(cleanLabel).filter(Boolean)
    if (parts.length >= 3) output.push(`${renderInlineBox(parts[0])} ── ${parts[2]} ─▶ ${renderInlineBox(parts[1])}`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderBlockDiagram(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^block-beta$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Block diagram"]
  for (const line of lines.slice(1, 20)) {
    if (/^columns\s+/i.test(line)) continue
    const labels = [...line.matchAll(/([A-Za-z][\w-]*)(?:\["([^"]+)"\]|\[([^\]]+)\])?/g)].map((match) =>
      renderInlineBox(match[2] || match[3] || match[1]),
    )
    if (labels.length) output.push(labels.join(" ── "))
  }
  return output.length > 1 ? output.join("\n") : undefined
}

function renderPacketDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^packet-beta$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Packet"]
  for (const line of lines.slice(1, 24)) {
    const field = /^([0-9]+(?:-[0-9]+)?)\s*:\s*"?([^"]+)"?$/.exec(line)
    if (field) output.push(`${padVisual(field[1], 8)} │ ${cleanLabel(field[2])}`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderArchitectureDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^architecture-beta$/i.test(lines[0] ?? "")) return undefined

  const output: string[] = ["Architecture"]
  for (const line of lines.slice(1, 32)) {
    const service = /^service\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\]/i.exec(line)
    if (service) {
      output.push(`${renderInlineBox(service[1])} ${cleanLabel(service[2])}  ${cleanLabel(service[3])}`)
      continue
    }
    const group = /^group\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\]/i.exec(line)
    if (group) {
      output.push(`Group ${renderInlineBox(group[1])} ${cleanLabel(group[3])}`)
      continue
    }
    const edge = /^([A-Za-z][\w-]*)(?::[A-Z])?\s*--\s*(?:[A-Z]:)?([A-Za-z][\w-]*)$/i.exec(line)
    if (edge) output.push(`${renderInlineBox(edge[1])} ──▶ ${renderInlineBox(edge[2])}`)
  }
  return output.length > 1 ? output.flatMap((line) => wrapTextLine("", line, width)).join("\n") : undefined
}

function renderSimpleMermaid(input: string, width: number): string | undefined {
  return (
    renderSimpleFlowchart(input, width) ??
    renderStateDiagram(input, width) ??
    renderSequenceDiagram(input, width) ??
    renderErDiagram(input, width) ??
    renderClassDiagram(input, width) ??
    renderPieChart(input, width) ??
    renderGanttChart(input, width) ??
    renderQuadrantChart(input, width) ??
    renderGitGraph(input) ??
    renderRequirementDiagram(input, width) ??
    renderC4Diagram(input, width) ??
    renderXyChart(input, width) ??
    renderSankeyDiagram(input, width) ??
    renderBlockDiagram(input) ??
    renderPacketDiagram(input, width) ??
    renderArchitectureDiagram(input, width) ??
    renderIndentedMermaid(input, /^mindmap$/i, "Mindmap") ??
    renderIndentedMermaid(input, /^timeline$/i, "Timeline") ??
    renderIndentedMermaid(input, /^journey$/i, "Journey") ??
    renderIndentedMermaid(input, /^kanban$/i, "Kanban")
  )
}

async function runTermaid(input: string, width: number): Promise<string | undefined> {
  const bin = resolveTermaid()
  if (!bin) return undefined

  return await new Promise<string | undefined>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(
      bin,
      ["--width", String(Math.max(40, Math.min(160, width))), "--padding-x", "2", "--padding-y", "1", "--gap", "2"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      },
    )

    let stdout = ""
    let stderr = ""
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(undefined)
    }, TERMAID_TIMEOUT_MS)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, "utf8") > MAX_TERMAID_OUTPUT_BYTES) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (Buffer.byteLength(stderr, "utf8") > MAX_TERMAID_OUTPUT_BYTES) child.kill("SIGKILL")
    })
    child.on("error", () => {
      finish(undefined)
    })
    child.on("close", (code) => {
      if (code !== 0) {
        finish(undefined)
        return
      }
      const output = cleanOutput(stdout || stderr)
      finish(output || undefined)
    })
    child.stdin.end(input)
  })
}

export async function renderPlanMarkdown(
  markdown: string,
  width: number,
  options: RenderPlanMarkdownOptions = {},
): Promise<string> {
  const source =
    Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES ? markdown.slice(0, MAX_MARKDOWN_BYTES) : markdown
  const blocks = [...source.matchAll(/```[ \t]*mermaid[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)]
  if (blocks.length === 0) return renderMarkdownForTui(source, width, options)

  let result = ""
  let cursor = 0
  let rendered = 0

  for (const match of blocks) {
    const index = match.index ?? 0
    result += source.slice(cursor, index)
    cursor = index + match[0].length

    const diagram = match[1] ?? ""
    if (rendered >= MAX_MERMAID_BLOCKS || Buffer.byteLength(diagram, "utf8") > MAX_MERMAID_BYTES) {
      result += match[0]
      continue
    }

    const output = renderSimpleMermaid(diagram, width) ?? (await runTermaid(diagram, width))
    if (!output) {
      result += match[0]
      continue
    }

    rendered++
    const heading = popTrailingHeading(result)
    result = heading.prefix
    const renderedDiagram = output.trimEnd()
    const block = alignTextBlock(
      heading.title ? [heading.title, "", renderedDiagram].join("\n") : renderedDiagram,
      width,
    )
    result += ["```text", block, "```"].join("\n")
  }

  result += source.slice(cursor)
  return renderMarkdownForTui(result, width, options)
}

export function renderPlanMarkdownStatic(
  markdown: string,
  width: number,
  options: RenderPlanMarkdownOptions = {},
): string {
  const source =
    Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES ? markdown.slice(0, MAX_MARKDOWN_BYTES) : markdown
  const blocks = [...source.matchAll(/```[ \t]*mermaid[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)]
  if (blocks.length === 0) return renderMarkdownForTui(source, width, options)

  let result = ""
  let cursor = 0
  let rendered = 0

  for (const match of blocks) {
    const index = match.index ?? 0
    result += source.slice(cursor, index)
    cursor = index + match[0].length

    const diagram = match[1] ?? ""
    if (rendered >= MAX_MERMAID_BLOCKS || Buffer.byteLength(diagram, "utf8") > MAX_MERMAID_BYTES) {
      result += match[0]
      continue
    }

    const output = renderSimpleMermaid(diagram, width)
    if (!output) {
      result += match[0]
      continue
    }

    rendered++
    const heading = popTrailingHeading(result)
    result = heading.prefix
    const renderedDiagram = output.trimEnd()
    const block = alignTextBlock(
      heading.title ? [heading.title, "", renderedDiagram].join("\n") : renderedDiagram,
      width,
    )
    result += ["```text", block, "```"].join("\n")
  }

  result += source.slice(cursor)
  return renderMarkdownForTui(result, width, options)
}

function streamingOptionsKey(options: RenderPlanMarkdownOptions) {
  return `${options.tableMode ?? ""}:${options.markdownMode ?? ""}`
}

export function renderPlanMarkdownStreaming(
  markdown: string,
  width: number,
  options: RenderPlanMarkdownOptions = {},
  previous?: StreamingPlanMarkdownState,
): { content: string; tail: string; state: StreamingPlanMarkdownState } {
  const optionsKey = streamingOptionsKey(options)
  const commitIndex = streamingMarkdownCommitIndex(markdown)
  const previousIsReusable =
    !!previous &&
    previous.width === width &&
    previous.optionsKey === optionsKey &&
    commitIndex >= previous.sourceCursor &&
    markdown.slice(0, previous.sourceCursor) === previous.sourcePrefix

  let state: StreamingPlanMarkdownState = previousIsReusable
    ? previous
    : {
        sourceCursor: 0,
        sourcePrefix: "",
        renderedPrefix: "",
        width,
        optionsKey,
      }

  if (commitIndex > state.sourceCursor) {
    const sourcePrefix = markdown.slice(0, commitIndex)
    state = {
      sourceCursor: commitIndex,
      sourcePrefix,
      renderedPrefix: renderPlanMarkdownStatic(sourcePrefix, width, options),
      width,
      optionsKey,
    }
  }

  return {
    content: state.renderedPrefix,
    tail: markdown.slice(state.sourceCursor),
    state,
  }
}

function renderStableStreamingMarkdown(markdown: string, finalized: boolean, width: number) {
  if (finalized || markdown.endsWith("\n")) return wrapStreamingText(renderStreamingMarkdownText(markdown), width)

  const lastLineStart = markdown.lastIndexOf("\n") + 1
  if (lastLineStart <= 0) return wrapStreamingText(markdown, width)

  const stable = markdown.slice(0, lastLineStart)
  const live = markdown.slice(lastLineStart)
  return `${wrapStreamingText(renderStreamingMarkdownText(stable), width)}${wrapStreamingText(renderLiveStreamingLine(live), width)}`
}

export function renderStreamingMarkdownTail(
  markdown: string,
  width: number,
  options: RenderPlanMarkdownOptions = {},
  state: { finalized?: boolean } = {},
) {
  if (options.tableMode !== "grid") return renderStableStreamingMarkdown(markdown, state.finalized ?? false, width)

  const lines = markdown.split("\n")
  const result: string[] = []
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const current = lines[index] ?? ""

    if (isFenceLine(current)) {
      inFence = !inFence
      result.push(current)
      continue
    }

    if (inFence) {
      result.push(current)
      continue
    }

    const next = lines[index + 1]
    if (next && isMarkdownTableRow(current) && isMarkdownTableSeparator(next)) {
      const table = [current, next]
      index += 2
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        table.push(lines[index] ?? "")
        index++
      }
      result.push(...renderLiveMarkdownTableAsGrid(table, width))
      index--
      continue
    }

    result.push(...wrapStreamingTextLine(current, width))
  }

  return renderStableStreamingMarkdown(result.join("\n"), state.finalized ?? false, width)
}

export function hasMermaidFence(markdown: string): boolean {
  return MERMAID_FENCE_PATTERN.test(markdown)
}
