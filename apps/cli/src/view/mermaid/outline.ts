import type { Line } from "../../ui/theme"
import { cells, takeCellSlice, textWidth, truncateEnd, wrap } from "../wrap"

/**
 * What a diagram becomes when its picture cannot be drawn in the room there is: the picture cut at the right edge, or its
 * statements as an indented outline. Both are one pass over their input and a bounded number of rows, at any size.
 */

/** Rows an outline shows before it says how many are left. */
const OUTLINE_MAX_ROWS = 240
const OUTLINE_MAX_DEPTH = 8

/** The prepared source (header first) as an outline: the type as a heading, each statement under it at its own depth. */
export function outlineLines(source: readonly string[], width: number): Line[] {
  const rows: Line[] = [[{ text: truncateEnd(source[0]!.trim(), width), fg: "heading", bold: true }]]
  const indents: number[] = []
  let hidden = 0
  for (const raw of source.slice(1)) {
    const text = raw.trim()
    if (!text) continue
    if (rows.length >= OUTLINE_MAX_ROWS) {
      hidden++
      continue
    }
    const indent = raw.replace(/\t/g, "  ").match(/^\s*/)![0].length
    while (indents.length && indents.at(-1)! > indent) indents.pop()
    if (indents.at(-1) !== indent) indents.push(indent)
    // Indent and text room share the width: the text keeps at least two cells, so deep rows are indented less, never wider.
    const depth = Math.max(0, Math.min(OUTLINE_MAX_DEPTH, indents.length - 1, Math.floor((width - 4) / 2)))
    const lead = "│ ".repeat(depth) + "├ "
    const room = Math.max(1, width - textWidth(lead))
    const parts = wrap(text, room)
    for (let at = 0; at < parts.length; at++) {
      if (rows.length >= OUTLINE_MAX_ROWS) {
        hidden += parts.length - at
        break
      }
      rows.push([{ text: at === 0 ? lead : "│ ".repeat(depth + 1), fg: "muted" }, { text: truncateEnd(parts[at]!, room), fg: "body" }])
    }
  }
  if (hidden) rows.push([{ text: truncateEnd(`… ${hidden} more lines`, width), fg: "muted" }])
  return rows
}

/** `line` cut to `width` cells, its last cell an ellipsis when anything was cut. Spans keep their colours. */
export function clipLine(line: Line, width: number): Line {
  let used = 0
  for (const span of line) used += textWidth(span.text)
  if (used <= width) return line
  const out: Line = []
  let room = width - 1
  for (const span of line) {
    if (room <= 0) break
    const text = takeCellSlice([...cells(span.text)], room)
    if (text) out.push({ ...span, text })
    room -= textWidth(text)
    if (textWidth(text) < textWidth(span.text)) break
  }
  out.push({ text: "…", fg: "muted" })
  return out
}

/** A line of a diagram type that has no drawing: `A --> B`, `A ..> B : label`, `"A" -- "B"`. */
const LINK = /^("[^"]+"|[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,39}?)\s*(<?[|}{o*]{0,2}(?:-{2,}|\.{2,}|={2,}|-)[|}{o*]{0,2}>{0,2})\s*("[^"]+"|[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,39}?)(?:\s*:\s*(.+))?$/u

/** The links of a source whose statements mostly join two names; undefined when it is not that kind of diagram. */
export function looseLinks(body: readonly string[]): Array<{ from: string; to: string; label?: string; dashed: boolean; head: boolean }> | undefined {
  const links: Array<{ from: string; to: string; label?: string; dashed: boolean; head: boolean }> = []
  let statements = 0
  for (const raw of body) {
    const text = raw.trim()
    if (!text) continue
    statements++
    const link = LINK.exec(text)
    if (!link || !/[-.=]{2}|->/.test(link[2]!)) continue
    const name = (value: string) => value.replace(/^"|"$/g, "").trim()
    links.push({ from: name(link[1]!), to: name(link[3]!), ...(link[4] ? { label: link[4].trim() } : {}), dashed: link[2]!.includes(".."), head: link[2]!.includes(">") })
    if (links.length > 400) return undefined
  }
  return links.length && links.length * 2 >= statements ? links : undefined
}
