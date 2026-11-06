import type { ColorName, Line, Span } from "../ui/theme"
import { overlayAt } from "./scroll-chrome"
import { cells, textWidth } from "./wrap"

/**
 * The border around a sub-agent's view: drawn while the chat shows a sub-agent (its thread, or the session of a child task) so
 * the reader never takes it for the conversation. The top and bottom edges are rows of their own; the sides are drawn over the
 * blank margin cells at the first and last column, so no text moves. A last column that holds something (the scrollbar) keeps it.
 */

type Edges = { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string; across: string; down: string }
const ROUND: Edges = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", across: "─", down: "│" }
const PLAIN: Edges = { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", across: "-", down: "|" }

/** One edge row `width` cells wide, with `label` (and `hint` at the right) set into the top edge. */
function edgeRow({ width, color, left, right, label, hint }: { width: number; color: ColorName; left: string; right: string; label?: string; hint?: string }, edges: Edges): Line {
  const inner = Math.max(0, width - 2)
  const named = label ? ` ${label} ` : ""
  const hinted = hint ? ` ${hint} ` : ""
  // The label sits one dash from the corner and the hint one dash from the other; what does not fit is left out, the hint first.
  const withHint = named && hinted && 1 + textWidth(named) + textWidth(hinted) + 1 <= inner
  const withLabel = named && 1 + textWidth(named) + 1 <= inner
  const fill = inner - (withLabel ? 1 + textWidth(named) : 0) - (withHint ? textWidth(hinted) + 1 : 0)
  return [
    { text: left, fg: color },
    ...(withLabel ? [{ text: edges.across, fg: color } as Span, { text: named, fg: color, bold: true } as Span] : []),
    { text: edges.across.repeat(Math.max(0, fill)), fg: color },
    ...(withHint ? [{ text: hinted, fg: "muted" } as Span, { text: edges.across, fg: color } as Span] : []),
    { text: right, fg: color },
  ]
}

/** The top edge: `╭─ sub-agent ───── ↑ parent ─╮`. */
export function frameTop({ width, color, ascii, label, hint }: { width: number; color: ColorName; ascii: boolean; label?: string; hint?: string }): Line {
  const edges = ascii ? PLAIN : ROUND
  return edgeRow({ width, color, left: edges.topLeft, right: edges.topRight, ...(label ? { label } : {}), ...(hint ? { hint } : {}) }, edges)
}

/** The bottom edge: `╰──────╯`. */
export function frameBottom({ width, color, ascii }: { width: number; color: ColorName; ascii: boolean }): Line {
  const edges = ascii ? PLAIN : ROUND
  return edgeRow({ width, color, left: edges.bottomLeft, right: edges.bottomRight }, edges)
}

/** `line` with the side edges set over its first and last cell when those are blank. */
export function frameSides({ line, width, color, ascii }: { line: Line; width: number; color: ColorName; ascii: boolean }): Line {
  const down = (ascii ? PLAIN : ROUND).down
  const flat = [...cells(line.map((span) => span.text).join(""))].map((cell) => cell.text)
  const blank = (index: number) => (flat[index] ?? " ") === " "
  const edge: Line = [{ text: down, fg: color }]
  let out = line
  if (blank(0)) out = overlayAt({ line: out, width, from: 0, label: edge }) ?? out
  if (blank(width - 1)) out = overlayAt({ line: out, width, from: width - 1, label: edge }) ?? out
  return out
}
