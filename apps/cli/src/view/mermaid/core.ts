import type { ColorName, Line, Span } from "../../ui/theme"
import { cells, wrap } from "../wrap"

/** Shared cell canvas and resource limits for the lazily loaded diagram families. */
export type MermaidResult = { lines: Line[] } | { note: string }

export const MERMAID_NOTES = {
  unsupported: "unsupported diagram",
  tooWide: "diagram too wide · shown as source",
  tooComplex: "diagram too complex · shown as source",
} as const

export const MAX_NODES = 120
export const MAX_LABEL_WIDTH = 28
export const MAX_ROWS = 400

export function assertCanvas(width: number, height: number) {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0) || width > 1600 || height > 600 || width * height > 160_000) throw new Error(MERMAID_NOTES.tooComplex)
}

// ---------------------------------------------------------------------------------------------
// Canvas

type Role = "box" | "text" | "edge" | "label" | "keyword" | "frame"

const ROLE_STYLE: Record<Role, { fg: ColorName; bold?: boolean }> = {
  box: { fg: "heading" },
  text: { fg: "body" },
  edge: { fg: "muted" },
  label: { fg: "code" },
  keyword: { fg: "heading", bold: true },
  frame: { fg: "muted" },
}

const N = 1
export const E = 2
const S = 4
export const W = 8

const SOLID: Record<number, string> = { 1: "│", 4: "│", 5: "│", 2: "─", 8: "─", 10: "─", 6: "┌", 12: "┐", 3: "└", 9: "┘", 7: "├", 13: "┤", 14: "┬", 11: "┴", 15: "┼" }
const THICK: Record<number, string> = { 1: "┃", 4: "┃", 5: "┃", 2: "━", 8: "━", 10: "━", 6: "┏", 12: "┓", 3: "┗", 9: "┛", 7: "┣", 13: "┫", 14: "┳", 11: "┻", 15: "╋" }
const DASHED: Record<number, string> = { ...SOLID, 1: "┆", 4: "┆", 5: "┆", 2: "┄", 8: "┄", 10: "┄" }
const GLYPHS = { solid: SOLID, dashed: DASHED, thick: THICK }

export type LineStyle = "solid" | "dashed" | "thick"
export type Point = { x: number; y: number }

const CONTINUATION = "\0"

export class Canvas {
  private readonly cells: string[]
  private readonly roles: (Role | undefined)[]
  private readonly masks: number[]
  private readonly styles: LineStyle[]

  constructor(readonly width: number, readonly height: number) {
    assertCanvas(width, height)
    const size = width * height
    this.cells = new Array<string>(size).fill("")
    this.roles = new Array<Role | undefined>(size).fill(undefined)
    this.masks = new Array<number>(size).fill(0)
    this.styles = new Array<LineStyle>(size).fill("solid")
  }

  private index(x: number, y: number) {
    return x < 0 || y < 0 || x >= this.width || y >= this.height ? -1 : y * this.width + x
  }

  glyph(x: number, y: number, ch: string, role: Role) {
    const i = this.index(x, y)
    if (i < 0) return
    this.cells[i] = ch
    this.roles[i] = role
  }

  text(x: number, y: number, value: string, role: Role) {
    let cursor = x
    for (const { text: ch, width: w } of cells(value)) {
      this.glyph(cursor, y, ch, role)
      if (w === 2) this.glyph(cursor + 1, y, CONTINUATION, role)
      cursor += Math.max(1, w)
    }
  }

  charAt(x: number, y: number) {
    const i = this.index(x, y)
    return i < 0 ? "" : this.cells[i]!
  }

  isEmpty(x: number, y: number) {
    const i = this.index(x, y)
    return i >= 0 && this.cells[i] === "" && this.masks[i] === 0
  }

  /** True when the run [x, x+length) on row y is empty and not glued to another label. */
  isFreeRun(x: number, y: number, length: number) {
    for (let k = 0; k < length; k++) if (!this.isEmpty(x + k, y)) return false
    for (const edge of [x - 1, x + length]) {
      const i = this.index(edge, y)
      if (i >= 0 && this.roles[i] === "label" && this.cells[i] !== "") return false
    }
    return true
  }

  connect(x: number, y: number, mask: number, style: LineStyle) {
    const i = this.index(x, y)
    if (i < 0 || this.cells[i] !== "") return
    if (this.masks[i] === 0) this.styles[i] = style
    this.masks[i] = this.masks[i]! | mask
    this.roles[i] = "edge"
  }

  maskAt(x: number, y: number) {
    const i = this.index(x, y)
    return i < 0 ? 0 : this.masks[i]!
  }

  path(points: Point[], style: LineStyle) {
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k]!
      const b = points[k + 1]!
      if (a.x === b.x) {
        const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y]
        for (let y = lo; y <= hi; y++) this.connect(a.x, y, (y > lo ? N : 0) | (y < hi ? S : 0), style)
      } else {
        const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
        for (let x = lo; x <= hi; x++) this.connect(x, a.y, (x > lo ? W : 0) | (x < hi ? E : 0), style)
      }
    }
  }

  /** Turns a plain border cell into a T junction where a line touches it from `side`. */
  junction(x: number, y: number, side: "N" | "E" | "S" | "W") {
    const ch = this.charAt(x, y)
    const table: Record<string, Partial<Record<string, string>>> = {
      "─": { N: "┴", S: "┬" },
      "│": { E: "├", W: "┤" },
      "═": { N: "╩", S: "╦" },
      "║": { E: "╠", W: "╣" },
    }
    const next = table[ch]?.[side]
    if (next) this.glyph(x, y, next, this.roles[this.index(x, y)] ?? "box")
  }

  toLines(): Line[] {
    const out: Line[] = []
    for (let y = 0; y < this.height; y++) {
      const spans: Span[] = []
      let run: { role: Role | undefined; text: string } | undefined
      const flush = () => {
        if (!run) return
        const style = run.role ? ROLE_STYLE[run.role] : undefined
        spans.push(style ? { text: run.text, fg: style.fg, ...(style.bold ? { bold: true } : {}) } : { text: run.text })
        run = undefined
      }
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x
        let ch = this.cells[i]!
        if (ch === CONTINUATION) continue
        if (ch === "" && this.masks[i]! > 0) ch = GLYPHS[this.styles[i]!][this.masks[i]!] ?? "┼"
        if (ch === "") ch = " "
        const role = ch === " " ? undefined : this.roles[i]
        if (run && run.role === role) run.text += ch
        else {
          flush()
          run = { role, text: ch }
        }
      }
      flush()
      while (spans.length && spans[spans.length - 1]!.fg === undefined && /^\s*$/.test(spans[spans.length - 1]!.text)) spans.pop()
      out.push(spans)
    }
    return out
  }
}

// ---------------------------------------------------------------------------------------------
// Shared parsing helpers

export function wrapPlain(text: string, max: number): string[] {
  return wrap(text, Math.max(2, max))
}

export function decodeLabel(raw: string): string[] {
  let text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
  if (text.startsWith("`") && text.endsWith("`") && text.length >= 2) text = text.slice(1, -1)
  text = text.replace(/#quot;/g, '"').replace(/#amp;/g, "&").replace(/#lt;/g, "<").replace(/#gt;/g, ">")
  return text
    .split(/<br\s*\/?>|\\n/i)
    .flatMap((part) => wrapPlain(part.replace(/<[^>]+>/g, "").replace(/[\u0000-\u001f\u007f]/g, ""), MAX_LABEL_WIDTH))
}

export function cleanSource(source: string): string[] {
  const lines = source.replace(/\r/g, "").split("\n")
  let start = 0
  while (start < lines.length && !lines[start]!.trim()) start++
  if (lines[start]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > start && line.trim() === "---")
    if (end > start) start = end + 1
  }
  return lines.slice(start)
}

// ---------------------------------------------------------------------------------------------
