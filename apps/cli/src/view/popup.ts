import type { Line, Span } from "../ui/theme"
import { lineWidth, onColor } from "./panel-box"
import { PROMPT_MARGIN } from "./prompt-chrome"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/** v1's autocomplete shows up to ten rows. */
export const POPUP_ROWS = 10

export type PopupItem = { label: string; note?: string; suffix?: string }

/** Index of the first row shown: the window follows the selection. */
export function popupWindowStart(count: number, selected: number, rows = POPUP_ROWS) {
  return Math.max(0, Math.min(selected - rows + 1, count - rows))
}

/**
 * v1's autocomplete box (`prompt/autocomplete.tsx`): a `┃` border on the menu fill, the selected row
 * filled with the primary color across the whole width, the label padded to the longest one plus two,
 * the note muted. `first` is the index of the first row drawn, for click hit-testing.
 */
export function renderPopup(input: { items: readonly PopupItem[]; width: number; selected: number; maxRows?: number }): { rows: Line[]; first: number } {
  const { items, width } = input
  const rows = Math.max(1, Math.min(POPUP_ROWS, input.maxRows ?? POPUP_ROWS))
  const first = popupWindowStart(items.length, input.selected, rows)
  const inner = Math.max(4, width - PROMPT_MARGIN * 2 - 1)
  const column = Math.min(Math.floor(inner / 2), Math.max(...items.map((item) => textWidth(item.label)), 0) + 2)
  const lines = items.slice(first, first + rows).map((item, offset): Line => {
    const on = first + offset === input.selected
    const label = truncateEnd(item.label, inner - 2)
    const spans: Span[] = [{ text: ` ${label}${" ".repeat(Math.max(0, column - textWidth(label)))}` }]
    const noteRoom = inner - lineWidth(spans) - 1
    if (item.note && noteRoom > 3) spans.push({ text: truncateEnd(item.note, noteRoom), ...(on ? {} : { fg: "muted" as const }) })
    const suffix = item.suffix ? ` ${item.suffix}` : ""
    if (suffix && inner - lineWidth(spans) > suffix.length + 1) spans.push({ text: suffix, ...(on ? {} : { fg: "muted" as const, dim: true }) })
    const body: Span[] = spans.map((span) => (on ? { ...span, ...onColor("primary"), bold: true } : { fg: "text", ...span, bg: "element" }))
    const pad = Math.max(0, inner - lineWidth(spans))
    return [{ text: " ".repeat(PROMPT_MARGIN) }, { text: "┃", fg: "border", bg: "element" }, ...body, { text: " ".repeat(pad), ...(on ? onColor("primary") : { bg: "element" as const }) }]
  })
  return { rows: lines, first }
}
