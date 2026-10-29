import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { cells, textWidth } from "./wrap"
import { panelGrid, clip } from "./deck"
import { pickerFrame } from "./picker-frame"
import { OPEN_FILE_TITLE } from "./file-ref"
import { AIRY_HEIGHT, CARD_PADDING, cardChrome, cardPlace, cardWidthFor, padTo } from "./modal-card"

export type PaletteKind = "command" | "action" | "session" | "theme" | "view" | "permission" | "setting" | "file"
/** `current` (or the legacy hint `current`) marks the item in use with v1's `●`. `hint` is v1's description, muted after the title. */
export type PaletteItem = { id: string; kind: PaletteKind; title: string; hint?: string; keywords?: string; current?: boolean }
export type PaletteState = { title?: string; query: string; selected: number }
export type PaletteAction = { type: "none" } | { type: "close" } | { type: "run"; item: PaletteItem }
export type PaletteMatch = { item: PaletteItem; score: number; positions: number[] }
export type PaletteOverlay = { rows: Line[]; top: number; left: number; cursor: { row: number; col: number } }

const NONE: PaletteAction = { type: "none" }
const KEYWORD_PENALTY = 30
const PAGE_STEP = 10
const MAX_LIST_ROWS = 14
const CARD: ColorName = "panel"
const TITLE = "Commands"
const PLACEHOLDER = "search commands, /slash, shortcut..."
const KIND_HEADING: Record<PaletteKind, string> = { command: "Commands", action: "Actions", session: "Sessions", theme: "Themes", view: "Views", permission: "Permissions", setting: "Settings", file: "Files" }
const HINTS: ReadonlyArray<[string, string]> = [["Run", "enter"], ["Move", "↑↓"], ["Close", "esc"]]

export function createPaletteState(): PaletteState {
  return { query: "", selected: 0 }
}

const isWordStart = (chars: string[], index: number) => index === 0 || !/[\p{L}\p{N}]/u.test(chars[index - 1]!)

/**
 * Subsequence match with scoring: word starts and the very first character earn a bonus, characters that
 * follow each other earn a contiguity bonus, gaps cost a little. Returns the best placement (case-insensitive).
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | undefined {
  const needle = Array.from(query.toLowerCase().replace(/\s+/g, ""))
  const chars = Array.from(text)
  const lower = chars.map((c) => c.toLowerCase())
  if (needle.length === 0) return { score: 0, positions: [] }
  if (needle.length > chars.length) return undefined
  const n = needle.length
  const m = chars.length
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(Number.NEGATIVE_INFINITY))
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1))
  for (let i = 0; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (lower[j] !== needle[i]) continue
      const gain = 1 + (isWordStart(chars, j) ? 8 : 0) + (j === 0 ? 6 : 0)
      if (i === 0) {
        best[i]![j] = gain - j * 0.05
        continue
      }
      for (let k = i - 1; k < j; k++) {
        const previous = best[i - 1]![k]!
        if (previous === Number.NEGATIVE_INFINITY) continue
        const score = previous + gain + (k === j - 1 ? 5 : -(j - k - 1) * 0.1)
        if (score > best[i]![j]!) {
          best[i]![j] = score
          from[i]![j] = k
        }
      }
    }
  }
  let end = -1
  for (let j = 0; j < m; j++) if (best[n - 1]![j]! > (end < 0 ? Number.NEGATIVE_INFINITY : best[n - 1]![end]!)) end = j
  if (end < 0 || best[n - 1]![end] === Number.NEGATIVE_INFINITY) return undefined
  const positions: number[] = []
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions.unshift(j)
    j = from[i]![j]!
  }
  return { score: best[n - 1]![end]!, positions }
}

/** Items matching the query, best first; ties keep the original order. Without a query: all items in order. */
export function filterPalette(items: PaletteItem[], query: string): PaletteMatch[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, positions: [] }))
  const matches: (PaletteMatch & { index: number })[] = []
  items.forEach((item, index) => {
    const title = fuzzyMatch(query, item.title)
    if (title) return void matches.push({ item, index, score: title.score, positions: title.positions })
    const other = fuzzyMatch(query, [item.keywords, item.hint, item.kind].filter(Boolean).join(" "))
    if (other) matches.push({ item, index, score: other.score - KEYWORD_PENALTY, positions: [] })
  })
  return matches.sort((a, b) => b.score - a.score || a.index - b.index).map(({ item, score, positions }) => ({ item, score, positions }))
}

function isPrintable(key: string) {
  if (!key) return false
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false
  }
  return true
}

/** Handles one raw key. Returns a new state object only when something changed. */
export function paletteKey(state: PaletteState, key: string, items: PaletteItem[]): { state: PaletteState; action: PaletteAction } {
  const matches = filterPalette(items, state.query)
  const current = Math.max(0, Math.min(state.selected, matches.length - 1))
  const move = (index: number) => {
    const next = Math.max(0, Math.min(index, matches.length - 1))
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (key === "\x1b") return { state, action: { type: "close" } }
  if (key === "\x1b[A" || key === "\x1bOA" || key === "\x10") return move(current - 1)
  if (key === "\x1b[B" || key === "\x1bOB" || key === "\x0e") return move(current + 1)
  if (key === "\x1b[5~") return move(current - PAGE_STEP)
  if (key === "\x1b[6~") return move(current + PAGE_STEP)
  if (key === "\x1b[H" || key === "\x1bOH" || key === "\x1b[1~") return move(0)
  if (key === "\x1b[F" || key === "\x1bOF" || key === "\x1b[4~") return move(matches.length - 1)
  if (key === "\r" || key === "\n") {
    const target = matches[current]
    return target ? { state, action: { type: "run", item: target.item } } : { state, action: NONE }
  }
  if (key === "\x7f" || key === "\b") {
    if (!state.query) return { state, action: NONE }
    return { state: { ...state, query: Array.from(state.query).slice(0, -1).join(""), selected: 0 }, action: NONE }
  }
  if (key === "\x15") return state.query ? { state: { ...state, query: "", selected: 0 }, action: NONE } : { state, action: NONE }
  if (isPrintable(key)) return { state: { ...state, query: state.query + key.replace(/[\r\n]+/g, " "), selected: 0 }, action: NONE }
  return { state, action: NONE }
}

/** The title with its matched characters in `hit`; runs of unmatched characters keep `base`. */
function highlighted(title: string, positions: number[], base: Span, hit: Span): Span[] {
  if (positions.length === 0) return [{ ...base, text: title }]
  const marked = new Set(positions)
  const spans: Span[] = []
  let run = ""
  let on = false
  for (const [index, char] of Array.from(title).entries()) {
    const matched = marked.has(index)
    if (matched !== on && run) {
      spans.push({ ...(on ? hit : base), text: run })
      run = ""
    }
    on = matched
    run += char
  }
  if (run) spans.push({ ...(on ? hit : base), text: run })
  return spans
}

/** Truncates a title and drops the highlight positions that fell off. */
function fitTitle(title: string, positions: number[], room: number): { title: string; positions: number[] } {
  const fitted = truncateEnd(title, room)
  const kept = fitted.endsWith("…") && fitted !== title ? Array.from(fitted).length - 1 : Array.from(fitted).length
  return { title: fitted, positions: positions.filter((p) => p < kept) }
}

/** One line of the list: a category heading, the gap before one, or a match. */
type ListEntry = { type: "gap" } | { type: "heading"; kind: PaletteKind } | { type: "match"; index: number }

/** Matches in order with v1's category headings, shown only while nothing is typed (a search result is one flat list). */
function listEntries(matches: PaletteMatch[], grouped: boolean): ListEntry[] {
  const entries: ListEntry[] = []
  let kind: PaletteKind | undefined
  matches.forEach(({ item }, index) => {
    if (grouped && item.kind !== kind) {
      if (kind !== undefined) entries.push({ type: "gap" })
      entries.push({ type: "heading", kind: item.kind })
      kind = item.kind
    }
    entries.push({ type: "match", index })
  })
  return entries
}

const isCurrent = (item: PaletteItem) => item.current === true || item.hint === "current"

/**
 * v1's command dialog as a centered card on the panel fill: title row with `esc`, the search line, category headings,
 * the selected row as a full-width `primary` bar with `background` text, `●` on the item in use and a key hint row.
 * Every row is exactly `rows[i]` wide (the card width); the cursor sits at the end of the query.
 */
export function renderPalette(input: { items: PaletteItem[]; state: PaletteState; width: number; height: number; glyphs?: Glyphs }): PaletteOverlay {
  const { items, state, width, height } = input
  if (state.title === "Themes") {
    const matches = filterPalette(items, state.query)
    const selected = Math.max(0, Math.min(state.selected, matches.length - 1))
    const room = Math.max(0, height - 2)
    const rows = pickerFrame("Themes", "↑↓ preview · enter select · esc back", width, height, panelGrid({ width, compact: false, padding: true, maxColumns: width < 70 ? 1 : 2, heights: [room], rows: [[{
      title: `Themes · ${matches.length}`, active: true, scroll: Math.max(0, selected - room + 6),
      body: (w) => matches.length ? matches.map(({ item }, i) => clip([{ text: `${i === selected ? "› " : "  "}${item.title}${isCurrent(item) ? " · current" : ""}`, fg: i === selected ? "primary" : "text" }], w)) : [[{ text: "No matching themes", fg: "muted" }]],
    }]] }), `Search / ${state.query}`)
    return { rows, top: 0, left: 0, cursor: { row: 1, col: Math.min(width - 1, 9 + textWidth(state.query)) } }
  }
  const glyphs = input.glyphs ?? defaultGlyphs()
  const cardWidth = cardWidthFor(width)
  const none: PaletteOverlay = { rows: [], top: 0, left: 0, cursor: { row: 0, col: 0 } }
  if (cardWidth < 24 || height < 6) return none
  const { inner, line, blank, gapped, gutter, title } = cardChrome(cardWidth)
  const matches = filterPalette(items, state.query)
  const selected = Math.max(0, Math.min(state.selected, matches.length - 1))
  // Padding rows (top, below the title, below the search, above the hints, bottom) only when the screen has room for them.
  const airy = height >= AIRY_HEIGHT
  const fixed = airy ? 8 : 3
  const entries = listEntries(matches, !state.query.trim())
  const listRows = Math.max(1, Math.min(MAX_LIST_ROWS, height - fixed - 1, Math.max(1, entries.length)))
  const selectedEntry = Math.max(0, entries.findIndex((entry) => entry.type === "match" && entry.index === selected))
  const first = Math.min(Math.max(0, selectedEntry - listRows + 1), Math.max(0, entries.length - listRows))

  const count = matches.length ? `${selected + 1}/${matches.length}` : ""
  const queryRoom = Math.max(1, inner - textWidth(count) - 2)
  const queryText = truncateEnd(state.query, queryRoom)
  const searchLine = line(
    state.query
      ? gapped([{ text: queryText, fg: "text" }], count ? [{ text: count, fg: "muted" }] : [])
      : gapped([{ text: truncateEnd(state.title === OPEN_FILE_TITLE ? "search the paths in view" : PLACEHOLDER, queryRoom), fg: "muted" }], count ? [{ text: count, fg: "muted" }] : []),
  )
  const rows: Line[] = [...(airy ? [blank()] : []), title(state.title ?? TITLE), ...(airy ? [blank()] : []), searchLine, ...(airy ? [blank()] : [])]
  const searchRow = rows.length - 1 - (airy ? 1 : 0)

  if (matches.length === 0) rows.push(line([{ text: "No results found", fg: "muted" }]))
  for (const [position, entry] of entries.slice(first, first + listRows).entries()) {
    // A window that starts on the gap before a heading would add a second empty row under the search line.
    if (entry.type === "gap") position > 0 && rows.push(blank())
    else if (entry.type === "heading") rows.push(line([{ text: KIND_HEADING[entry.kind], fg: "accent", bold: true }]))
    else {
      const { item, positions } = matches[entry.index]!
      const on = entry.index === selected
      const current = isCurrent(item)
      const footer = state.query.trim() ? item.kind : ""
      const description = current || !item.hint ? "" : item.hint
      const titleRoom = Math.max(1, inner - (footer ? textWidth(footer) + 2 : 0))
      const fit = fitTitle(item.title, positions, titleRoom)
      const descRoom = titleRoom - textWidth(fit.title) - 2
      const shownDescription = description && descRoom > 3 ? truncateEnd(description, descRoom) : ""
      const ink: Span = on ? { text: "", fg: "background" } : { text: "", fg: "text" }
      const left: Span[] = [
        ...highlighted(fit.title, fit.positions, ink, on ? { text: "", fg: "background", bold: true } : { text: "", fg: "primary", bold: true }),
        ...(shownDescription ? [{ text: `  ${shownDescription}`, fg: on ? ("background" as const) : ("muted" as const) }] : []),
      ]
      const body = footer ? gapped(left, [{ text: footer, fg: on ? "background" : "muted" }]) : left
      const bar: ColorName | undefined = on ? "primary" : undefined
      const marker: Span = { text: current ? glyphs.dot : " ", fg: on ? "background" : "primary" }
      const spans = [gutter(" "), marker, gutter(" "), ...padTo(body, inner), gutter(" ".repeat(CARD_PADDING))].map((span): Span => ({ ...span, bg: bar ?? CARD }))
      rows.push(spans)
    }
  }
  // Hints that do not fit the card are dropped from the end.
  const hints: Span[] = []
  for (const [index, [title, key]] of HINTS.entries()) {
    const next: Span[] = [...(index ? [gutter("  ")] : []), { text: title, fg: "text", bold: true }, { text: ` ${key}`, fg: "muted" }]
    if (hints.concat(next).reduce((sum, span) => sum + textWidth(span.text), 0) > inner) break
    hints.push(...next)
  }
  rows.push(...(airy ? [blank()] : []), line(hints), ...(airy ? [blank()] : []))

  const { top, left } = cardPlace(rows.length, cardWidth, width, height)
  return { rows, top, left, cursor: { row: top + searchRow, col: left + CARD_PADDING + Math.min(textWidth(state.query), textWidth(queryText)) } }
}

/** Cells [start, end) of a line, padded with spaces where the line is shorter. Wide characters cut in half become spaces. */
function cut(line: Line, start: number, end: number): Span[] {
  const out: Span[] = []
  let col = 0
  for (const span of line) {
    let text = ""
    for (const { text: char, width: w } of cells(span.text)) {
      const inside = col >= start && col + w <= end
      if (inside) text += char
      else if (col + w > start && col < end && w > 0) text += " ".repeat(Math.min(col + w, end) - Math.max(col, start))
      col += w
    }
    if (text) out.push({ ...span, text })
    if (col >= end) return out
  }
  if (col < end) out.push({ text: " ".repeat(end - Math.max(col, start)) })
  return out
}

/** Paints the overlay over the page rows; rows outside the box are untouched. */
export function composeOverlay(base: Line[], overlay: PaletteOverlay, width: number): Line[] {
  if (overlay.rows.length === 0) return base
  const out = [...base]
  overlay.rows.forEach((row, index) => {
    const y = overlay.top + index
    if (y >= out.length) return
    const boxWidth = row.reduce((sum, span) => sum + textWidth(span.text), 0)
    const page = out[y] ?? []
    out[y] = [...cut(page, 0, overlay.left), ...row, ...cut(page, overlay.left + boxWidth, width)].filter((span) => span.text !== "")
  })
  return out
}
