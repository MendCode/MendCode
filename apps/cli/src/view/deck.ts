import type { ColorName, Line } from "../ui/theme"
import { center, page, pageChrome, type Hint, type PageTab } from "./page"
import { cells, lineWidth, textWidth } from "./wrap"

/**
 * Row helpers and the legacy page API. Pages build their body from titled sections (`panel`) and hand it
 * to `deck`, which draws the page standard of `page.ts` and fills exactly width × height. `panel` and
 * `bigNumber` keep the heights of the old bordered widgets, so page layouts sized for them still add up.
 */

export type DeckTone = "live" | "warn" | "error"
export type DeckStatus = { label: string; tone?: DeckTone }

export { lineWidth } from "./wrap"

/** Cuts a row to `width` cells, never splitting a grapheme. */
export function clip(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    let text = ""
    for (const cell of cells(span.text)) {
      if (used + cell.width > width) {
        if (text) out.push({ ...span, text })
        return out
      }
      text += cell.text
      used += cell.width
    }
    if (text) out.push({ ...span, text })
  }
  return out
}

/** Exactly `width` cells: clipped, then padded with spaces. */
export function fit(line: Line, width: number): Line {
  if (width <= 0) return []
  const clipped = clip(line, width)
  const room = width - lineWidth(clipped)
  return room > 0 ? [...clipped, { text: " ".repeat(room) }] : clipped
}

/** `left` and `right` on one row with the gap between them; `right` is dropped when both do not fit. */
export function spread(left: Line, right: Line, width: number): Line {
  const gap = width - lineWidth(left) - lineWidth(right)
  return gap >= 1 ? [...left, { text: " ".repeat(gap) }, ...right] : fit(left, width)
}

/** Splits `width` into columns by weight with `gap` cells between them; widths sum to exactly `width - gaps`. */
export function columns(width: number, weights: number[], gap = 1): number[] {
  const usable = Math.max(0, width - gap * (weights.length - 1))
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  const sizes = weights.map((w) => Math.floor((usable * w) / total))
  let rest = usable - sizes.reduce((sum, w) => sum + w, 0)
  for (let i = 0; rest > 0; i = (i + 1) % sizes.length, rest--) sizes[i]!++
  return sizes
}

const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } as const

/**
 * A bordered box for content inside the chat (tool cards, render specs), where borders still frame a
 * block among messages: single border, one space of padding at the sides, the title in the primary color.
 * `compact` drops the padding rows. Exactly `width` wide; `height`, when given, is exact too.
 */
export function boxPanel(input: { title?: string; body: Line[]; width: number; height?: number; compact?: boolean; active?: boolean; titleTone?: ColorName; borderTitle?: boolean; flat?: boolean; scroll?: number }): Line[] {
  const { width } = input
  if (width < 4) return []
  if (input.flat) {
    const head: Line[] = input.title ? [[{ text: input.title, fg: input.titleTone ?? "primary", bold: true }], [{ text: BOX.h.repeat(width), fg: "border" }]] : []
    const room = input.height === undefined ? input.body.length : Math.max(0, input.height - head.length)
    const start = Math.max(0, Math.min(input.scroll ?? 0, Math.max(0, input.body.length - room)))
    return toHeight([...head, ...input.body.slice(start, start + room)], width, input.height ?? head.length + room)
  }
  const border: ColorName = input.active ? "borderActive" : "border"
  const inner = width - 4
  const row = (line: Line): Line => [{ text: `${BOX.v} `, fg: border }, ...fit(line, inner), { text: ` ${BOX.v}`, fg: border }]
  const head: Line[] = input.title && !input.borderTitle ? [[{ text: input.title, fg: input.titleTone ?? "primary" }], ...(input.compact ? [] : [[]])] : []
  const pad: Line[] = input.compact ? [] : [[]]
  let body = [...pad, ...head, ...input.body, ...pad]
  if (input.height !== undefined) {
    const room = Math.max(0, input.height - 2)
    if (input.borderTitle && !input.compact) {
      const padding = pad.slice(0, Math.floor(room / 2))
      const contentRoom = room - padding.length * 2
      const start = Math.max(0, Math.min(input.scroll ?? 0, Math.max(0, input.body.length - contentRoom)))
      body = [...padding, ...toHeight(input.body.slice(start, start + contentRoom), inner, contentRoom), ...padding]
    } else {
      const start = Math.max(0, Math.min(input.scroll ?? 0, Math.max(0, body.length - room)))
      body = toHeight(body.slice(start, start + room), inner, room)
    }
  }
  const rule = BOX.h.repeat(width - 2)
  const top: Line = input.borderTitle && input.title
    ? [{ text: `${BOX.tl}─ `, fg: border }, ...clip([{ text: input.title, fg: input.titleTone ?? "primary", bold: true }], width - 6)]
    : [{ text: `${BOX.tl}${rule}`, fg: border }]
  if (input.borderTitle && input.title) top.push({ text: ` ${BOX.h.repeat(Math.max(0, width - lineWidth(top) - 2))}`, fg: border })
  top.push({ text: BOX.tr, fg: border })
  return [fit(top, width), ...body.map(row), [{ text: `${BOX.bl}${rule}${BOX.br}`, fg: border }]]
}

/** Blank rows up to `height` (or clipped to it); exact `width` cells each. */
function toHeight(rows: Line[], width: number, height: number): Line[] {
  const out = rows.slice(0, Math.max(0, height)).map((line) => fit(line, width))
  while (out.length < height) out.push(fit([], width))
  return out
}

/** Rows the old bordered panel took for this content: borders, padding and the title with its gap. */
function boxedHeight(input: { title?: string; bodyRows: number; compact?: boolean }) {
  const title = input.title ? (input.compact ? 1 : 2) : 0
  return 2 + (input.compact ? 0 : 2) + title + input.bodyRows
}

/**
 * A titled section in place of the old bordered panel: the title in bold (primary when `active`), a blank
 * row unless `compact`, then the body, flush left. Content stays inside `width - 4` cells as before, and the
 * height is the old panel's (or `height` when given), so layouts built for boxes keep their rhythm.
 */
export function panel(input: { title?: string; body: Line[]; width: number; height?: number; compact?: boolean; active?: boolean; titleTone?: ColorName }): Line[] {
  const { width } = input
  if (width < 4) return []
  const inner = width - 4
  const head: Line[] = input.title ? [[{ text: input.title, fg: input.active ? "primary" : (input.titleTone ?? "text"), bold: true }], ...(input.compact ? [] : [[]])] : []
  const rows = [...head, ...input.body].map((line) => fit(line, inner))
  const height = input.height ?? boxedHeight({ ...(input.title ? { title: input.title } : {}), bodyRows: input.body.length, ...(input.compact ? { compact: true } : {}) })
  return toHeight(rows, width, height)
}

/**
 * A KPI: the value in bold over its muted label (and optional detail), centered. Same height as the old
 * bordered tile, or `height` when given, so a row of KPIs shares one height.
 */
export function bigNumber(input: { label: string; value: string; detail?: string; width: number; height?: number; tone?: ColorName }): Line[] {
  const { width } = input
  if (width < 4) return []
  const rows: Line[] = [[], center([{ text: input.value, fg: input.tone ?? "text", bold: true }], width), center([{ text: input.label, fg: "muted" }], width)]
  if (input.detail !== undefined) rows.push(center([{ text: input.detail, fg: "muted" }], width))
  const height = input.height ?? boxedHeight({ title: input.label, bodyRows: input.detail !== undefined ? 2 : 1 })
  return toHeight(rows, width, height)
}

/**
 * A row of titled panels sharing one height (the tallest body, plus chrome), split across `width` by
 * `weight` (equal weights by default). Use this instead of hand-rolling `columns` + `panel` + `beside`
 * whenever a page needs several bordered panels lined up with aligned borders.
 */
export function panelsRow(items: Array<{ title: string; body: Line[]; weight?: number; titleTone?: ColorName; active?: boolean }>, width: number, gap = 1): Line[] {
  if (items.length === 0) return []
  const height = Math.max(...items.map((item) => item.body.length)) + 6
  const widths = columns(width, items.map((item) => item.weight ?? 1), gap)
  return beside(
    items.map((item, index) => ({
      lines: panel({ title: item.title, body: item.body, width: widths[index]!, height, ...(item.titleTone ? { titleTone: item.titleTone } : {}), ...(item.active ? { active: true } : {}) }),
      width: widths[index]!,
    })),
    gap,
  )
}

/** Blocks side by side with `gap` cells between them; shorter blocks are padded, each block keeps its own width. */
export function beside(blocks: Array<{ lines: Line[]; width: number }>, gap = 1): Line[] {
  const height = Math.max(0, ...blocks.map((block) => block.lines.length))
  const out: Line[] = []
  for (let y = 0; y < height; y++) {
    const row: Line = []
    blocks.forEach((block, index) => {
      if (index > 0 && gap > 0) row.push({ text: " ".repeat(gap) })
      row.push(...fit(block.lines[y] ?? [], block.width))
    })
    out.push(row)
  }
  return out
}


export type GridPanel = {
  title: string
  body: Line[] | ((width: number) => Line[])
  weight?: number
  scroll?: number
  active?: boolean
}

/** Weighted panel rows: one column below 70, two below 110, full rows above it. */
export function panelGrid(input: { rows: GridPanel[][]; width: number; heights?: number[]; gap?: number; compact?: boolean; padding?: boolean; maxColumns?: number }): Line[] {
  const { width } = input
  const gap = input.gap ?? 1
  const compact = input.compact ?? width < 68
  const count = input.maxColumns ?? (compact ? 1 : width < 108 ? 2 : Number.POSITIVE_INFINITY)
  const rows: Line[] = []
  input.rows.forEach((group, rowIndex) => {
    for (let offset = 0; offset < group.length; offset += count) {
      const items = group.slice(offset, offset + count)
      const widths = columns(width, items.map((item) => item.weight ?? 1), gap)
      const bodies = items.map((item, i) => typeof item.body === "function" ? item.body(compact ? widths[i]! : Math.max(1, widths[i]! - 4)) : item.body)
      const height = input.heights?.[rowIndex] ?? Math.max(0, ...bodies.map((body) => body.length)) + (input.padding === true ? 4 : 2)
      if (rows.length && gap) rows.push([])
      rows.push(...beside(items.map((item, i) => ({ width: widths[i]!, lines: boxPanel({ title: item.title, body: bodies[i]!, width: widths[i]!, height, compact: input.padding !== true, borderTitle: true, flat: compact, scroll: item.scroll ?? 0, active: item.active ?? false }) })), gap))
    }
  })
  return rows.map((row) => fit(row, width))
}

/** A key-hint string wrapped at its separators (three spaces or " · ") to `width`. */
export function wrapHints(hints: string, width: number): string[] {
  const parts = hints.split(/ {3,}| · /).filter(Boolean)
  const sep = hints.includes(" · ") && !/ {3,}/.test(hints) ? " · " : "   "
  const lines: string[] = []
  let current = ""
  for (const part of parts) {
    const next = current ? `${current}${sep}${part}` : part
    if (current && textWidth(next) > width) {
      lines.push(current)
      current = part
    } else current = next
  }
  if (current) lines.push(current)
  return lines
}

/** Rows the deck itself uses around the body, for pages that size their body before calling `deck`. */
export function deckChrome(hints: string, width: number, extra: { tabs?: boolean; mode?: boolean } = {}) {
  return pageChrome({ hints, width, ...extra })
}

/**
 * The whole page in the standard of `page.ts`: `Page · subtitle` with the summary (and a warn/error status)
 * on the right, optional tabs and mode line, the body, and the key footer. Exactly `height` rows of `width`.
 */
export function deck(input: { page: string; status?: DeckStatus; subtitle?: string; summary?: string; body: Line[]; hints: string; width: number; height: number; tabs?: PageTab[]; activeTab?: number; mode?: Hint; scroll?: number }): Line[] {
  return page({
    title: input.page,
    ...(input.subtitle ? { context: input.subtitle } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.tabs ? { tabs: input.tabs, activeTab: input.activeTab ?? 0 } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.scroll !== undefined ? { scroll: input.scroll } : {}),
    body: input.body,
    hints: input.hints,
    width: input.width,
    height: input.height,
  })
}
