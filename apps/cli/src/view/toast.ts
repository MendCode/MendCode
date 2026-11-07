import { glyphs as currentGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { truncateEnd, textWidth } from "./wrap"

/**
 * The one notice of the app (docs/commands.md#notices): one at a time, always one row with the same shape, in the chat on the notice
 * row above the prompt and on a page in its top right corner. A coloured severity mark, an optional bold title, the message
 * and a muted hint; what does not fit, or the `detail` behind it, is one key away (`F4 details`).
 */
export type ToastVariant = "info" | "success" | "warning" | "error"
/**
 * `hint` is what to do next (`/memory undo`): muted after the message, and kept whole when the row has to cut the message.
 * `detail` is the full text behind F4 when the message is a short summary of it. `oneLine` is kept for callers; every notice is one row.
 */
export type Toast = { variant: ToastVariant; title?: string; message: string; hint?: string; detail?: string; oneLine?: boolean }

const VARIANT_COLOR: Record<ToastVariant, ColorName> = { info: "info", success: "success", warning: "warning", error: "error" }
/** The widest a notice gets on a page, where it covers the page's own text. */
const PAGE_MAX_WIDTH = 100
/** The key that opens the full text of the latest notice, as the notice names it. */
export const DETAILS_HINT = "F4 details"

/**
 * How long a notice stays: info and success go by themselves, a warning stays longer, an error stays until the next prompt
 * or command, a newer notice, or F4 (`undefined`: no timer). A caller may ask a different time for info, success and warnings.
 */
export const TOAST_MS: Readonly<Record<ToastVariant, number | undefined>> = { info: 5_000, success: 5_000, warning: 8_000, error: undefined }
/** How long an info notice stays when the caller does not say. */
export const DEFAULT_TOAST_MS = TOAST_MS.info!

/** The severity mark: a glyph as well as a colour, so the kind reads without colour too. */
export function toastMark(variant: ToastVariant, glyphs: Glyphs = currentGlyphs()): string {
  return variant === "success" ? glyphs.ok : variant === "error" ? glyphs.fail : variant === "warning" ? "!" : glyphs.running
}

/** The message as one line: its lines joined, runs of space folded. */
const flat = (text: string) => text.trim().split(/\s*\n\s*/).filter(Boolean).join(" · ").replace(/\s+/g, " ")

/** Whether the notice's title and message do not fit one row of `width` with `margin` cells each side, its hint kept whole. */
export function toastCut(toast: Toast, width: number, margin = 2): boolean {
  const hint = toast.hint?.trim() ? ` · ${flat(toast.hint)}` : ""
  return toast.message.trim().includes("\n") || textWidth(rowText(toast)) > Math.max(1, width - margin * 2 - 2 - textWidth(hint))
}

const rowText = (toast: Toast) => [toast.title?.trim() ? flat(toast.title) : "", flat(toast.message)].filter(Boolean).join(" · ")

/** The notice's row: `margin` blank cells, the mark, the title and message cut to fit, then the hint, muted and whole. */
export function renderToastRow(toast: Toast, width: number, margin: number, glyphs: Glyphs = currentGlyphs()): Line {
  const color = VARIANT_COLOR[toast.variant]
  const room = Math.max(1, width - margin * 2 - 2)
  const hint = toast.hint?.trim() ? ` · ${flat(toast.hint)}` : ""
  const space = Math.max(1, room - textWidth(hint))
  const title = toast.title?.trim() ? flat(toast.title) : ""
  const message = flat(toast.message)
  const spans: Line = [{ text: " ".repeat(margin) }, { text: `${toastMark(toast.variant, glyphs)} `, fg: color, bold: true }]
  if (title && textWidth(title) + 3 < space) {
    spans.push({ text: title, fg: color, bold: true })
    if (message) spans.push({ text: ` · ${truncateEnd(message, Math.max(1, space - textWidth(title) - 3))}`, fg: "text" })
  } else spans.push({ text: truncateEnd(title ? `${title} · ${message}` : message, space), ...(title ? { fg: color, bold: true } : { fg: "text" as const }) })
  if (hint) spans.push({ text: hint, fg: "muted" })
  return spans
}

/**
 * The notice on a page: the same row on the panel fill with one cell of padding each side, as wide as its text needs and at
 * most PAGE_MAX_WIDTH or the screen less 4 cells. A screen too narrow for a mark and a word shows nothing.
 */
export function renderToast(toast: Toast, screenWidth: number, glyphs: Glyphs = currentGlyphs()): Line[] {
  const most = Math.min(PAGE_MAX_WIDTH, screenWidth - 4)
  if (most < 12) return []
  const hint = toast.hint?.trim() ? ` · ${flat(toast.hint)}` : ""
  const width = Math.min(most, textWidth(rowText(toast)) + textWidth(hint) + 4)
  const row = renderToastRow(toast, width, 1, glyphs)
  const used = row.reduce((sum, span) => sum + textWidth(span.text), 0)
  return [[...row, { text: " ".repeat(Math.max(0, width - used)) }].map((span) => ({ ...span, bg: "panel" as const }))]
}

/** Where a notice goes on a page: its row and first column for a screen `width` wide (row 2, 2 cells from the right). */
export function toastPosition(toastWidth: number, screenWidth: number): { row: number; col: number } {
  return { row: 2, col: Math.max(0, screenWidth - 2 - toastWidth) }
}
