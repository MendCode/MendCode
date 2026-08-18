import { spawn } from "child_process"
import stripAnsi from "strip-ansi"
import { which } from "@/util/which"
import { normalizeHexColor } from "./hex-colors"

const MAX_MARKDOWN_BYTES = 50_000
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
const MERMAID_OPEN_PATTERN = /(^|\r?\n)([ \t]*)(`{3,}|~{3,})[ \t]*mermaid(?:[^\r\n]*)?(?:\r?\n|$)/gim

type MermaidBlock = {
  start: number
  end: number
  diagram: string
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractMermaidBlocks(input: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  MERMAID_OPEN_PATTERN.lastIndex = 0

  for (const opening of input.matchAll(MERMAID_OPEN_PATTERN)) {
    const openingStart = (opening.index ?? 0) + (opening[1]?.length ?? 0)
    const bodyStart = (opening.index ?? 0) + opening[0].length
    const fence = opening[3] ?? "```"
    const closePattern = new RegExp(
      `^[ \\t]*${escapeRegExp(fence[0] ?? "`")}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    )
    closePattern.lastIndex = bodyStart
    const closing = closePattern.exec(input)
    if (!closing) {
      blocks.push({
        start: openingStart,
        end: input.length,
        diagram: input.slice(bodyStart).replace(/(?:\r?\n)+$/, ""),
      })
      break
    }

    const rawDiagram = input.slice(bodyStart, closing.index ?? bodyStart)
    const diagram = rawDiagram.replace(/(?:\r?\n)+$/, "")
    const end = (closing.index ?? bodyStart) + closing[0].length
    blocks.push({
      start: openingStart,
      end,
      diagram,
    })
    MERMAID_OPEN_PATTERN.lastIndex = end
  }

  return blocks
}

export function extractMermaidSources(input: string) {
  return extractMermaidBlocks(input).map((block) => block.diagram)
}

function mermaidKind(input: string) {
  const first = preparedMermaidLines(input)[0]
  if (!first) return "diagram"
  const match = /^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|erDiagram|[A-Za-z][\w-]*)\b/i.exec(first)
  return match?.[1] ?? "diagram"
}

function mermaidDisplayKind(input: string) {
  const kind = mermaidKind(input).toLowerCase()
  const labels: Record<string, string> = {
    flowchart: "flow",
    graph: "flow",
    sequencediagram: "sequence",
    statediagram: "state",
    "statediagram-v2": "state",
    erdiagram: "entities",
    classdiagram: "classes",
    "classdiagram-v2": "classes",
    pie: "distribution",
    mindmap: "tree",
    timeline: "timeline",
    journey: "journey",
    gantt: "schedule",
    quadrantchart: "quadrant",
    gitgraph: "git",
    requirementdiagram: "requirements",
    c4context: "C4",
    "block-beta": "blocks",
    packet: "packet",
    "packet-beta": "packet",
    "architecture-beta": "architecture",
    "xychart-beta": "xy chart",
    sankey: "sankey",
    "sankey-beta": "sankey",
    "swimlane-beta": "swimlane",
    zenuml: "ZenUML",
    "radar-beta": "radar",
    eventmodeling: "event modeling",
    "treemap-beta": "treemap",
    "venn-beta": "Venn",
    "ishikawa-beta": "Ishikawa",
    "wardley-beta": "Wardley",
    "cynefin-beta": "Cynefin",
    "treeview-beta": "TreeView",
  }
  return labels[kind] ?? (kind.replace(/(?:diagram|chart|(?:-beta))$/i, "") || "diagram")
}

function preparedMermaidLines(input: string) {
  const lines: string[] = []
  let inFrontmatter = false
  let inDirective = false
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (lines.length === 0 && line === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false
      continue
    }
    if (inDirective) {
      if (line.includes("}%%")) inDirective = false
      continue
    }
    if (line.startsWith("%%{")) {
      if (!line.includes("}%%")) inDirective = true
      continue
    }
    if (line.startsWith("%%")) continue
    lines.push(line)
  }
  return lines
}

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
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  const width = Math.max(10, Bun.stringWidth(text) + 2)
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

function renderEntityBox(label: string, fields: string[]) {
  if (fields.length === 0) return renderBox(label)

  const name = cleanMermaidLabel(label) || cleanLabel(label) || "entity"
  const fieldLines = fields.map((field) => cleanMermaidLabel(field) || cleanLabel(field)).filter(Boolean)
  const width = Math.max(10, Bun.stringWidth(name) + 2, ...fieldLines.map((field) => Bun.stringWidth(field) + 2))
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
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  return `┌ ${text} ┐`
}

function renderCompactBox(label: string, minWidth = 8) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "item"
  const width = Math.max(minWidth, Bun.stringWidth(text) + 2)
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

function renderStateBox(label: string) {
  const display = cleanMermaidLabel(label) || cleanLabel(label)
  const width = display === "●" || display === "◉" ? 5 : Math.max(12, Bun.stringWidth(display) + 2)
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
  return trimmed.includes("|") && !/^(`{3,}|~{3,})/.test(trimmed)
}

function isFenceLine(line: string) {
  return /^\s*(?:`{3,}|~{3,})/.test(line)
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

export function visibleStreamingMarkdownPreview(input: string) {
  const end = input.lastIndexOf("\n")
  if (end < 0) return ""
  return input.slice(0, end + 1)
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
    if (isFenceLine(line)) {
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
    if (isFenceLine(line)) {
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
    if (isFenceLine(line)) {
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

function mermaidSourceLine(input: string) {
  return cleanMermaidLabel(input)
    .replace(/--!?>\|([^|]+)\|/g, "── $1 ─▶")
    .replace(/-->/g, "──▶")
    .replace(/-\.->/g, "╌╌▶")
    .replace(/==>/g, "━━▶")
}

function renderMermaidSourceFallback(input: string, width: number) {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"))
    .filter((line) => !/^(?:style|classDef|class|click|linkStyle)\b/i.test(line))
  const body = lines.slice(1, 80).flatMap((line) => wrapTextLine("• ", mermaidSourceLine(line), width))
  if (lines.length > 81) body.push(`• … ${lines.length - 81} líneas omitidas por límite de seguridad`)
  return [`ASCII source fallback: ${mermaidDisplayKind(input)}`, ...body].join("\n")
}

function renderMermaidCanvas(output: string, input: string, width: number) {
  const diagramLines = output.trimEnd().split("\n")
  const title = ` Mermaid ASCII · ${mermaidDisplayKind(input)} `
  const contentWidth = Math.max(Bun.stringWidth(title), ...diagramLines.map((line) => Bun.stringWidth(line)), 20)
  const requestedWidth = Math.max(40, Math.floor(width) - 8)
  const cardWidth = Math.max(requestedWidth, contentWidth + 4)
  const innerWidth = cardWidth - 2
  const titleWidth = Bun.stringWidth(title)
  const top = `╭${title}${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`
  const blockPadding = Math.max(0, Math.floor((innerWidth - contentWidth) / 2))
  const blockRightPadding = Math.max(0, innerWidth - contentWidth - blockPadding)
  const rows = diagramLines.map((line) =>
    `│${" ".repeat(blockPadding)}${padVisual(line, contentWidth)}${" ".repeat(blockRightPadding)}│`,
  )
  const bottom = `╰${"─".repeat(innerWidth)}╯`
  return [top, ...rows, bottom].join("\n")
}

type FlowDirection = "td" | "tb" | "lr" | "rl" | "bt"

type FlowchartEdge = { from: string; to: string; label?: string }
type FlowchartNodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "circle"
  | "double-circle"
  | "diamond"
  | "cylinder"
  | "subroutine"
  | "parallelogram"
  | "trapezoid"
  | "hexagon"
  | "asymmetric"
  | (string & {})
type FlowchartRoutedEdge = { edge: FlowchartEdge; backward: boolean }
type FlowchartLayoutNode = {
  rank: number
  center: number
}
type ConnectorDirection = "up" | "down" | "left" | "right"

const FLOWCHART_MAX_LAYOUT_NODES = 128
const FLOWCHART_MAX_LAYOUT_RANKS = 32
const FLOWCHART_MAX_CANVAS_WIDTH = 240
const FLOWCHART_NODE_GAP = 5
const FLOWCHART_CONNECTOR_GAP = 4

function connectorGlyph(directions: Set<ConnectorDirection>) {
  const up = directions.has("up")
  const down = directions.has("down")
  const left = directions.has("left")
  const right = directions.has("right")

  if (up && down && left && right) return "┼"
  if (up && down && left) return "┤"
  if (up && down && right) return "├"
  if (down && left && right) return "┬"
  if (up && left && right) return "┴"
  if (down && right) return "┌"
  if (down && left) return "┐"
  if (up && right) return "└"
  if (up && left) return "┘"
  if (left || right) return "─"
  if (up || down) return "│"
  return " "
}

function addConnectorDirection(
  cells: Set<ConnectorDirection>[][],
  row: number,
  column: number,
  direction: ConnectorDirection,
) {
  const cell = cells[row]?.[column]
  if (cell) cell.add(direction)
}

function drawVerticalConnector(
  cells: Set<ConnectorDirection>[][],
  column: number,
  start: number,
  end: number,
) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  for (let row = low; row <= high; row++) {
    if (row > low) addConnectorDirection(cells, row, column, "up")
    if (row < high) addConnectorDirection(cells, row, column, "down")
  }
}

function drawHorizontalConnector(
  cells: Set<ConnectorDirection>[][],
  row: number,
  start: number,
  end: number,
) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  for (let column = low; column <= high; column++) {
    if (column > low) addConnectorDirection(cells, row, column, "left")
    if (column < high) addConnectorDirection(cells, row, column, "right")
  }
}

function flowchartRanks(nodes: string[], edges: FlowchartEdge[]) {
  const outgoing = new Map<string, FlowchartEdge[]>()
  const incoming = new Map<string, number>()
  for (const node of nodes) {
    outgoing.set(node, [])
    incoming.set(node, 0)
  }
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  const ranks = new Map(nodes.map((node) => [node, 0]))
  const queue = nodes.filter((node) => incoming.get(node) === 0)
  const processed = new Set<string>()

  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    if (!node) continue
    processed.add(node)
    for (const edge of outgoing.get(node) ?? []) {
      ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(node) ?? 0) + 1))
      const remaining = (incoming.get(edge.to) ?? 0) - 1
      incoming.set(edge.to, remaining)
      if (remaining === 0) queue.push(edge.to)
    }
  }

  if (processed.size !== nodes.length) return undefined
  return ranks
}

function flowchartLayoutEdges(nodes: string[], edges: FlowchartEdge[]) {
  const outgoing = new Map<string, FlowchartEdge[]>()
  for (const node of nodes) outgoing.set(node, [])
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])

  const state = new Map<string, "visiting" | "visited">()
  const layoutEdges: FlowchartEdge[] = []
  const deferredEdges: FlowchartEdge[] = []
  const visit = (node: string) => {
    state.set(node, "visiting")
    for (const edge of outgoing.get(node) ?? []) {
      if (state.get(edge.to) === "visiting") {
        deferredEdges.push(edge)
        continue
      }

      layoutEdges.push(edge)
      if (!state.has(edge.to)) visit(edge.to)
    }
    state.set(node, "visited")
  }

  for (const node of nodes) {
    if (!state.has(node)) visit(node)
  }

  return { layoutEdges, deferredEdges }
}

function putOverlay(canvas: Map<number, string>, width: number, row: number, start: number, text: string) {
  for (const [index, character] of [...text].entries()) {
    const column = start + index
    if (column < 0 || column >= width || !character) continue
    canvas.set(row * width + column, character)
  }
}

function renderRankedVerticalFlowchart(input: {
  edges: FlowchartEdge[]
  labels: Map<string, string>
  shapes?: Map<string, FlowchartNodeShape>
  nodes?: string[]
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
      (sum, node, index) => sum + (boxes.get(node)?.[0] ? Bun.stringWidth(boxes.get(node)![0]!) : 0) + (index === 0 ? 0 : FLOWCHART_NODE_GAP),
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
        ? rankNodes[sourceIndex - 1]
        : !goesLeft && sourceIndex < rankNodes.length - 1
          ? rankNodes[sourceIndex + 1]
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
        const directions = connectorCells[rowIndex]?.[column]
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
  shapes?: Map<string, FlowchartNodeShape>
  nodes?: string[]
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

function cleanMermaidLabel(input: string | undefined) {
  return (input ?? "")
    .trim()
    .replace(/^(?:["'`])([\s\S]*)(?:["'`])$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/#(quot|apos|amp|lt|gt);/gi, (_match, entity: string) => {
      const values: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }
      return values[entity.toLowerCase()] ?? _match
    })
    .replace(/&quot;|&apos;|&amp;|&lt;|&gt;/gi, (match) => {
      const values: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" }
      return values[match.toLowerCase()] ?? match
    })
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/\\(["'`])/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ")
    .replace(/\s+/g, " ")
    .trim()
}

function topLevelMask(input: string) {
  const output = [...input]
  const stack: string[] = []
  let quote: string | undefined
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < output.length; index++) {
    const character = output[index]
    if (quote) {
      output[index] = " "
      if (character === quote && input[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      output[index] = " "
      quote = character
      continue
    }
    if (stack.length > 0) {
      output[index] = " "
      if (character === stack[stack.length - 1]) stack.pop()
      else if (pairs[character]) stack.push(pairs[character])
      continue
    }
    if (pairs[character]) {
      output[index] = " "
      stack.push(pairs[character])
    }
  }

  return output.join("")
}

function splitMermaidTopLevel(input: string, separator: string) {
  const parts: string[] = []
  let start = 0
  let quote: string | undefined
  const stack: string[] = []
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quote) {
      if (character === quote && input[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (stack.length > 0) {
      if (character === stack[stack.length - 1]) stack.pop()
      else if (pairs[character]) stack.push(pairs[character])
      continue
    }
    if (pairs[character]) {
      stack.push(pairs[character])
      continue
    }
    if (input.startsWith(separator, index)) {
      parts.push(input.slice(start, index).trim())
      start = index + separator.length
      index += separator.length - 1
    }
  }
  parts.push(input.slice(start).trim())
  return parts.filter(Boolean)
}

function flowchartShapeForExpression(expression: string): FlowchartNodeShape {
  if (expression.startsWith("(((") && expression.endsWith(")))")) return "double-circle"
  if (expression.startsWith("((") && expression.endsWith("))")) return "circle"
  if (expression.startsWith("([") && expression.endsWith("])")) return "stadium"
  if (expression.startsWith("{{") && expression.endsWith("}}")) return "hexagon"
  if (expression.startsWith("[(") && expression.endsWith(")]")) return "cylinder"
  if (expression.startsWith("[[") && expression.endsWith("]]")) return "subroutine"
  if (expression.startsWith("[/\\") && expression.endsWith("\\/]")) return "trapezoid"
  if (expression.startsWith("[/") && expression.endsWith("/]") || expression.startsWith("[\\") && expression.endsWith("\\]")) {
    return "parallelogram"
  }
  if (expression.startsWith("[>") && expression.endsWith("]")) return "asymmetric"
  if (expression.startsWith("[") && expression.endsWith("]")) return "rect"
  if (expression.startsWith("(") && expression.endsWith(")")) return "round"
  if (expression.startsWith("{") && expression.endsWith("}")) return "diamond"
  return "rect"
}

function parseFlowchartNodeExpression(expression: string): { id: string; label: string; shape: FlowchartNodeShape } | undefined {
  const text = expression
    .trim()
    .replace(/\s*:::[A-Za-z_][\w-]*\s*$/, "")
    .replace(/;\s*$/, "")
    .trim()
  const idMatch = /^([A-Za-z_][\w.:-]*)/.exec(text)
  if (!idMatch) return undefined
  const id = idMatch[1]
  const rest = text.slice(id.length).trim()
  if (!rest) return { id, label: id, shape: "rect" }

  if (rest.startsWith("@{") && rest.endsWith("}")) {
    const values = new Map<string, string>()
    for (const item of splitMermaidTopLevel(rest.slice(2, -1), ",")) {
      const separator = item.indexOf(":")
      if (separator < 0) continue
      values.set(item.slice(0, separator).trim().toLowerCase(), cleanMermaidLabel(item.slice(separator + 1)))
    }
    const shapeName = values.get("shape")?.toLowerCase()
    const shapeAliases: Record<string, FlowchartNodeShape> = {
      bang: "bang",
      rect: "rect",
      proc: "rect",
      process: "rect",
      rectangle: "rect",
      rounded: "round",
      event: "round",
      stadium: "stadium",
      pill: "stadium",
      terminal: "stadium",
      circle: "circle",
      circ: "circle",
      dbl_circle: "double-circle",
      "dbl-circ": "double-circle",
      "double-circle": "double-circle",
      diamond: "diamond",
      diam: "diamond",
      decision: "diamond",
      question: "diamond",
      hexagon: "hexagon",
      hex: "hexagon",
      prepare: "hexagon",
      cylinder: "cylinder",
      cyl: "cylinder",
      database: "cylinder",
      db: "cylinder",
      subroutine: "subroutine",
      subproc: "fr-rect",
      subprocess: "fr-rect",
      "framed-rectangle": "fr-rect",
      "fr-rect": "fr-rect",
      parallelogram: "parallelogram",
      trapezoid: "trapezoid",
      "trap-b": "trap-b",
      "trap-t": "trap-t",
      priority: "trap-b",
      "trapezoid-bottom": "trap-b",
      "inv-trapezoid": "trap-t",
      manual: "trap-t",
      "trapezoid-top": "trap-t",
      "notch-rect": "notch-rect",
      card: "notch-rect",
      "notched-rectangle": "notch-rect",
      cloud: "cloud",
      hourglass: "hourglass",
      collate: "hourglass",
      bolt: "bolt",
      "com-link": "bolt",
      "lightning-bolt": "bolt",
      brace: "brace",
      "brace-l": "brace",
      comment: "brace",
      "brace-r": "brace-r",
      braces: "braces",
      "lean-r": "lean-r",
      "in-out": "lean-r",
      "lean-right": "lean-r",
      "lean-l": "lean-l",
      "out-in": "lean-l",
      "lean-left": "lean-l",
      datastore: "datastore",
      "data-store": "datastore",
      delay: "delay",
      "half-rounded-rectangle": "delay",
      "h-cyl": "h-cyl",
      das: "h-cyl",
      "horizontal-cylinder": "h-cyl",
      "lin-cyl": "lin-cyl",
      disk: "lin-cyl",
      "lined-cylinder": "lin-cyl",
      "curv-trap": "curv-trap",
      display: "curv-trap",
      "curved-trapezoid": "curv-trap",
      "div-rect": "div-rect",
      "div-proc": "div-rect",
      "divided-process": "div-rect",
      "divided-rectangle": "div-rect",
      doc: "doc",
      document: "doc",
      tri: "tri",
      extract: "tri",
      triangle: "tri",
      fork: "fork",
      join: "fork",
      "win-pane": "win-pane",
      "internal-storage": "win-pane",
      "window-pane": "win-pane",
      "f-circ": "f-circ",
      "filled-circle": "f-circ",
      junction: "f-circ",
      "lin-doc": "lin-doc",
      "lined-document": "lin-doc",
      "lin-rect": "lin-rect",
      "lin-proc": "lin-rect",
      "lined-process": "lin-rect",
      "lined-rectangle": "lin-rect",
      "shaded-process": "lin-rect",
      "notch-pent": "notch-pent",
      "loop-limit": "notch-pent",
      "notched-pentagon": "notch-pent",
      "flip-tri": "flip-tri",
      "flipped-triangle": "flip-tri",
      "manual-file": "flip-tri",
      "sl-rect": "sl-rect",
      "manual-input": "sl-rect",
      "sloped-rectangle": "sl-rect",
      "multi-document": "docs",
      docs: "docs",
      documents: "docs",
      "st-doc": "docs",
      "stacked-document": "docs",
      "multi-process": "st-rect",
      "st-rect": "st-rect",
      processes: "st-rect",
      procs: "st-rect",
      "stacked-rectangle": "st-rect",
      flag: "flag",
      "paper-tape": "flag",
      "bow-rect": "bow-rect",
      "bow-tie-rectangle": "bow-rect",
      "stored-data": "bow-rect",
      "sm-circ": "sm-circ",
      "small-circle": "sm-circ",
      start: "sm-circ",
      "fr-circ": "fr-circ",
      "framed-circle": "fr-circ",
      stop: "fr-circ",
      "cross-circ": "cross-circ",
      "crossed-circle": "cross-circ",
      summary: "cross-circ",
      "tag-doc": "tag-doc",
      "tagged-document": "tag-doc",
      "tag-rect": "tag-rect",
      "tag-proc": "tag-rect",
      "tagged-process": "tag-rect",
      "tagged-rectangle": "tag-rect",
      odd: "odd",
      text: "text",
      icon: "icon",
      image: "image",
    }
    const shape = shapeAliases[shapeName ?? ""] ?? (values.has("img") ? "image" : values.has("icon") ? "icon" : "rect")
    const label = values.get("label") || values.get("text") || (shape === "image" ? "image" : id)
    return { id, label, shape }
  }

  const shape = flowchartShapeForExpression(rest)
  const delimiters: Array<[string, string]> = [
    ["(((", ")))"] ,
    ["((", "))"],
    ["([", "])"],
    ["{{", "}}"],
    ["[(", ")]"],
    ["[[", "]]"],
    ["[/\\", "\\/]"],
    ["[/", "/]"],
    ["[\\", "\\]"],
    ["[>", "]"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ]
  const delimiter = delimiters.find(([opening, closing]) => rest.startsWith(opening) && rest.endsWith(closing))
  if (!delimiter) return { id, label: id, shape: "rect" }
  return { id, label: cleanMermaidLabel(rest.slice(delimiter[0].length, rest.length - delimiter[1].length)) || id, shape }
}

type FlowchartOperator = {
  start: number
  end: number
  label?: string
}

function flowchartOperators(input: string): FlowchartOperator[] {
  const mask = topLevelMask(input)
  const operators: FlowchartOperator[] = []
  const occupied: Array<[number, number]> = []
  const labeled = /(?:--|-\.|==)\s+(.+?)\s+(\.-+[>xo]|\.-+|-{2,}>|--[xo]|=+>|={2,}|-{3,})/g

  for (const match of mask.matchAll(labeled)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    operators.push({ start, end, label: cleanMermaidLabel(input.slice(start + (match[0].indexOf(match[1] ?? "") || 0), start + (match[0].indexOf(match[1] ?? "") || 0) + (match[1]?.length ?? 0))) || undefined })
    occupied.push([start, end])
  }

  const direct = /[xo][-=.]+[xo]|<[-=.]+>|-+\.-+>|=+>|-+!?[>xo]|-+\.-+|={3,}|-{3,}|[—–-]*→/g
  for (const match of mask.matchAll(direct)) {
    const start = match.index ?? 0
    if (occupied.some(([low, high]) => start >= low && start < high)) continue
    let end = start + match[0].length
    let label: string | undefined
    if (input[end] === "|") {
      const close = input.indexOf("|", end + 1)
      if (close >= 0) {
        label = cleanMermaidLabel(input.slice(end + 1, close)) || undefined
        end = close + 1
      }
    }
    operators.push({ start, end, label })
    occupied.push([start, end])
  }

  return operators.sort((left, right) => left.start - right.start)
}

function parseFlowchartEdgeLine(
  line: string,
  labels: Map<string, string>,
  shapes?: Map<string, FlowchartNodeShape>,
  nodes?: Set<string>,
) {
  const edges: FlowchartEdge[] = []
  const operators = flowchartOperators(line)
  if (operators.length === 0) {
    if (!/^subgraph\b|^end$/i.test(line.trim())) {
      const node = parseFlowchartNodeExpression(line)
      if (node) {
        labels.set(node.id, node.label)
        shapes?.set(node.id, node.shape)
        nodes?.add(node.id)
      }
    }
    return edges
  }

  const segments: string[] = []
  let cursor = 0
  for (const operator of operators) {
    segments.push(line.slice(cursor, operator.start))
    cursor = operator.end
  }
  segments.push(line.slice(cursor))
  const groups = segments.map((segment) =>
    splitMermaidTopLevel(segment, "&")
      .map((item) => parseFlowchartNodeExpression(item))
      .filter((item): item is { id: string; label: string; shape: FlowchartNodeShape } => Boolean(item)),
  )

  for (const group of groups) {
    for (const node of group) {
      if (node.label !== node.id || !labels.has(node.id)) labels.set(node.id, node.label)
      if (node.shape !== "rect" || !shapes?.has(node.id)) shapes?.set(node.id, node.shape)
      nodes?.add(node.id)
    }
  }

  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index]
    const sources = groups[index] ?? []
    const targets = groups[index + 1] ?? []
    for (const source of sources) {
      for (const target of targets) {
        edges.push({ from: source.id, to: target.id, label: operator.label })
      }
    }
  }
  return edges
}

type HorizontalPathSegment =
  | { type: "node"; label: string; shape?: FlowchartNodeShape }
  | { type: "edge"; label?: string }
  | { type: "loop"; label: string; shape?: FlowchartNodeShape }

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

function renderConnectedDiagramBoxes(input: {
  left: string[]
  right: string[]
  connector: string
  label?: string
}) {
  const leftWidth = Math.max(...input.left.map((line) => Bun.stringWidth(line)), 1)
  const rightWidth = Math.max(...input.right.map((line) => Bun.stringWidth(line)), 1)
  const label = cleanConnectorLabel(input.label)
  const gapWidth = Math.max(12, Bun.stringWidth(input.connector) + 2, Bun.stringWidth(label) + 2)
  const height = Math.max(input.left.length, input.right.length, 3)
  const rows: string[] = []

  for (let row = 0; row < height; row++) {
    const left = padVisual(input.left[row] ?? " ".repeat(leftWidth), leftWidth)
    const right = padVisual(input.right[row] ?? " ".repeat(rightWidth), rightWidth)
    const middle = row === 0 ? centerVisual(label, gapWidth) : row === 1 ? centerVisual(input.connector, gapWidth) : " ".repeat(gapWidth)
    rows.push(`${left}${middle}${right}`.trimEnd())
  }

  return rows
}

function classRelationConnector(relation: string) {
  const connectors: Record<string, string> = {
    "<|--": "◁────",
    "--|>": "────▷",
    "*--": "◆────",
    "--*": "────◆",
    "o--": "◇────",
    "--o": "────◇",
    "-->": "────▶",
    "<--": "◀────",
    "..>": "╌╌╌▶",
    "<..": "◀╌╌╌",
    "..|>": "╌╌╌▷",
    "<|..": "◁╌╌╌",
    "--": "─────",
    "..": "╌╌╌╌╌",
  }
  return connectors[relation] ?? relation
}

function erRelationConnector(relation: string) {
  return relation.replace("--", "────").replace("..", "╌╌╌╌")
}

function flowchartShapeMarker(shape: FlowchartNodeShape | undefined) {
  if (!shape || shape === "rect" || shape === "round" || shape === "stadium") return ""
  const markers: Record<string, string> = {
    diamond: "◇",
    diam: "◇",
    decision: "◇",
    circle: "◯",
    "double-circle": "◎",
    "dbl-circ": "◎",
    "fr-circ": "◉",
    "sm-circ": "·",
    "f-circ": "●",
    cylinder: "▱",
    cyl: "▱",
    datastore: "▤",
    "h-cyl": "▱",
    "lin-cyl": "▤",
    hexagon: "⬡",
    hex: "⬡",
    subroutine: "▣",
    "fr-rect": "▣",
    "framed-rectangle": "▣",
    parallelogram: "▱",
    trapezoid: "⏢",
    "trap-b": "⏢",
    "trap-t": "⏢",
    "curv-trap": "⌒",
    "lean-r": "▰",
    "lean-l": "◀",
    "sl-rect": "▱",
    "lin-rect": "▤",
    "div-rect": "▥",
    "st-rect": "▦",
    "tag-rect": "▣",
    "notch-rect": "▰",
    "bow-rect": "◈",
    "win-pane": "▥",
    "docs": "▤",
    "lin-doc": "▤",
    "tag-doc": "▤",
    doc: "▤",
    "notch-pent": "⬟",
    "flip-tri": "◢",
    tri: "△",
    flag: "⚑",
    bolt: "ϟ",
    brace: "{",
    "brace-r": "}",
    braces: "{}",
    odd: "◇",
    delay: "◒",
    fork: "▰",
    hourglass: "⌛",
    "cross-circ": "⊗",
    cloud: "☁",
    bang: "‼",
    text: "▤",
    icon: "◆",
    image: "▧",
  }
  return markers[shape] ?? "◇"
}

function renderFlowchartBox(label: string, shape: FlowchartNodeShape | undefined) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  const marker = flowchartShapeMarker(shape)
  return renderBox(marker ? `${marker} ${text}` : text)
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

    const box =
      segment.type === "loop"
        ? renderFlowchartBox(`↩ ${segment.label}`, segment.shape)
        : renderFlowchartBox(segment.label, segment.shape)
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    for (let index = 0; index < rows.length; index++) {
      rows[index] += padVisual(box[index] ?? "", boxWidth)
    }
  }

  return rows
}

function renderWrappedHorizontalPath(
  segments: HorizontalPathSegment[],
  direction: "lr" | "rl",
  width: number,
) {
  const maxRowWidth = Math.max(40, Math.min(180, Math.floor(width) - 12))
  const segmentWidth = (segment: HorizontalPathSegment, rowDirection: "lr" | "rl") => {
    if (segment.type === "edge") {
      return Bun.stringWidth(
        rowDirection === "rl"
          ? segment.label ? `◀─ ${segment.label} ──` : "◀────"
          : segment.label ? `── ${segment.label} ─▶` : "────▶",
      )
    }
    return Math.max(
      ...renderFlowchartBox(segment.type === "loop" ? `↩ ${segment.label}` : segment.label, segment.shape).map((line) => Bun.stringWidth(line)),
    )
  }
  const fullWidth = segments.reduce((total, segment) => total + segmentWidth(segment, direction), 0)
  if (fullWidth <= maxRowWidth) return renderHorizontalPath(direction === "rl" ? reverseHorizontalPath(segments) : segments, direction)

  const chunks: Array<{ segments: HorizontalPathSegment[]; bridge?: Extract<HorizontalPathSegment, { type: "edge" }> }> = []
  let current: HorizontalPathSegment[] = segments[0] ? [segments[0]] : []
  let currentWidth = current[0] ? segmentWidth(current[0], "lr") : 0
  for (let index = 1; index < segments.length; index += 2) {
    const edge = segments[index]
    const node = segments[index + 1]
    if (!edge || edge.type !== "edge" || !node || node.type === "edge") continue
    const pairWidth = segmentWidth(edge, "lr") + segmentWidth(node, "lr")
    if (current.length > 0 && currentWidth + pairWidth > maxRowWidth) {
      chunks.push({ segments: current, bridge: edge })
      current = [node]
      currentWidth = segmentWidth(node, "lr")
      continue
    }
    current.push(edge, node)
    currentWidth += pairWidth
  }
  if (current.length > 0) chunks.push({ segments: current })

  const chunkRows = chunks.map((chunk, index) => {
    const rowDirection = index % 2 === 0 ? direction : direction === "lr" ? "rl" : "lr"
    const ordered = rowDirection === "rl" ? reverseHorizontalPath(chunk.segments) : chunk.segments
    const rows = renderHorizontalPath(ordered, rowDirection)
    const blockWidth = Math.max(...rows.map((row) => Bun.stringWidth(row)))
    const first = chunk.segments[0]
    const last = chunk.segments.at(-1)
    const firstWidth = first && first.type !== "edge" ? segmentWidth(first, rowDirection) : 1
    const lastWidth = last && last.type !== "edge" ? segmentWidth(last, rowDirection) : 1
    return { chunk, rowDirection, rows, blockWidth, firstWidth, lastWidth }
  })
  const canvasWidth = Math.max(...chunkRows.map((chunk) => chunk.blockWidth), 1)
  const output: string[] = []
  chunkRows.forEach((chunk, index) => {
    const left = chunk.rowDirection === "lr" ? 0 : canvasWidth - chunk.blockWidth
    output.push(...chunk.rows.map((row) => `${" ".repeat(left)}${row}`.trimEnd()))
    const next = chunkRows[index + 1]
    if (!next) return
    const nextLeft = next.rowDirection === "lr" ? 0 : canvasWidth - next.blockWidth
    const fromColumn = chunk.rowDirection === "lr"
      ? left + chunk.blockWidth - Math.floor(chunk.lastWidth / 2) - 1
      : left + Math.floor(chunk.lastWidth / 2)
    const toColumn = next.rowDirection === "lr"
      ? nextLeft + Math.floor(next.firstWidth / 2)
      : nextLeft + next.blockWidth - Math.floor(next.firstWidth / 2) - 1
    const connectors = Array.from({ length: 3 }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
    drawVerticalConnector(connectors, fromColumn, 0, 1)
    drawHorizontalConnector(connectors, 1, fromColumn, toColumn)
    drawVerticalConnector(connectors, toColumn, 1, 2)
    const bridgeLabel = cleanConnectorLabel(chunk.chunk.bridge?.label)
    const bridgeRows: string[][] = connectors.map((row) => row.map(connectorGlyph))
    bridgeRows[2]![toColumn] = "▼"
    if (bridgeLabel) writeVisual(bridgeRows[1]!, Math.max(0, Math.min(canvasWidth - Bun.stringWidth(bridgeLabel), Math.floor((fromColumn + toColumn - Bun.stringWidth(bridgeLabel)) / 2))), bridgeLabel)
    output.push(...bridgeRows.map((row) => row.join("").trimEnd()))
  })
  return output
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
  shapes?: Map<string, FlowchartNodeShape>
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
    if (next.length === 0 || path.length >= FLOWCHART_MAX_LAYOUT_NODES * 2) {
      paths.push(path)
      return
    }

    for (const edge of next) {
      const nextLabel = input.labels.get(edge.to) ?? edge.to
      const connector = { type: "edge", label: edge.label } satisfies HorizontalPathSegment
      if (seen.has(edge.to)) {
        paths.push([...path, connector, { type: "loop", label: nextLabel, shape: input.shapes?.get(edge.to) }])
        continue
      }
      walk(
        edge.to,
        [...path, connector, { type: "node", label: nextLabel, shape: input.shapes?.get(edge.to) }],
        new Set([...seen, edge.to]),
      )
    }
  }

  for (const start of input.starts) {
    walk(
      start,
      [{ type: "node", label: input.labels.get(start) ?? start, shape: input.shapes?.get(start) }],
      new Set([start]),
    )
    if (paths.length >= 48) break
  }

  const rendered = paths.slice(0, 48).flatMap((path, index) => {
    const rows = renderWrappedHorizontalPath(path, input.direction, input.width)
    return index === 0 ? rows : ["", ...rows]
  })
  if (rendered.length === 0) return undefined

  return rendered.join("\n").trimEnd()
}

function renderIsolatedFlowchartNodes(
  nodes: string[],
  labels: Map<string, string>,
  shapes: Map<string, FlowchartNodeShape>,
) {
  if (nodes.length === 0) return undefined
  const rows = ["", "", ""]
  for (const node of nodes) {
    const box = renderFlowchartBox(labels.get(node) ?? node, shapes.get(node))
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    for (let index = 0; index < rows.length; index++) {
      rows[index] += `${padVisual(box[index] ?? "", boxWidth)}${" ".repeat(FLOWCHART_NODE_GAP)}`
    }
  }
  return rows.map((row) => row.trimEnd()).join("\n")
}

function renderSimpleFlowchart(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  const head = lines[0]?.toLowerCase()
  const headMatch = /^(flowchart|graph)\s+(td|tb|lr|rl|bt)\b/.exec(head ?? "")
  if (!headMatch) return undefined
  const direction = headMatch[2] as FlowDirection

  const labels = new Map<string, string>()
  const shapes = new Map<string, FlowchartNodeShape>()
  const parsedNodes = new Set<string>()
  const parsedEdges: FlowchartEdge[] = []

  const statements = lines.slice(1).flatMap((line) => splitMermaidTopLevel(line, ";"))
  for (const line of statements) {
    if (/^(?:style|classDef|class|click|linkStyle)\b/i.test(line)) continue
    parsedEdges.push(...parseFlowchartEdgeLine(line, labels, shapes, parsedNodes))
  }

  if (parsedEdges.length === 0 && parsedNodes.size === 0) return undefined
  if (direction === "td" || direction === "tb" || direction === "bt") {
    const ranked = renderRankedVerticalFlowchart({ edges: parsedEdges, labels, shapes, nodes: [...parsedNodes], direction, width })
    if (ranked && flowchartOutputFits(ranked, width)) return ranked

    const compact = renderCompactRankedVerticalFlowchart({ edges: parsedEdges, labels, shapes, nodes: [...parsedNodes], direction, width })
    if (compact) return compact
    if (ranked) return ranked
  }
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

  if (direction === "lr" || direction === "rl") {
    const horizontal = renderLayeredHorizontalFlowchart({
      starts: starts.length > 0 ? starts : start ? [start] : [],
      edges,
      labels,
      shapes,
      direction,
      width,
    })
    const isolated = [...parsedNodes].filter((node) => !parsedEdges.some((edge) => edge.from === node || edge.to === node))
    if (horizontal) {
      const isolatedOutput = renderIsolatedFlowchartNodes(isolated, labels, shapes)
      return isolatedOutput ? `${horizontal}\n\n${isolatedOutput}` : horizontal
    }
    if (isolated.length > 0) return renderIsolatedFlowchartNodes(isolated, labels, shapes)
  }

  if (start && edges.length <= 16) {
    const renderNode = (node: string, path: Set<string>, depth = 0): string[] => {
      const next = outgoing.get(node) ?? []
      const lines = indentLines(renderFlowchartBox(labels.get(node) ?? node, shapes.get(node)), depth)
      if (next.length === 0) return lines

      if (next.length === 1 && !next[0].label) {
        const target = next[0].to
        if (path.has(target)) {
          lines.push(`${"  ".repeat(depth)}        └──────── ${cleanLabel(labels.get(target) ?? target)}`)
          return lines
        }
        lines.push(`${"  ".repeat(depth)}        │`)
        lines.push(`${"  ".repeat(depth)}        ▼`)
        return [...lines, ...renderNode(target, new Set([...path, target]), depth)]
      }

      for (let index = 0; index < next.length; index++) {
        const edge = next[index]
        const isLast = index === next.length - 1
        const label = edge.label || ""
        const branchIndent = "  ".repeat(depth)
        const childPrefix = `${branchIndent}${isLast ? "   " : "│  "}`
        if (index > 0) lines.push("")
        lines.push(`${branchIndent}${label ? `${label} ` : ""}─▶`)

        if (path.has(edge.to)) {
          lines.push(`${childPrefix}└────▶ ${cleanLabel(labels.get(edge.to) ?? edge.to)}`)
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
  const lines = preparedMermaidLines(input)
  if (lines[0]?.toLowerCase() !== "sequencediagram") return undefined

  const aliases = new Map<string, string>()
  const messages: Array<{ from: string; to: string; label: string; dashed: boolean }> = []
  const events: Array<
    | { kind: "message"; message: (typeof messages)[number] }
    | { kind: "frame"; edge: "start" | "region" | "end"; label: string }
    | { kind: "note"; label: string }
  > = []
  const participants: string[] = []
  const addParticipant = (id: string, label?: string) => {
    aliases.set(id, cleanMermaidLabel(label || aliases.get(id) || id) || id)
    if (!participants.includes(id)) participants.push(id)
  }

  for (const line of lines.slice(1)) {
    const participant = /^(?:participant|actor)\s+([A-Za-z][\w.:-]*)(?:\s+as\s+(.+))?$/i.exec(line)
    if (participant) {
      addParticipant(participant[1], participant[2] || participant[1])
      continue
    }

    const fragment = /^(alt|opt|loop|par|critical|break)\b\s*(.*)$/i.exec(line)
    if (fragment) {
      events.push({ kind: "frame", edge: "start", label: `${fragment[1]}${fragment[2] ? ` · ${cleanMermaidLabel(fragment[2])}` : ""}` })
      continue
    }

    const region = /^(else|and|option)\b\s*(.*)$/i.exec(line)
    if (region) {
      events.push({ kind: "frame", edge: "region", label: `${region[1]}${region[2] ? ` · ${cleanMermaidLabel(region[2])}` : ""}` })
      continue
    }

    if (/^end$/i.test(line)) {
      events.push({ kind: "frame", edge: "end", label: "end" })
      continue
    }

    const note = /^note\s+(?:(?:(?:left|right)\s+of|over)\s+[^:]+\s*:\s*|\s*:\s*)(.+)$/i.exec(line)
    if (note) {
      events.push({ kind: "note", label: cleanMermaidLabel(note[1]) })
      continue
    }

    const message = /^([A-Za-z][\w.:-]*?)(?:\(\))?\s*(-->>|->>|-->|->|--x|-x|==>>|=>>|==>|=>|-\)|--\))\s*[+-]?\s*([A-Za-z][\w.:-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!message) continue
    const from = message[1]
    const to = message[3]
    addParticipant(from)
    addParticipant(to)
    const parsedMessage = {
      from,
      to,
      label: cleanMermaidLabel(message[4]),
      dashed: message[2].startsWith("--") || message[2].startsWith("="),
    }
    messages.push(parsedMessage)
    events.push({ kind: "message", message: parsedMessage })
  }

  if (messages.length === 0 && events.length === 0) return undefined
  if (participants.length >= 2 && participants.length <= 5) {
    const labels = participants.map((id) => aliases.get(id) ?? id)
    const columnWidth = Math.max(12, Math.max(...labels.map((label) => Bun.stringWidth(label) + 4)))
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

      const frameRow = (edge: "start" | "region" | "end", label: string) => {
        const left = edge === "start" ? "┌" : edge === "end" ? "└" : "├"
        const right = edge === "start" ? "┐" : edge === "end" ? "┘" : "┤"
        const row = Array.from({ length: totalWidth }, () => "─")
        row[0] = left
        row[totalWidth - 1] = right
        writeVisual(row, 2, ` ${label} `)
        return row.join("").trimEnd()
      }

      const noteRow = (label: string) => {
        const row = Array.from({ length: totalWidth }, () => " ")
        const text = `╞ ${label} ╡`
        writeVisual(row, Math.max(0, Math.floor((totalWidth - Bun.stringWidth(text)) / 2)), text)
        return row.join("").trimEnd()
      }

      const rows: string[] = [...renderParticipantRow(), lifelineRow()]
      for (const event of events.slice(0, 40)) {
        if (event.kind === "frame") {
          rows.push(frameRow(event.edge, event.label))
          continue
        }
        if (event.kind === "note") {
          rows.push(noteRow(event.label), lifelineRow())
          continue
        }
        const message = event.message
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

  for (const [index, event] of events.slice(0, 40).entries()) {
    if (index > 0) rows.push("")
    if (event.kind === "frame") {
      rows.push(`┌─ ${event.label} ─┐`)
      continue
    }
    if (event.kind === "note") {
      rows.push(`╞ ${event.label} ╡`)
      continue
    }
    const message = event.message
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
    children.forEach((relation, index) => {
      const branch = index === children.length - 1 ? "└" : "├"
      lines.push(`${prefix}${branch}─ ${relation.relation} ${relation.label}`)

      if (path.has(relation.to) || rendered.has(relation.to)) {
        lines.push(`${prefix}   └────▶ ${relation.to}`)
        return
      }

      lines.push(...renderEntity(relation.to, depth + 1, new Set([...path, relation.to])))
    })

    return lines
  }

  const blocks = starts.flatMap((entity, index) => {
    const lines = rendered.has(entity) ? [`└────▶ ${entity}`] : renderEntity(entity, 0, new Set([entity]))
    return index === 0 ? lines : ["", ...lines]
  })

  const remaining = [...entities].filter((entity) => !rendered.has(entity))
  for (const entity of remaining) {
    blocks.push("", ...renderEntity(entity, 0, new Set([entity])))
  }

  return blocks
}

function renderErDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  if (lines[0]?.toLowerCase() !== "erdiagram") return undefined

  const relationDefinitions: ErRelation[] = []
  const attributes = new Map<string, string[]>()
  let currentEntity: string | undefined

  for (const line of lines.slice(1)) {
    const entity = /^([A-Za-z_][\w.-]*)\s*\{$/.exec(line)
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
      attributes.set(currentEntity, [...(attributes.get(currentEntity) ?? []), cleanMermaidLabel(line)])
      continue
    }

    const relation = /^([A-Za-z_][\w.-]*)\s+([|o}{]{1,2}(?:--|\.\.)[|o}{]{1,2})\s+([A-Za-z_][\w.-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!relation) continue
    relationDefinitions.push({
      from: relation[1],
      to: relation[3],
      relation: relation[2],
      label: cleanMermaidLabel(relation[4]),
      dotted: relation[2].includes(".."),
    })
  }

  if (relationDefinitions.length === 0 && attributes.size === 0) return undefined
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
    const horizontalGap = Math.max(16, Math.min(26, Math.floor(width / 4)))
    const verticalGap = 5
    const columnLeft = new Map<number, number>()
    const columnWidth = new Map<number, number>()
    let canvasWidth = 0
    for (const rank of orderedRanks) {
      const rankWidth = Math.max(...(rankGroups.get(rank) ?? []).map((entity) => Bun.stringWidth(boxes.get(entity)?.[0] ?? "")), 10)
      columnLeft.set(rank, canvasWidth)
      columnWidth.set(rank, rankWidth)
      canvasWidth += rankWidth + horizontalGap
    }
    canvasWidth = Math.max(40, canvasWidth - horizontalGap)
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
        const boxWidth = Bun.stringWidth(box[0] ?? "")
        const left = leftBase + Math.floor((rankWidth - boxWidth) / 2)
        positions.set(entity, { left, right: left + boxWidth - 1, top, bottom: top + box.length - 1, centerRow: top + Math.floor(box.length / 2) })
        top += box.length + verticalGap
      }
      canvasHeight = Math.max(canvasHeight, top - verticalGap)
    }
    canvasHeight += relationDefinitions.length * 2 + 2
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
    relationDefinitions.slice(0, 24).forEach((relation, index) => {
      const from = positions.get(relation.from)
      const to = positions.get(relation.to)
      if (!from || !to) return
      const cardinality = /^([|o}{]{1,2})(--|\.\.)([|o}{]{1,2})$/.exec(relation.relation)
      const fromMark = cardinality?.[1] ?? ""
      const toMark = cardinality?.[3] ?? ""
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
      const directions = connectors[rowIndex]?.[column]
      if (!boxCells.has(cell) && directions?.size) return dottedCells.has(cell) ? "╌" : connectorGlyph(directions)
      return character
    }).join("").trimEnd())
    while (rendered.at(-1) === "") rendered.pop()
    return rendered.join("\n")
  }

  const renderedAttributes = [...attributes.entries()].slice(0, 6).flatMap(([entity, fields], index) => {
    const lines = renderEntityBox(entity, fields)
    return index === 0 ? lines : ["", ...lines]
  })

  return renderedAttributes.join("\n")
}

function renderStateDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  if (!/^stateDiagram(?:-v2)?$/i.test(lines[0] ?? "")) return undefined

  const aliases = new Map<string, string>()
  const transitions: FlowchartEdge[] = []
  const knownStates = new Set<string>()
  const containers: string[] = []
  const markerKinds = new Map<string, "start" | "end">()
  let markerIndex = 0
  let direction: "td" | "bt" | "lr" | "rl" = "td"

  for (const line of lines.slice(1)) {
    if (line.startsWith("%%") || /^(?:classDef|class|style)\b/i.test(line)) continue
    const directionLine = /^direction\s+(TD|TB|BT|LR|RL)$/i.exec(line)
    if (directionLine) {
      const parsedDirection = directionLine[1].toLowerCase()
      direction = parsedDirection === "tb" ? "td" : (parsedDirection as "td" | "bt" | "lr" | "rl")
      continue
    }
    if (line === "}") {
      containers.pop()
      continue
    }

    const composite = /^state\s+([A-Za-z_][\w.:-]*)\s*\{$/i.exec(line)
    if (composite) {
      const id = composite[1]
      knownStates.add(id)
      aliases.set(id, `${id} {}`)
      containers.push(id)
      continue
    }

    const stateAlias = /^state\s+"([^"]+)"\s+as\s+([A-Za-z][\w-]*)$/i.exec(line)
    if (stateAlias) {
      aliases.set(stateAlias[2], cleanMermaidLabel(stateAlias[1]))
      knownStates.add(stateAlias[2])
      continue
    }

    const stereotype = /^state\s+([A-Za-z_][\w.:-]*)\s+<<(fork|join|choice)>>$/i.exec(line)
    if (stereotype) {
      knownStates.add(stereotype[1])
      aliases.set(stereotype[1], `${stereotype[2].toLowerCase()} · ${stereotype[1]}`)
      continue
    }

    const transition = /^(\[\*\]|[A-Za-z_][\w.:-]*)\s*-->\s*(\[\*\]|[A-Za-z_][\w.:-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (!transition) continue
    const from = transition[1] === "[*]" ? `__state_start_${markerIndex++}` : transition[1]
    const to = transition[2] === "[*]" ? `__state_end_${markerIndex++}` : transition[2]
    if (transition[1] === "[*]") markerKinds.set(from, "start")
    if (transition[2] === "[*]") markerKinds.set(to, "end")
    knownStates.add(from)
    knownStates.add(to)
    transitions.push({
      from,
      to,
      label: cleanMermaidLabel(transition[3]) || undefined,
    })
  }

  if (transitions.length === 0 && knownStates.size === 0) return undefined
  const labels = new Map<string, string>()
  for (const state of knownStates) labels.set(state, aliases.get(state) ?? state)
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
    const walk = (state: string, pathNodes: string[], pathEdges: FlowchartEdge[], seen: Set<string>) => {
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
    const rendered = paths.slice(0, 32).flatMap((path, pathIndex) => {
      const orderedNodes = direction === "rl" ? [...path.nodes].reverse() : path.nodes
      const orderedEdges = direction === "rl" ? [...path.edges].reverse() : path.edges
      const blocks = orderedNodes.map(renderNode)
      const rows = ["", "", ""]
      blocks.forEach((block, index) => {
        const blockWidth = Math.max(...block.map((line) => Bun.stringWidth(line)))
        for (let row = 0; row < 3; row++) rows[row] += padVisual(block[row] ?? "", blockWidth)
        const edge = orderedEdges[index]
        if (!edge) return
        const label = cleanConnectorLabel(edge.label)
        const gap = Math.max(8, Bun.stringWidth(label) + 2)
        rows[0] += centerVisual(label, gap)
        rows[1] += centerVisual(direction === "rl" ? "◀────" : "────▶", gap)
        rows[2] += " ".repeat(gap)
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

    const relation = /^([A-Za-z][\w-]*)\s+(<\|--|--\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|\.\.\|>|<\|\.\.|\.\.|--)\s+([A-Za-z][\w-]*)(?:\s*:\s*(.+))?$/.exec(line)
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
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  const blocks = relations.slice(0, 16).flatMap((relation, index) => {
    const block = renderConnectedDiagramBoxes({
      left: renderEntityBox(relation.from, classes.get(relation.from) ?? []),
      right: renderEntityBox(relation.to, classes.get(relation.to) ?? []),
      connector: classRelationConnector(relation.relation),
      label: relation.label,
    })
    return index === 0 ? block : ["", ...block]
  })
  for (const [name, members] of classes) {
    if (related.has(name)) continue
    blocks.push(...(blocks.length > 0 ? [""] : []), ...renderEntityBox(name, members))
  }
  return blocks.join("\n")
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
  marker?: "milestone" | "crit" | "done" | "active"
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
    let marker: GanttTask["marker"]

    for (const part of parts) {
      const lower = part.toLowerCase()
      if (/^(active|done|crit|milestone)$/.test(lower)) {
        marker = lower as GanttTask["marker"]
        continue
      }
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

    tasks.push({ section, label: cleanLabel(task[1]), id, start, end, after, duration, marker })
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
  const available = Math.max(64, Math.min(140, width - 4))
  const nameWidth = Math.min(24, Math.max(10, ...resolved.map((task) => Bun.stringWidth(task.label))))
  const timelineWidth = Math.max(24, available - nameWidth - 5)
  const scale = Math.max(1, timelineWidth / totalDays)
  const dateRow = blankRow(timelineWidth)
  const tickRow = blankRow(timelineWidth)
  const tickEvery = Math.max(1, Math.ceil(totalDays / 6))
  const tickDays = [0, totalDays - 1]
  for (let day = tickEvery; day < totalDays - 1; day += tickEvery) {
    const column = Math.min(timelineWidth - 1, Math.max(0, Math.round(day * scale)))
    if (tickDays.every((selected) => Math.abs(column - Math.round(selected * scale)) >= 7)) tickDays.push(day)
  }
  for (const day of tickDays.sort((left, right) => left - right)) {
    const column = Math.min(timelineWidth - 1, Math.max(0, Math.round(day * scale)))
    const label = formatGanttDate(start + day)
    writeVisual(dateRow, Math.max(0, Math.min(timelineWidth - Bun.stringWidth(label), column - Math.floor(Bun.stringWidth(label) / 2))), label)
    tickRow[column] = "┬"
  }

  const output: string[] = [title]
  if (dateFormat) output.push(`Time scale · ${dateFormat}`)
  output.push(`${" ".repeat(nameWidth + 3)}${dateRow.join("").trimEnd()}`)
  output.push(`${" ".repeat(nameWidth + 2)}┌${tickRow.map((cell) => cell === "┬" ? "┬" : "─").join("")}▶`)

  let previousSection = ""
  for (const task of resolved.slice(0, 18)) {
    if (task.section !== previousSection) {
      previousSection = task.section
      output.push(`── ${task.section} ${"─".repeat(Math.max(1, nameWidth + timelineWidth - Bun.stringWidth(task.section)))} `)
    }
    const barStart = Math.max(0, Math.floor((task.start - start) * scale))
    const barEnd = Math.min(timelineWidth - 1, Math.max(barStart, Math.ceil((task.end - start + 1) * scale) - 1))
    const bar = Array.from({ length: timelineWidth }, (_, index) => {
      if (task.marker === "milestone") return index === barStart ? "◆" : " "
      if (index < barStart || index > barEnd) return " "
      if (task.marker === "crit") return "▓"
      if (task.marker === "done") return "█"
      if (task.marker === "active") return "▒"
      return index === barStart ? "█" : "▓"
    }).join("")
    output.push(`${padVisual(task.label, nameWidth)}  │${bar}│  ${formatGanttDate(task.start)}–${formatGanttDate(task.end)}`)
  }
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

type MermaidIndentedEntry = {
  depth: number
  label: string
  description?: string
  raw: string
}

function preparedMermaidSourceLines(input: string) {
  const lines: string[] = []
  let inFrontmatter = false
  let inDirective = false
  for (const raw of input.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (lines.length === 0 && trimmed === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (trimmed === "---") inFrontmatter = false
      continue
    }
    if (inDirective) {
      if (trimmed.includes("}%%")) inDirective = false
      continue
    }
    if (trimmed.startsWith("%%{")) {
      if (!trimmed.includes("}%%")) inDirective = true
      continue
    }
    if (trimmed.startsWith("%%")) continue
    lines.push(raw.replace(/\r$/, ""))
  }
  return lines
}

function mermaidIndentWidth(input: string) {
  return input.replace(/\t/g, "  ").match(/^\s*/)?.[0].length ?? 0
}

function mermaidIndentedLabel(input: string) {
  const source = input
    .replace(/\s+:::[A-Za-z_][\w-]*/g, "")
    .replace(/\s+@\{[^}]*\}\s*$/g, "")
    .replace(/::icon\([^)]*\)/gi, "")
    .trim()
  const description = /\s+##\s+(.+)$/.exec(source)?.[1]
  const withoutDescription = source.replace(/\s+##\s+.+$/, "").trim()
  const node = parseFlowchartNodeExpression(withoutDescription)
  const label =
    node && /[()[\]{}]/.test(withoutDescription.slice(node.id.length))
      ? node.label
      : cleanMermaidLabel(withoutDescription) || withoutDescription
  return { label: label || "item", description: description ? cleanMermaidLabel(description) : undefined }
}

function parseMermaidIndentedEntries(input: string, head: RegExp): MermaidIndentedEntry[] | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!head.test(lines[0]?.trim() ?? "")) return undefined
  const body = lines.slice(1)
  if (body.length === 0) return undefined

  const baseIndent = Math.min(...body.map(mermaidIndentWidth))
  const entries: MermaidIndentedEntry[] = []
  for (const raw of body) {
    const expanded = raw.replace(/\t/g, "  ")
    const trimmed = expanded.trim()
    if (!trimmed || /^(?:title|accTitle|accDescr|config|classDef|style|click|linkStyle)\b/i.test(trimmed)) continue
    const boxDrawing = /^(.*?)(?:├──|└──|┣━━|┗━━)\s*(.+)$/.exec(expanded)
    const depth = boxDrawing
      ? Math.max(0, Math.floor((boxDrawing[1]?.replace(/[│┃]/g, "  ").length ?? 0) / 4) + 1)
      : Math.max(0, Math.floor((mermaidIndentWidth(expanded) - baseIndent) / 2))
    const parsed = mermaidIndentedLabel(boxDrawing?.[2] ?? trimmed)
    entries.push({ depth, label: parsed.label, description: parsed.description, raw: trimmed })
  }
  return entries.length > 0 ? entries : undefined
}

function renderIndentedTreeRows(entries: MermaidIndentedEntry[]) {
  const lastAtDepth = new Map<number, boolean>()
  return entries.map((entry, index) => {
    const next = entries[index + 1]
    const isLast = !next || next.depth < entry.depth
    if (entry.depth === 0) {
      lastAtDepth.set(0, isLast)
      for (const depth of [...lastAtDepth.keys()]) if (depth > 0) lastAtDepth.delete(depth)
      return `${entry.label}${entry.description ? ` — ${entry.description}` : ""}`
    }
    let prefix = ""
    for (let level = 0; level < entry.depth - 1; level++) prefix += lastAtDepth.get(level) ? "  " : "│ "
    prefix += isLast ? "└─ " : "├─ "
    lastAtDepth.set(entry.depth, isLast)
    for (const depth of [...lastAtDepth.keys()]) if (depth > entry.depth) lastAtDepth.delete(depth)
    return `${prefix}${entry.label}${entry.description ? ` — ${entry.description}` : ""}`
  })
}

function renderBoxedHierarchy(title: string, entries: MermaidIndentedEntry[]) {
  const visible = entries.slice(0, 128)
  const boxes = visible.map((entry) => renderCompactBox(entry.description ? `${entry.label} · ${entry.description}` : entry.label, 12))
  const nodeWidth = Math.max(...boxes.flatMap((box) => box.map((line) => Bun.stringWidth(line))), 12)
  const columnStride = nodeWidth + 10
  const rowStride = 4
  const maxDepth = Math.max(...visible.map((entry) => entry.depth), 0)
  const canvasWidth = (maxDepth + 1) * columnStride - 10
  const rowCount = visible.length * rowStride - 1
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectors = Array.from({ length: rowCount }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const positions: Array<{ left: number; right: number; center: number; parent?: number }> = []
  const lastAtDepth = new Map<number, number>()

  visible.forEach((entry, index) => {
    const box = boxes[index] ?? renderBox(entry.label)
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    const left = entry.depth * columnStride + Math.floor((nodeWidth - boxWidth) / 2)
    const top = index * rowStride
    box.forEach((line, offset) => {
      writeVisual(rows[top + offset]!, left, line)
      for (let column = 0; column < boxWidth; column++) boxCells.add((top + offset) * canvasWidth + left + column)
    })
    const parent = entry.depth > 0 ? lastAtDepth.get(entry.depth - 1) : undefined
    positions.push({ left, right: left + boxWidth - 1, center: top + 1, parent })
    lastAtDepth.set(entry.depth, index)
    for (const depth of [...lastAtDepth.keys()]) if (depth > entry.depth) lastAtDepth.delete(depth)
  })

  positions.forEach((position) => {
    if (position.parent === undefined) return
    const parent = positions[position.parent]
    if (!parent) return
    const source = parent.right + 1
    const target = position.left - 1
    const elbow = Math.floor((source + target) / 2)
    drawHorizontalConnector(connectors, parent.center, source, elbow)
    drawVerticalConnector(connectors, elbow, parent.center, position.center)
    drawHorizontalConnector(connectors, position.center, elbow, target)
    putOverlay(overlays, canvasWidth, position.center, target, "▶")
  })
  const rendered = rows.map((row, rowIndex) => row.map((character, column) => {
    const cell = rowIndex * canvasWidth + column
    if (boxCells.has(cell)) return character
    const overlay = overlays.get(cell)
    if (overlay) return overlay
    const directions = connectors[rowIndex]?.[column]
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return [title, ...rendered].join("\n")
}

function renderAsciiTable(headers: string[], rows: string[][]) {
  const normalizedRows = rows.map((row) => headers.map((_, index) => cleanMermaidLabel(row[index]) || ""))
  const normalizedHeaders = headers.map((header) => cleanMermaidLabel(header) || "")
  const widths = normalizedHeaders.map((header, index) =>
    Math.max(Bun.stringWidth(header), ...normalizedRows.map((row) => Bun.stringWidth(row[index] ?? "")), 3),
  )
  const border = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`
  const top = `┌${widths.map((width) => "─".repeat(width + 2)).join("┬")}┐`
  const bottom = `└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`
  const row = (values: string[]) => `│${values.map((value, index) => ` ${padVisual(value, widths[index] ?? 0)} `).join("│")}│`
  return [top, row(normalizedHeaders), border, ...normalizedRows.map(row), bottom]
}

function renderMindmapDiagram(input: string): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^mindmap$/i)
  if (!entries) return undefined
  return renderBoxedHierarchy("Mindmap", entries)
}

function renderTimelineDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  const head = /^(timeline)(?:\s+(LR|TD))?$/i.exec(lines[0]?.trim() ?? "")
  if (!head) return undefined

  let title = "Timeline"
  let section = "Timeline"
  let period = ""
  const events: Array<{ section: string; period: string; event: string }> = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(line)
    if (sectionMatch) {
      section = cleanMermaidLabel(sectionMatch[1]) || section
      period = ""
      continue
    }
    const parts = splitMermaidTopLevel(line, ":").map(cleanMermaidLabel)
    if (parts.length < 2) continue
    if (parts[0]) period = parts.shift() ?? period
    for (const event of parts.filter(Boolean)) events.push({ section, period, event })
  }
  if (events.length === 0) return undefined
  const boxes = events.map((event) => renderCompactBox(`${event.event} · ${event.section}`, 16))
  const boxWidth = Math.max(...boxes.flatMap((box) => box.map((line) => Bun.stringWidth(line))), 16)
  if (head[2]?.toUpperCase() === "TD") {
    const gap = 8
    const axisColumn = boxWidth + gap
    const canvasWidth = boxWidth * 2 + gap * 2 + 1
    const canvasHeight = events.length * 5
    const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
    for (let row = 0; row < canvasHeight; row++) canvas[row]![axisColumn] = "│"
    events.forEach((event, index) => {
      const box = boxes[index] ?? renderBox(event.event)
      const leftSide = index % 2 === 0
      const top = index * 5
      const left = leftSide ? 0 : axisColumn + gap
      box.forEach((line, offset) => writeVisual(canvas[top + offset]!, left, line))
      const pointRow = top + 1
      canvas[pointRow]![axisColumn] = "●"
      if (leftSide) {
        for (let column = Bun.stringWidth(box[1] ?? ""); column < axisColumn; column++) canvas[pointRow]![column] = "─"
        writeVisual(canvas[pointRow - 1]!, Math.max(0, axisColumn - Bun.stringWidth(event.period)), event.period)
      } else {
        for (let column = axisColumn + 1; column < left; column++) canvas[pointRow]![column] = "─"
        writeVisual(canvas[pointRow - 1]!, axisColumn + 2, event.period)
      }
    })
    canvas[canvasHeight - 1]![axisColumn] = "▼"
    return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
  }
  const stride = boxWidth + 6
  const canvasWidth = events.length * stride
  const axisRow = 5
  const rowCount = 11
  const canvas = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  for (let column = Math.floor(boxWidth / 2); column < canvasWidth; column++) canvas[axisRow]![column] = "─"
  events.forEach((event, index) => {
    const box = boxes[index] ?? renderBox(event.event)
    const left = index * stride
    const above = index % 2 === 0
    const top = above ? 0 : 7
    box.forEach((line, offset) => writeVisual(canvas[top + offset]!, left, line))
    const center = left + Math.floor(Bun.stringWidth(box[0] ?? "") / 2)
    if (above) {
      for (let row = 3; row < axisRow; row++) canvas[row]![center] = "│"
      canvas[axisRow]![center] = "●"
      writeVisual(canvas[axisRow + 1]!, Math.max(0, center - Math.floor(Bun.stringWidth(event.period) / 2)), event.period)
    } else {
      canvas[axisRow]![center] = "●"
      for (let row = axisRow + 1; row < top; row++) canvas[row]![center] = "│"
      writeVisual(canvas[axisRow - 1]!, Math.max(0, center - Math.floor(Bun.stringWidth(event.period) / 2)), event.period)
    }
  })
  canvas[axisRow]![canvasWidth - 1] = "▶"
  return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}

function renderJourneyDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^journey$/i.test(lines[0]?.trim() ?? "")) return undefined
  let title = "Journey"
  let section = "Journey"
  const tasks: Array<{ section: string; label: string; score: number; actors: string }> = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(line)
    if (sectionMatch) {
      section = cleanMermaidLabel(sectionMatch[1]) || section
      continue
    }
    const task = /^(.+?)\s*:\s*([1-5])(?:\s*:\s*(.+))?$/.exec(line)
    if (task) tasks.push({
      section,
      label: cleanMermaidLabel(task[1]),
      score: Number(task[2]),
      actors: cleanMermaidLabel(task[3]) || "—",
    })
  }
  if (tasks.length === 0) return undefined

  const output: string[] = [title]
  const grouped = new Map<string, typeof tasks>()
  for (const task of tasks) grouped.set(task.section, [...(grouped.get(task.section) ?? []), task])
  for (const [sectionName, sectionTasks] of grouped) {
    if (output.length > 1) output.push("")
    const cellWidth = Math.max(
      16,
      ...sectionTasks.map((task) => Bun.stringWidth(task.label) + 4),
      ...sectionTasks.map((task) => Bun.stringWidth(task.actors) + 6),
    )
    const availableWidth = Math.max(40, Math.floor(width) - 12)
    const perRow = Math.max(1, Math.min(5, Math.floor(availableWidth / (cellWidth + 5))))
    for (let start = 0; start < sectionTasks.length; start += perRow) {
      const rowTasks = sectionTasks.slice(start, start + perRow)
      const sectionWidth = rowTasks.length * cellWidth + Math.max(0, rowTasks.length - 1) * 5
      output.push(`╭─ ${sectionName} ${"─".repeat(Math.max(1, sectionWidth - Bun.stringWidth(sectionName) - 3))}╮`)
      const taskBoxes = rowTasks.map((task) => {
        const innerWidth = cellWidth - 2
        const stars = `${"★".repeat(task.score)}${"☆".repeat(5 - task.score)}  ${task.score}/5`
        return [
          `╭${"─".repeat(innerWidth)}╮`,
          `│${centerVisual(task.label, innerWidth)}│`,
          `│${centerVisual(stars, innerWidth)}│`,
          `│${centerVisual(`● ${task.actors}`, innerWidth)}│`,
          `╰${"─".repeat(innerWidth)}╯`,
        ]
      })
      for (let row = 0; row < 5; row++) {
        const content = taskBoxes.map((box, index) => `${box[row] ?? ""}${index < taskBoxes.length - 1 ? row === 2 ? "───▶ " : "     " : ""}`).join("")
        output.push(`│${padVisual(content, sectionWidth)}│`)
      }
      output.push(`╰${"─".repeat(sectionWidth)}╯`)
    }
  }
  return output.join("\n")
}

function renderKanbanDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^kanban$/i.test(lines[0]?.trim() ?? "")) return undefined

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
    const label = bracketOnly ? cleanMermaidLabel(bracketOnly[1]) : node?.label
    if (!label) continue
    if (indent <= 0 || !current) {
      current = { title: label, tasks: [] }
      columns.push(current)
      continue
    }
    const metadata = /@\{(.+)\}$/.exec(line)?.[1]
    current.tasks.push(metadata ? `${label} · ${cleanMermaidLabel(metadata)}` : label)
  }
  if (columns.length === 0) return undefined
  const visible = columns.slice(0, 12)
  const columnWidth = Math.min(42, Math.max(18, ...visible.map((column) => Bun.stringWidth(column.title) + 4), ...visible.flatMap((column) => column.tasks.map((task) => Bun.stringWidth(task) + 6))))
  const maxTasks = Math.max(1, ...visible.map((column) => column.tasks.length))
  const renderedColumns = visible.map((column) => {
    const rows = [`╭${"─".repeat(columnWidth)}╮`, `│${centerVisual(column.title, columnWidth)}│`, `├${"─".repeat(columnWidth)}┤`]
    for (let index = 0; index < maxTasks; index++) {
      const task = column.tasks[index]
      if (!task) {
        rows.push(`│${" ".repeat(columnWidth)}│`, `│${" ".repeat(columnWidth)}│`, `│${" ".repeat(columnWidth)}│`)
        continue
      }
      const inner = columnWidth - 4
      rows.push(
        `│ ╭${"─".repeat(inner)}╮ │`,
        `│ │${centerVisual(task, inner)}│ │`,
        `│ ╰${"─".repeat(inner)}╯ │`,
      )
    }
    rows.push(`╰${"─".repeat(columnWidth)}╯`)
    return rows
  })
  return [
    "Kanban",
    ...renderedColumns[0]!.map((_, row) => renderedColumns.map((column) => column[row]).join("  ")),
  ].join("\n")
}

function renderTreeViewDiagram(input: string): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^treeview-beta$/i)
  if (!entries) return undefined
  return renderBoxedHierarchy("TreeView", entries)
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

  let title = "Quadrant chart"
  let xLow = "low"
  let xHigh = "high"
  let yLow = "low"
  let yHigh = "high"
  const quadrants = new Map<number, string>()
  const points: Array<{ label: string; x: number; y: number }> = []
  for (const line of lines.slice(1, 18)) {
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]) || title
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      const ends = axis[2].split(/\s*-->\s*/).map(cleanLabel)
      if (axis[1].toLowerCase() === "x-axis") [xLow, xHigh] = [ends[0] || xLow, ends[1] || xHigh]
      else [yLow, yHigh] = [ends[0] || yLow, ends[1] || yHigh]
      continue
    }
    const quadrant = /^quadrant-([1-4])\s+(.+)$/i.exec(line)
    if (quadrant) {
      quadrants.set(Number(quadrant[1]), cleanLabel(quadrant[2]))
      continue
    }
    const point = /^(.+?)\s*:\s*\[([^\]]+)\]$/.exec(line)
    if (point) {
      const [x, y] = point[2].split(",").map((value) => Number(value.trim()))
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ label: cleanLabel(point[1]), x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) })
    }
  }
  if (points.length === 0 && quadrants.size === 0) return undefined

  const chartWidth = Math.max(46, Math.min(72, width - 18))
  const chartHeight = 18
  const rows = Array.from({ length: chartHeight + 1 }, () => blankRow(chartWidth + 1))
  for (let column = 0; column <= chartWidth; column++) {
    rows[0]![column] = "─"
    rows[chartHeight]![column] = "─"
    rows[Math.floor(chartHeight / 2)]![column] = "─"
  }
  for (let row = 0; row <= chartHeight; row++) {
    rows[row]![0] = "│"
    rows[row]![chartWidth] = "│"
    rows[row]![Math.floor(chartWidth / 2)] = "│"
  }
  rows[0]![0] = "┌"
  rows[0]![chartWidth] = "┐"
  rows[chartHeight]![0] = "└"
  rows[chartHeight]![chartWidth] = "┘"
  rows[0]![Math.floor(chartWidth / 2)] = "┬"
  rows[chartHeight]![Math.floor(chartWidth / 2)] = "┴"
  rows[Math.floor(chartHeight / 2)]![0] = "├"
  rows[Math.floor(chartHeight / 2)]![chartWidth] = "┤"
  rows[Math.floor(chartHeight / 2)]![Math.floor(chartWidth / 2)] = "┼"

  const quadrantPositions = new Map<number, { row: number; column: number }>([
    [1, { row: 1, column: Math.floor(chartWidth / 2) + 2 }],
    [2, { row: 1, column: 2 }],
    [3, { row: Math.floor(chartHeight / 2) + 1, column: 2 }],
    [4, { row: Math.floor(chartHeight / 2) + 1, column: Math.floor(chartWidth / 2) + 2 }],
  ])
  for (const [number, label] of quadrants) {
    const position = quadrantPositions.get(number)
    if (position) writeVisual(rows[position.row]!, position.column, label.slice(0, Math.floor(chartWidth / 2) - 4))
  }
  for (const point of points) {
    const column = 1 + Math.round(point.x * (chartWidth - 2))
    const row = chartHeight - 1 - Math.round(point.y * (chartHeight - 2))
    rows[row]![column] = "●"
    const label = point.label
    const labelColumn = column + Bun.stringWidth(label) + 2 < chartWidth ? column + 2 : Math.max(1, column - Bun.stringWidth(label) - 1)
    writeVisual(rows[row]!, labelColumn, label)
  }

  return [
    centerVisual(title, chartWidth + 1),
    `${centerVisual(yHigh, chartWidth + 1)} ▲`,
    ...rows.map((row) => row.join("")),
    `${xLow} ◀${"─".repeat(Math.max(3, chartWidth - Bun.stringWidth(xLow) - Bun.stringWidth(xHigh) - 4))}▶ ${xHigh}`,
    `${centerVisual(yLow, chartWidth + 1)} ▼`,
  ].join("\n")
}

function renderGitGraph(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^gitGraph\b/i.test(lines[0] ?? "")) return undefined

  type GitBranch = { name: string; start: number; last: number }
  type GitCommit = { branch: string; column: number; label: string; mergeFrom?: string; mergeStart?: number; merge?: boolean }
  const branches: GitBranch[] = [{ name: "main", start: 0, last: 0 }]
  const commits: GitCommit[] = []
  let currentBranch = "main"
  let timeline = 0
  const branchFor = (name: string) => branches.find((branch) => branch.name === name)
  for (const line of lines.slice(1, 80)) {
    const commit = /^commit(?:\s+id:\s*"?([^"]+)"?)?/i.exec(line)
    if (commit) {
      timeline++
      const branch = branchFor(currentBranch)
      if (!branch) continue
      branch.last = timeline
      commits.push({ branch: currentBranch, column: timeline, label: cleanLabel(commit[1]) || "commit" })
      continue
    }
    const branch = /^branch\s+(.+)$/i.exec(line)
    if (branch) {
      const name = cleanLabel(branch[1])
      const source = branchFor(currentBranch)
      if (name && !branchFor(name)) branches.push({ name, start: source?.last ?? timeline, last: source?.last ?? timeline })
      if (name) currentBranch = name
      continue
    }
    const checkout = /^(?:checkout|switch)\s+(.+)$/i.exec(line)
    if (checkout) {
      currentBranch = cleanLabel(checkout[1]) || currentBranch
      continue
    }
    const merge = /^merge\s+(.+)$/i.exec(line)
    if (merge) {
      const sourceName = cleanLabel(merge[1]).split(/\s+/)[0]
      const source = branchFor(sourceName)
      const target = branchFor(currentBranch)
      if (!target) continue
      timeline++
      target.last = timeline
      commits.push({
        branch: currentBranch,
        column: timeline,
        label: `merge ${sourceName}`,
        mergeFrom: sourceName,
        mergeStart: source?.last,
        merge: true,
      })
    }
  }
  if (commits.length === 0) return undefined

  const labelWidth = Math.max(10, ...branches.map((branch) => Bun.stringWidth(branch.name) + 2))
  const stride = Math.max(10, ...commits.map((commit) => Bun.stringWidth(commit.label) + 4))
  const graphStart = labelWidth + 2
  const canvasWidth = graphStart + (timeline + 1) * stride
  const rowCount = branches.length * 4
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectors = Array.from({ length: rowCount }, () =>
    Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()),
  )
  const overlays = new Map<number, string>()
  const graphRow = (branchName: string) => branches.findIndex((branch) => branch.name === branchName) * 4 + 2
  const graphColumn = (column: number) => graphStart + column * stride

  for (const branch of branches) {
    const row = graphRow(branch.name)
    writeVisual(rows[row]!, 0, padVisual(branch.name, labelWidth))
    const branchStartColumn = graphColumn(branch.start)
    const visibleStart = branch.name === "main" ? branchStartColumn : Math.min(graphColumn(Math.max(branch.start, branch.last)), branchStartColumn + 3)
    drawHorizontalConnector(connectors, row, visibleStart, graphColumn(Math.max(branch.start, branch.last)))
    if (branch.name !== "main") {
      const parent = branches.find((candidate) => candidate !== branch && candidate.start <= branch.start && candidate.last >= branch.start) ?? branches[0]
      const parentRow = graphRow(parent?.name ?? "main")
      const rowStep = row > parentRow ? 1 : -1
      for (let offset = 1; offset < Math.abs(row - parentRow); offset++) {
        putOverlay(overlays, canvasWidth, parentRow + offset * rowStep, Math.min(canvasWidth - 1, branchStartColumn + offset), rowStep > 0 ? "╲" : "╱")
      }
    }
  }

  for (const commit of commits) {
    const row = graphRow(commit.branch)
    const column = graphColumn(commit.column)
    putOverlay(overlays, canvasWidth, row, column, commit.merge ? "◎" : "●")
    const labelStart = Math.max(graphStart, Math.min(canvasWidth - Bun.stringWidth(commit.label), column - Math.floor(Bun.stringWidth(commit.label) / 2)))
    writeVisual(rows[row - 1]!, labelStart, commit.label)
    if (commit.mergeFrom && commit.mergeStart !== undefined) {
      const sourceRow = graphRow(commit.mergeFrom)
      const sourceColumn = graphColumn(commit.mergeStart)
      const rowDistance = Math.abs(sourceRow - row)
      const diagonalStart = Math.max(sourceColumn, column - rowDistance)
      drawHorizontalConnector(connectors, sourceRow, sourceColumn, diagonalStart)
      const rowStep = row > sourceRow ? 1 : -1
      for (let offset = 1; offset < rowDistance; offset++) {
        putOverlay(overlays, canvasWidth, sourceRow + offset * rowStep, diagonalStart + offset, rowStep > 0 ? "╲" : "╱")
      }
    }
  }

  const rendered = rows.map((row, rowIndex) => row.map((character, column) => {
    const overlay = overlays.get(rowIndex * canvasWidth + column)
    if (overlay) return overlay
    const directions = connectors[rowIndex]?.[column]
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return ["Git graph", ...rendered].join("\n")
}

function renderRequirementDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^requirementDiagram$/i.test(lines[0] ?? "")) return undefined

  const requirements = new Map<string, { kind: string; fields: string[] }>()
  const relations: Array<{ from: string; to: string; type: string; reverse: boolean }> = []
  let current: string | undefined
  for (const line of lines.slice(1, 32)) {
    const block = /^(requirement|functionalRequirement|performanceRequirement|interfaceRequirement|physicalRequirement|designConstraint|element)\s+([A-Za-z][\w-]*)\s*\{?$/i.exec(line)
    if (block) {
      current = block[2]
      requirements.set(current, { kind: block[1], fields: [] })
      continue
    }
    if (line === "}") {
      current = undefined
      continue
    }
    const field = /^(id|text|risk|verifymethod|verifyMethod|type|docref|docRef):\s*(.+)$/i.exec(line)
    if (field && current) {
      const item = requirements.get(current)
      if (item) item.fields.push(`${field[1]}: ${cleanLabel(field[2])}`)
      continue
    }
    const relation = /^([A-Za-z][\w-]*)\s+(<-|-)\s*(contains|copies|derives|satisfies|verifies|refines|traces)\s*(->|-)\s+([A-Za-z][\w-]*)$/i.exec(line)
    if (relation) relations.push({ from: relation[1], to: relation[5], type: relation[3], reverse: relation[2] === "<-" })
  }
  if (requirements.size === 0) return undefined
  const boxFor = (id: string) => {
    const requirement = requirements.get(id)
    return renderEntityBox(`«${requirement?.kind ?? "requirement"}» ${id}`, requirement?.fields ?? [])
  }
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  const output: string[] = ["Requirement diagram"]
  for (const [index, relation] of relations.entries()) {
    if (index > 0) output.push("")
    output.push(...renderConnectedDiagramBoxes({
      left: boxFor(relation.from),
      right: boxFor(relation.to),
      connector: relation.reverse ? "◀────" : "────▶",
      label: relation.type,
    }))
  }
  for (const id of requirements.keys()) {
    if (related.has(id)) continue
    if (output.length > 1) output.push("")
    output.push(...boxFor(id))
  }
  return output.join("\n")
}

function renderC4Diagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^C4/i.test(lines[0] ?? "")) return undefined

  const body = lines.slice(1, 32)
  const entityPattern = /^(Person(?:_Ext)?|System(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?|_Boundary)?|Enterprise_Boundary|Container(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?|_Boundary)?|Component(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?)|Boundary|Deployment_Node|Node(?:_L|_R)?)\s*\((.+)\)\s*\{?$/i
  const entities = new Map<string, { label: string; kind: string; description?: string }>()
  for (const line of body) {
    const entity = entityPattern.exec(line)
    if (!entity) continue
    const args = stripMermaidCallArguments(entity[2])
    const id = args[0] || "item"
    entities.set(id, { label: args[1] || id, kind: entity[1], description: args[2] })
  }

  const output: string[] = [`C4 ${cleanLabel(lines[0]).replace(/^C4\s*/i, "") || "diagram"}`]
  const relations: Array<{ from: string; to: string; label: string }> = []
  for (const line of body) {
    const relation = /^(RelIndex|Rel(?:_[A-Za-z]+)?|BiRel)\s*\((.+)\)$/i.exec(line)
    if (relation) {
      const args = stripMermaidCallArguments(relation[2])
      const offset = relation[1].toLowerCase() === "relindex" ? 1 : 0
      relations.push({ from: args[offset] || "from", to: args[offset + 1] || "to", label: args[offset + 2] || "relates" })
      continue
    }

    const entity = entityPattern.exec(line)
    if (entity) {
      const args = stripMermaidCallArguments(entity[2])
      const id = args[0] || "item"
      const label = args[1] || id
      entities.set(id, { label, kind: entity[1], description: args[2] })
    }
  }
  const boxFor = (id: string) => {
    const entity = entities.get(id)
    return renderEntityBox(`${entity?.kind ?? "Element"} · ${entity?.label ?? id}`, entity?.description ? [entity.description] : [])
  }
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  for (const [index, relation] of relations.entries()) {
    if (index > 0) output.push("")
    output.push(...renderConnectedDiagramBoxes({ left: boxFor(relation.from), right: boxFor(relation.to), connector: "────▶", label: relation.label }))
  }
  for (const id of entities.keys()) {
    if (related.has(id)) continue
    if (output.length > 1) output.push("")
    output.push(...boxFor(id))
  }
  return output.length > 1 ? output.join("\n") : undefined
}

function renderXyChart(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const head = /^xychart(?:-beta)?(?:\s+(horizontal|vertical))?$/i.exec(lines[0] ?? "")
  if (!head) return undefined

  let title = "XY chart"
  let yTitle = "value"
  let yMin: number | undefined
  let yMax: number | undefined
  let categories: string[] = []
  const series: Array<{ kind: "bar" | "line"; values: number[] }> = []
  for (const line of lines.slice(1, 24)) {
    const titleMatch = /^title\s+"?([^"]+)"?$/i.exec(line)
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]) || title
      continue
    }
    const axis = /^(x-axis|y-axis)\s+(.+)$/i.exec(line)
    if (axis) {
      if (axis[1].toLowerCase() === "x-axis") {
        const list = /\[([^\]]+)\]/.exec(axis[2])
        if (list) categories = splitMermaidTopLevel(list[1], ",").map(cleanMermaidLabel)
      } else {
        const range = /^(?:"([^"]+)"|(.*?))?\s*(-?[0-9.]+)\s*-->\s*(-?[0-9.]+)$/.exec(axis[2])
        if (range) {
          yTitle = cleanMermaidLabel(range[1] || range[2]) || yTitle
          yMin = Number(range[3])
          yMax = Number(range[4])
        } else yTitle = cleanMermaidLabel(axis[2]) || yTitle
      }
      continue
    }
    const seriesMatch = /^(bar|line)\s+\[([^\]]+)\]$/i.exec(line)
    if (seriesMatch) {
      const values = splitMermaidTopLevel(seriesMatch[2], ",").map((value) => Number(/^\s*([-+0-9.]+)/.exec(value)?.[1])).filter(Number.isFinite)
      series.push({ kind: seriesMatch[1].toLowerCase() as "bar" | "line", values })
    }
  }
  if (series.length === 0) return undefined
  const count = Math.max(...series.map((item) => item.values.length), categories.length, 1)
  if (categories.length === 0) categories = Array.from({ length: count }, (_, index) => String(index + 1))
  const values = series.flatMap((item) => item.values)
  const minimum = yMin ?? Math.min(0, ...values)
  const maximum = yMax ?? Math.max(0, ...values)
  const span = Math.max(1, maximum - minimum)
  if (head[1]?.toLowerCase() === "horizontal") {
    const labelWidth = Math.max(8, ...categories.map((category) => Bun.stringWidth(category)))
    const plotWidth = Math.max(36, Math.min(72, width - labelWidth - 8))
    const rows = Array.from({ length: count * 2 - 1 }, () => blankRow(plotWidth))
    const valueColumn = (value: number) => Math.max(0, Math.min(plotWidth - 1, Math.round((value - minimum) / span * (plotWidth - 1))))
    const zeroColumn = valueColumn(Math.max(minimum, Math.min(maximum, 0)))
    const barSeries = series.find((item) => item.kind === "bar")
    barSeries?.values.forEach((value, index) => {
      const end = valueColumn(value)
      for (let column = Math.min(zeroColumn, end); column <= Math.max(zeroColumn, end); column++) rows[index * 2]![column] = "█"
    })
    const lineSeries = series.filter((item) => item.kind === "line")
    lineSeries.forEach((item, seriesIndex) => {
      item.values.forEach((value, index) => {
        const column = valueColumn(value)
        const row = index * 2
        rows[row]![column] = seriesIndex === 0 ? "●" : "◆"
        if (index === 0) return
        const previous = valueColumn(item.values[index - 1] ?? 0)
        const bridgeRow = row - 1
        for (let x = Math.min(previous, column); x <= Math.max(previous, column); x++) if (rows[bridgeRow]![x] === " ") rows[bridgeRow]![x] = "─"
        rows[bridgeRow]![previous] = "┐"
        rows[bridgeRow]![column] = "└"
      })
    })
    return [
      title,
      ...rows.map((row, index) => `${padVisual(index % 2 === 0 ? categories[index / 2] ?? "" : "", labelWidth)} │${row.join("")}`),
      `${" ".repeat(labelWidth + 2)}└${"─".repeat(plotWidth)}▶ ${yTitle}`,
    ].join("\n")
  }
  const plotHeight = 14
  const plotWidth = Math.max(42, Math.min(84, width - 14))
  const stride = Math.max(3, Math.floor(plotWidth / count))
  const actualWidth = stride * count
  const rows = Array.from({ length: plotHeight }, () => blankRow(actualWidth))
  const valueRow = (value: number) => Math.max(0, Math.min(plotHeight - 1, Math.round((maximum - value) / span * (plotHeight - 1))))
  const zeroRow = valueRow(Math.max(minimum, Math.min(maximum, 0)))
  for (let column = 0; column < actualWidth; column++) rows[zeroRow]![column] = "─"

  const bars = series.filter((item) => item.kind === "bar")
  for (const [seriesIndex, item] of bars.entries()) {
    item.values.forEach((value, index) => {
      const center = index * stride + Math.floor(stride / 2)
      const column = Math.min(actualWidth - 1, center + seriesIndex - Math.floor(bars.length / 2))
      const row = valueRow(value)
      for (let y = Math.min(row, zeroRow); y <= Math.max(row, zeroRow); y++) rows[y]![column] = "█"
    })
  }
  for (const [seriesIndex, item] of series.filter((entry) => entry.kind === "line").entries()) {
    for (let index = 0; index < item.values.length; index++) {
      const x = index * stride + Math.floor(stride / 2)
      const y = valueRow(item.values[index] ?? 0)
      rows[y]![x] = seriesIndex === 0 ? "●" : "◆"
      if (index === 0) continue
      const previousX = (index - 1) * stride + Math.floor(stride / 2)
      const previousY = valueRow(item.values[index - 1] ?? 0)
      const elbow = Math.floor((previousX + x) / 2)
      for (let column = previousX + 1; column <= elbow; column++) if (rows[previousY]![column] === " ") rows[previousY]![column] = "─"
      for (let row = Math.min(previousY, y); row <= Math.max(previousY, y); row++) if (rows[row]![elbow] === " ") rows[row]![elbow] = "│"
      for (let column = elbow + 1; column < x; column++) if (rows[y]![column] === " ") rows[y]![column] = "─"
    }
  }
  const output = [title, `${yTitle} ↑`]
  rows.forEach((row, index) => {
    const value = maximum - index / (plotHeight - 1) * span
    const tick = index === 0 || index === plotHeight - 1 || index === zeroRow ? String(Math.round(value * 100) / 100) : ""
    output.push(`${padVisual(tick, 7)}│${row.join("")}`)
  })
  output.push(`${" ".repeat(7)}└${"─".repeat(actualWidth)}▶`)
  output.push(`${" ".repeat(8)}${categories.map((category) => centerVisual(category.slice(0, stride - 1), stride)).join("")}`)
  return output.join("\n")
}

function renderSankeyDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^sankey(?:-beta)?$/i.test(lines[0] ?? "")) return undefined

  const links: Array<{ from: string; to: string; value: number }> = []
  for (const line of lines.slice(1, 24)) {
    const parts = splitMermaidTopLevel(line, ",").map(cleanLabel).filter(Boolean)
    const value = Number(parts[2])
    if (parts.length >= 3 && Number.isFinite(value)) links.push({ from: parts[0], to: parts[1], value })
  }
  if (links.length === 0) return undefined
  const maximum = Math.max(...links.map((link) => Math.abs(link.value)), 1)
  const output = ["Sankey · flow width = value"]
  for (const [index, link] of links.entries()) {
    if (index > 0) output.push("")
    const bandWidth = Math.max(6, Math.round(Math.abs(link.value) / maximum * Math.max(12, Math.min(36, width - 34))))
    const left = renderCompactBox(link.from, 12)
    const right = renderCompactBox(link.to, 12)
    const gap = Math.max(bandWidth + 3, Bun.stringWidth(String(link.value)) + 4)
    output.push(
      `${padVisual(left[0]!, Bun.stringWidth(left[0]!))}${centerVisual(String(link.value), gap)}${right[0]}`,
      `${left[1]}${centerVisual(`${"█".repeat(bandWidth)}▶`, gap)}${right[1]}`,
      `${left[2]}${" ".repeat(gap)}${right[2]}`,
    )
  }
  return output.join("\n")
}

function renderBlockDiagram(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^block(?:-beta)?$/i.test(lines[0] ?? "")) return undefined

  const body = lines.slice(1, 80)
  const columns = Math.max(1, Number(/^columns\s+(\d+)/i.exec(body.find((line) => /^columns\s+/i.test(line)) ?? "")?.[1] ?? 1))
  const labels = new Map<string, string>()
  const shapes = new Map<string, FlowchartNodeShape>()
  const order: string[] = []
  const edges: FlowchartEdge[] = []
  const nodePattern = /([A-Za-z][\w-]*)(?:\[\s*"?([^\]"]+)"?\s*\])?(?::\d+)?/g
  const parseNodes = (line: string) => {
    const nodes: string[] = []
    for (const match of line.matchAll(nodePattern)) {
      const id = match[1]
      if (!id || id.toLowerCase() === "space") continue
      labels.set(id, cleanLabel(match[2] || labels.get(id) || id))
      if (!order.includes(id)) order.push(id)
      nodes.push(id)
    }
    return nodes
  }
  for (const raw of body) {
    const line = raw.split("%%", 1)[0]?.trim() ?? ""
    if (!line || /^columns\s+/i.test(line) || /^(?:space|\{|\})/i.test(line)) continue
    const edge = /^(.+?)\s+(<-->|-->|<--|---|--)\s+(.+?)$/.exec(line)
    if (edge) {
      const from = parseNodes(edge[1] ?? "")[0]
      const to = parseNodes(edge[3] ?? "")[0]
      if (from && to) {
        edges.push(edge[2] === "<--" ? { from: to, to: from } : { from, to })
        continue
      }
    }
    for (const node of parseNodes(line)) {
      const expression = new RegExp(`${node}[^\\s]*`).exec(line)?.[0]
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
    if (from.center === to.center) {
      const forward = to.left > from.right
      drawHorizontalConnector(connectors, from.center, forward ? from.right + 1 : from.left - 1, forward ? to.left - 1 : to.right + 1)
      putOverlay(overlays, canvasWidth, to.center, forward ? to.left - 1 : to.right + 1, forward ? "▶" : "◀")
      continue
    }
    const fromCenter = Math.floor((from.left + from.right) / 2)
    const toCenter = Math.floor((to.left + to.right) / 2)
    const elbowRow = Math.floor((from.bottom + to.top) / 2)
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
    const directions = connectors[rowIndex]?.[column]
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return ["Block diagram", ...rendered].join("\n")
}

function renderPacketDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^packet(?:-beta)?$/i.test(lines[0] ?? "")) return undefined

  const fields: Array<{ start: number; end: number; label: string }> = []
  for (const line of lines.slice(1, 24)) {
    const field = /^(\+?[0-9]+(?:-[0-9]+)?)\s*:\s*"?([^"%]+)"?(?:\s+%%.*)?$/.exec(line)
    if (!field) continue
    const relative = field[1].startsWith("+")
    const range = field[1].replace(/^\+/, "").split("-").map(Number)
    const previousEnd = fields.at(-1)?.end ?? -1
    const start = relative ? previousEnd + 1 : range[0] ?? previousEnd + 1
    const end = range.length > 1 ? range[1] ?? start : relative ? start + (range[0] ?? 1) - 1 : start
    fields.push({ start, end: Math.max(start, end), label: cleanLabel(field[2]) })
  }
  if (fields.length === 0) return undefined
  const output = ["Packet layout"]
  const groups = new Map<number, typeof fields>()
  for (const field of fields) {
    const word = Math.floor(field.start / 32)
    groups.set(word, [...(groups.get(word) ?? []), field])
  }
  for (const [word, wordFields] of groups) {
    if (output.length > 1) output.push("")
    output.push(`word ${word} · bits ${word * 32}–${word * 32 + 31}`)
    const widths = wordFields.map((field) => Math.max(Bun.stringWidth(field.label) + 2, (field.end - field.start + 1) * 2))
    output.push(wordFields.map((field, index) => centerVisual(`${field.start}–${field.end}`, widths[index] ?? 4)).join(" "))
    output.push(`┌${widths.map((fieldWidth) => "─".repeat(fieldWidth)).join("┬")}┐`)
    output.push(`│${wordFields.map((field, index) => centerVisual(field.label, widths[index] ?? 4)).join("│")}│`)
    output.push(`└${widths.map((fieldWidth) => "─".repeat(fieldWidth)).join("┴")}┘`)
  }
  return output.join("\n")
}

function renderArchitectureDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^architecture-beta$/i.test(lines[0] ?? "")) return undefined

  const body = lines.slice(1, 80)
  const groups = new Map<string, { label: string; icon: string; parent?: string }>()
  const nodes = new Map<string, { label: string; icon: string; group?: string; junction: boolean }>()
  const relations: Array<{ from: string; to: string; connector: string }> = []
  for (const line of body) {
    const service = /^(?:service)\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\](?:\s+in\s+([A-Za-z][\w-]*))?/i.exec(line)
    if (service) {
      nodes.set(service[1], { label: cleanLabel(service[3]), icon: cleanLabel(service[2]), group: service[4], junction: false })
      continue
    }
    const group = /^group\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\](?:\s+in\s+([A-Za-z][\w-]*))?/i.exec(line)
    if (group) {
      groups.set(group[1], { label: cleanLabel(group[3]), icon: cleanLabel(group[2]), parent: group[4] })
      continue
    }
    const junction = /^junction\s+([A-Za-z][\w-]*)(?:\s+in\s+([A-Za-z][\w-]*))?/i.exec(line)
    if (junction) {
      nodes.set(junction[1], { label: junction[1], icon: "junction", group: junction[2], junction: true })
      continue
    }
    const edge = /^([A-Za-z][\w-]*)(?:\{[^}]+\})?(?::[A-Z])?\s*(<-->|<--|-->|---|--|<->)\s*(?:[A-Z]:)?([A-Za-z][\w-]*)(?:\{[^}]+\})?$/i.exec(line)
    if (edge) relations.push({ from: edge[1], to: edge[3], connector: edge[2] })
  }

  const output: string[] = ["Architecture"]
  const boxFor = (id: string) => {
    const node = nodes.get(id)
    if (!node) return renderBox(id)
    if (node.junction) return renderCompactBox(`◆ ${node.label}`, 10)
    return renderEntityBox(node.label, [node.icon])
  }
  const renderNodeSet = (ids: string[], scopedRelations: typeof relations) => {
    const boxes = ids.map((id) => boxFor(id))
    const widths = boxes.map((box) => Bun.stringWidth(box[0] ?? ""))
    const heights = boxes.map((box) => box.length)
    const gap = Math.max(10, Math.min(18, Math.floor(width / Math.max(5, ids.length * 2))))
    const lefts: number[] = []
    let rowWidth = 0
    widths.forEach((boxWidth, index) => {
      lefts.push(rowWidth)
      rowWidth += boxWidth + (index < widths.length - 1 ? gap : 0)
    })
    const rowHeight = Math.max(...heights, 3)
    const canvasHeight = rowHeight + Math.max(0, scopedRelations.length - 1) * 2
    const canvas = Array.from({ length: canvasHeight }, () => blankRow(rowWidth))
    boxes.forEach((box, index) => box.forEach((line, row) => writeVisual(canvas[row]!, lefts[index] ?? 0, line)))
    scopedRelations.forEach((relation, relationIndex) => {
      const fromIndex = ids.indexOf(relation.from)
      const toIndex = ids.indexOf(relation.to)
      if (fromIndex < 0 || toIndex < 0) return
      const fromLeft = lefts[fromIndex] ?? 0
      const toLeft = lefts[toIndex] ?? 0
      const fromRight = fromLeft + (widths[fromIndex] ?? 1) - 1
      const toRight = toLeft + (widths[toIndex] ?? 1) - 1
      const fromCenterRow = Math.floor((heights[fromIndex] ?? 3) / 2)
      const toCenterRow = Math.floor((heights[toIndex] ?? 3) / 2)
      const connector = relation.connector === "-->" ? "────▶" : relation.connector === "<--" ? "◀────" : relation.connector === "<-->" || relation.connector === "<->" ? "◀──▶" : "─────"
      if (fromIndex < toIndex && toIndex === fromIndex + 1 && fromCenterRow === toCenterRow) {
        writeVisual(canvas[fromCenterRow]!, fromRight + 1, centerVisual(connector, Math.max(1, toLeft - fromRight - 1)))
        return
      }
      const laneRow = Math.min(canvasHeight - 1, rowHeight + relationIndex * 2)
      const sourceColumn = fromIndex < toIndex ? fromRight : fromLeft
      const targetColumn = fromIndex < toIndex ? toLeft : toRight
      for (let row = fromCenterRow + 1; row <= laneRow; row++) canvas[row]![sourceColumn] = "│"
      for (let column = Math.min(sourceColumn, targetColumn); column <= Math.max(sourceColumn, targetColumn); column++) canvas[laneRow]![column] = "─"
      for (let row = toCenterRow + 1; row <= laneRow; row++) canvas[row]![targetColumn] = "│"
      canvas[toCenterRow]![targetColumn] = fromIndex < toIndex ? "▶" : "◀"
    })
    return canvas.map((row) => row.join("").trimEnd())
  }

  const renderedNodes = new Set<string>()
  for (const [groupId, group] of groups) {
    const members = [...nodes].filter(([, node]) => node.group === groupId).map(([id]) => id)
    if (members.length === 0) continue
    const internalRelations = relations.filter((relation) => members.includes(relation.from) && members.includes(relation.to))
    const content = renderNodeSet(members, internalRelations)
    const contentWidth = Math.max(...content.map((line) => Bun.stringWidth(line)), 20)
    const heading = ` ${group.label} · ${group.icon} `
    output.push(
      `╭─${heading}${"─".repeat(Math.max(1, contentWidth - Bun.stringWidth(heading) + 1))}╮`,
      ...content.map((line) => `│ ${padVisual(line, contentWidth)} │`),
      `╰${"─".repeat(contentWidth + 2)}╯`,
    )
    members.forEach((member) => renderedNodes.add(member))
  }
  const standalone = [...nodes.keys()].filter((id) => !renderedNodes.has(id))
  if (standalone.length > 0) {
    if (output.length > 1) output.push("")
    output.push(...renderNodeSet(standalone, relations.filter((relation) => standalone.includes(relation.from) && standalone.includes(relation.to))))
  }
  const crossGroup = relations.filter((relation) => nodes.get(relation.from)?.group !== nodes.get(relation.to)?.group)
  if (crossGroup.length > 0) output.push("", "Cross-group links", ...crossGroup.map((relation) => `${relation.from} ${relation.connector} ${relation.to}`))
  return output.length > 1 ? output.join("\n") : undefined
}

function renderSwimlaneDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  const head = /^swimlane-beta(?:\s+(TB|TD|BT|LR|RL))?$/i.exec(lines[0]?.trim() ?? "")
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
      lane = cleanMermaidLabel(subgraph[2] || subgraph[1]) || `Lane ${laneNumber + 1}`
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
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectorCells = Array.from({ length: rowCount }, () =>
    Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()),
  )
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const positions = new Map<string, { left: number; right: number; centerRow: number }>()

  for (const [laneIndex, layout] of laneLayouts.entries()) {
    const border = laneIndex === 0 ? "┌" : "├"
    rows[layout.top]![0] = border
    for (let column = 1; column < canvasWidth - 1; column++) rows[layout.top]![column] = "─"
    rows[layout.top]![canvasWidth - 1] = laneIndex === 0 ? "┐" : "┤"
    writeVisual(rows[layout.top]!, 2, ` ${layout.name} `)
    for (let row = layout.top + 1; row < layout.bottom; row++) {
      rows[row]![0] = "│"
      rows[row]![canvasWidth - 1] = "│"
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
  rows[bottom]![0] = "└"
  for (let column = 1; column < canvasWidth - 1; column++) rows[bottom]![column] = "─"
  rows[bottom]![canvasWidth - 1] = "┘"

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
      const directions = connectorCells[rowIndex]?.[column]
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

  return [`Swimlane · ${(head[1] ?? "LR").toUpperCase()}`, ...rendered].join("\n")
}

function renderZenUml(input: string, width: number): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^zenuml$/i.test(lines[0]?.trim() ?? "")) return undefined
  const sequenceSource = ["sequenceDiagram"]
  let sequenceMessages = 0
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const message = /^([A-Za-z_][\w.-]*?)\s*(-->>|->>|-->|->|=>|=>>|\-\))\s*([A-Za-z_][\w.-]*?)(?:\s*:\s*(.+))?$/i.exec(line)
    if (message) {
      sequenceSource.push(`${message[1]}${message[2]}${message[3]}: ${cleanMermaidLabel(message[4]) || "call"}`)
      sequenceMessages++
      continue
    }
    const branch = /^(if\s*\((.+)\)|opt\s+(.+)|loop\s+(.+))\s*\{?$/i.exec(line)
    if (branch) sequenceSource.push(`${/^loop/i.test(branch[1]) ? "loop" : /^opt/i.test(branch[1]) ? "opt" : "alt"} ${cleanMermaidLabel(branch[2] || branch[3] || branch[4])}`)
    else if (/^}\s*else/i.test(line)) sequenceSource.push(`else ${cleanMermaidLabel(line.replace(/^}\s*else\s*/i, "").replace(/[{}]/g, ""))}`)
    else if (line === "}") sequenceSource.push("end")
  }
  if (sequenceMessages > 0) {
    const rendered = renderSequenceDiagram(sequenceSource.join("\n"), width)
    if (rendered) return ["ZenUML", rendered].join("\n")
  }
  const output: string[] = ["ZenUML"]
  let depth = 0
  let rendered = 0
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (!line) continue
    if (line === "}") {
      depth = Math.max(0, depth - 1)
      output.push(`${"  ".repeat(depth)}└─ end`)
      continue
    }
    const closeBranch = /^}\s*(else(?:\s+if\s*\(.+\))?|catch|finally)\s*\{?$/i.exec(line)
    if (closeBranch) {
      depth = Math.max(0, depth - 1)
      output.push(`${"  ".repeat(depth)}├─ ${cleanMermaidLabel(closeBranch[1])}`)
      if (line.endsWith("{")) depth++
      continue
    }
    const branch = /^(if\s*\(.+\)|else(?:\s+if\s*\(.+\))?|opt|par|try|catch|finally|loop)\s*\{?$/i.exec(line)
    if (branch) {
      output.push(`${"  ".repeat(depth)}┌─ ${cleanMermaidLabel(branch[1])} ─┐`)
      if (line.endsWith("{")) depth++
      continue
    }
    const message = /^([A-Za-z_][\w.-]*?)\s*(-->>|->>|-->|->|=>|=>>|\-\))\s*([A-Za-z_][\w.-]*?)(?:\s*:\s*(.+))?$/i.exec(line)
    if (message) {
      const connector = message[2].startsWith("--") || message[2].startsWith("=") ? "╌╌╌▶" : "────▶"
      output.push(`${"  ".repeat(depth)}${renderInlineBox(message[1])} ${connector} ${renderInlineBox(message[3])}${message[4] ? `  ${cleanMermaidLabel(message[4])}` : ""}`)
      rendered++
      continue
    }
    const call = /^([A-Za-z_][\w.-]*)\s*\.\s*(.+)$/.exec(line)
    if (call) {
      output.push(`${"  ".repeat(depth)}${renderInlineBox(call[1])} · ${cleanMermaidLabel(call[2])}`)
      rendered++
      continue
    }
    if (!/^(?:title|hide|show)\b/i.test(line)) output.push(`${"  ".repeat(depth)}• ${cleanMermaidLabel(line)}`)
  }
  return rendered > 0 ? output.join("\n") : undefined
}

type RadarCurve = { id: string; label: string; values: string[] }

function renderRadarDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^radar-beta$/i.test(lines[0]?.trim() ?? "")) return undefined
  let title = "Radar"
  let min = "0"
  let max = "auto"
  const axes: Array<{ id: string; label: string }> = []
  const curves: RadarCurve[] = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    const minMatch = /^min\s+(.+)$/i.exec(line)
    if (minMatch) {
      min = cleanMermaidLabel(minMatch[1])
      continue
    }
    const maxMatch = /^max\s+(.+)$/i.exec(line)
    if (maxMatch) {
      max = cleanMermaidLabel(maxMatch[1])
      continue
    }
    if (/^(?:showLegend|graticule|ticks)\b/i.test(line)) continue
    const axis = /^axis\s+(.+)$/i.exec(line)
    if (axis) {
      for (const token of splitMermaidTopLevel(axis[1], ",")) {
        const labeled = /^([A-Za-z_][\w-]*)\s*\[\s*\"?(.+?)\"?\s*\]$/.exec(token)
        const id = cleanMermaidLabel(labeled?.[1] || token)
        axes.push({ id, label: cleanMermaidLabel(labeled?.[2] || labeled?.[1] || token) })
      }
      continue
    }
    const curve = /^curve\s+(.+)$/i.exec(line)
    if (curve) {
      for (const match of curve[1].matchAll(/([A-Za-z_][\w-]*)(?:\s*\[\s*\"?([^\]]+?)\"?\s*\])?\s*\{([^}]*)\}/g)) {
        const id = match[1]
        const label = cleanMermaidLabel(match[2] || id)
        const values = splitMermaidTopLevel(match[3], ",").map(cleanMermaidLabel)
        curves.push({ id, label, values })
      }
    }
  }
  if (axes.length === 0 || curves.length === 0) return undefined
  const valuesForCurve = (curve: RadarCurve) => {
    const keyed = new Map<string, number>()
    for (const value of curve.values) {
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)$/.exec(value)
      if (pair) keyed.set(pair[1], Number(pair[2]))
    }
    if (keyed.size > 0) return axes.map((axis) => keyed.get(axis.id) ?? 0)
    return axes.map((_, index) => Number(curve.values[index]) || 0)
  }
  const resolvedCurves = curves.map((curve) => ({ ...curve, numericValues: valuesForCurve(curve) }))
  const numericValues = resolvedCurves.flatMap((curve) => curve.numericValues.filter(Number.isFinite))
  const minimum = Number.isFinite(Number(min)) ? Number(min) : 0
  const maximum = Number.isFinite(Number(max)) ? Number(max) : Math.max(...numericValues, minimum + 1)
  const span = Math.max(1, maximum - minimum)
  const legend = resolvedCurves.map((curve, index) => `${["●", "○", "◆", "◇"][index % 4]} ${curve.label}`).join("  ")
  if (axes.length === 2) {
    const halfWidth = 22
    const axisWidth = halfWidth * 2 + 1
    const rows = resolvedCurves.map((curve, curveIndex) => {
      const row = blankRow(axisWidth)
      const left = Math.max(0, Math.min(halfWidth, Math.round(((curve.numericValues[0] ?? minimum) - minimum) / span * halfWidth)))
      const right = Math.max(0, Math.min(halfWidth, Math.round(((curve.numericValues[1] ?? minimum) - minimum) / span * halfWidth)))
      for (let column = halfWidth - left; column <= halfWidth + right; column++) row[column] = curveIndex === 0 ? "─" : "·"
      row[halfWidth] = "┼"
      row[halfWidth - left] = curveIndex === 0 ? "●" : "○"
      row[halfWidth + right] = curveIndex === 0 ? "●" : "○"
      return `${padVisual(curve.label, Math.max(10, ...resolvedCurves.map((item) => Bun.stringWidth(item.label) + 2)))}${row.join("")}`
    })
    return [
      title,
      `Scale ${minimum}–${maximum} · two opposing axes`,
      `${axes[0]?.label ?? "axis 1"}${" ".repeat(Math.max(3, axisWidth - Bun.stringWidth(axes[0]?.label ?? "") - Bun.stringWidth(axes[1]?.label ?? "")))}${axes[1]?.label ?? "axis 2"}`,
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
      if (canvas[y]![x] === " " || canvas[y]![x] === "·") canvas[y]![x] = glyph
    }
  }
  const pointsAt = (values: number[], scale = 1) => axes.map((_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    const ratio = Math.max(0, Math.min(1, ((values[index] ?? minimum) - minimum) / span)) * scale
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
    const axis = axes[index] ?? { id: "axis", label: "axis" }
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    const labelX = Math.round(centerX + Math.cos(angle) * (radiusX + 5))
    const labelY = Math.round(centerY + Math.sin(angle) * (radiusY + 2))
    axisLabels.push({
      row: Math.max(0, Math.min(canvasHeight - 1, labelY)),
      column: Math.max(0, Math.min(canvasWidth - Bun.stringWidth(axis.label), labelX - Math.floor(Bun.stringWidth(axis.label) / 2))),
      label: axis.label,
    })
  }
  const curveMarkers = ["●", "○", "◆", "◇"]
  resolvedCurves.forEach((curve, curveIndex) => {
    const points = pointsAt(curve.numericValues)
    const marker = curveMarkers[curveIndex % curveMarkers.length] ?? "●"
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!
      const next = points[(index + 1) % points.length]!
      const deltaX = next.x - point.x
      const deltaY = next.y - point.y
      const glyph = curveIndex % 2 === 1 ? "·" : Math.abs(deltaX) > Math.abs(deltaY) * 2 ? "─" : Math.abs(deltaY) > Math.abs(deltaX) * 2 ? "│" : deltaX * deltaY > 0 ? "╲" : "╱"
      line(point.x, point.y, next.x, next.y, glyph)
      canvas[point.y]![point.x] = marker
    }
  })
  for (const label of axisLabels) writeVisual(canvas[label.row]!, label.column, label.label)
  return [
    title,
    `Scale ${minimum}–${maximum} · ${legend}`,
    ...canvas.map((row) => row.join("").trimEnd()),
  ].join("\n")
}

type EventModelFrame = { id: string; type: string; entity: string; data?: string; dataRef?: string; reset: boolean }

function renderEventModelingDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^eventmodeling$/i.test(lines[0]?.trim() ?? "")) return undefined
  const frames: EventModelFrame[] = []
  const dataBlocks = new Map<string, string[]>()
  const explicitRelations: Array<{ from: string; to: string; connector: string }> = []
  let currentData: string | undefined
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const dataStart = /^data\s+([A-Za-z_][\w.-]*)\s*(?:`[^`]+`)?\s*\{?(.*)$/i.exec(line)
    if (dataStart) {
      currentData = dataStart[1]
      const inlineData = dataStart[2]?.replace(/^\s*\{/, "").replace(/}\s*$/, "").trim()
      dataBlocks.set(currentData, inlineData ? [cleanMermaidLabel(inlineData)] : [])
      if (line.endsWith("}")) currentData = undefined
      continue
    }
    if (currentData) {
      if (line === "}") {
        currentData = undefined
        continue
      }
      const values = dataBlocks.get(currentData) ?? []
      dataBlocks.set(currentData, [...values, cleanMermaidLabel(line.replace(/}\s*$/, ""))])
      if (line.endsWith("}")) currentData = undefined
      continue
    }
    const frame = /^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(ui|pcr|processor|cmd|command|rmo|readmodel|evt|event)\s+(.+?)(?:\s+\{(.+)\})?$/i.exec(line)
    if (frame) {
      const dataRef = /\[\[([^\]]+)\]\]/.exec(frame[4])?.[1]
      frames.push({
        id: frame[2],
        type: frame[3].toLowerCase(),
        entity: cleanMermaidLabel(frame[4].replace(/\[\[[^\]]+\]\]/, "")),
        data: cleanMermaidLabel(frame[5]),
        dataRef,
        reset: /^rf|resetframe$/i.test(frame[1]),
      })
      continue
    }
    const relaxed = /^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(.+)$/i.exec(line)
    if (relaxed) {
      const dataRef = /\[\[([^\]]+)\]\]/.exec(relaxed[3])?.[1]
      frames.push({ id: relaxed[2], type: "event", entity: cleanMermaidLabel(relaxed[3].replace(/\[\[[^\]]+\]\]/, "")), dataRef, reset: /^rf|resetframe$/i.test(relaxed[1]) })
      continue
    }
    const relation = /^(\S+)\s*(->>|-->|->)\s*(\S+)$/i.exec(line)
    if (relation) explicitRelations.push({ from: relation[1], to: relation[3], connector: relation[2] })
  }
  if (frames.length === 0) return undefined
  const laneForType = (type: string) => /^(?:ui|pcr|processor)$/i.test(type) ? "UI / Automation" : /^(?:cmd|command|rmo|readmodel)$/i.test(type) ? "Command / Read Model" : "Events"
  const generated = ["swimlane-beta LR"]
  const frameNode = new Map<string, string>()
  const laneNames = ["UI / Automation", "Command / Read Model", "Events"]
  for (const [laneIndex, lane] of laneNames.entries()) {
    generated.push(`subgraph lane${laneIndex}["${lane}"]`)
    frames.forEach((frame, index) => {
      if (laneForType(frame.type) !== lane) return
      const id = `frame${index}`
      frameNode.set(frame.id, id)
      const data = frame.data || (frame.dataRef ? dataBlocks.get(frame.dataRef)?.join(" ") : undefined) || dataBlocks.get(frame.entity)?.join(" ")
      generated.push(`  ${id}["${frame.id} · ${frame.entity}${data ? ` · ${data}` : ""}"]`)
    })
    generated.push("end")
  }
  if (explicitRelations.length > 0) {
    for (const relation of explicitRelations) {
      const from = frameNode.get(relation.from)
      const to = frameNode.get(relation.to)
      if (from && to) generated.push(`${from} --> ${to}`)
    }
  } else {
    for (let index = 1; index < frames.length; index++) generated.push(`frame${index - 1} --> frame${index}`)
  }
  const swimlane = renderSwimlaneDiagram(generated.join("\n"))
  return swimlane ? ["Event modeling", ...swimlane.split("\n").slice(1)].join("\n") : undefined
}

type VennDefinition = { kind: "set" | "union" | "text"; members: string[]; label: string; size?: string; depth: number }

function renderVennDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^venn-beta$/i.test(lines[0]?.trim() ?? "")) return undefined
  let title = "Venn"
  const definitions: VennDefinition[] = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    const declaration = /^(set|union|text)\s+(.+)$/i.exec(line)
    if (!declaration) {
      if (/^(?:style|classDef)\b/i.test(line)) continue
      continue
    }
    const kind = declaration[1].toLowerCase() as VennDefinition["kind"]
    let rest = declaration[2].trim()
    const sizeMatch = /:\s*([0-9.]+)\s*$/.exec(rest)
    const size = sizeMatch?.[1]
    if (sizeMatch) rest = rest.slice(0, sizeMatch.index).trim()
    const labelMatch = /\[\s*\"?([^\]]+)\"?\s*\]/.exec(rest)
    const label = cleanMermaidLabel((labelMatch?.[1] || rest).replace(/^['"]|['"]$/g, ""))
    const memberSource = labelMatch ? rest.slice(0, labelMatch.index).trim() : rest
    const members = kind === "union" ? memberSource.split(",").map((member) => cleanMermaidLabel(member.replace(/^['"]|['"]$/g, ""))).filter(Boolean) : [cleanMermaidLabel(memberSource.replace(/^['"]|['"]$/g, ""))]
    const definition = { kind, members, label, size, depth: mermaidIndentWidth(raw) }
    definitions.push(definition)
  }
  if (definitions.length === 0) return undefined
  const sets = definitions.filter((definition) => definition.kind === "set")
  const unions = definitions.filter((definition) => definition.kind === "union")
  if (sets.length < 2) return [title, ...sets.flatMap((set) => renderBox(`${set.label}${set.size ? ` · ${set.size}` : ""}`))].join("\n")
  const canvasWidth = 62
  const canvasHeight = 19
  const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
  const circles = [
    { x: 23, y: 9, rx: 18, ry: 8 },
    { x: 39, y: 9, rx: 18, ry: 8 },
  ]
  circles.forEach((circle) => {
    for (let row = 0; row < canvasHeight; row++) {
      for (let column = 0; column < canvasWidth; column++) {
        const distance = ((column - circle.x) / circle.rx) ** 2 + ((row - circle.y) / circle.ry) ** 2
        if (Math.abs(distance - 1) < 0.12) canvas[row]![column] = "·"
      }
    }
  })
  const left = sets[0]!
  const right = sets[1]!
  writeVisual(canvas[8]!, 8, `${left.label}${left.size ? ` (${left.size})` : ""}`)
  writeVisual(canvas[8]!, Math.max(42, canvasWidth - Bun.stringWidth(right.label) - 8), `${right.label}${right.size ? ` (${right.size})` : ""}`)
  const overlap = unions[0]
  if (overlap) writeVisual(canvas[10]!, Math.max(22, 31 - Math.floor(Bun.stringWidth(overlap.label) / 2)), `${overlap.label}${overlap.size ? ` (${overlap.size})` : ""}`)
  const textNodes = definitions.filter((definition) => definition.kind === "text")
  textNodes.slice(0, 4).forEach((node, index) => writeVisual(canvas[12 + index]!, 10 + index * 3, `• ${node.label}`))
  return [title, ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}

function renderIshikawaDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^ishikawa-beta$/i.test(lines[0]?.trim() ?? "")) return undefined
  const entries = parseMermaidIndentedEntries(input, /^ishikawa-beta$/i)
  if (!entries || entries.length === 0) return undefined
  const effect = entries[0].label
  const groups: Array<{ label: string; children: string[] }> = []
  for (const entry of entries.slice(1)) {
    if (entry.depth === 1) groups.push({ label: entry.label, children: [] })
    else if (groups.length > 0) groups.at(-1)?.children.push(entry.label)
  }
  if (groups.length === 0) return undefined
  const effectBox = renderCompactBox(effect, 16)
  const effectWidth = Math.max(...effectBox.map((line) => Bun.stringWidth(line)))
  const spineRow = 9
  const spineStart = 2
  const spineEnd = Math.max(62, groups.length * 16)
  const canvasWidth = spineEnd + effectWidth + 3
  const canvasHeight = 19
  const canvas = Array.from({ length: canvasHeight }, () => blankRow(canvasWidth))
  for (let column = spineStart; column < spineEnd; column++) canvas[spineRow]![column] = "═"
  canvas[spineRow]![spineEnd - 1] = "▶"
  effectBox.forEach((line, row) => writeVisual(canvas[spineRow - 1 + row]!, spineEnd + 1, line))
  groups.forEach((group, index) => {
    const x = Math.min(spineEnd - 6, 10 + index * Math.max(10, Math.floor((spineEnd - 18) / Math.max(1, groups.length - 1))))
    const above = index % 2 === 0
    const endpointX = Math.max(1, x - 6)
    const endpointY = above ? 2 : 16
    const steps = Math.abs(spineRow - endpointY)
    for (let step = 0; step <= steps; step++) {
      const row = Math.round(spineRow + (endpointY - spineRow) * step / steps)
      const column = Math.round(x + (endpointX - x) * step / steps)
      canvas[row]![column] = above ? "╱" : "╲"
    }
    const labelRow = above ? 0 : 17
    writeVisual(canvas[labelRow]!, Math.max(0, endpointX - Math.floor(Bun.stringWidth(group.label) / 2)), group.label)
    group.children.slice(0, 3).forEach((child, childIndex) => {
      const row = above ? 3 + childIndex : 15 - childIndex
      writeVisual(canvas[row]!, Math.max(0, endpointX + 2), `• ${child}`)
    })
  })
  return ["Ishikawa · causes feed the effect", ...canvas.map((row) => row.join("").trimEnd())].join("\n")
}

type WardleyNode = { name: string; visibility: number; evolution: number; kind: "anchor" | "component"; decorator?: string }

function renderWardleyDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^wardley-beta$/i.test(lines[0]?.trim() ?? "")) return undefined
  let title = "Wardley map"
  const nodes = new Map<string, WardleyNode>()
  const links: Array<{ from: string; to: string; label?: string; flow: boolean }> = []
  const notes: Array<{ text: string; visibility: number; evolution: number }> = []
  const evolutions: Array<{ name: string; target: number }> = []
  const annotations: string[] = []

  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    if (/^(?:size|evolution|pipeline|accelerator|deaccelerator|annotations)\b/i.test(line)) {
      continue
    }
    const node = /^(anchor|component)\s+(?:\"([^\"]+)\"|(.+?))\s+\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\](.*)$/i.exec(line)
    if (node) {
      const name = cleanMermaidLabel(node[2] || node[3])
      if (!name) continue
      const decorator = /\((inertia|build|buy|outsource|market)\)/i.exec(node[6] ?? "")?.[1]
      nodes.set(name, { name, visibility: Number(node[4]), evolution: Number(node[5]), kind: node[1].toLowerCase() === "anchor" ? "anchor" : "component", decorator })
      continue
    }
    const note = /^note\s+\"(.+?)\"\s+\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]$/i.exec(line)
    if (note) {
      notes.push({ text: cleanMermaidLabel(note[1]), visibility: Number(note[2]), evolution: Number(note[3]) })
      continue
    }
    const annotation = /^annotation\s+(.+)$/i.exec(line)
    if (annotation) {
      annotations.push(cleanMermaidLabel(annotation[1]))
      continue
    }
    const evolve = /^evolve\s+(?:\"([^\"]+)\"|(.+?))\s+([0-9.]+)$/i.exec(line)
    if (evolve) {
      evolutions.push({ name: cleanMermaidLabel(evolve[1] || evolve[2]), target: Number(evolve[3]) })
      continue
    }
    const link = /^(.+?)\s*(\+<>|\+'([^']+)'>|\+>|\+<|-\.->|-->|->)\s*(.+?)(?:\s*;\s*(.+))?$/i.exec(line)
    if (link) {
      const from = cleanMermaidLabel(link[1])
      const to = cleanMermaidLabel(link[4])
      if (from && to) links.push({ from, to, label: cleanMermaidLabel(link[3] || link[5]), flow: link[2].includes("+") })
    }
  }

  if (nodes.size === 0 && links.length === 0 && notes.length === 0) return undefined
  const mapWidth = Math.max(68, Math.min(104, Math.max(68, ...[...nodes.values()].map((node) => Bun.stringWidth(node.name) + Math.round(node.evolution * 64) + 8))))
  const mapHeight = 20
  const canvas = Array.from({ length: mapHeight }, () => Array.from({ length: mapWidth }, () => " "))
  const put = (row: number, column: number, text: string) => {
    for (const [index, char] of [...text].entries()) {
      if (row < 0 || row >= mapHeight || column + index < 0 || column + index >= mapWidth) continue
      canvas[row]![column + index] = char
    }
  }
  const plotLeft = 3
  const plotRight = mapWidth - 2
  const plotTop = 1
  const plotBottom = mapHeight - 3
  put(0, plotLeft, "Visibility ↑")
  for (let row = plotTop; row <= plotBottom; row++) canvas[row]![plotLeft] = "│"
  canvas[plotBottom]![plotLeft] = "└"
  for (let column = plotLeft + 1; column <= plotRight; column++) canvas[plotBottom]![column] = "─"
  for (const ratio of [0.25, 0.5, 0.75]) {
    const column = plotLeft + Math.round((plotRight - plotLeft) * ratio)
    for (let row = plotTop; row < plotBottom; row++) if (canvas[row]![column] === " ") canvas[row]![column] = "┆"
  }
  const stages = ["Genesis", "Custom built", "Product", "Commodity"]
  stages.forEach((stage, index) => {
    const center = plotLeft + Math.round((plotRight - plotLeft) * ((index + 0.5) / stages.length))
    put(mapHeight - 2, Math.max(plotLeft, center - Math.floor(Bun.stringWidth(stage) / 2)), stage)
  })
  put(mapHeight - 1, Math.max(plotLeft, Math.floor((mapWidth - Bun.stringWidth("Evolution →")) / 2)), "Evolution →")
  const positions = new Map<string, { row: number; column: number }>()
  for (const node of nodes.values()) {
    const row = Math.max(plotTop, Math.min(plotBottom - 1, plotTop + Math.round((1 - Math.max(0, Math.min(1, node.visibility))) * (plotBottom - plotTop - 1))))
    const column = Math.max(plotLeft + 1, Math.min(plotRight - 2, plotLeft + 1 + Math.round(Math.max(0, Math.min(1, node.evolution)) * (plotRight - plotLeft - 3))))
    positions.set(node.name, { row, column })
  }
  const dependencyGlyph = (from: { row: number; column: number }, to: { row: number; column: number }) => {
    const deltaX = to.column - from.column
    const deltaY = to.row - from.row
    return Math.abs(deltaX) > Math.abs(deltaY) * 2 ? "─" : Math.abs(deltaY) > Math.abs(deltaX) * 2 ? "│" : deltaX * deltaY > 0 ? "╲" : "╱"
  }
  for (const link of links) {
    const from = positions.get(link.from)
    const to = positions.get(link.to)
    if (!from || !to) continue
    const steps = Math.max(Math.abs(to.column - from.column), Math.abs(to.row - from.row), 1)
    const glyph = link.flow ? "┄" : dependencyGlyph(from, to)
    for (let step = 0; step <= steps; step++) {
      const row = Math.round(from.row + (to.row - from.row) * step / steps)
      const column = Math.round(from.column + (to.column - from.column) * step / steps)
      if (canvas[row]?.[column] === " " || canvas[row]?.[column] === "┆") canvas[row]![column] = glyph
    }
    canvas[to.row]![to.column] = to.column >= from.column ? "▶" : "◀"
    if (link.label) put(Math.round((from.row + to.row) / 2), Math.round((from.column + to.column) / 2) + 1, link.label)
  }
  for (const evolution of evolutions) {
    const from = positions.get(evolution.name)
    if (!from) continue
    const targetColumn = Math.max(plotLeft + 1, Math.min(plotRight - 1, plotLeft + 1 + Math.round(evolution.target * (plotRight - plotLeft - 3))))
    for (let column = Math.min(from.column, targetColumn) + 1; column < Math.max(from.column, targetColumn); column++) canvas[from.row]![column] = "╌"
    canvas[from.row]![targetColumn] = targetColumn >= from.column ? "▶" : "◀"
  }
  for (const note of notes) {
    const row = Math.max(plotTop, Math.min(plotBottom - 1, plotTop + Math.round((1 - note.visibility) * (plotBottom - plotTop - 1))))
    const column = Math.max(plotLeft + 1, Math.min(plotRight - Bun.stringWidth(note.text) - 2, plotLeft + 1 + Math.round(note.evolution * (plotRight - plotLeft - 3))))
    put(row, column, `⟦${note.text}⟧`)
  }
  for (const node of nodes.values()) {
    const position = positions.get(node.name)
    if (!position) continue
    const marker = node.kind === "anchor" ? "◆" : node.decorator === "build" ? "△" : node.decorator === "buy" ? "◇" : node.decorator === "outsource" ? "□" : node.decorator === "market" ? "○" : "●"
    put(position.row, position.column, `${marker} ${node.name}`)
  }
  const output = [title, ...canvas.map((row) => row.join("").replace(/ +$/g, ""))]
  if (annotations.length > 0) output.push("Annotations", ...annotations.map((annotation) => `• ${annotation}`))
  return output.join("\n")
}

function renderCynefinDiagram(input: string): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^cynefin-beta$/i.test(lines[0]?.trim() ?? "")) return undefined
  const domains = new Map<string, string[]>()
  const transitions: Array<{ from: string; to: string; label?: string }> = []
  let title = "Cynefin framework"
  let current: string | undefined
  const domainNames = new Set(["complex", "complicated", "clear", "chaotic", "confusion"])
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const titleMatch = /^title\s+(.+)$/i.exec(line)
    if (titleMatch) {
      title = cleanMermaidLabel(titleMatch[1]) || title
      continue
    }
    const domain = /^(complex|complicated|clear|chaotic|confusion)$/i.exec(line)
    if (domain) {
      current = domain[1].toLowerCase()
      if (!domains.has(current)) domains.set(current, [])
      continue
    }
    const transition = /^(complex|complicated|clear|chaotic|confusion)\s*-->\s*(complex|complicated|clear|chaotic|confusion)\s*(?::\s*\"?(.+?)\"?)?$/i.exec(line)
    if (transition) {
      transitions.push({ from: transition[1].toLowerCase(), to: transition[2].toLowerCase(), label: cleanMermaidLabel(transition[3]) })
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
  canvas[0]![0] = "╭"
  canvas[0]![canvasWidth - 1] = "╮"
  canvas[rowCount - 1]![0] = "╰"
  canvas[rowCount - 1]![canvasWidth - 1] = "╯"
  for (let column = 1; column < canvasWidth - 1; column++) {
    canvas[0]![column] = "─"
    canvas[rowCount - 1]![column] = "─"
    canvas[midRow]![column] = column % 4 === 0 ? "≈" : "─"
  }
  for (let row = 1; row < rowCount - 1; row++) {
    canvas[row]![0] = "│"
    canvas[row]![canvasWidth - 1] = "│"
    canvas[row]![midColumn] = row % 3 === 0 ? "≈" : "│"
  }
  canvas[0]![midColumn] = "┬"
  canvas[midRow]![0] = "├"
  canvas[midRow]![midColumn] = "┼"
  canvas[midRow]![canvasWidth - 1] = "┤"
  canvas[rowCount - 1]![midColumn] = "┴"

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
        canvas[row]![column] = overlay
        continue
      }
      const directions = connectors[row]?.[column]
      if (directions?.size && canvas[row]![column] === " ") canvas[row]![column] = connectorGlyph(directions)
    }
  }

  const confusionWidth = 30
  const confusionLeft = midColumn - Math.floor(confusionWidth / 2)
  const confusionTop = midRow - 3
  const confusionItems = domains.get("confusion") ?? []
  const confusionBox = [
    `╭${"≈".repeat(confusionWidth - 2)}╮`,
    `│${centerVisual("CONFUSION / DISORDER", confusionWidth - 2)}│`,
    `│${centerVisual(confusionItems[0] ? `[${confusionItems[0]}]` : "Move unknowns outward", confusionWidth - 2)}│`,
    `│${centerVisual(confusionItems[1] ? `[${confusionItems[1]}]` : "", confusionWidth - 2)}│`,
    `╰${"≈".repeat(confusionWidth - 2)}╯`,
  ]
  confusionBox.forEach((line, offset) => writeVisual(canvas[confusionTop + offset]!, confusionLeft, line))
  const rendered = canvas.map((row) => row.join("").trimEnd())
  return [title, ...rendered].join("\n")
}

function renderTreemapDiagram(input: string): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^treemap-beta$/i)
  if (!entries) return undefined
  const root = entries.find((entry) => entry.depth === 0)?.label ?? "Treemap"
  const leaves = entries.slice(0, 256).flatMap((entry) => {
    const value = /^\s*\"?(.+?)\"?\s*:\s*([0-9.]+)\s*$/.exec(entry.raw)
    return value ? [{ label: cleanMermaidLabel(value[1]), value: Number(value[2]) }] : []
  })
  if (leaves.length === 0) return renderBoxedHierarchy("Treemap", entries)
  const total = leaves.reduce((sum, leaf) => sum + leaf.value, 0) || 1
  const innerWidth = Math.max(54, ...leaves.map((leaf) => Bun.stringWidth(leaf.label) + 4))
  const widths = leaves.map((leaf) => Math.max(Bun.stringWidth(leaf.label) + 2, Math.round(leaf.value / total * innerWidth)))
  const currentWidth = widths.reduce((sum, value) => sum + value, 0)
  if (currentWidth < innerWidth) widths[widths.length - 1] = (widths.at(-1) ?? 0) + innerWidth - currentWidth
  const contentWidth = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, leaves.length - 1)
  return [
    "Treemap",
    `╭─ ${root} ${"─".repeat(Math.max(1, contentWidth - Bun.stringWidth(root) - 3))}╮`,
    `│┌${widths.map((value) => "─".repeat(value)).join("┬")}┐│`,
    `││${leaves.map((leaf, index) => centerVisual(leaf.label, widths[index] ?? 1)).join("│")}││`,
    `││${leaves.map((leaf, index) => centerVisual(String(leaf.value), widths[index] ?? 1)).join("│")}││`,
    `│└${widths.map((value) => "─".repeat(value)).join("┴")}┘│`,
    `╰${"─".repeat(contentWidth + 2)}╯`,
  ].join("\n")
}

function renderSimpleMermaid(input: string, width: number): string | undefined {
  return (
    renderSimpleFlowchart(input, width) ??
    renderSwimlaneDiagram(input) ??
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
    renderRadarDiagram(input) ??
    renderEventModelingDiagram(input) ??
    renderTreemapDiagram(input) ??
    renderVennDiagram(input) ??
    renderIshikawaDiagram(input) ??
    renderWardleyDiagram(input) ??
    renderCynefinDiagram(input) ??
    renderTreeViewDiagram(input) ??
    renderZenUml(input, width) ??
    renderMindmapDiagram(input) ??
    renderTimelineDiagram(input) ??
    renderJourneyDiagram(input, width) ??
    renderKanbanDiagram(input) ??
    renderIndentedMermaid(input, /^mindmap$/i, "Mindmap") ??
    renderIndentedMermaid(input, /^timeline$/i, "Timeline") ??
    renderIndentedMermaid(input, /^journey$/i, "Journey") ??
    renderIndentedMermaid(input, /^kanban$/i, "Kanban")
  )
}

export function renderMermaidAsciiCard(diagram: string, width: number) {
  const output = renderSimpleMermaid(diagram, width) ?? renderMermaidSourceFallback(diagram, width)
  return renderMermaidCanvas(output.trimEnd(), diagram, width)
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
  const blocks = extractMermaidBlocks(source)
  if (blocks.length === 0) return renderMarkdownForTui(source, width, options)

  let result = ""
  let cursor = 0

  for (const blockInput of blocks) {
    result += source.slice(cursor, blockInput.start)
    cursor = blockInput.end

    const diagram = blockInput.diagram
    const internal = renderSimpleMermaid(diagram, width)
    const output = internal ?? (Buffer.byteLength(diagram, "utf8") <= MAX_MERMAID_BYTES ? await runTermaid(diagram, width) : undefined) ?? renderMermaidSourceFallback(diagram, width)

    const heading = popTrailingHeading(result)
    result = heading.prefix
    const renderedDiagram = renderMermaidCanvas(output.trimEnd(), diagram, width)
    const block = alignTextBlock(heading.title ? [heading.title, "", renderedDiagram].join("\n") : renderedDiagram, width)
    result += ["```text", block, "```"].join("\n")
    if (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") result += "\n"
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
  const blocks = extractMermaidBlocks(source)
  if (blocks.length === 0) return renderMarkdownForTui(source, width, options)

  let result = ""
  let cursor = 0

  for (const blockInput of blocks) {
    result += source.slice(cursor, blockInput.start)
    cursor = blockInput.end

    const diagram = blockInput.diagram
    const heading = popTrailingHeading(result)
    result = heading.prefix
    const renderedDiagram = renderMermaidAsciiCard(diagram, width)
    const block = alignTextBlock(heading.title ? [heading.title, "", renderedDiagram].join("\n") : renderedDiagram, width)
    result += ["```text", block, "```"].join("\n")
    if (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") result += "\n"
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

type StreamingMarkdownTailState = {
  finalized?: boolean
  output?: "text" | "markdown"
}

function renderStreamingMarkdownTailAsMarkdown(markdown: string, width: number, options: RenderPlanMarkdownOptions = {}) {
  if (options.tableMode !== "grid") return markdown

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
      result.push("```text", ...renderLiveMarkdownTableAsGrid(table, width), "```")
      index--
      continue
    }

    result.push(current)
  }

  return result.join("\n")
}

export function renderStreamingMarkdownTail(
  markdown: string,
  width: number,
  options: RenderPlanMarkdownOptions = {},
  state: StreamingMarkdownTailState = {},
) {
  if (state.output === "markdown") return renderStreamingMarkdownTailAsMarkdown(markdown, width, options)
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
  return /(^|\r?\n)[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid(?:[^\r\n]*)?(?:\r?$|\r?\n)/im.test(markdown)
}
