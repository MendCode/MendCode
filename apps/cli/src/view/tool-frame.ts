import type { ColorName, Line, Span } from "../ui/theme"
import { clip } from "./deck"
import { shortenMiddle, textWidth, truncateEnd } from "./wrap"

/**
 * The common frame of a `balanced` or `full` tool card: a header row (a glyph per tool kind coloured by status, the label, the
 * target emphasised, muted facts, a duration at the right edge) over a body that hangs from a thin left rule. Pure: the marks
 * and the sizes in, rows out. `ascii` swaps every drawn mark for plain ASCII.
 */

export const INDENT = "   "

/** Fold marks of a card's rows (`line-meta`): 0 opens or closes the card, 1 turns to its next page, 2 opens or closes a folded run. */
export const FOLD_CARD = 0
export const FOLD_PAGE = 1
export const FOLD_RUN = 2

export type Marks = { rail: string; ellipsis: string; dot: string; minus: string; dash: string; folded: string; /** The marker of a failed call: it replaces the kind's glyph so the state reads without colour. */ failed: string }

const UNICODE: Marks = { rail: "│", ellipsis: "…", dot: "·", minus: "−", dash: "–", folded: "⋯", failed: "✗" }
const ASCII: Marks = { rail: "|", ellipsis: "...", dot: "-", minus: "-", dash: "-", folded: "...", failed: "x" }

export const marksOf = (ascii: boolean): Marks => (ascii ? ASCII : UNICODE)

/** The resolved `glyphs` mode (or MENDCODE_GLYPHS=ascii) turns every card's marks to ASCII, like the graph cards. */
export { asciiGlyphs } from "../ui/theme"

/** A glyph per tool kind, in the order a reader meets them: looking, searching, changing, running, reaching out. */
const GLYPHS: Readonly<Record<string, readonly [string, string]>> = {
  read: ["▤", "r"],
  ls: ["▦", "l"],
  glob: ["✲", "*"],
  grep: ["⌕", "?"],
  write: ["+", "+"],
  edit: ["✎", "~"],
  apply_patch: ["±", "%"],
  notebook_edit: ["✎", "~"],
  shell: ["$", "$"],
  shell_output: ["$", "$"],
  shell_kill: ["$", "$"],
  shell_session: ["$", "$"],
  shell_monitor: ["$", "$"],
  webfetch: ["⌁", "^"],
  web_search: ["⌁", "^"],
  websearch: ["⌁", "^"],
  task: ["◔", "@"],
  todo: ["✓", "v"],
  question: ["?", "?"],
  skill: ["◇", "o"],
  browser: ["◎", "o"],
  image_generation: ["◧", "i"],
  image_gen: ["◧", "i"],
  tool_define: ["◧", "i"],
}

export function glyphOf({ name, ascii }: { name: string; ascii: boolean }): string {
  const found = GLYPHS[name]
  if (found) return found[ascii ? 1 : 0]
  if (name.startsWith("mcp__")) return ascii ? "#" : "⊙"
  if (name.startsWith("graph_") || name.startsWith("code_")) return ascii ? "g" : "◈"
  return ascii ? "o" : "◆"
}

export type StatusTone = "running" | "ok" | "failed" | "cancelled" | "awaiting"

/** The colour of a card's glyph and rule: the status says what happened, nothing else on the row is coloured to say it. */
export function toneOf(status: StatusTone): { glyph: ColorName; rule: ColorName; dim: boolean } {
  switch (status) {
    case "running":
      return { glyph: "primary", rule: "primary", dim: false }
    case "awaiting":
      return { glyph: "warning", rule: "warning", dim: false }
    case "failed":
      return { glyph: "error", rule: "error", dim: false }
    case "cancelled":
      return { glyph: "muted", rule: "border", dim: true }
    case "ok":
      return { glyph: "success", rule: "border", dim: true }
  }
}

/** A run of facts (`126 lines`, `exit 1`, a group such as `+3 −1`) as muted spans separated by two spaces. */
export const factSpans = (facts: ReadonlyArray<string | Span | Span[]>): Span[] =>
  facts.flatMap((fact, at): Span[] => [...(at ? [{ text: "  " }] : []), ...(typeof fact === "string" ? [{ text: fact, fg: "muted" as const }] : Array.isArray(fact) ? fact : [fact])])

export type HeaderInput = {
  glyph: Span
  /** The tool's name as a reader says it (`Read`); shell cards have none. */
  label?: string
  target?: string
  /** How the target is drawn: a path or pattern is plain emphasis, a shell command is the primary tone. */
  targetTone?: ColorName
  /** Muted facts after the target; dropped from the end when the row is too narrow. */
  facts?: Span[]
  /** Right-aligned at the card's edge (a duration). */
  right?: string
  width: number
  /** Cut the target in its middle (`bun test …/a.test.ts`) instead of letting it take more than one row. */
  middle?: boolean
  strike?: boolean
  /** The target is plain weight rather than bold (a call kept to one row reads behind the assistant's text). */
  plain?: boolean
}

/** Smallest slice of the row the target keeps before the facts start to give way. */
const MIN_TARGET = 12

/**
 * `   ▤ Read README.md  126 lines                              2.4s`. One row: the target is cut in its middle when the
 * row is short, and the facts are dropped from the end before the target goes below MIN_TARGET cells.
 */
export function headerRow(input: HeaderInput): Line {
  const { width } = input
  const edge = width - 1
  const right = input.right ? `${input.right}` : ""
  const rightWidth = right ? textWidth(right) + 2 : 0
  const target = input.target ?? ""
  const start = INDENT.length + textWidth(input.glyph.text) + 1
  // A label is a tool's name and keeps its room before the target; an engine's whole title can land there too, and then it ends in `…` like a target.
  const labelRoom = Math.max(1, edge - start - rightWidth - (target ? 2 : 0))
  const label = input.label ? truncateEnd(input.label, labelRoom) : ""
  const lead: Span[] = [{ text: INDENT }, input.glyph, { text: " " }, ...(label ? [{ text: label, fg: "muted" as const, ...(input.strike ? { strike: true } : {}) }] : [])]
  let used = lead.reduce((sum, span) => sum + textWidth(span.text), 0)
  let facts = input.facts ?? []
  const space = input.label && target ? 1 : 0
  const room = (extra: number) => edge - used - space - rightWidth - extra
  const factsWidth = (list: Span[]) => (list.length ? 2 + list.reduce((sum, span) => sum + textWidth(span.text), 0) : 0)
  // Drop facts from the end until the target keeps its minimum.
  while (facts.length && room(factsWidth(facts)) < Math.min(MIN_TARGET, textWidth(target))) facts = facts.slice(0, -1)
  const targetRoom = Math.max(1, room(factsWidth(facts)))
  const shown = input.middle ? shortenMiddle(target, targetRoom) : truncateEnd(target, targetRoom)
  const row: Line = [...lead]
  if (shown) row.push({ text: `${space ? " " : ""}${shown}`, fg: input.targetTone ?? "text", ...(input.plain ? {} : { bold: true }), ...(input.strike ? { strike: true } : {}) })
  if (facts.length) row.push({ text: "  " }, ...facts)
  used = row.reduce((sum, span) => sum + textWidth(span.text), 0)
  if (right && edge - used - rightWidth >= 0) row.push({ text: " ".repeat(edge - used - textWidth(right)) }, { text: right, fg: "muted" })
  return row
}

/** The leading cells of a body row: the card's indent, then the rule in the card's colour. */
export const railPrefix = ({ rule, marks }: { rule: ColorName; marks: Marks }): Span[] => [{ text: INDENT }, { text: `${marks.rail} `, fg: rule }]

/** Cells of a body row after the rule; the last column is left empty. */
export const bodyWidth = (width: number) => Math.max(1, width - INDENT.length - 2 - 1)

export type GridCell = { spans: Span[]; width: number }

/**
 * Cells in columns the way `ls` lays them out: column by column, each column as wide as its widest cell, as many columns as
 * fit, at most `maxRows` rows. Returns the rows and how many cells fit; the rest are the caller's `… +N`.
 */
export function gridRows({ cells, width, maxRows, gap = 2 }: { cells: readonly GridCell[]; width: number; maxRows: number; gap?: number }): { rows: Line[]; shown: number } {
  const count = cells.length
  if (!count) return { rows: [], shown: 0 }
  for (let columns = Math.min(count, Math.max(1, Math.floor((width + gap) / (1 + gap)))); columns >= 1; columns--) {
    const rows = Math.min(maxRows, Math.ceil(count / columns))
    const shown = Math.min(count, rows * columns)
    const used = Math.ceil(shown / rows)
    const widths = Array.from({ length: used }, (_, column) => Math.max(...cells.slice(column * rows, Math.min(shown, column * rows + rows)).map((cell) => cell.width)))
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (used - 1)
    if (total > width && columns > 1) continue
    const lines = Array.from({ length: rows }, (_, row): Line => {
      const line: Line = []
      for (let column = 0; column < used; column++) {
        const cell = cells[column * rows + row]
        if (!cell || column * rows + row >= shown) break
        const last = column === used - 1 || column * rows + rows + row >= shown
        line.push(...cell.spans, ...(last ? [] : [{ text: " ".repeat(widths[column]! - cell.width + gap) }]))
      }
      return line
    })
    return { rows: lines.map((line) => clip(line, width)), shown }
  }
  return { rows: [], shown: 0 }
}
