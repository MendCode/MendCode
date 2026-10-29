import type { AsideCard } from "./aside-card"
import type { ColorName, Line, Span } from "../ui/theme"
import { fit } from "./deck"
import { compact } from "./format"
import type { LanguageScan } from "./fetch-info"
import { truncateEnd } from "./session-list"

/**
 * `/fetch`: a neofetch-style card of MendCode and the project, floating over the transcript like the `/btw` card
 * (same `AsideCard` shape, so the app places and closes it the same way). The logo sits on the left, key/value rows
 * on the right; below `LOGO_ROOM` columns of value space the logo is dropped and only the rows remain.
 */

export type FetchFacts = {
  project: string
  branch: string
  languages?: LanguageScan
  sessions?: number
  model?: string
  usageToday?: { tokens: number; calls: number; costMicros?: number }
  pet?: string
  version?: string
  terminal: string
}

const CARD: ColorName = "panel"
const PADDING = 2
const MAX_WIDTH = 76
const MIN_WIDTH = 30
const GAP = 3
const MIN_VALUE = 22

/** The MendCode mark: an M with a stitched seam under it; 7 rows, at most 18 cells. */
const LOGO: Array<{ text: string; fg: ColorName; bold?: boolean; dim?: boolean }> = [
  { text: "███▄        ▄███", fg: "primary" },
  { text: "██▀██▄    ▄██▀██", fg: "primary" },
  { text: "██  ▀██▄▄██▀  ██", fg: "secondary" },
  { text: "██    ▀██▀    ██", fg: "secondary" },
  { text: "██     ▀▀     ██", fg: "accent" },
  { text: "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌", fg: "muted", dim: true },
  { text: "  m e n d c o d e", fg: "primary", bold: true },
]
const LOGO_WIDTH = Math.max(...LOGO.map((row) => [...row.text].length))

export const FETCH_LOGO = { rows: LOGO.length, width: LOGO_WIDTH } as const

function money(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/** The key/value rows, in display order; rows whose fact is unknown are left out. */
export function fetchRows(facts: FetchFacts): Array<{ key: string; value: string }> {
  const languages = facts.languages?.top.length
    ? `${facts.languages.capped ? "~" : ""}${facts.languages.top.map((share) => `${share.name} ${share.percent}%`).join(" · ")}`
    : undefined
  const usage = facts.usageToday
  return [
    { key: "project", value: facts.project },
    { key: "branch", value: facts.branch },
    ...(languages ? [{ key: "languages", value: languages }] : []),
    ...(facts.sessions !== undefined ? [{ key: "sessions", value: String(facts.sessions) }] : []),
    ...(facts.model ? [{ key: "model", value: facts.model }] : []),
    ...(usage ? [{ key: "usage", value: `${compact(usage.tokens)} tokens · ${usage.calls} calls${usage.costMicros ? ` · ${money(usage.costMicros)}` : ""}` }] : []),
    ...(facts.pet ? [{ key: "pet", value: facts.pet }] : []),
    ...(facts.version ? [{ key: "version", value: facts.version }] : []),
    { key: "terminal", value: facts.terminal },
  ]
}

/** The logo and the rows side by side, exactly `inner` cells per row; the shorter column is centred vertically. */
function body(facts: FetchFacts, inner: number): Line[] {
  const rows = fetchRows(facts)
  const keyWidth = Math.max(...rows.map((row) => row.key.length)) + 2
  const withLogo = inner - LOGO_WIDTH - GAP >= keyWidth + MIN_VALUE
  const valueWidth = Math.max(1, (withLogo ? inner - LOGO_WIDTH - GAP : inner) - keyWidth)
  const right = rows.map((row): Line => [{ text: row.key.padEnd(keyWidth), fg: "muted" }, { text: truncateEnd(row.value, valueWidth), fg: "text" }])
  if (!withLogo) return right.map((line) => fit(line, inner))
  const height = Math.max(LOGO.length, right.length)
  const logoTop = Math.floor((height - LOGO.length) / 2)
  const rowsTop = Math.floor((height - right.length) / 2)
  return Array.from({ length: height }, (_, index): Line => {
    const mark = LOGO[index - logoTop]
    const left: Span[] = mark ? [{ text: mark.text, fg: mark.fg, ...(mark.bold ? { bold: true } : {}), ...(mark.dim ? { dim: true } : {}) }] : []
    return fit([...fit(left, LOGO_WIDTH), { text: " ".repeat(GAP) }, ...(right[index - rowsTop] ?? [])], inner)
  })
}

/**
 * The card with its bottom just above the prompt at `bottom`: title and `esc`, a blank row, the body, a blank row.
 * Undefined when the screen is too small; rows are clipped to the room above the prompt.
 */
export function renderFetchCard(input: { facts: FetchFacts; width: number; bottom: number }): AsideCard | undefined {
  const cardWidth = Math.min(MAX_WIDTH, input.width - 4)
  const room = input.bottom
  if (cardWidth < MIN_WIDTH || room < 5) return undefined
  const inner = cardWidth - PADDING * 2
  const painted = (line: Line): Line => [{ text: " ".repeat(PADDING), bg: CARD }, ...fit(line, inner).map((span) => ({ ...span, bg: span.bg ?? CARD })), { text: " ".repeat(PADDING), bg: CARD }]
  const blank = painted([])
  const title = painted([{ text: "fetch", fg: "accent", bold: true }, { text: " ".repeat(Math.max(1, inner - 8)) }, { text: "esc", fg: "muted" }])
  const lines = body(input.facts, inner).map(painted)
  const rows = [blank, title, blank, ...lines, blank].slice(0, room)
  return { rows, top: Math.max(0, input.bottom - rows.length), left: Math.max(0, Math.floor((input.width - cardWidth) / 2)), lines: lines.length, visible: lines.length }
}
