import { COLOR_NAMES } from "../themes/define"
import type { ColorName, Line, Span } from "../ui/theme"

/** What a terminal extension may hand back to be drawn: reduced to printable cells and theme spans. Shared by slots and views. */

/** A whole terminal escape sequence: CSI (colors, cursor moves), OSC (titles, links) or a two-character escape. */
const ESCAPE_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g

/** Text is one row of printable cells: escape sequences and other controls are dropped, newlines and tabs become spaces. */
export function clean(text: unknown): string {
  return String(text ?? "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => (char === "\t" || char === "\n" ? " " : ""))
}

const ROLES: ReadonlySet<string> = new Set(COLOR_NAMES)
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** One extension span as a theme span: roles the theme knows stay roles, `#rrggbb` becomes a hex color, anything else is `text`. */
export function themeSpan(raw: unknown): Span | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const span: Span = { text: clean(source.text) }
  if (typeof source.fg === "string") {
    if (HEX.test(source.fg)) span.fgHex = source.fg
    else span.fg = ROLES.has(source.fg) ? (source.fg as ColorName) : "text"
  }
  if (typeof source.bg === "string") {
    if (HEX.test(source.bg)) span.bgHex = source.bg
    else if (ROLES.has(source.bg)) span.bg = source.bg as ColorName
  }
  if (source.bold === true) span.bold = true
  if (source.dim === true) span.dim = true
  if (source.italic === true) span.italic = true
  if (source.underline === true) span.underline = true
  return span
}

/** The lines a renderer returned as theme lines; anything but an array of arrays is a bug in the extension. */
export function themeLines(result: unknown, cap: number): Line[] {
  if (!Array.isArray(result)) throw new TypeError(`expected Line[] or undefined, got ${typeof result}`)
  return result.slice(0, cap).map((line) => {
    if (!Array.isArray(line)) throw new TypeError("a line must be an array of spans")
    return line.flatMap((raw): Span[] => {
      const span = themeSpan(raw)
      return span ? [span] : []
    })
  })
}
