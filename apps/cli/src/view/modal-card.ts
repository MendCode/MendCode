import type { ColorName, Line, Span } from "../ui/theme"
import { textWidth } from "./wrap"
import { clip } from "./deck"

/**
 * The card chrome of v1's command dialog, shared by the palette and extension modals (docs/extensions-tui.md, "Modals"): a centered
 * card on the panel fill, three columns of padding, the title row with `esc` on the right, and padding rows when the screen has room.
 */

/** v1's command dialog: `min(148, max(96, 72% of the width))`, never wider than the screen minus two columns. */
export const CARD_MIN = 96
export const CARD_MAX = 148
export const CARD_SHARE = 0.72
export const CARD_PADDING = 3
/** Below this many screen rows the card drops its padding rows. */
export const AIRY_HEIGHT = 24
const CARD: ColorName = "panel"

export type CardOverlay = { rows: Line[]; top: number; left: number; title?: string }

export const spansWidth = (spans: readonly Span[]) => spans.reduce((sum, span) => sum + textWidth(span.text), 0)

export function padTo(spans: Span[], width: number): Span[] {
  const used = spansWidth(spans)
  return used < width ? [...spans, { text: " ".repeat(width - used) }] : spans
}

/** The card's row builders for a card `cardWidth` wide: every row is exactly that wide, on the panel fill. */
export function cardChrome(cardWidth: number) {
  const inner = cardWidth - CARD_PADDING * 2
  const painted = (spans: Span[]): Span[] => spans.map((span) => ({ ...span, bg: span.bg ?? CARD }))
  const gutter = (text: string): Span => ({ text })
  const line = (spans: Span[]): Line => painted([gutter(" ".repeat(CARD_PADDING)), ...padTo(spans, inner), gutter(" ".repeat(CARD_PADDING))])
  const blank = (): Line => painted([gutter(" ".repeat(cardWidth))])
  const gapped = (left: Span[], right: Span[]): Span[] => [...left, gutter(" ".repeat(Math.max(1, inner - spansWidth(left) - spansWidth(right)))), ...right]
  const title = (text: string): Line => line(gapped(clip([{ text, fg: "text", bold: true }], Math.max(1, inner - 4)), [{ text: "esc", fg: "muted" }]))
  return { inner, painted, gutter, line, blank, gapped, title }
}

/** Where a card of `rows` rows and `cardWidth` columns sits: a third of the way down, centered. */
export function cardPlace(rows: number, cardWidth: number, width: number, height: number) {
  return { top: Math.max(0, Math.min(Math.floor((height - rows) / 3), height - rows)), left: Math.floor((width - cardWidth) / 2) }
}

/** The card width for a terminal `width` wide: `requested` columns (above 1) or a share of the terminal (0 to 1), else v1's dialog rule. */
export function cardWidthFor(width: number, requested?: number) {
  const wanted = requested === undefined || !Number.isFinite(requested) || requested <= 0
    ? Math.min(CARD_MAX, Math.max(CARD_MIN, Math.floor(width * CARD_SHARE)))
    : requested <= 1 ? Math.floor(width * requested) : Math.floor(requested)
  return Math.max(0, Math.min(width - 2, wanted))
}

/** The smallest card a modal is drawn in; on a smaller terminal there is no room for one. */
const MIN_CARD = 16
/** Rows the modal's chrome takes: the title, and on a tall screen a padding row above it, one under it and one at the bottom. */
const chromeRows = (airy: boolean) => (airy ? 4 : 1)

/** The body area a modal gets on this terminal: `width` cells and `height` rows inside the card; undefined when no card fits. */
export function modalLayout(input: { width: number; height: number; requested?: number }) {
  const cardWidth = cardWidthFor(input.width, input.requested)
  const airy = input.height >= AIRY_HEIGHT
  // A row of the screen stays free above and below the card.
  const room = input.height - chromeRows(airy) - 2
  if (cardWidth < MIN_CARD || room < 1) return undefined
  return { cardWidth, inner: cardWidth - CARD_PADDING * 2, room, airy }
}

/** An extension modal drawn with the palette's chrome; `body` is already fitted to the layout's `inner` width and `room` rows. */
export function modalCard(input: { title: string; body: Line[]; layout: NonNullable<ReturnType<typeof modalLayout>>; width: number; height: number }): CardOverlay {
  const { layout, width, height } = input
  const chrome = cardChrome(layout.cardWidth)
  const rows: Line[] = [
    ...(layout.airy ? [chrome.blank()] : []),
    chrome.title(input.title),
    ...(layout.airy ? [chrome.blank()] : []),
    ...input.body.slice(0, layout.room).map((row) => chrome.line(clip(row, layout.inner))),
    ...(layout.airy ? [chrome.blank()] : []),
  ]
  return { rows, title: input.title, ...cardPlace(rows.length, layout.cardWidth, width, height) }
}
