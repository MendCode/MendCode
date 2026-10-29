import type { ColorName, Line, Span } from "../ui/theme"
// deck.ts delegates its chrome here; only functions cross the cycle, so load order does not matter.
import { clip, fit, lineWidth, spread } from "./deck"
import { textWidth, wrap } from "./wrap"

/**
 * The page standard (after Codex CLI 0.159's /usage): `Title · context` with the summary on the right,
 * numbered tabs, a rule, an optional mode line, the body, and a key footer (`esc back` on its own row,
 * then the page's keys). Sections are titled by weight, not boxes. Exactly width × height.
 */

export type PageTab = { key: string; label: string; short?: string }
export type Hint = { key: string; label: string }
export type PageStatus = { label: string; tone?: "live" | "warn" | "error" }

const MAX_CONTENT = 112
const RULE = "─"
const HINT_SEP = " · "
const STATUS_TONE: Record<"warn" | "error", ColorName> = { warn: "warning", error: "error" }
const BACK_LABELS = new Set(["back", "close", "quit", "exit"])
const LABEL_WORD = /^[A-Za-z][a-z]+$/

/** The centered content column: at most 112 cells, 4 cells narrower than the page, never under 20. */
export function contentWidth(width: number) {
  return Math.max(Math.min(20, width), Math.min(MAX_CONTENT, width - 4))
}

/** A row centered in `width` cells (clipped when wider). */
export function center(line: Line, width: number): Line {
  const used = lineWidth(line)
  if (used >= width) return clip(line, width)
  const left = Math.floor((width - used) / 2)
  return [{ text: " ".repeat(left) }, ...line]
}

/** A block of rows placed in the middle of a `width`-wide row, each row padded to `blockWidth`. */
export function centerBlock(lines: Line[], blockWidth: number, width: number): Line[] {
  const left = Math.max(0, Math.floor((width - blockWidth) / 2))
  const pad: Span = { text: " ".repeat(left) }
  return lines.map((line) => (left > 0 ? [pad, ...fit(line, Math.min(blockWidth, width))] : fit(line, width)))
}

/** "USAGE" and "usage" read as "Usage"; mixed-case titles ("MCPs") are kept. */
function sentenceCase(word: string) {
  if (!word) return word
  const whole = word === word.toUpperCase() ? word.toLowerCase() : word
  return whole[0]!.toUpperCase() + whole.slice(1)
}

/**
 * A legacy hint string ("←→ Day   [ ] Range   Esc/Q Back") as key/label pairs: the label is the run of plain
 * words at the end of each part (the first token is always key). The back/close hint is returned apart.
 */
export function parseHints(hints: string): { back?: Hint; hints: Hint[] } {
  const parts = hints.split(/ {3,}| · /).map((part) => part.trim()).filter(Boolean)
  const out: Hint[] = []
  let back: Hint | undefined
  for (const part of parts) {
    const tokens = part.split(/\s+/)
    let split = tokens.length
    while (split > 1 && LABEL_WORD.test(tokens[split - 1]!)) split--
    const hint: Hint = { key: tokens.slice(0, split).join(" "), label: tokens.slice(split).join(" ").toLowerCase() }
    if (!back && BACK_LABELS.has(hint.label)) back = hint
    else out.push(hint)
  }
  return back ? { back, hints: out } : { hints: out }
}

function hintSpans(hint: Hint): Line {
  return hint.label ? [{ text: hint.key, fg: "text", bold: true }, { text: ` ${hint.label}`, fg: "muted" }] : [{ text: hint.key, fg: "text", bold: true }]
}

/** Hints joined by " · " and wrapped to `width`; at most `maxRows` rows (later hints are dropped, never cut). */
export function hintRows(hints: Hint[], width: number, maxRows = 3): Line[] {
  const rows: Line[] = []
  let current: Line = []
  for (const hint of hints) {
    const spans = hintSpans(hint)
    const next = current.length ? [...current, { text: HINT_SEP, fg: "muted" as const }, ...spans] : spans
    if (current.length && lineWidth(next) > width) {
      rows.push(current)
      if (rows.length === maxRows) return rows
      current = spans
    } else current = next
  }
  if (current.length && rows.length < maxRows) rows.push(current)
  return rows.map((row) => clip(row, width))
}

function resolveHints(input: { hints: Hint[] | string; back?: Hint | false }) {
  const parsed = typeof input.hints === "string" ? parseHints(input.hints) : { hints: input.hints }
  const back = input.back === false ? undefined : (input.back ?? parsed.back)
  return { back, hints: parsed.hints }
}

function footerRows(input: { hints: Hint[] | string; back?: Hint | false; width: number }): Line[] {
  const { back, hints } = resolveHints(input)
  const rows: Line[] = back ? [clip(hintSpans({ key: back.key.toLowerCase() === "esc/q" ? "esc" : back.key.toLowerCase(), label: back.label }), input.width)] : []
  return [...rows, ...hintRows(hints, input.width, back ? 2 : 3)]
}

/** The tab row: `1 Overview   2 Limits …`, the active tab on the element background; labels shorten to fit. A tab with an empty `key` is just its label (tabs that other keys switch). */
export function tabsRow(tabs: PageTab[], active: number, width: number): Line {
  const render = (label: (tab: PageTab) => string, gap: number): Line => {
    const row: Line = []
    tabs.forEach((tab, index) => {
      if (index > 0) row.push({ text: " ".repeat(gap) })
      const text = tab.key ? ` ${tab.key} ${label(tab)} ` : ` ${label(tab)} `
      row.push(index === active ? { text, fg: "text", bg: "element", bold: true } : { text, fg: "muted" })
    })
    return row
  }
  const full = render((tab) => tab.label, 2)
  if (lineWidth(full) <= width) return full
  const short = render((tab) => tab.short ?? tab.label.slice(0, 2), 1)
  return lineWidth(short) <= width ? short : clip(render(() => "", 0), width)
}

/** Rows the page uses around its body, for pages that size their body before calling `page`. */
export function pageChrome(input: { tabs?: boolean; mode?: boolean; hints: Hint[] | string; back?: Hint | false; width: number }) {
  const inner = Math.max(1, input.width - 2)
  return 5 + (input.tabs ? 1 : 0) + (input.mode ? 1 : 0) + footerRows({ hints: input.hints, ...(input.back !== undefined ? { back: input.back } : {}), width: inner }).length
}

function titleRow(input: { title: string; context?: string; summary?: string; status?: PageStatus }, width: number): Line {
  const left: Line = [{ text: sentenceCase(input.title), fg: "text", bold: true }]
  if (input.context) left.push({ text: " · ", fg: "muted" }, { text: input.context, fg: "muted" })
  const right: Line = []
  if (input.summary) right.push({ text: input.summary, fg: "muted" })
  const tone = input.status?.tone
  if (input.status && tone && tone !== "live") {
    if (right.length) right.push({ text: " · ", fg: "muted" })
    right.push({ text: input.status.label, fg: STATUS_TONE[tone], bold: true })
  }
  return right.length ? spread(left, right, width) : clip(left, width)
}

/**
 * The whole page. Rows: blank, title, tabs?, rule, mode?, blank, body (scrolled by `scroll`), blank, footer.
 * Every row is padded by one cell on each side, so the body is `width - 2` cells wide.
 */
export function page(input: {
  title: string
  context?: string
  summary?: string
  status?: PageStatus
  tabs?: PageTab[]
  activeTab?: number
  mode?: Hint
  body: Line[]
  hints: Hint[] | string
  back?: Hint | false
  scroll?: number
  width: number
  height: number
}): Line[] {
  const { width, height } = input
  if (height <= 0 || width <= 0) return []
  const inner = Math.max(1, width - 2)
  const head: Line[] = [[], titleRow(input, inner)]
  if (input.tabs?.length) head.push(tabsRow(input.tabs, input.activeTab ?? 0, inner))
  head.push([{ text: RULE.repeat(inner), fg: "border" }])
  if (input.mode) head.push(hintSpans(input.mode))
  head.push([])
  const footer = footerRows({ hints: input.hints, ...(input.back !== undefined ? { back: input.back } : {}), width: inner })
  const bodyRoom = Math.max(0, height - head.length - 1 - footer.length)
  const start = Math.max(0, Math.min(input.scroll ?? 0, Math.max(0, input.body.length - bodyRoom)))
  const body = input.body.slice(start, start + bodyRoom)
  while (body.length < bodyRoom) body.push([])
  const rows: Line[] = [...head, ...body, [], ...footer]
  if (width < 3) return rows.slice(0, height).map((line) => fit(line, width))
  const pad: Span = { text: " " }
  return rows.slice(0, height).map((line) => [pad, ...fit(line, inner), pad])
}

/** A titled section: bold title, optional muted subtitle, a blank row, then the body. */
/** The subtitle and a body line of one span (a sentence: an empty state, a note) wrap at words; a row of several spans (a table, a bar) is clipped. */
export function section(input: { title: string; subtitle?: string; body: Line[]; width: number; titleTone?: ColorName }): Line[] {
  const rows: Line[] = [clip([{ text: input.title, fg: input.titleTone ?? "text", bold: true }], input.width)]
  if (input.subtitle) rows.push(...proseRows({ text: input.subtitle, fg: "muted" }, input.width))
  rows.push([], ...input.body.flatMap((line) => line.length === 1 ? proseRows(line[0]!, input.width) : [clip(line, input.width)]))
  return rows
}

function proseRows(span: Span, width: number): Line[] {
  if (textWidth(span.text) <= width || width < 1) return [clip([span], width)]
  return wrap(span.text, width).map((text) => [{ ...span, text }])
}

/** Label on the left, value right-aligned, one row each; the label is cut before the value. */
export function kvList(rows: Array<{ label: string; value: string; tone?: ColorName }>, width: number): Line[] {
  return rows.map(({ label, value, tone }) => {
    const valueWidth = Math.min(textWidth(value), width)
    const labelRoom = Math.max(0, width - valueWidth - 1)
    const left = clip([{ text: label, fg: "muted" }], labelRoom)
    const gap = Math.max(labelRoom > 0 ? 1 : 0, width - lineWidth(left) - valueWidth)
    return [...left, { text: " ".repeat(gap) }, ...clip([{ text: value, fg: tone ?? "text" }], valueWidth)]
  })
}

/**
 * KPIs as bold values over muted labels, spread evenly across `width`; items that do not fit on one row
 * wrap to further row pairs (a blank row between pairs).
 */
export function kpiRow(items: Array<{ value: string; label: string; tone?: ColorName }>, width: number): Line[] {
  if (items.length === 0 || width <= 0) return []
  const widest = Math.max(...items.map((item) => Math.max(textWidth(item.value), textWidth(item.label)))) + 2
  const perRow = Math.max(1, Math.min(items.length, Math.floor(width / widest)))
  const rows: Line[] = []
  for (let start = 0; start < items.length; start += perRow) {
    const slice = items.slice(start, start + perRow)
    const cell = Math.floor(width / slice.length)
    const values: Line = []
    const labels: Line = []
    slice.forEach((item) => {
      values.push(...fit(center([{ text: item.value, fg: item.tone ?? "text", bold: true }], cell), cell))
      labels.push(...fit(center([{ text: item.label, fg: "muted" }], cell), cell))
    })
    if (rows.length) rows.push([])
    rows.push(values, labels)
  }
  return rows
}

/** Two blocks side by side with a 4-cell gutter, or stacked (blank row between) when a column would be under `minColumn`. */
export function twoColumns(left: Line[], right: Line[], width: number, minColumn = 36): Line[] {
  const gutter = 4
  const column = Math.floor((width - gutter) / 2)
  if (column < minColumn) return [...left.map((line) => clip(line, width)), [], ...right.map((line) => clip(line, width))]
  const height = Math.max(left.length, right.length)
  const rows: Line[] = []
  for (let y = 0; y < height; y++) rows.push([...fit(left[y] ?? [], column), { text: " ".repeat(gutter) }, ...fit(right[y] ?? [], column)])
  return rows
}
