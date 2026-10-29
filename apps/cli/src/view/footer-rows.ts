import { FOOTER_ICON_MODES, FOOTER_PRESETS, FOOTER_PRESET_NAMES, FOOTER_ROWS_MAX, FOOTER_HEIGHT_FRACTION, footerRowsProblems, parseRowSegment, type FooterIconMode } from "@mendcode/protocol/wire"
import type { Line, Span } from "../ui/theme"
import { clip, decorate, dropToFit, entryBody, entrySpans, type FooterInput } from "./footer"
import { lineWidth as widthOf, textWidth } from "./wrap"

/**
 * The built-in footer as rows (`footerRows` in the profile, docs/customize.md "Footer rows"): each row a list of segment names, drawn left
 * to right with the separator between them. A row that does not fit drops its lowest-ranked segments, the later of equal rank first, then
 * truncates with `…`; a row never wraps. Rows are cut to a quarter of the terminal's height from the bottom of the list.
 */

/** How many rows the footer may take on a terminal `height` rows tall: a quarter of it, at least one, never more than the ceiling. */
export const footerRowBudget = (height: number) => Math.max(1, Math.min(FOOTER_ROWS_MAX, Math.floor(height / FOOTER_HEIGHT_FRACTION)))

/** A segment as a row draws it: `context` and `effort` take the words of a row (`context 42%`, `low:JEV`), the rest are the shared segments. */
function rowEntry(entry: string, input: FooterInput): Span[] {
  const { id } = parseRowSegment(entry)
  // The shared `context` says `compact 42%`; a row says what the figure is.
  if (id === "context") return decorate(entry, entryBody(entry, input).map((span) => (span.text === "compact " ? { ...span, text: "context " } : span)), input)
  if (id === "effort") return decorate(entry, input.effort ? [{ text: input.effort, fg: "text" }, ...(input.adaptive ? [{ text: ":JEV", fg: "primary" as const }] : [])] : [], input)
  return entrySpans(entry, input)
}

/**
 * The rows, each at most `input.width` cells, without margins. The first `limit` rows are drawn; a non-default permission always shows on
 * the first row, as the goal does in the single row, so a row layout cannot hide by accident that the agent can write; the user's own
 * `showPermission` off hides it, as it does in the single row.
 */
export function renderFooterRows({ input, rows, limit }: { input: FooterInput; rows: readonly (readonly string[])[]; limit: number }): Line[] {
  const separator = input.separator ?? " · "
  return rows.slice(0, Math.max(1, limit)).map((row, index) => {
    const entries = index === 0 && input.showPermission !== false && input.permission !== "ask" && !row.includes("permission") ? [...row, "permission"] : row
    const parts = entries.map((entry) => ({ id: entry, spans: rowEntry(entry, input) })).filter((part) => part.spans.length > 0)
    dropToFit(parts, input.width, textWidth(separator))
    const line: Line = []
    parts.forEach((part, at) => {
      if (at) line.push({ text: separator, fg: "muted" })
      line.push(...part.spans)
    })
    return widthOf(line) > input.width ? clip(line, input.width) : line
  })
}

export type FooterRowsPatch = { footerRows?: string[][]; footerIcons?: FooterIconMode; quotaView?: "used" | "left"; quotaColor?: "pressure" | "accent" }
export type FooterRowsCommand = { ok: true; patch: FooterRowsPatch; notice: string } | { ok: false; error: string }

/**
 * `/footer` words that shape rows, or undefined when `args` is not one of them (the caller then reads the segment grammar):
 * `rows N` keeps the first N rows, `row N a b c` sets row N (a new row may follow the last), `row N` removes it,
 * `preset NAME` (alone it lists them) and `icons none|glyph|nerd`. `reset` is the caller's: it also clears the rows.
 */
export function parseFooterRowsCommand(args: string, current: { rows: readonly (readonly string[])[]; icons: FooterIconMode }): FooterRowsCommand | undefined {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [word, ...rest] = tokens
  if (word === "preset" || word === "presets") {
    const name = rest[0]
    if (!name) return { ok: false, error: `presets: ${FOOTER_PRESET_NAMES.join(", ")} (/footer preset NAME)` }
    const preset = FOOTER_PRESETS[name]
    if (!preset || rest.length > 1) return { ok: false, error: `unknown preset "${rest.join(" ")}" (${FOOTER_PRESET_NAMES.join(", ")})` }
    return { ok: true, patch: { footerRows: preset.rows.map((row) => [...row]), ...(preset.profile ?? {}) }, notice: `footer preset ${name}${preset.rows.length ? `: ${preset.rows.length} row${preset.rows.length === 1 ? "" : "s"}` : ""}` }
  }
  if (word === "icons") {
    const mode = FOOTER_ICON_MODES.find((candidate) => candidate === rest[0])
    return mode && rest.length === 1 ? { ok: true, patch: { footerIcons: mode }, notice: `footer icons: ${mode}` } : { ok: false, error: `usage: /footer icons ${FOOTER_ICON_MODES.join("|")} (now ${current.icons})` }
  }
  if (word === "rows") {
    const count = Number(rest[0])
    if (rest.length !== 1 || !Number.isInteger(count) || count < 0 || count > FOOTER_ROWS_MAX) return { ok: false, error: `usage: /footer rows 0..${FOOTER_ROWS_MAX} (now ${current.rows.length})` }
    return { ok: true, patch: { footerRows: current.rows.slice(0, count).map((row) => [...row]) }, notice: count ? `footer rows: ${count}` : "footer rows: off" }
  }
  if (word === "row") {
    const at = Number(rest[0])
    if (!Number.isInteger(at) || at < 1 || at > Math.min(FOOTER_ROWS_MAX, current.rows.length + 1)) return { ok: false, error: `usage: /footer row 1..${Math.min(FOOTER_ROWS_MAX, current.rows.length + 1)} [segments…] (now ${current.rows.length} row${current.rows.length === 1 ? "" : "s"})` }
    const names = rest.slice(1).flatMap((token) => token.split(",")).filter(Boolean)
    const rows = current.rows.map((row) => [...row])
    if (names.length === 0) rows.splice(at - 1, 1)
    else {
      const problems = footerRowsProblems([names])
      if (problems.length) return { ok: false, error: problems[0]!.replace(/^footerRows: row 1: /, "") }
      rows[at - 1] = names
    }
    return { ok: true, patch: { footerRows: rows }, notice: names.length ? `footer row ${at}: ${names.join(" ")}` : `footer row ${at} removed` }
  }
  return undefined
}
