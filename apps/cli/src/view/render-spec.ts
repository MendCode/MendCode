import type { RenderNode } from "@mendcode/protocol"
import { asciiGlyphs, type ColorName, type Line } from "../ui/theme"
import { renderCodeMap } from "./code-map"
import { beside, boxPanel, columns, fit } from "./deck"
import { renderGraphCard } from "./graph-card"
import { wrapSpans } from "./markdown"
import { parseDiff, renderDiffRows } from "./tool-card"
import { textWidth } from "./wrap"

/**
 * Draws a renderSpec@1 tree (a tool's declared presentation) with the client's own primitives: v1-style
 * panels, columns, tables, bars and diffs. Data only: nothing in a spec can run, and every node is
 * clipped to the width it is given.
 */

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export type RenderSpecOptions = {
  /** Draw `graph` nodes with ASCII glyphs (also on when MENDCODE_GLYPHS=ascii). */
  ascii?: boolean
  /** Show every row of a `codemap` (ctrl+o) instead of its preview. */
  expanded?: boolean
  /** How much a `codemap` shows per side: names and lines (`balanced`) or kinds and a longer preview (`full`). */
  detail?: "balanced" | "full"
  /** How much of a card shows: `detail` nodes appear at `preview` (the `full` view) or `full` (an opened card); without it `expanded` says `full`. */
  level?: "summary" | "preview" | "full"
}

export function renderSpecLines(node: RenderNode, width: number, options: RenderSpecOptions = {}): Line[] {
  const w = Math.max(4, width)
  switch (node.type) {
    case "stack": {
      const gap = node.gap ?? 0
      return node.children.flatMap((child, index) => [...(index > 0 ? Array.from({ length: gap }, (): Line => []) : []), ...renderSpecLines(child, w, options)])
    }
    case "row": {
      const weights = node.children.map((_, index) => node.weights?.[index] ?? 1)
      const sizes = columns(w, weights, 1)
      return beside(node.children.map((child, index) => ({ lines: renderSpecLines(child, sizes[index]!, options), width: sizes[index]! })), 1)
    }
    case "box":
      return boxPanel({ ...(node.title ? { title: node.title } : {}), body: node.children.flatMap((child) => renderSpecLines(child, w - 4, options)), width: w, compact: true })
    case "text":
      return wrapSpans([{ text: node.text, fg: node.tone ?? "text", ...(node.bold ? { bold: true } : {}), ...(node.dim ? { dim: true } : {}) }], w)
    case "badge":
      return [fit([{ text: ` ${node.text} `, fg: node.tone ?? "text", bg: "element" }], Math.min(w, textWidth(node.text) + 2))]
    case "progress": {
      const max = node.max ?? 100
      const ratio = max > 0 ? Math.max(0, Math.min(1, node.value / max)) : 0
      const label = node.label ? `${node.label} ` : ""
      const percent = ` ${Math.round(ratio * 100)}%`
      const bar = Math.max(4, Math.min(24, w - textWidth(label) - percent.length))
      const filled = Math.round(bar * ratio)
      const tone: ColorName = node.tone ?? (ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success")
      return [fit([{ text: label, fg: "muted" }, { text: "█".repeat(filled), fg: tone }, { text: "░".repeat(bar - filled), fg: "muted", dim: true }, { text: percent, fg: tone }], w)]
    }
    case "table": {
      const count = node.columns.length
      const natural = node.columns.map((column, index) => Math.max(textWidth(column), ...node.rows.map((row) => textWidth(row[index] ?? ""))))
      const room = w - 2 * (count - 1)
      const total = natural.reduce((sum, n) => sum + n, 0)
      const sizes = total <= room ? natural : natural.map((n) => Math.max(3, Math.floor((n * room) / total)))
      const line = (cells: string[], header: boolean): Line =>
        fit(cells.flatMap((cell, index) => [...(index > 0 ? [{ text: "  " }] : []), ...fit([{ text: cell, fg: header ? ("muted" as const) : ("text" as const), ...(header ? { bold: true } : {}) }], sizes[index]!)]), w)
      return [line(node.columns, true), ...node.rows.map((row) => line(node.columns.map((_, index) => row[index] ?? ""), false))]
    }
    case "kv": {
      const keyWidth = Math.min(Math.max(0, ...node.items.map((item) => textWidth(item.key))) + 2, Math.floor(w / 2))
      return node.items.flatMap((item) => wrapSpans([{ text: item.value, fg: item.tone ?? "text" }], w, [...fit([{ text: item.key, fg: "muted" }], keyWidth)]))
    }
    case "list":
      return node.items.flatMap((item, index) => wrapSpans([{ text: item, fg: "text" }], w, [{ text: node.ordered ? `${index + 1}. ` : "• ", fg: "muted" }]))
    case "code":
      return node.text.split("\n").map((line): Line => fit([{ text: "│ ", fg: "border" }, { text: line, fg: "code" }], w))
    case "diff": {
      const diff = parseDiff(node.text)
      return diff ? renderDiffRows(diff.rows, w + 3).map((line) => line.slice(1)) : renderSpecLines({ type: "code", text: node.text }, w)
    }
    case "sparkline": {
      const values = node.values.slice(-Math.max(1, w - (node.label ? textWidth(node.label) + 1 : 0)))
      const low = Math.min(...values)
      const high = Math.max(...values)
      const spark = values.map((value) => SPARK[high === low ? 3 : Math.round(((value - low) / (high - low)) * (SPARK.length - 1))]).join("")
      return [fit([...(node.label ? [{ text: `${node.label} `, fg: "muted" as const }] : []), { text: spark, fg: node.tone ?? "primary" }], w)]
    }
    case "graph":
      return renderGraphCard({ root: node.root, edges: node.edges, title: node.title, width: w, ascii: options.ascii ?? asciiGlyphs() })
    case "detail": {
      const level = options.level ?? (options.expanded ? "full" : "summary")
      return (node.at === "preview" && level === "preview") || (node.at === "open" && level === "full") ? node.children.flatMap((child) => renderSpecLines(child, w, options)) : []
    }
    case "codemap":
      return renderCodeMap({ center: node.center, left: node.left, right: node.right, title: node.title, saved: node.saved, width: w, expanded: options.expanded, detail: options.detail, ascii: options.ascii ?? asciiGlyphs() })
  }
}
