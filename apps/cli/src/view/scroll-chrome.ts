import type { Glyphs, Line, Span } from "../ui/theme"
import { fit } from "./deck"
import { cells, textWidth } from "./wrap"
import { PROMPT_MARGIN } from "./prompt-chrome"

/**
 * What the transcript draws about its own scrolling: a one-cell scrollbar in a column kept free at its right edge, and the
 * "jump to latest" button. Pure geometry and spans; the app owns the state (docs/customize.md, "Scrolling").
 */

/** How long the `auto` scrollbar stays after the last wheel, key or drag, in milliseconds. */
export const SCROLLBAR_LINGER_MS = 1200

export type ScrollbarMode = "auto" | "always" | "off"

/** The thumb inside a track of `rows` cells: where it starts and how long it is. */
export type Thumb = { top: number; length: number }

/** The thumb for a transcript of `total` rows seen through `viewport` rows, `offset` rows above the bottom; undefined when everything fits. */
export function scrollThumb({ rows, total, viewport, offset }: { rows: number; total: number; viewport: number; offset: number }): Thumb | undefined {
  if (rows < 1 || total <= viewport) return undefined
  const length = Math.max(1, Math.min(rows, Math.round(rows * viewport / total)))
  const max = total - viewport
  const top = Math.round((1 - Math.min(1, Math.max(0, offset / max))) * (rows - length))
  return { top, length }
}

/** The offset (rows above the bottom) that puts the thumb's first cell at `top` of the track: the inverse of `scrollThumb`. */
export function offsetForThumb({ rows, total, viewport, top }: { rows: number; total: number; viewport: number; top: number }): number {
  const length = Math.max(1, Math.min(rows, Math.round(rows * viewport / total)))
  const room = rows - length
  const max = Math.max(0, total - viewport)
  return room <= 0 ? 0 : Math.round((1 - Math.min(1, Math.max(0, top / room))) * max)
}

/** Whether the bar is drawn: always, or in `auto` while the view is off the bottom or was just scrolled. */
export function scrollbarShown({ mode, offset, lingering }: { mode: ScrollbarMode; offset: number; lingering: boolean }): boolean {
  return mode === "always" || (mode === "auto" && (offset > 0 || lingering))
}

/** The glyphs: the profile's (thumb, then an optional track) or the glyph set's. A missing track means none is drawn. */
export function scrollbarGlyphs(custom: string, g: Glyphs): { thumb: string; track: string | undefined } {
  const own = [...cells(custom)].map((cell) => cell.text)
  return own.length ? { thumb: own[0]!, track: own[1] } : { thumb: g.thumb, track: g.track }
}

/** `rows` with a column added at the right: each row cut to `width - 1` cells (the layout already left them free) and the bar's cell, or a blank while the bar is hidden. */
export function withScrollbar({ rows, width, thumb, glyphs, shown }: { rows: Line[]; width: number; thumb: Thumb | undefined; glyphs: { thumb: string; track: string | undefined }; shown: boolean }): Line[] {
  return rows.map((row, index): Line => {
    const body = fit(row, width - 1)
    if (!shown || !thumb) return [...body, { text: " " }]
    const inThumb = index >= thumb.top && index < thumb.top + thumb.length
    // Bold keeps the thumb apart from the track in the two themes whose primary and border are the same orange.
    const cell: Span = inThumb ? { text: glyphs.thumb, fg: "primary", bold: true } : glyphs.track ? { text: glyphs.track, fg: "border" } : { text: " " }
    return [...body, cell]
  })
}

export type JumpPosition = "right" | "center" | "left"

/** The button's text: the profile's template (`{n}` rows that arrived below, `{key}` the key while it works) or the default. */
export function jumpText({ template, unseen, keyHint, g }: { template: string; unseen: number; keyHint: boolean; g: Glyphs }): string {
  const key = keyHint ? "End" : ""
  if (template) return template.replace(/\{n\}/g, String(unseen)).replace(/\{key\}/g, key).replace(/\s+/g, " ").trim()
  return `${g.below} ${unseen > 0 ? `${unseen} new` : "latest"}${key ? ` ${g.sep} ${key}` : ""}`
}

/** The first `width` cells of `line` and what follows them; the cut falls on a cell boundary. */
function splitAt(line: Line, width: number): [Line, Line] {
  const head: Line = []
  const tail: Line = []
  let used = 0
  for (const span of line) {
    let before = ""
    let after = ""
    for (const cell of cells(span.text)) {
      if (used + cell.width <= width) before += cell.text
      else after += cell.text
      used += cell.width
    }
    if (before) head.push({ ...span, text: before })
    if (after) tail.push({ ...span, text: after })
  }
  return [head, tail]
}

/**
 * `label` laid over `line` (a row `width` cells wide) with its first cell at `from`, in a pill; the text underneath that it covers is
 * dropped, the rest stays. Undefined when the label does not fit between the margins.
 */
export function overlayAt({ line, width, from, label }: { line: Line; width: number; from: number; label: Line }): Line | undefined {
  const labelWidth = label.reduce((sum, span) => sum + textWidth(span.text), 0)
  if (from < 0 || from + labelWidth > width) return undefined
  const [head, rest] = splitAt(fit(line, width), from)
  const [, tail] = splitAt(rest, labelWidth)
  // A wide glyph cut in half at either edge leaves the row a cell off: pad or clip it back to `width`.
  return fit([...fit(head, from), ...label, ...tail], width)
}

/** The jump button as a pill: an arrow in the accent colour, the text on a panel fill. */
export function jumpPill(text: string, g: Glyphs): Line {
  const arrow = text.startsWith(g.below) ? g.below : ""
  const rest = arrow ? text.slice(arrow.length) : text
  return [
    ...(arrow ? [{ text: ` ${arrow}`, fg: "primary", bg: "panel", bold: true } as Span] : [{ text: " ", bg: "panel" } as Span]),
    { text: `${rest} `, fg: "text", bg: "panel", bold: true },
  ]
}

/** Where the pill starts on a row `width` cells wide, inside the prompt margin; the right edge keeps the margin the old label had. */
export function jumpFrom({ position, width, labelWidth, gutter }: { position: JumpPosition; width: number; labelWidth: number; gutter: number }): number {
  if (position === "left") return PROMPT_MARGIN
  if (position === "center") return Math.max(PROMPT_MARGIN, Math.floor((width - gutter - labelWidth) / 2))
  return width - gutter - PROMPT_MARGIN - labelWidth
}
