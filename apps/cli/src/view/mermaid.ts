import type { Line } from "../ui/theme"
import { cells, textWidth, truncateEnd } from "./wrap"
import { MERMAID_NOTES } from "./mermaid/core"
import { flowFromLinks, parseFlowchart, renderFlowchart, skippedNote } from "./mermaid/flowchart"
import type { Direction } from "./mermaid/flowchart"
import { parseSequence, renderSequence } from "./mermaid/sequence"
import { invalidStatements } from "./mermaid/syntax"
import { registry } from "./mermaid/registry"
import { markPicture } from "./line-meta"
import { preparedMermaidSourceLines } from "./mermaid/legacy-shared"
import { clipLine, looseLinks, outlineLines } from "./mermaid/outline"

export { MERMAID_NOTES } from "./mermaid/core"
export type { MermaidResult } from "./mermaid/core"
import type { MermaidResult } from "./mermaid/core"

/** A source past these is never handed to a layout: it is shown as an outline, which is one pass and a fixed number of rows. */
const SOURCE_MAX_CHARS = 400_000
const SOURCE_MAX_LINES = 8000
/** Flowcharts and sequences bound their own parse; every other family lays out whatever it is given, so it is given less. */
const FAMILY_MAX_CHARS = 48_000
const FAMILY_MAX_LINES = 800
const LINE_MAX_CHARS = 4096
/** The widest a diagram is laid out, here and in the viewer. */
const NATURAL_WIDTH = 1600
/** With at most this many lines, a family that draws nothing is asked again without each line in turn, to name the one in its way. */
const NAME_LINE_MAX = 80

function themed(output: string): Line[] {
  return output.split("\n").map((row, index) => {
    const spans: Line = []
    for (const cell of cells(row)) {
      const fg = index === 0 ? "heading" : /[─-╿]/u.test(cell.text) ? "heading" : /[←-⇿■-◿☀-⛿]/u.test(cell.text) ? "accent" : "body"
      const last = spans.at(-1)
      if (last?.fg === fg) last.text += cell.text
      else spans.push({ text: cell.text, fg })
    }
    return spans
  })
}

/** `row` with the cells `[from, from + count)` in the colour `fg`; the cells before and after keep their spans. */
function tintCells(row: Line, from: number, count: number, fg: NonNullable<Line[number]["fg"]>): Line {
  const out: Line = []
  let at = 0
  for (const span of row) {
    for (const cell of cells(span.text)) {
      const inside = at >= from && at < from + count
      const last = out.at(-1)
      const next = inside ? { ...span, text: cell.text, fg } : { ...span, text: cell.text }
      if (last && last.fg === next.fg && last.bg === next.bg && last.bold === next.bold) last.text += cell.text
      else out.push(next)
      at += cell.width
    }
  }
  return out
}

/** `%%{init: {"sequence": {"mirrorActors": false}}}%%` (or the YAML front-matter form) turns the bottom participant boxes off. */
const MIRROR_OFF = /mirrorActors["']?\s*:\s*false\b/i

type Drawn = { lines: Line[]; note?: string }
/**
 * Why a family drew nothing: the picture is `wide`r than the room or too `large` for a canvas, lines were `unread`, the
 * family read every line and still made no picture (`undrawn`), or the type is `unknown` here.
 */
type Failure = { fail: "wide" | "large" | "undrawn" | "unknown" } | { fail: "unread"; skipped: string[] }

const failureOf = (note: string): Failure => (note.startsWith("diagram too wide") ? { fail: "wide" } : note === MERMAID_NOTES.tooComplex ? { fail: "large" } : { fail: "undrawn" })

/** One registry family at `width`: its output as lines, or why there are none. */
function drawRegistered(render: NonNullable<(typeof registry)[string]>, source: string, width: number): Drawn | Failure {
  let output: ReturnType<typeof render>
  try {
    output = render(source, width)
  } catch (error) {
    return failureOf(error instanceof Error ? error.message : "")
  }
  if (!output) return { fail: "undrawn" }
  if (typeof output !== "string" && "text" in output) {
    const { text, picture, tint } = output
    if (text.length > 160_000 || text.split("\n").length > 600) return { fail: "large" }
    if (text.split("\n").some((row) => textWidth(row) > width)) return { fail: "wide" }
    const rows = themed(text).map((row, at) => (tint ?? []).filter((mark) => mark.row === at).reduce((made, mark) => tintCells(made, mark.col, mark.cols, mark.fg), row))
    return { lines: picture ? rows.map((row, at) => (at >= picture.row && at < picture.row + picture.rows ? markPicture(row, { key: picture.key, row: at - picture.row, rows: picture.rows, cols: picture.cols, col: picture.col }) : row)) : rows }
  }
  if (typeof output !== "string") return output.lines.length > 600 ? { fail: "large" } : output.lines.some((row) => textWidth(row.map((span) => span.text).join("")) > width) ? { fail: "wide" } : output
  if (output.length > 160_000 || output.split("\n").length > 600) return { fail: "large" }
  if (output.split("\n").some((row) => textWidth(row) > width)) return { fail: "wide" }
  return { lines: themed(output) }
}

/** The family the header names, drawn at `width`. */
function drawFamily(input: { source: string; lines: string[]; width: number }): Drawn | Failure {
  const { source, lines, width } = input
  const header = lines[0]!.trim().replace(/[;:]$/, "")
  const body = lines.slice(1)
  const flowHeader = /^(?:flowchart(?:-elk)?|graph)(?:\s+(TD|TB|LR|RL|BT))?$/i.exec(header)
  if (flowHeader) {
    const raw = (flowHeader[1] ?? "TD").toUpperCase()
    const flow = parseFlowchart(body, raw === "TB" ? "TD" : raw as Direction)
    return "nodes" in flow ? renderFlowchart(flow, width) : { fail: "unread", skipped: flow.skipped }
  }
  if (/^sequenceDiagram$/i.test(header)) {
    const seq = parseSequence(body)
    if (!("items" in seq)) return { fail: "unread", skipped: seq.skipped }
    let made: ReturnType<typeof renderSequence>
    try {
      made = renderSequence(seq, width, { mirror: !MIRROR_OFF.test(source) })
    } catch (error) {
      return failureOf(error instanceof Error ? error.message : "")
    }
    if (!("lines" in made)) return failureOf(made.note)
    return seq.skipped.length ? { lines: made.lines, note: skippedNote(seq.skipped) } : made
  }
  const render = registry[header.split(/\s/)[0]!.toLowerCase().replace(/:$/, "")]
  if (!render) return { fail: "unknown" }
  if (source.length > FAMILY_MAX_CHARS || lines.length > FAMILY_MAX_LINES) return { fail: "large" }
  const { bad, open } = invalidStatements(header, body)
  if (open) return { fail: "unread", skipped: ["a { or a note that is never closed"] }
  const skipped = bad.map((at) => body[at]!.trim())
  const kept = bad.length ? body.filter((_, at) => !bad.includes(at)) : body
  if (skipped.length > kept.length) return { fail: "unread", skipped }
  const made = drawRegistered(render, [lines[0]!, ...kept].join("\n"), width)
  if ("lines" in made) return skipped.length ? { lines: made.lines, note: skippedNote(skipped) } : made
  if (skipped.length) return { fail: "unread", skipped }
  // A family that reads its only statement and draws nothing did not understand that statement.
  if (made.fail === "undrawn" && kept.length === 1) return { fail: "unread", skipped: [kept[0]!.trim()] }
  if (made.fail !== "undrawn" || kept.length < 2 || kept.length > NAME_LINE_MAX) return made
  for (let at = 0; at < kept.length; at++) {
    const without = drawRegistered(render, [lines[0]!, ...kept.slice(0, at), ...kept.slice(at + 1)].join("\n"), width)
    if ("lines" in without) return { lines: without.lines, note: skippedNote([kept[at]!]) }
  }
  return made
}

/** A picture wider than the chat is laid out a little wider, then wider again, and cut at the right edge: the least that is lost. */
function drawCut(input: { source: string; lines: string[]; width: number }): Drawn | undefined {
  const { width } = input
  for (const wider of [width + 24, Math.ceil(width * 1.5), width * 2, width * 3, width * 5, NATURAL_WIDTH]) {
    if (wider <= width || wider > NATURAL_WIDTH) continue
    const made = drawFamily({ ...input, width: wider })
    if (!("lines" in made)) continue
    return { lines: made.lines.map((row) => clipLine(row, width)), note: ["wider than the chat, cut at the right edge · /diagram shows it whole", made.note].filter(Boolean).join(" · ") }
  }
  return undefined
}

/**
 * Pure synchronous dispatch; the entire registry loads only through mermaid-lazy.
 *
 * A mermaid block is drawn whenever anything of it can be: its family's picture; that picture without the lines the family
 * did not understand, named in the note; the picture cut at the right edge when it is wider than the chat; an outline when
 * it is too large or its type has no picture here. Only text that is not read as a diagram at all comes back as a bare
 * note (the caller shows the source), and that note quotes the line that was not understood.
 */
export function renderMermaid(source: string, width: number): MermaidResult {
  if (!Number.isFinite(width) || width < 4) return { note: MERMAID_NOTES.tooWide }
  width = Math.min(NATURAL_WIDTH, Math.floor(width))
  const lines = source.length > SOURCE_MAX_CHARS ? [] : preparedMermaidSourceLines(source)
  if (source.length > SOURCE_MAX_CHARS) return { note: "diagram source too long to read · shown as source" }
  if (!lines.length) return { note: "empty diagram" }
  const type = lines[0]!.trim().split(/\s/)[0]!.replace(/[;:]$/, "")
  const outline = (note: string): MermaidResult => ({ lines: outlineLines(lines, width), note })
  if (lines.length > SOURCE_MAX_LINES || lines.some((line) => line.length > LINE_MAX_CHARS)) return outline("too large to draw · shown as an outline")
  const input = { source, lines, width }
  let made: Drawn | Failure
  try {
    made = drawFamily(input)
  } catch {
    made = { fail: "undrawn" }
  }
  if ("lines" in made) return made
  if (made.fail === "unread" && !made.skipped.length) return { note: "empty diagram · shown as source" }
  if (made.fail === "unread") return { note: `${skippedNote(made.skipped)} · shown as source` }
  if (made.fail === "wide") {
    let cut: Drawn | undefined
    try {
      cut = drawCut(input)
    } catch {
      cut = undefined
    }
    return cut ?? outline("too wide to draw here · shown as an outline · /diagram shows it whole")
  }
  // A diagram of names joined by lines keeps its shape as a plain graph, whatever its type: a sequence is the one that does not.
  const links = /^sequenceDiagram$/i.test(type) ? undefined : looseLinks(lines.slice(1))
  const why = made.fail === "large" ? "too large for its own drawing" : made.fail === "undrawn" ? `could not be drawn as a ${truncateEnd(type, 32)}` : `${truncateEnd(type, 32)} has no drawing here`
  if (links) {
    const flow = renderFlowchart(flowFromLinks(links), width)
    return { lines: flow.lines, note: [`${why} · its links drawn as a plain graph`, flow.note].filter(Boolean).join(" · ") }
  }
  if (made.fail === "unknown" && lines.length < 2) return { note: `not a mermaid diagram type: ${truncateEnd(lines[0]!.trim(), 48)} · shown as source` }
  return outline(`${why} · shown as an outline`)
}
