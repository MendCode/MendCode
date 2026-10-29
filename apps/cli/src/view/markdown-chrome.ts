import type { ColorName, Line, Span } from "../ui/theme"
import { copyOf, markCopy, markGutter, type CopyRegion } from "./line-meta"
import { alignRight, firstStrong, hasRtl, visualRow } from "./markdown-bidi"
import { plainText, wrapSpans } from "./markdown-wrap"
import type { Callout, HeadingStyle, MarkdownStyle, Roles } from "./markdown-style"
import { cells, textWidth } from "./wrap"

/** A button in a block header: what it says, and what a click puts on the clipboard. */
export type HeaderButton = { text: string; copy: string; label: string }

const GAP = "  "

/**
 * The header row of a block: `╭─ label ──────── art  copy`. The whole row is chrome (a selection skips it) and each
 * button answers a click. Buttons that do not fit are dropped from the right, then the label is cut.
 */
export function blockHeader(input: { label: string; width: number; roles: Roles; buttons: readonly HeaderButton[] }): Line {
  const { width, roles } = input
  const lead = "╭─ "
  const shown = [...input.buttons]
  const rightOf = (items: readonly HeaderButton[]) => items.map((item) => item.text).join(GAP)
  const room = (items: readonly HeaderButton[]) => width - textWidth(lead) - 2 - (items.length ? textWidth(rightOf(items)) + 1 : 0)
  while (shown.length && room(shown) < Math.min(textWidth(input.label), 6)) shown.pop()
  let label = ""
  let used = 0
  for (const cell of cells(input.label)) {
    if (used + cell.width > Math.max(0, room(shown))) break
    label += cell.text
    used += cell.width
  }
  const right = shown.length ? rightOf(shown) : ""
  const fill = Math.max(0, width - textWidth(lead) - used - 1 - (right ? textWidth(right) + 1 : 0))
  const row: Line = [{ text: lead, fg: roles.codeBorder }, { text: label, fg: roles.codeLabel }, { text: ` ${"─".repeat(fill)}`, fg: roles.codeBorder }]
  const regions: CopyRegion[] = []
  if (right) {
    let col = textWidth(lead) + used + 1 + fill + 1
    row.push({ text: " " })
    shown.forEach((button, at) => {
      if (at) {
        row.push({ text: GAP })
        col += GAP.length
      }
      row.push({ text: button.text, fg: roles.copy })
      regions.push({ from: col, to: col + textWidth(button.text), text: button.copy, label: button.label })
      col += textWidth(button.text)
    })
  }
  markGutter(row, 1000)
  markCopy(row, regions)
  return row
}

/**
 * Marks every row of a block with an invisible, zero-width copy region, so `ctrl+x Y` finds the block under the middle of
 * the screen. Nothing is drawn and a click never hits it. Rows that already carry a button keep it.
 */
export function tagCopy(rows: Line[], text: string, label: string): Line[] {
  const regions: readonly CopyRegion[] = [{ from: 0, to: 0, text, label }]
  for (const row of rows) if (!copyOf(row)) markCopy(row, regions)
  return rows
}

/** The first `columns` cells of a row, padded with blanks to exactly that width. */
function takeCells(row: Line, columns: number): Line {
  const out: Line = []
  let used = 0
  for (const span of row) {
    let text = ""
    let stopped = false
    for (const cell of cells(span.text)) {
      if (used + cell.width > columns) {
        stopped = true
        break
      }
      text += cell.text
      used += cell.width
    }
    if (text) out.push({ ...span, text })
    if (stopped) break
  }
  if (used < columns) out.push({ text: " ".repeat(columns - used) })
  return out
}

/** The text of cells `[from, to)` of a row, or undefined when a wide character straddles an edge. */
function segment(row: Line, from: number, to: number): string | undefined {
  let col = 0
  let text = ""
  for (const cell of cells(plainText(takeCells(row, to)))) {
    if (col >= from) text += cell.text
    else if (col + cell.width > from) return undefined
    col += cell.width
  }
  return text
}

/**
 * Draws buttons inside a row of a block's own art, right edge at `end` (a table's top border, a diagram's first row): the
 * cells they take must satisfy `accept`, otherwise nothing is drawn and the key is the only way to copy. A `tail` span
 * stays after the buttons. The row becomes chrome, so a selection skips the hint.
 */
export function overlayHint(input: { row: Line; end: number; buttons: readonly HeaderButton[]; roles: Roles; accept: (cut: string) => boolean; tail?: Span }): Line | undefined {
  const { row, end, buttons, roles, tail } = input
  const body = buttons.map((button) => button.text).join(GAP)
  const start = end - (1 + textWidth(body) + (tail ? 1 : 0))
  if (start < 0) return undefined
  const cut = segment(row, start, end)
  if (cut === undefined || !input.accept(cut)) return undefined
  const result: Line = [...takeCells(row, start), { text: " " }]
  const regions: CopyRegion[] = []
  let col = start + 1
  buttons.forEach((button, at) => {
    if (at) {
      result.push({ text: GAP })
      col += GAP.length
    }
    result.push({ text: button.text, fg: roles.copy })
    regions.push({ from: col, to: col + textWidth(button.text), text: button.copy, label: button.label })
    col += textWidth(button.text)
  })
  if (tail) result.push({ text: " " }, tail)
  markGutter(result, 1000)
  markCopy(result, regions)
  return result
}

export const levelRole =(level: number, roles: Roles): ColorName => (level === 1 ? roles.h1 : level === 2 ? roles.h2 : level === 3 ? roles.h3 : roles.h4)

/** Upper-cases text spans but not code, links' targets or swatches: those carry meaning in their case. */
function shout(spans: Span[], roles: Roles): Span[] {
  return spans.map((span) => (span.fg === roles.inlineCode || span.link || span.fgHex ? span : { ...span, text: span.text.toUpperCase() }))
}

/**
 * A heading as rows. Hierarchy comes from the level in every style: h1 and h2 carry the heading colour, h3 is bold text,
 * h4 and below bold body text. `banner` fills h1 and h2 with a bar, `underline` rules h1 (double) and h2 (single) under the
 * text, `uppercase` capitalises h1 and h2, `bold` is bold text only. Right-to-left headings are aligned right.
 */
export function headingRows(input: { level: number; spans: Span[]; width: number; style: MarkdownStyle; roles: Roles; sourceText: string }): Line[] {
  const { level, width, style, roles } = input
  const kind: HeadingStyle = style.heading
  const role = levelRole(level, roles)
  const shouting = kind === "uppercase" && level <= 2
  const spans = (shouting ? shout(input.spans, roles) : input.spans).map((span): Span => ({ ...span, bold: true }))
  const barred = kind === "banner" && level <= 2
  const mark = kind === "banner" && level === 3 ? "▌ " : ""
  const inner = Math.max(1, width - (barred ? 2 : 0) - textWidth(mark))
  const rtl = style.rtl && hasRtl(input.sourceText)
  const base = rtl ? (firstStrong(input.sourceText) ?? "ltr") : "ltr"
  const visual = wrapSpans(spans, inner).map((row) => (rtl ? visualRow(row, base) : row))
  const widest = Math.max(1, ...visual.map((row) => textWidth(row.map((span) => span.text).join(""))))
  let rows = base === "rtl" ? visual.map((row) => alignRight(row, inner)) : visual
  if (barred) {
    const bg: ColorName = level === 1 ? "element" : "panel"
    rows = rows.map((row) => {
      const filled = [{ text: " ", bg }, ...row.map((span) => ({ ...span, bg })), { text: " ".repeat(Math.max(1, width - textWidth(row.map((span) => span.text).join("")) - 1)), bg }]
      markGutter(filled, 1)
      return filled
    })
  } else if (mark) rows = rows.map((row, at) => [{ text: at ? " ".repeat(textWidth(mark)) : mark, fg: role }, ...row])
  if (kind === "underline" && level <= 2) {
    const rule: Line = [{ text: (level === 1 ? "═" : "─").repeat(Math.min(width, widest)), fg: roles.rule }]
    rows.push(base === "rtl" ? alignRight(rule, width) : rule)
  }
  return rows
}

/** `[!NOTE]` and its siblings, with the label the callout shows. */
export const CALLOUT_LABELS: Readonly<Record<Callout, string>> = { note: "NOTE", tip: "TIP", important: "IMPORTANT", warning: "WARNING", caution: "CAUTION" }
export const calloutRole = (kind: Callout, roles: Roles): ColorName => roles[kind]
