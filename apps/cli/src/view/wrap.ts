import type { Span } from "../ui/theme"

/** Cell width of a styled row, measured per span just as the terminal draws it. */
export const lineWidth = (line: readonly Span[]) => line.reduce((sum, span) => sum + textWidth(span.text), 0)

/** A prefix or suffix of already measured cells, without splitting a grapheme. */
export function takeCellSlice(all: { text: string; width: number }[], budget: number, fromEnd = false) {
  const out: string[] = []
  let used = 0
  const ordered = fromEnd ? [...all].reverse() : all
  for (const cell of ordered) {
    if (used + cell.width > budget) break
    used += cell.width
    out.push(cell.text)
  }
  return (fromEnd ? out.reverse() : out).join("")
}

/** Truncates at the end with an ellipsis so the result is at most `width` cells. */
export function truncateEnd(text: string, width: number) {
  if (width <= 0) return ""
  if (textWidth(text) <= width) return text
  return takeCellSlice([...cells(text)], width - 1) + "…"
}

/** Shortens in the middle with an ellipsis, favouring the tail of a path. */
export function shortenMiddle(text: string, width: number) {
  if (width <= 0) return ""
  if (textWidth(text) <= width) return text
  if (width === 1) return "…"
  const chars = [...cells(text)]
  const budget = width - 1
  const head = Math.floor(budget / 3)
  return takeCellSlice(chars, head) + "…" + takeCellSlice(chars, budget - head, true)
}

/** Escape sequences (CSI, OSC, two-byte ESC) that tool output and model text may carry; they are never drawn. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g
/** Control characters other than tab and newline (\r, bell, backspace, C1…): drawing them moves the cursor. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/
/**
 * Text where every UTF-16 unit is its own grapheme: no surrogates (astral emoji), combining marks, joiners,
 * variation selectors, controls or tabs. Box drawing, bullets, accented letters and CJK all qualify, and
 * skip the (slow) grapheme segmenter.
 */
const SIMPLE_BMP = /^[^\x00-\x1f\x7f-\x9f\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0900-\u0903\u093a-\u094f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\ud800-\udfff]*$/
const TAB = "    "
const segmenter = new Intl.Segmenter()

/**
 * What the terminal will draw for `text`, one grapheme at a time with its cell width: escape sequences
 * and control characters are dropped, a tab becomes four spaces, and widths come from Bun.stringWidth
 * (emoji presentation, skin tones, ZWJ sequences, CJK). Every measure-and-cut path uses this, and the
 * screen writes exactly these graphemes, so the layout and the terminal never disagree.
 */
export function* cells(text: string): Generator<{ text: string; width: number }> {
  const clean = text.includes("\x1b") ? text.replace(ANSI, "") : text
  if (PRINTABLE_ASCII.test(clean)) {
    for (const char of clean) yield { text: char, width: 1 }
    return
  }
  if (SIMPLE_BMP.test(clean)) {
    const allNarrow = Bun.stringWidth(clean) === clean.length
    for (const char of clean) yield { text: char, width: allNarrow ? 1 : Bun.stringWidth(char) }
    return
  }
  for (const { segment } of segmenter.segment(clean)) {
    if (segment === "\t") yield { text: TAB, width: TAB.length }
    else if (segment === "\n") yield { text: segment, width: 0 }
    else if (!CONTROL.test(segment)) yield { text: segment, width: Bun.stringWidth(segment) }
  }
}

/**
 * The longest prefix of `text` that fits in `room` cells, as the terminal draws it (`\n` dropped), with its width. Same
 * result as walking `cells(text)` until one does not fit, but ASCII and narrow BMP text, nearly every row of a frame,
 * is cut without allocating an object per cell: the screen runs this over every row of every frame.
 */
export function takeCells(text: string, room: number): { text: string; width: number } {
  if (PRINTABLE_ASCII.test(text) || (SIMPLE_BMP.test(text) && Bun.stringWidth(text) === text.length)) {
    const width = Math.max(0, Math.min(text.length, room))
    return { text: width === text.length ? text : text.slice(0, width), width }
  }
  let out = ""
  let width = 0
  for (const cell of cells(text)) {
    if (cell.text === "\n") continue
    if (width + cell.width > room) break
    out += cell.text
    width += cell.width
  }
  return { text: out, width }
}

/** `text` as the terminal will draw it (see `cells`). */
export function terminalText(text: string) {
  if (PRINTABLE_ASCII.test(text)) return text
  let out = ""
  for (const cell of cells(text)) out += cell.text
  return out
}

export function textWidth(text: string) {
  if (PRINTABLE_ASCII.test(text)) return text.length
  if (SIMPLE_BMP.test(text)) return Bun.stringWidth(text)
  let width = 0
  for (const cell of cells(text)) width += cell.width
  return width
}

/** Wraps on spaces when possible, hard-breaks words longer than the width. Never returns an empty array. */
export function wrap(text: string, width: number): string[] {
  if (width < 1) throw new RangeError(`[VIEW]: wrap width must be >= 1, got ${width}`)
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    let line = ""
    let lineWidth = 0
    for (const word of raw.split(" ")) {
      let rest = word
      let restWidth = textWidth(rest)
      const gap = line ? 1 : 0
      if (lineWidth + gap + restWidth <= width) {
        line = line ? `${line} ${rest}` : rest
        lineWidth += gap + restWidth
        continue
      }
      if (line) {
        lines.push(line)
        line = ""
        lineWidth = 0
      }
      while (restWidth > width) {
        let cut = ""
        let cutWidth = 0
        let taken = 0
        for (const cell of cells(rest)) {
          if (cutWidth + cell.width > width) break
          cut += cell.text
          cutWidth += cell.width
          taken++
        }
        lines.push(cut)
        rest = [...cells(rest)].slice(taken).map((cell) => cell.text).join("")
        restWidth = textWidth(rest)
      }
      line = rest
      lineWidth = restWidth
    }
    lines.push(line)
  }
  return lines
}
