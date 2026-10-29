import type { Line } from "../ui/theme"
import { highlightLine } from "../ui/selection"
import { textWidth } from "./wrap"

/** One hit in the transcript's laid-out lines: the line (from the top of the window) and the cells it covers. */
export type FindMatch = { line: number; from: number; to: number }

/** The find bar's state: what is typed, whether only prompts count, the hits, which one is current and what they were computed for (`width`, `total` laid-out lines, `seen` the transcript's own line count then). */
export type FindState = { query: string; prompts: boolean; matches: FindMatch[]; index: number; width: number; total: number; seen: number; /** The transcript revision the hits were found in. */ revision?: number }

export const FIND_MAX_QUERY = 200

type SearchLine = { text: string; kind: string; gutter?: number; row?: number }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Every hit of `query` in `lines`: case-insensitive unless the query has a capital. With `prompts` only the user's
 * messages count, and an empty query then lists each of them (one hit on its first row), which is how the bar jumps
 * from prompt to prompt. Chrome cells (the lead glyph and inset) never match.
 */
export function findMatches(lines: readonly SearchLine[], query: string, prompts: boolean): FindMatch[] {
  const out: FindMatch[] = []
  if (!query) {
    if (prompts) lines.forEach((line, index) => { if (line.kind === "user_message" && line.row === 0) out.push({ line: index, from: line.gutter ?? 0, to: Math.max(line.gutter ?? 0, textWidth(line.text.trimEnd())) }) })
    return out
  }
  const pattern = new RegExp(escape(query), /[A-Z]/.test(query) ? "g" : "gi")
  lines.forEach((line, index) => {
    if (prompts && line.kind !== "user_message") return
    for (const hit of line.text.matchAll(pattern)) {
      const from = textWidth(line.text.slice(0, hit.index))
      if (from < (line.gutter ?? 0)) continue
      out.push({ line: index, from, to: from + textWidth(hit[0]) })
    }
  })
  return out
}

/** The viewport offset (rows above the bottom) that puts `line` in the middle of a body `height` rows tall, within the window. */
export function centerOffset(total: number, line: number, height: number) {
  return Math.max(0, Math.min(total - height, total - height + Math.floor(height / 2) - line))
}

/** `row` with the hits painted: the current one stands out from the others. */
export function paintMatches(row: Line, hits: ReadonlyArray<{ match: FindMatch; current: boolean }>): Line {
  let out = row
  for (const { match, current } of hits) out = highlightLine(out, match.from, match.to, current ? { fg: "background", bg: "warning", bold: true } : { fg: "background", bg: "muted" })
  return out
}

const NARROW = 70

/** The find bar: label and query on the left, the hit count (`3/17`) and the key hints on the right. */
export function findBar(input: { state: FindState; width: number; margin: number }): { row: Line; cursor: number } {
  const { state, width, margin } = input
  const room = Math.max(1, width - margin * 2)
  const count = state.matches.length ? `${state.index + 1}/${state.matches.length}` : state.query || state.prompts ? "no matches" : ""
  const hints = width >= NARROW ? "↑↓ move · tab prompts · esc close" : ""
  const labelWidth = 5
  const base = [state.prompts ? "prompts" : "", count].filter(Boolean)
  const full = [...base, hints].filter(Boolean)
  const right = labelWidth + textWidth(state.query) + 2 + textWidth(full.join("  ")) <= room ? full : base
  const rightWidth = right.length ? textWidth(right.join("  ")) + 2 : 0
  let query = state.query
  while (query && textWidth(query) > Math.max(1, room - labelWidth - rightWidth)) query = query.slice(1)
  const gap = Math.max(1, room - labelWidth - textWidth(query) - Math.max(0, rightWidth - 2))
  const spans: Line = [
    { text: " ".repeat(margin) },
    { text: "find ", fg: "heading" },
    { text: query, fg: "text" },
    { text: " ".repeat(gap) },
    ...right.flatMap((part, at): Line => [...(at ? [{ text: "  " }] : []), { text: part, fg: part === "no matches" ? "warning" : part === "prompts" ? "heading" : "muted" }]),
  ]
  return { row: spans, cursor: margin + labelWidth + textWidth(query) }
}
