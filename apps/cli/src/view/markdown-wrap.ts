import type { Line, Span } from "../ui/theme"
import { cells, textWidth } from "./wrap"
import { markGutter, markSoftWrapped } from "./line-meta"

/** Forced line break inside a span (`<br>`); wrapSpans starts a new line at it and never draws it. */
export const BREAK = String.fromCharCode(0x2028)
const BREAK_OR_SPACE = new RegExp(`(${BREAK}|[^\\S${BREAK}]+)`)

/** Splits spans into words (runs of non-space fragments, possibly of several styles) and spaces. */
function toWords(spans: Span[]): (Span[] | Span)[] {
  const tokens: (Span[] | Span)[] = []
  let word: Span[] = []
  for (const span of spans) {
    for (const part of span.text.split(BREAK_OR_SPACE)) {
      if (!part) continue
      if (part === BREAK) {
        if (word.length) tokens.push(word)
        word = []
        tokens.push({ ...span, text: BREAK })
      } else if (/^\s+$/.test(part)) {
        if (word.length) tokens.push(word)
        word = []
        tokens.push({ ...span, text: " " })
      } else word.push({ ...span, text: part })
    }
  }
  if (word.length) tokens.push(word)
  return tokens
}

/** Word-wraps styled spans to `width` cells, with optional first-line and continuation prefixes. Words never split at style boundaries. */
export function wrapSpans(spans: Span[], width: number, first: Span[] = [], rest: Span[] = first.map((s) => ({ text: " ".repeat(textWidth(s.text)) }))): Line[] {
  const lines: Line[] = []
  let line: Line = [...first]
  let used = first.reduce((n, s) => n + textWidth(s.text), 0)
  const restWidth = rest.reduce((n, s) => n + textWidth(s.text), 0)
  /** For each row after the first: how a wrap, not a forced break, joined it to the one before. */
  const joins: Array<"space" | "none" | undefined> = [undefined]
  const newLine = (join?: "space" | "none") => {
    lines.push(line)
    joins.push(join)
    line = [...rest]
    used = restWidth
  }
  for (const token of toWords(spans)) {
    if (!Array.isArray(token)) {
      if (token.text === BREAK) {
        newLine()
        continue
      }
      if (used > restWidth && used + 1 <= width) {
        line.push(token)
        used += 1
      }
      continue
    }
    const w = token.reduce((n, s) => n + textWidth(s.text), 0)
    if (used + w > width && used > restWidth) newLine("space")
    if (used + w <= width) {
      line.push(...token)
      used += w
      continue
    }
    for (const fragment of token) {
      let buffer = ""
      for (const { text: char, width: cw } of cells(fragment.text)) {
        if (used + cw > width && used > restWidth) {
          if (buffer) line.push({ ...fragment, text: buffer })
          buffer = ""
          newLine("none")
        }
        buffer += char
        used += cw
      }
      if (buffer) line.push({ ...fragment, text: buffer })
    }
  }
  lines.push(line)
  const trimmed = lines.map(trimTrailingSpace)
  const alignment = rest.every((s) => /^\s*$/.test(s.text))
  trimmed.forEach((row, i) => {
    const join = joins[i]
    if (!join) return
    markSoftWrapped(row, join)
    if (alignment) markGutter(row, restWidth)
  })
  return trimmed
}

function trimTrailingSpace(line: Line): Line {
  const copy = [...line]
  while (copy.length && /^\s*$/.test(copy[copy.length - 1]!.text) && copy.length > 1) copy.pop()
  return copy
}

/** `text` cut to `width` cells with a closing `…`. */
export function clip(text: string, width: number) {
  if (textWidth(text) <= width) return text
  let out = ""
  let used = 0
  for (const { text: char, width: w } of cells(text)) {
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return `${out}…`
}

export const plainText = (spans: Span[]) => spans.map((s) => s.text).join("")
