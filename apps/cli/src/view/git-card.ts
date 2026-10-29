import type { Line, Span } from "../ui/theme"
import { clampLine } from "./changes-page"
import { textWidth, wrap } from "./wrap"

/**
 * The rows the Git page's cards are made of (docs/git.md): the push, pull request, publish and initialize cards all quote a command, wrap
 * a sentence or give the output of a failed action the same way, so they share this and none draws its own.
 */

/** An argument list as one line a shell would read back as the same words. */
export const quoted = (argv: readonly string[]) => argv.map((word) => (/^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(" ")

export const text = (value: string, extra: Partial<Span> = {}): Span => ({ text: value, fg: "text", ...extra })
export const muted = (value: string): Span => ({ text: value, fg: "muted" })
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
export const wrapped = (value: string, width: number, extra: Partial<Span> = {}): Line[] => wrap(value, width).map((row): Line => [text(row, extra)])
export const mutedWrapped = (value: string, width: number): Line[] => wrap(value, width).map((row): Line => [muted(row)])

/** What a failed action printed, under its card: the explanations the card already gave make room for it. */
export const outputRows = (detail: readonly string[], width: number): Line[] => detail.map((row): Line => clampLine([text(row.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))], width))

/** The one action of a state, drawn like the active tab (the element background) with its key after it; a click on it does what the key does. */
export const actionChip = (label: string): Span => ({ text: ` ${label} `, fg: "text", bg: "element", bold: true })

/** Where `chip` was drawn in the rows of a page: the row and the screen columns of its cells. */
export function chipAt(rows: readonly Line[], chip: string): { row: number; from: number; to: number } | undefined {
  for (let row = 0; row < rows.length; row++) {
    let column = 0
    for (const span of rows[row]!) {
      const width = textWidth(span.text)
      if (span.text === chip && span.bg === "element") return { row, from: column, to: column + width }
      column += width
    }
  }
  return undefined
}
