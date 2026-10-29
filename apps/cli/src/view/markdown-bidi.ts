import type { Line, Span } from "../ui/theme"
import { cells, textWidth } from "./wrap"
import { markGutter } from "./line-meta"

/**
 * Right-to-left text for the terminal, which draws cells left to right and does no bidi of its own. A small version of the
 * Unicode bidirectional algorithm (UAX #9), applied per drawn row after wrapping: strong types (R, AL, L), numbers with
 * their separators (EN, AN), neutral resolution (N1/N2), embedding levels 0 and 1 with numbers at level 2, the reversal
 * of runs (L2) and bracket mirroring (L4). Not implemented: explicit embeddings and isolates (LRE, RLI…), bracket pairing
 * (UAX #9 rule N0), Arabic contextual shaping and ligatures (the terminal's font does that, or nothing does) and
 * combining-mark reordering beyond keeping a mark with its base. Documented in docs/design/markdown-parity.md.
 */

type Kind = "L" | "R" | "AL" | "EN" | "AN" | "CS" | "ET" | "N"
export type Direction = "ltr" | "rtl"

const inRange = (code: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([from, to]) => code >= from && code <= to)
const HEBREW: ReadonlyArray<readonly [number, number]> = [[0x0590, 0x05ff], [0xfb1d, 0xfb4f], [0x07c0, 0x085f], [0x200f, 0x200f]]
const ARABIC: ReadonlyArray<readonly [number, number]> = [[0x0600, 0x07bf], [0x0860, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]]
/** Any right-to-left letter: the cheap test that keeps every other row on the plain path. */
const RTL_LETTER = /[֐-ࣿ‏יִ-﷿ﹰ-﻿]/

export const hasRtl = (text: string) => RTL_LETTER.test(text)

function kindOf(char: string): Kind {
  const code = char.codePointAt(0)!
  if (code >= 0x30 && code <= 0x39) return "EN"
  if (code >= 0x06f0 && code <= 0x06f9) return "EN"
  if ((code >= 0x0660 && code <= 0x0669) || code === 0x066b || code === 0x066c) return "AN"
  if (inRange(code, ARABIC)) return /\p{L}|\p{M}/u.test(char) ? "AL" : "N"
  if (inRange(code, HEBREW)) return /\p{L}|\p{M}/u.test(char) || code === 0x200f ? "R" : "N"
  if (code === 0x200e) return "L"
  if (",.:/".includes(char)) return "CS"
  if ("+-#$%¢£¥°±‰".includes(char)) return "ET"
  if (/\p{L}/u.test(char)) return "L"
  return "N"
}

/** The direction of the first strong character of `text`, or undefined when it has none (digits and punctuation only). */
export function firstStrong(text: string): Direction | undefined {
  for (const char of text) {
    const kind = kindOf(char)
    if (kind === "R" || kind === "AL") return "rtl"
    if (kind === "L") return "ltr"
  }
  return undefined
}

const MIRRORS: Readonly<Record<string, string>> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" }

type Unit = { text: string; span: Span; kind: Kind; level: number }

/** The embedding level of every unit of one line (`base` 0 left-to-right, 1 right-to-left). */
function resolve(units: Unit[], base: 0 | 1) {
  const kinds = units.map((unit) => unit.kind)
  // W2/W4/W5: a number after Arabic letters is an Arabic number; a separator between two numbers of one kind, or a sign next to a number, joins it.
  let previousStrong: Kind = base ? "R" : "L"
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === "L" || kinds[i] === "R" || kinds[i] === "AL") previousStrong = kinds[i]!
    else if (kinds[i] === "EN" && previousStrong === "AL") kinds[i] = "AN"
  }
  for (let i = 1; i < kinds.length - 1; i++) {
    if (kinds[i] === "CS" && kinds[i - 1] === kinds[i + 1] && (kinds[i - 1] === "EN" || kinds[i - 1] === "AN")) kinds[i] = kinds[i - 1]!
  }
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== "ET") continue
    if (kinds[i - 1] === "EN" || kinds[i + 1] === "EN") kinds[i] = "EN"
  }
  // W6/W7: the rest of the separators are neutral; a European number after a left-to-right letter is left-to-right text.
  previousStrong = base ? "R" : "L"
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!
    if (kind === "L" || kind === "R" || kind === "AL") previousStrong = kind === "AL" ? "R" : kind
    else if (kind === "EN" && previousStrong === "L") kinds[i] = "L"
    else if (kind === "CS" || kind === "ET") kinds[i] = "N"
  }
  const strong = (kind: Kind): "L" | "R" | undefined => (kind === "L" ? "L" : kind === "R" || kind === "AL" || kind === "EN" || kind === "AN" ? "R" : undefined)
  // N1/N2: neutrals take the direction of the strong text on both sides, else the embedding direction.
  const embedding = base ? "R" : "L"
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== "N") continue
    let end = i
    while (end < kinds.length && kinds[end] === "N") end++
    const before = i === 0 ? embedding : strong(kinds[i - 1]!)
    const after = end === kinds.length ? embedding : strong(kinds[end]!)
    const resolved = before && before === after ? before : embedding
    for (let k = i; k < end; k++) kinds[k] = resolved
    i = end - 1
  }
  units.forEach((unit, i) => {
    const kind = kinds[i]!
    unit.kind = kind
    unit.level = base === 0 ? (kind === "R" || kind === "AL" ? 1 : kind === "EN" || kind === "AN" ? 2 : 0) : (kind === "L" || kind === "EN" || kind === "AN" ? 2 : 1)
  })
}

/** One drawn row in visual order (the order a terminal draws it). Rows without right-to-left letters come back as they are. */
export function visualRow(row: Line, base: Direction): Line {
  const text = row.map((span) => span.text).join("")
  if (!hasRtl(text)) return row
  const units: Unit[] = []
  for (const span of row) for (const cell of cells(span.text)) units.push({ text: cell.text, span, kind: kindOf(cell.text), level: 0 })
  resolve(units, base === "rtl" ? 1 : 0)
  const top = Math.max(...units.map((unit) => unit.level))
  const lowestOdd = Math.min(...units.map((unit) => unit.level).filter((level) => level % 2 === 1), top + 1)
  for (let level = top; level >= lowestOdd; level--) {
    for (let i = 0; i < units.length; i++) {
      if (units[i]!.level < level) continue
      let end = i
      while (end < units.length && units[end]!.level >= level) end++
      const run = units.slice(i, end).reverse()
      units.splice(i, end - i, ...run)
      i = end - 1
    }
  }
  const out: Line = []
  for (const unit of units) {
    const mirrored = unit.level % 2 === 1 ? (MIRRORS[unit.text] ?? unit.text) : unit.text
    const last = out.at(-1)
    if (last && sameStyle(last, unit.span)) last.text += mirrored
    else out.push({ ...unit.span, text: mirrored })
  }
  return out
}

function sameStyle(a: Span, b: Span) {
  return a.fg === b.fg && a.fgHex === b.fgHex && a.bg === b.bg && a.bgHex === b.bgHex && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.link === b.link
}

/** `row` pushed to the right edge of `width` cells; the blanks are chrome, so copying a selection skips them. */
export function alignRight(row: Line, width: number, trailing = 0): Line {
  const pad = Math.max(0, width - trailing - row.reduce((n, span) => n + textWidth(span.text), 0))
  if (!pad) return row
  const out: Line = [{ text: " ".repeat(pad) }, ...row]
  markGutter(out, pad)
  return out
}
