import type { PermissionMode, StatusSegment } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { fit } from "./deck"
import type { TokenLook } from "./attachments"
import { truncateEnd } from "./session-list"
import { cells, lineWidth as widthOf, textWidth } from "./wrap"

/** Cells of blank margin either side of v1's prompt rules and lead glyph (the session container's padding). */
export const PROMPT_MARGIN = 2
/** Where v1's status row and working row start: one cell past the margin (`promptOuterMetaPadLeft`). */
export const META_MARGIN = PROMPT_MARGIN + 1

/** v1's home placeholder examples (`routes/home.tsx`): one is picked per session. */
export const PLACEHOLDER_EXAMPLES: readonly string[] = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]

/** v1's shell-mode placeholder examples. */
export const SHELL_EXAMPLES: readonly string[] = ["ls -la", "git status", "pwd"]

export function shellPlaceholderFor(random: number) {
  const example = SHELL_EXAMPLES[Math.min(SHELL_EXAMPLES.length - 1, Math.floor(random * SHELL_EXAMPLES.length))]!
  return `Run a command... "${example}"`
}

export function placeholderFor(random: number) {
  const example = PLACEHOLDER_EXAMPLES[Math.min(PLACEHOLDER_EXAMPLES.length - 1, Math.floor(random * PLACEHOLDER_EXAMPLES.length))]!
  return `Ask anything... "${example}"`
}

/** v1's `top-bottom` chrome: straight rules with a 2-cell margin; minimal keeps bare full-width rules. */
export function promptRule({ width, glyphs, color, rich }: { width: number; glyphs: Glyphs; color: ColorName; rich: boolean }): Line {
  if (!rich) return [{ text: glyphs.rule.repeat(width), fg: color }]
  return [{ text: " ".repeat(PROMPT_MARGIN) }, { text: glyphs.rule.repeat(Math.max(0, width - PROMPT_MARGIN * 2)), fg: color }]
}

/** Cells before the first character of a prompt row: margin, lead glyph and its gap. */
export const promptInset = (rich: boolean) => (rich ? PROMPT_MARGIN + 2 : 2)

/** The prompt's surroundings for a chrome preset (`tui-profile.ts`): rows above and below the editor rows, and how each editor row is wrapped. */
export type PromptFrame = {
  top: Line[]
  bottom: Line[]
  /** One editor row (as `promptRow` returns it) inside the frame. */
  row(line: Line): Line
  /** Cells before the first typed character of a row. */
  inset: number
  /** Cells between a row's text area and its right edge (margin, and a box's bar and gap); the margin when a frame does not say. */
  rightEdge?: number
  /** Legacy callback shape; current presets never supply it. The footer stays outside. */
  inside?(status: (width: number) => Line): Line
}

const BOX_GLYPHS = {
  box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  "ascii-box": { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
} as const

/** Cells the vertical bars, their gaps and the margins take on a boxed row. */
const BOX_CHROME = PROMPT_MARGIN * 2 + 4
/** Where the typed text starts inside a box: margin, bar, gap, then the lead glyph and its gap. */
const BOX_INSET = promptInset(true) + 2

/** The margin span `promptRow` puts first in a rich row, dropped so a preset can place its own border there. */
export function withoutMargin(line: Line): Line {
  const first = line[0]
  return first && first.fg === undefined && first.bg === undefined && first.text === " ".repeat(PROMPT_MARGIN) ? line.slice(1) : line
}

/**
 * v1's prompt chrome: `top-bottom` (straight rules, the default), `box` (rounded frame), `ascii-box` (single-line box by default)
 * and `minimal` (subtle tint, no lines). The footer is always outside. The bare minimal *view* keeps its full-width rules whatever the
 * preset. Every row is exactly `width` cells.
 */
export function promptFrame({ preset, width, glyphs, rich, lead = "❭", border = "auto", borders = "" }: { preset: "box" | "top-bottom" | "minimal" | "ascii-box"; width: number; glyphs: Glyphs; rich: boolean; placement?: "auto" | "inside" | "outside"; lead?: string; border?: "auto" | "single" | "rounded" | "double" | "ascii"; borders?: string }): PromptFrame {
  const custom = [...cells(borders)].map((cell) => cell.text)
  const rule = promptRule({ width, glyphs: custom.length === 6 ? { ...glyphs, rule: custom[0]! } : border === "double" ? { ...glyphs, rule: "═" } : border === "ascii" ? { ...glyphs, rule: "=" } : glyphs, color: "primary", rich })
  if (!rich) return { top: [rule], bottom: [rule], row: (line) => line, inset: promptInset(false), rightEdge: 0 }
  if (preset === "top-bottom") {
    const padded = fit(rule, width)
    return { top: [padded], bottom: [padded], row: (line) => fit(line, width), inset: PROMPT_MARGIN + textWidth(lead) + 1 }
  }
  if (preset === "minimal") {
    const blank: Line = [{ text: " ".repeat(Math.max(0, width)), bg: "promptBg" }]
    return { top: [blank], bottom: [blank], row: (line) => fit(line, width).map((span) => (span.bg ? span : { ...span, bg: "promptBg" })), inset: PROMPT_MARGIN + textWidth(lead) + 1 }
  }
  const set = custom.length === 6 ? { h: custom[0]!, v: custom[1]!, tl: custom[2]!, tr: custom[3]!, bl: custom[4]!, br: custom[5]! } : border === "single" ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } : border === "double" ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" } : border === "ascii" || glyphs.rule === "-" ? { tl: "+", tr: "+", bl: "+", br: "+", h: "=", v: "|" } : border === "rounded" ? BOX_GLYPHS.box : BOX_GLYPHS[preset]
  const margin: Span = { text: " ".repeat(PROMPT_MARGIN) }
  const bar: Span = { text: set.v, fg: "primary" }
  const bodyWidth = Math.max(0, width - BOX_CHROME)
  const edge = (left: string, right: string): Line => [margin, { text: `${left}${set.h.repeat(Math.max(0, width - PROMPT_MARGIN * 2 - 2))}${right}`, fg: "primary" }, margin]
  const row = (body: Line): Line => [margin, bar, { text: " " }, ...fit(body, bodyWidth), { text: " " }, bar, margin]
  return {
    top: [edge(set.tl, set.tr)],
    bottom: [edge(set.bl, set.br)],
    row: (line) => row(withoutMargin(line)),
    inset: BOX_INSET + textWidth(lead) - 1,
    rightEdge: PROMPT_MARGIN + 2,
  }
}

/**
 * Prompt text as spans. An attachment token is drawn as the transcript's chip badge of its kind (the image badge's accent for an image,
 * primary for a PDF, secondary for a file or folder), whole, so it reads as one unit inside the sentence.
 */
export function promptSpans(line: string, tokens: readonly TokenLook[]): Span[] {
  const hits: Array<{ start: number; end: number; role: TokenLook["role"] }> = []
  for (const { label, role } of tokens) for (let at = line.indexOf(label); at >= 0; at = line.indexOf(label, at + label.length)) hits.push({ start: at, end: at + label.length, role })
  if (!hits.length) return textSpans(line)
  hits.sort((a, b) => a.start - b.start)
  const spans: Span[] = []
  let at = 0
  for (const hit of hits) {
    if (hit.start < at) continue
    if (hit.start > at) spans.push(...textSpans(line.slice(at, hit.start)))
    spans.push({ text: line.slice(hit.start, hit.end), fg: "background", bg: hit.role })
    at = hit.end
  }
  if (at < line.length) spans.push(...textSpans(line.slice(at)))
  return spans
}

/** `@path` mentions are drawn in the warning color, bold, like v1's virtual mention tokens. */
function textSpans(line: string): Span[] {
  const spans: Span[] = []
  let last = 0
  for (const match of line.matchAll(/(^|\s)(@\S+)/g)) {
    const start = match.index + match[1]!.length
    if (start > last) spans.push({ text: line.slice(last, start), fg: "text" })
    spans.push({ text: match[2]!, fg: "warning", bold: true })
    last = start + match[2]!.length
  }
  if (last < line.length) spans.push({ text: line.slice(last), fg: "text" })
  return spans
}

/** One editor row. The first carries the lead glyph (or the placeholder while the prompt is empty). */
export function promptRow({ text, first, rich, glyphs, placeholder, shell, lead: leadText = "❭", selection, tokens = [] }: { text: string; first: boolean; rich: boolean; glyphs: Glyphs; placeholder?: string; shell?: boolean; lead?: string; selection?: { start: number; end: number }; tokens?: readonly TokenLook[] }): Line {
  const margin: Span[] = rich ? [{ text: " ".repeat(PROMPT_MARGIN) }] : []
  // Minimal has no row that says `Shell`, so its lead becomes `!` in shell mode.
  const lead: Span = first ? (rich ? { text: `${leadText} `, fg: "muted" } : { text: `${shell ? "!" : glyphs.user} `, fg: "primary", bold: true }) : { text: " ".repeat(rich ? textWidth(leadText) + 1 : 2) }
  if (first && text === "" && placeholder) return [...margin, lead, { text: placeholder, fg: "muted" }]
  const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((cell) => cell.segment)
  const content = selection ? [...promptSpans(chars.slice(0, selection.start).join(""), tokens), { text: chars.slice(selection.start, selection.end).join(""), fg: "background" as const, bg: "primary" as const }, ...promptSpans(chars.slice(selection.end).join(""), tokens)] : promptSpans(text, tokens)
  return [...margin, lead, ...content]
}

const PERMISSION_COLOR: Record<PermissionMode, ColorName> = { ask: "muted", smart: "info", edits: "warning", full: "error", plan: "heading" }

export type StatusRowInput = {
  leftItems?: Line
  rightItems?: Line
  separator?: string
  width: number
  agent?: string
  agentColor?: Pick<Span, "fg" | "fgHex">
  model?: string
  effort?: string
  provider?: string
  counters?: Line
  /** Named only when it is not the default `ask`: the row stays v1's `model · effort` otherwise. */
  permission?: PermissionMode
  permissionLabel?: string
  /** The folder profile of this project when it is not `personal` (leads the row as `◆ name`). */
  profile?: string
  pr?: { number: number; state: string }
  loops: number
  /** The session's goal indicator (docs/goals.md), already spans; leads the right side. Not given where a footer shows it. */
  goal?: Line
  /** Live workflows of this project; `waiting` of them need the user. */
  workflows?: { live: number; waiting: number }
  notice?: string
  connection?: "connected" | "reconnecting" | "closed"
  /** Shell mode: the row says `Shell` and `esc exit shell mode`, without model, effort, script status or loops. */
  shell?: boolean
  /** Script-backed status segments (v1's `promptStatus.scripts`): `left` follows the built-in items, `right` ends the row. */
  scriptLeft?: readonly StatusSegment[]
  scriptRight?: readonly StatusSegment[]
  /** An explicit script row owns its side; its colored segments concatenate as in v1. */
  scriptLeftRow?: readonly StatusSegment[]
  scriptRightRow?: readonly StatusSegment[]
  /** Extension slots (`footer.left`, `footer.right`, `footer.replace`) for views whose footer is this row; already theme spans. */
  ext?: { left?: Line; right?: Line; replace?: Line }
}

/** Rows an extension slot adds above or below the prompt: each cut to `width`, at most `maxRows` of them. */
export function slotRows(lines: readonly Line[], width: number, maxRows: number): Line[] {
  return lines.slice(0, Math.max(0, maxRows)).map((line) => fitSpans(line, width))
}

/** A script segment as a span: its own hex color when it has one, muted otherwise. */
function segmentSpan(segment: StatusSegment): Span {
  return { text: segment.text, ...(segment.fg ? { fgHex: segment.fg } : { fg: "muted" as const }), ...(segment.bold ? { bold: true } : {}) }
}

/**
 * One row under the prompt: agent, model and runtime on the left; live counters on the right.
 * Non-default permissions, connection failures and extension slots share the same row.
 */
export function renderStatusRow(input: StatusRowInput): Line {
  if (input.ext?.replace) return [{ text: " ".repeat(META_MARGIN) }, ...fitSpans(input.ext.replace, Math.max(0, input.width - META_MARGIN - PROMPT_MARGIN))]
  const left: Span[] = []
  const add = (span: Span) => {
    if (left.length) left.push({ text: input.separator ?? " · ", fg: "muted" })
    left.push(span)
  }
  if (input.shell) add({ text: "Shell", fg: "primary", bold: true })
  else {
    if (input.profile) add({ text: `◆ ${input.profile}`, fg: "heading", bold: true })
    if (input.pr) add({ text: `#${input.pr.number} ${input.pr.state.toLowerCase()}`, fg: "link", bold: true })
    if (input.agent) add({ text: input.agent, fg: "primary", ...input.agentColor, bold: true })
    if (input.permission && input.permission !== "ask") add({ text: input.permissionLabel ?? input.permission, fg: PERMISSION_COLOR[input.permission], bold: true })
    if (input.model) add({ text: input.model, fg: "text" })
    const runtime = [input.effort, input.provider].filter(Boolean).join(" / ")
    if (runtime) add({ text: runtime, fg: input.provider ? "muted" : "warning", bold: !input.provider })
    for (const segment of input.scriptLeft ?? []) if (segment.text && !segment.prepend) add(segmentSpan(segment))
    if (input.ext?.left?.length) {
      if (left.length) left.push({ text: input.separator ?? " · ", fg: "muted" })
      left.push(...input.ext.left)
    }
  }
  if (input.leftItems && !input.shell) {
    left.splice(0, left.length, ...input.leftItems)
    for (const segment of input.scriptLeft ?? []) if (segment.text && !segment.prepend) add(segmentSpan(segment))
    if (input.ext?.left?.length) {
      if (left.length) left.push({ text: input.separator ?? " · ", fg: "muted" })
      left.push(...input.ext.left)
    }
  }
  if (input.scriptLeftRow && !input.shell) {
    left.splice(0, left.length, ...input.scriptLeftRow.map(segmentSpan))
    if (input.ext?.left?.length) left.push(...(left.length ? [{ text: input.separator ?? " · ", fg: "muted" as const }] : []), ...input.ext.left)
  }
  if (!input.shell) {
    const before: Line = []
    for (const segment of input.scriptLeftRow ? [] : input.scriptLeft ?? []) if (segment.text && segment.prepend) {
      if (before.length) before.push({ text: input.separator ?? " · ", fg: "muted" })
      before.push(segmentSpan(segment))
    }
    if (before.length) left.unshift(...before, ...(left.length ? [{ text: input.separator ?? " · ", fg: "muted" as const }] : []))
  }
  const right: Span[] = []
  const connection = input.connection && input.connection !== "connected" ? (input.connection === "reconnecting" ? "offline · reconnecting…" : "disconnected") : ""
  const note = [connection, input.notice].filter(Boolean).join(" · ")
  const rightMargin = PROMPT_MARGIN
  if (input.shell) right.push({ text: "esc", fg: "text" }, { text: " exit shell mode", fg: "muted" })
  else {
    if (input.goal?.length) right.push(...input.goal)
    if (input.loops > 0) right.push(...(right.length ? [{ text: "  " }] : []), { text: `↻ ${input.loops} loop${input.loops === 1 ? "" : "s"}`, fg: "secondary" })
    if (input.workflows?.live) right.push(...(right.length ? [{ text: "  " }] : []), { text: `◇ ${input.workflows.live} workflow${input.workflows.live === 1 ? "" : "s"}${input.workflows.waiting ? " ?" : ""}`, fg: input.workflows.waiting ? "warning" : "secondary" })
    if (input.counters?.length) right.push(...(right.length ? [{ text: "  " }] : []), ...input.counters)
    if (input.rightItems) right.push(...(right.length ? [{ text: "  " }] : []), ...input.rightItems)
    if (input.scriptRightRow) {
      const row = input.scriptRightRow.map(segmentSpan)
      if (row.length) {
        if (input.scriptRightRow[0]?.prepend) right.unshift(...row, ...(right.length ? [{ text: "  " }] : []))
        else right.push(...(right.length ? [{ text: "  " }] : []), ...row)
      }
    } else for (const segment of input.scriptRight ?? []) if (segment.text && !segment.prepend) right.push(...(right.length ? [{ text: "  " }] : []), segmentSpan(segment))
    if (input.ext?.right?.length) right.push(...(right.length ? [{ text: "  " }] : []), ...input.ext.right)
    const before: Line = []
    for (const segment of input.scriptRightRow ? [] : input.scriptRight ?? []) if (segment.text && segment.prepend) before.push(...(before.length ? [{ text: "  " }] : []), segmentSpan(segment))
    if (before.length) right.unshift(...before, ...(right.length ? [{ text: "  " }] : []))
  }
  const room = Math.max(0, input.width - META_MARGIN - rightMargin)
  if (note) {
    const gap = right.length ? 2 : 0
    const budget = room - widthOf(left) - widthOf(right) - gap - (left.length ? 2 : 0)
    if (budget >= 8) right.unshift({ text: truncateEnd(note, budget), fg: "warning" }, ...(gap ? [{ text: "  " }] : []))
  }
  let leftSpans = left
  if (widthOf(left) + (right.length ? 2 : 0) + widthOf(right) > room) {
    if (input.scriptLeftRow || input.scriptRightRow) {
      const leftBudget = right.length && left.length ? Math.max(0, Math.floor((room - 2) / 2)) : room
      const rightBudget = Math.max(0, room - Math.min(widthOf(left), leftBudget) - (left.length && right.length ? 2 : 0))
      right.splice(0, right.length, ...fitSpans(right, rightBudget))
    } else if (widthOf(right) >= room) right.length = 0
    const budget = room - widthOf(right) - (right.length ? 2 : 0)
    leftSpans = fitSpans(left, budget)
  }
  const line: Line = [{ text: " ".repeat(META_MARGIN) }, ...leftSpans]
  if (right.length) line.push({ text: " ".repeat(Math.max(1, room - widthOf(leftSpans) - widthOf(right))) }, ...right)
  return line
}

/** `label` dim on the right edge of `line`, which is cut to make room; the line is left alone when the row is too narrow. */
export function withRightLabel(line: Line, width: number, label: string): Line {
  const labelWidth = textWidth(label)
  const room = width - PROMPT_MARGIN - labelWidth - 1
  if (room < 8) return line
  const text = line.map((span) => span.text).join("")
  const kept = textWidth(text.trimEnd()) <= room ? cutSpans(line, room) : fitSpans(line, room)
  const used = kept.reduce((sum, span) => sum + textWidth(span.text), 0)
  return [...kept, { text: " ".repeat(width - PROMPT_MARGIN - labelWidth - used) }, { text: label, fg: "muted", dim: true }]
}

/** `line` cut to leave room for `block` (exactly `blockWidth` cells) at the right edge, inside the prompt margin. */
export function withRightBlock(line: Line, width: number, block: Line, blockWidth: number): Line {
  const room = width - PROMPT_MARGIN - blockWidth - 1
  if (room < 8) return line
  // Only cut text gets an ellipsis. Where nothing but padding and frame is lost (a message's background, a separator, the side or
  // corner of a panel's border), the row just ends at the block: an ellipsis there reads as a stray glyph beside it.
  const text = line.map((span) => span.text).join("")
  let cells = 0
  let lost = ""
  for (const char of text) {
    if (cells >= room) lost += char
    cells += textWidth(char)
  }
  const kept = /^[\s\u2500-\u257f]*$/.test(lost) ? cutSpans(line, room) : fitSpans(line, room)
  const used = kept.reduce((sum, span) => sum + textWidth(span.text), 0)
  return [...kept, { text: " ".repeat(room + 1 - used) }, ...block]
}

/** The first `width` cells of `spans`, cut without an ellipsis (for padding only). */
function cutSpans(spans: Span[], width: number): Span[] {
  const out: Span[] = []
  let used = 0
  for (const span of spans) {
    if (used >= width) break
    const w = textWidth(span.text)
    out.push(used + w <= width ? span : { ...span, text: span.text.slice(0, width - used) })
    used += Math.min(w, width - used)
  }
  return out
}

function fitSpans(spans: Span[], width: number): Span[] {
  const out: Span[] = []
  let used = 0
  for (const span of spans) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}
