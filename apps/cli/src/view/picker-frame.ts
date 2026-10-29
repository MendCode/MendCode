import type { Line } from "../ui/theme"
import { fit, spread } from "./deck"
import { textWidth, truncateEnd } from "./wrap"

/** Operate pages keep keys in the header and give the panel grid the remaining rows. */
export function pickerFrame(title: string, hints: string, width: number, height: number, body: Line[], summary = ""): Line[] {
  const room = Math.max(0, width - textWidth(title) - 2)
  const parts = hints.split(/\s+·\s+/)
  const close = parts.pop() ?? ""
  let keys = close
  for (const part of parts) {
    const next = keys === close ? `${part} · ${close}` : `${keys.slice(0, -close.length - 3)} · ${part} · ${close}`
    if (textWidth(next) <= room) keys = next
  }
  const head = spread([{ text: title, fg: "primary", bold: true }], [{ text: keys, fg: "muted" }], width)
  const rows: Line[] = [head, ...(summary ? [[{ text: summaryFor(summary, width), fg: "muted" }]] as Line[] : [[]]), ...body]
  return Array.from({ length: Math.max(0, height) }, (_, i) => fit(rows[i] ?? [], width))
}

/** A summary too wide for its row keeps the whole sentences that fit, or else the words that fit and an ellipsis: never half a word. */
export function summaryFor(summary: string, width: number): string {
  if (textWidth(summary) <= width) return summary
  const sentences = summary.split(/(?<=\.)\s+/)
  for (let count = sentences.length - 1; count > 0; count--) {
    const kept = sentences.slice(0, count).join(" ")
    if (textWidth(kept) <= width) return kept
  }
  let kept = ""
  for (const word of summary.split(/\s+/)) {
    const next = kept ? `${kept} ${word}` : word
    if (textWidth(next) > width - 1) break
    kept = next
  }
  return kept ? `${kept}…` : truncateEnd(summary, width)
}
