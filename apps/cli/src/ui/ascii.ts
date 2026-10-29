import { cells } from "../view/wrap"
import type { Line, Span } from "./theme"

/**
 * The `glyphs: ascii` frame filter: every cell that is not printable ASCII becomes ASCII of the same width, so a layout measured
 * in Unicode lands in the same columns. Marks get a look-alike (box lines, arrows, checks, bullets), accented letters lose their
 * accent, a wide character becomes `??` and anything else `?`. Applied to the whole frame, it covers views that never heard of
 * the setting (an extension's rows, a tool's output).
 */
const MARKS: Readonly<Record<string, string>> = {
  "…": ".", "⋯": ".", "·": "-", "•": "*", "∙": "-", "⋅": "-", "‧": "-",
  "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
  "‘": "'", "’": "'", "‚": ",", "“": "\"", "”": "\"", "„": "\"", "′": "'", "″": "\"",
  "‹": "<", "›": ">", "«": "<", "»": ">", "❮": "<", "❯": ">", "❭": ">", "❬": "<", "⟨": "<", "⟩": ">",
  "←": "<", "→": ">", "↑": "^", "↓": "v", "↔": "-", "↕": "|", "↵": "<", "↩": "<", "↪": ">", "⇒": ">", "⇐": "<", "⇧": "^", "⇥": ">", "↳": ">", "↺": "@", "↻": "@",
  "✓": "+", "✔": "+", "✗": "x", "✘": "x", "×": "x", "✎": "~", "✲": "*", "✱": "*", "✦": "*", "✧": "*", "★": "*", "☆": "*", "⚠": "!", "⚙": "*", "⌕": "?", "⌘": "#", "⌥": "%", "⌃": "^", "⏎": "<",
  "●": "o", "○": "o", "◉": "o", "◎": "@", "◌": "o", "◍": "o", "◯": "O", "⦿": "o",
  "◆": "*", "◇": "+", "◈": "*", "♦": "*", "■": "#", "□": "#", "▪": "#", "▫": "#", "▤": "#", "▦": "#", "▧": "#", "▨": "#", "▩": "#",
  "▲": "^", "△": "^", "▴": "^", "▶": ">", "▸": ">", "►": ">", "▷": ">", "▼": "v", "▽": "v", "▾": "v", "◀": "<", "◂": "<", "◄": "<", "◁": "<",
  "≈": "~", "≥": ">", "≤": "<", "≠": "#", "±": "+", "°": "o", "µ": "u", "∞": "8", "⊕": "+", "⊗": "x", "∅": "0",
  "░": ".", "▒": ":", "▓": "#", "█": "#", "▀": "#", "▄": "#", "▌": "#", "▐": "#",
  "╱": "/", "╲": "\\", "╳": "x", " ": " ",
}

const HORIZONTAL = new Set([..."─━┄┅┈┉╌╍═╼╾╴╶╸╺"])
const VERTICAL = new Set([..."│┃┆┇┊┋╎╏║╽╿╵╷╹╻"])

function boxChar(code: number, char: string): string | undefined {
  if (code < 0x2500 || code > 0x257f) return undefined
  if (HORIZONTAL.has(char)) return "-"
  if (VERTICAL.has(char)) return "|"
  return MARKS[char] ?? "+"
}

function cellAscii(char: string, width: number): string {
  if (width <= 0) return ""
  const code = char.codePointAt(0)!
  if (char.length === 1 && code >= 0x20 && code < 0x7f) return char
  const mark = MARKS[char] ?? boxChar(code, char)
  if (mark !== undefined) return mark.padEnd(width).slice(0, width)
  if (code >= 0x2580 && code <= 0x259f) return "#".repeat(width)
  if (code >= 0x2800 && code <= 0x28ff) return code === 0x2800 ? " " : "*"
  if ((code >= 0xe000 && code <= 0xf8ff) || code >= 0xf0000) return "*".repeat(width)
  const plain = char.normalize("NFD").replace(/[̀-ͯ]/g, "")
  if (/^[\x20-\x7e]+$/.test(plain)) return plain.padEnd(width).slice(0, width)
  return "?".repeat(width)
}

const cache = new Map<string, string>()

/** `text` as printable ASCII, cell for cell. */
export function asciiText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const known = cache.get(text)
  if (known !== undefined) return known
  let out = ""
  for (const cell of cells(text)) out += cellAscii(cell.text, cell.width)
  if (cache.size > 4096) cache.clear()
  cache.set(text, out)
  return out
}

export function asciiLine(line: Line): Line {
  return line.some((span) => !/^[\x20-\x7e]*$/.test(span.text)) ? line.map((span): Span => ({ ...span, text: asciiText(span.text) })) : line
}
