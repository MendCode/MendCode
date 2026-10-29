import type { ColorName, Line } from "../ui/theme"
import { slice } from "./overlay"
import { lineWidth, truncateEnd, wrap, textWidth } from "./wrap"

/**
 * v1's toast (ui/toast.tsx): one at a time, top-right, at most min(60, width − 6) wide, on the panel fill, with
 * a `┃` on both sides in the variant's color, an optional bold title and the wrapped message.
 */
export type ToastVariant = "info" | "success" | "warning" | "error"
/** `hint` is what to do next (`/memory undo`): muted under the message, and kept whole when the one-line form has to cut the message. */
export type Toast = { variant: ToastVariant; title?: string; message: string; hint?: string; oneLine?: boolean }

const VARIANT_COLOR: Record<ToastVariant, ColorName> = { info: "info", success: "success", warning: "warning", error: "error" }
const MAX_WIDTH = 60
const MAX_MESSAGE_ROWS = 6
/** How long a toast stays when the caller does not say (v1 callers use 4–8 s). */
export const DEFAULT_TOAST_MS = 5_000

/** The toast's rows, each exactly the same width; the caller places them at row 2, right-aligned with 2 cells of margin. */
export function renderToast(toast: Toast, screenWidth: number): Line[] {
  const outer = Math.min(MAX_WIDTH, screenWidth - 6)
  if (outer < 12) return []
  const inner = outer - 6 // "┃" + 2 padding on each side
  const border: ColorName = VARIANT_COLOR[toast.variant]
  const row = (text: string, bold = false): Line => [
    { text: "┃", fg: border, bg: "panel" },
    { text: `  ${text}${" ".repeat(Math.max(0, inner - textWidth(text)))}  `, fg: "text", bg: "panel", ...(bold ? { bold: true } : {}) },
    { text: "┃", fg: border, bg: "panel" },
  ]
  const blank = row("")
  const lines: Line[] = [blank]
  if (toast.title?.trim()) {
    for (const part of wrap(toast.title.trim(), inner).slice(0, 2)) lines.push(row(part, true))
    lines.push(blank)
  }
  const message = wrap(toast.message.trim(), inner)
  const shown = message.slice(0, MAX_MESSAGE_ROWS)
  if (message.length > MAX_MESSAGE_ROWS) shown[MAX_MESSAGE_ROWS - 1] = `${shown[MAX_MESSAGE_ROWS - 1]!.slice(0, Math.max(0, inner - 1))}…`
  for (const part of shown) lines.push(row(part))
  if (toast.hint?.trim()) {
    const hint = row(toast.hint.trim().slice(0, inner))
    lines.push(hint.map((span, index) => index === 1 ? { ...span, fg: "muted" as const } : span))
  }
  lines.push(blank)
  return lines
}

/** The toast as one row in the variant's color, for the inline live region where a floating box has no room. */
export function renderToastRow(toast: Toast, width: number, margin: number): Line {
  const room = Math.max(1, width - margin * 2)
  const hint = toast.hint?.trim() ? ` · ${toast.hint.trim()}` : ""
  const text = [toast.title?.trim(), toast.message.trim()].filter(Boolean).join(" · ").replace(/\s+/g, " ")
  const space = Math.max(1, room - textWidth(hint))
  const shown = textWidth(text) > space ? `${truncateEnd(text, space)}` : text
  return [{ text: " ".repeat(margin) }, { text: shown, fg: VARIANT_COLOR[toast.variant] }, ...(hint ? [{ text: hint, fg: "muted" as const }] : [])]
}

/**
 * Whether a toast needs the floating box: only a message that does not fit one row (an error with detail, several lines).
 * Everything short is one row, and `oneLine` (a memory notice) is always one row, cut to fit.
 */
export function toastBoxed(toast: Toast, width: number, margin = 2): boolean {
  if (toast.oneLine) return false
  const text = [toast.title?.trim(), toast.message.trim(), toast.hint?.trim()].filter(Boolean).join(" · ")
  return text.includes("\n") || textWidth(text) > Math.max(1, width - margin * 2)
}

/** Whether cells [from, to) of a row are empty: no text and no fill (a tinted message row is not empty). */
function clear(line: Line, from: number, to: number) {
  return slice(line, from, to).every((span) => !span.text.trim() && span.bg === undefined)
}

/**
 * The first place in the chat body, top-right and below the top bar and the pinned prompt, where a toast of `box` rows covers
 * nothing: every cell under it, and one cell around it, is empty. `top` and `bottom` bound the transcript rows in `rows`. No such
 * place (a full transcript) is `undefined`, and the toast goes on the one-line notice row instead of over the text.
 */
export function toastSpot(input: { rows: readonly Line[]; top: number; bottom: number; box: readonly Line[]; width: number }): { row: number; col: number } | undefined {
  const { rows, top, bottom, box, width } = input
  if (!box.length) return undefined
  const col = toastPosition(lineWidth(box[0]!), width).col
  const from = Math.max(0, col - 1)
  const to = Math.min(width, col + lineWidth(box[0]!) + 1)
  for (let row = top; row + box.length <= bottom; row++) {
    if (rows.slice(row, row + box.length).every((line) => clear(line, from, to))) return { row, col }
  }
  return undefined
}

/** Where a toast goes on a page without a transcript: its first row and first column for a screen `width` wide (top 2, right 2, like v1). */
export function toastPosition(toastWidth: number, screenWidth: number): { row: number; col: number } {
  return { row: 2, col: Math.max(0, screenWidth - 2 - toastWidth) }
}
