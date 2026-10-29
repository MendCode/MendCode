import type { Line } from "../ui/theme"
import { cells, textWidth } from "./wrap"
import { cleanSource, MERMAID_NOTES } from "./mermaid/core"
import { parseFlowchart, renderFlowchart } from "./mermaid/flowchart"
import type { Direction } from "./mermaid/flowchart"
import { parseSequence, renderSequence } from "./mermaid/sequence"
import { validStatements } from "./mermaid/syntax"
import { registry } from "./mermaid/registry"
import { markPicture } from "./line-meta"
import { preparedMermaidSourceLines } from "./mermaid/legacy-shared"

export { MERMAID_NOTES } from "./mermaid/core"
export type { MermaidResult } from "./mermaid/core"
import type { MermaidResult } from "./mermaid/core"

/** Layout budgets are checked before a parser can allocate a canvas or expand a numeric range. */
function bounded(source: string) {
  if (source.length > 16_000 || source.split("\n").length > 256) return false
  if (source.split("\n").some((line) => line.length > 2048)) return false
  if ((source.match(/[,;{}\[\]]/g)?.length ?? 0) > 1500) return false
  return true
}

function themed(output: string): Line[] {
  return output.split("\n").map((row, index) => {
    const spans: Line = []
    for (const cell of cells(row)) {
      const fg = index === 0 ? "heading" : /[\u2500-\u257f]/u.test(cell.text) ? "heading" : /[\u2190-\u21ff\u25a0-\u25ff\u2600-\u26ff]/u.test(cell.text) ? "accent" : "body"
      const last = spans.at(-1)
      if (last?.fg === fg) last.text += cell.text
      else spans.push({ text: cell.text, fg })
    }
    return spans
  })
}

/** `row` with the cells `[from, from + count)` in the colour `fg`; the cells before and after keep their spans. */
function tintCells(row: Line, from: number, count: number, fg: NonNullable<Line[number]["fg"]>): Line {
  const out: Line = []
  let at = 0
  for (const span of row) {
    for (const cell of cells(span.text)) {
      const inside = at >= from && at < from + count
      const last = out.at(-1)
      const next = inside ? { ...span, text: cell.text, fg } : { ...span, text: cell.text }
      if (last && last.fg === next.fg && last.bg === next.bg && last.bold === next.bold) last.text += cell.text
      else out.push(next)
      at += cell.width
    }
  }
  return out
}

/** `%%{init: {"sequence": {"mirrorActors": false}}}%%` (or the YAML front-matter form) turns the bottom participant boxes off. */
const MIRROR_OFF = /mirrorActors["']?\s*:\s*false\b/i

/** Pure synchronous dispatch; the entire registry loads only through mermaid-lazy. */
export function renderMermaid(source: string, width: number): MermaidResult {
  if (!Number.isFinite(width) || width < 4) return { note: MERMAID_NOTES.tooWide }
  width = Math.min(1600, Math.floor(width))
  if (!bounded(source)) return { note: MERMAID_NOTES.tooComplex }
  const lines = preparedMermaidSourceLines(source)
  const header = lines[0]?.trim().replace(/;$/, "") ?? ""
  const body = lines.slice(1)
  try {
    const flowHeader = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?$/i.exec(header)
    if (flowHeader) {
      const raw = (flowHeader[1] ?? "TD").toUpperCase()
      const flow = parseFlowchart(body, raw === "TB" ? "TD" : raw as Direction)
      return flow ? renderFlowchart(flow, width) : { note: MERMAID_NOTES.unsupported }
    }
    if (/^sequenceDiagram$/i.test(header)) {
      const seq = parseSequence(body)
      return seq ? renderSequence(seq, width, { mirror: !MIRROR_OFF.test(source) }) : { note: MERMAID_NOTES.unsupported }
    }
    const render = registry[header.split(/\s/)[0]!.toLowerCase()]
    if (!render) return { note: MERMAID_NOTES.unsupported }
    if (!validStatements(header, body)) return { note: "invalid diagram syntax · shown as source" }
    const output = render(lines.join("\n"), width)
    if (!output) return { note: MERMAID_NOTES.unsupported }
    if (typeof output !== "string" && "text" in output) {
      const { text, picture, tint } = output
      if (text.length > 160_000 || text.split("\n").length > 600) return { note: MERMAID_NOTES.tooComplex }
      if (text.split("\n").some((row) => textWidth(row) > width)) return { note: MERMAID_NOTES.tooWide }
      const rows = themed(text).map((row, at) => (tint ?? []).filter((mark) => mark.row === at).reduce((made, mark) => tintCells(made, mark.col, mark.cols, mark.fg), row))
      return { lines: picture ? rows.map((row, at) => (at >= picture.row && at < picture.row + picture.rows ? markPicture(row, { key: picture.key, row: at - picture.row, rows: picture.rows, cols: picture.cols, col: picture.col }) : row)) : rows }
    }
    if (typeof output !== "string") return output.lines.length > 600 ? { note: MERMAID_NOTES.tooComplex } : output.lines.some((row) => textWidth(row.map((span) => span.text).join("")) > width) ? { note: MERMAID_NOTES.tooWide } : output
    if (output.length > 160_000 || output.split("\n").length > 600) return { note: MERMAID_NOTES.tooComplex }
    if (output.split("\n").some((row) => textWidth(row) > width)) return { note: MERMAID_NOTES.tooWide }
    return { lines: themed(output) }
  } catch (error) {
    const note = error instanceof Error ? error.message : ""
    return { note: note === MERMAID_NOTES.tooComplex || note === MERMAID_NOTES.tooWide ? note : "invalid diagram syntax · shown as source" }
  }
}
