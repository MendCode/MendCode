import type { ColorName, Line, Span } from "../ui/theme"
import { ensureMermaid } from "./mermaid-lazy"
import { mathDisplay, mathInline, subscript, superscript } from "./math"
import { highlight, type HighlightState } from "./syntax"
import { cells, textWidth } from "./wrap"
import { carryCopy, carryFold, carryPicture, markCopy, markFold, markGutter, markSoftWrapped } from "./line-meta"
import { safeLink } from "../ui/hyperlink"
import { BREAK, plainText, wrapSpans } from "./markdown-wrap"
import { renderTable, type Align } from "./markdown-table"
import { CALLOUTS, CLASSIC_STYLE, rolesOf, styleKey, type Callout, type MarkdownStyle, type Roles } from "./markdown-style"
import { blockHeader, CALLOUT_LABELS, calloutRole, headingRows, levelRole, overlayHint, tagCopy, type HeaderButton } from "./markdown-chrome"
import { alignRight, firstStrong, hasRtl, visualRow } from "./markdown-bidi"

export { wrapSpans } from "./markdown-wrap"
export { CLASSIC_STYLE, markdownStyleFor, type MarkdownStyle } from "./markdown-style"

/** A web address as a span's link target; other schemes (javascript:, file:) are never linked from message text. */
const webLink = (url: string): { link: string } | undefined => {
  const link = /^https?:\/\//i.test(url) ? safeLink(url) : undefined
  return link ? { link } : undefined
}

/** `Span` now carries `fgHex` (swatches) and `italic`; kept as an alias for the renderer's internals. */
export type RichSpan = Span

const BULLETS = ["•", "◦", "▪"]
const GUTTER = "│ "
/** A row that is all drawing (a code block's language label): copying a selection skips it. */
const chrome = (row: Line): Line => (markGutter(row, 1000), row)
const CONTINUATION = "↪ "
const MAX_LIST_LEVEL = 4
const MIN_COLUMN = 3
const MAX_MATH_LINES = 60
const DETAILS_OPEN = /<details\b/gi
const DETAILS_CLOSE = /<\/details\s*>/gi

export type MarkdownOptions = {
  /** Whether the n-th `<details>` block (document order, nested ones included) is expanded; undefined keeps its own `open` attribute. */
  detailsOpen?: (ordinal: number) => boolean | undefined
  /** How to draw; the classic style (the `markdown` renderer's) when absent. See `markdownStyleFor`. */
  style?: MarkdownStyle
}

type RenderContext = { ordinal: number; detailsOpen: MarkdownOptions["detailsOpen"]; style: MarkdownStyle; roles: Roles }

const contextOf = (options: MarkdownOptions): RenderContext => {
  const style = options.style ?? CLASSIC_STYLE
  return { ordinal: 0, detailsOpen: options.detailsOpen, style, roles: rolesOf(style) }
}

/** The initial open state of each `<details>` block of a Markdown source, in document order, so a caller can keep one state per block. */
export function detailsDefaults(source: string): boolean[] {
  return (source.match(/<details\b[^>]*>/gi) ?? []).map((tag) => /\sopen\b/i.test(tag))
}

/**
 * Streaming-safe Markdown → styled terminal lines. Handles the subset that matters in agent output:
 * headings, paragraphs with inline styles, nested/ordered/task lists, quotes and callouts, rules, GFM tables, fenced
 * code, mermaid diagrams, LaTeX math (inline `$…$`, display `$$…$$` / `\[…\]`) shown as Unicode, collapsible
 * `<details>` blocks and the inline HTML models emit (`<br>`, `<kbd>`, `<sub>`, `<sup>`, `<b>`, `<i>`…).
 * Unclosed fences and partial tables render what they have, so streamed text never disappears (S1) and no
 * line is wider than `width`. `options.style` selects the enhanced engine of the `full` renderer.
 */
export function renderMarkdown(source: string, width: number, base: ColorName = "body", options: MarkdownOptions = {}): Line[] {
  if (source.length < SETTLED_MIN_CHARS || STATEFUL_SOURCE.test(source)) return render(source, width, base, contextOf(options))
  return renderSettled(source, width, base, options.style ?? CLASSIC_STYLE)
}

/** The same rendering without the settled-prefix memo below: the reference the memo is tested against. */
export function renderMarkdownWhole(source: string, width: number, base: ColorName = "body", options: MarkdownOptions = {}): Line[] {
  return render(source, width, base, contextOf(options))
}

/**
 * A streamed answer is drawn again at every delta although only its last paragraph changed. A blank line outside code
 * ends a block whose rows depend on nothing after it, provided the next line is not indented (an indented list item
 * would nest under the previous list). The rows before the last such line are kept per (width, colour, style) and
 * only the tail is rendered again, so a frame costs the length of the open paragraph, not of the whole answer.
 * `<details>` (numbered across blocks), display math (looks ahead) and diagrams (load lazily) render whole.
 */
const SETTLED_MIN_CHARS = 1200
const SETTLED_KEPT = 4
const STATEFUL_SOURCE = /<details|\$\$|\\\[|mermaid/i
const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/
type Settled = { width: number; base: ColorName; style: string; text: string; rows: Line[] }
const settledSources: Settled[] = []

const joinBlocks = (rows: Line[], next: Line[]): Line[] => (!next.length ? rows : rows.length ? [...rows, [], ...next] : next)

function renderSettled(source: string, width: number, base: ColorName, style: MarkdownStyle): Line[] {
  const key = styleKey(style)
  const known = settledSources.find((entry) => entry.width === width && entry.base === base && entry.style === key && source.startsWith(entry.text))
  let rows = known?.rows ?? []
  let consumed = known?.text.length ?? 0
  const lines = source.slice(consumed).split("\n")
  const piece = (from: number, to: number) => render(lines.slice(from, to).join("\n"), width, base, contextOf({ style }))
  let fence: { char: string; size: number } | undefined
  let start = 0
  for (let at = 0; at < lines.length - 1; at++) {
    const raw = lines[at]!
    if (fence) {
      if (closesFence(raw, fence)) fence = undefined
      continue
    }
    const open = FENCE_OPEN.exec(raw)
    if (open) {
      fence = { char: open[1]![0]!, size: open[1]!.length }
      continue
    }
    const next = lines[at + 1]!
    if (raw.trim() || !next.trim() || /^\s/.test(next)) continue
    rows = joinBlocks(rows, piece(start, at))
    for (let line = start; line <= at; line++) consumed += lines[line]!.length + 1
    start = at + 1
  }
  if (consumed > (known?.text.length ?? 0)) {
    const kept = { width, base, style: key, text: source.slice(0, consumed), rows }
    if (known) settledSources.splice(settledSources.indexOf(known), 1)
    settledSources.unshift(kept)
    settledSources.length = Math.min(settledSources.length, SETTLED_KEPT)
  }
  return joinBlocks(rows, piece(start, lines.length)).slice()
}

const QUOTE_LINE = /^\s*>\s?(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:\s*(.*)$/

/** The index of the line that closes the fence opened at `from`, or -1 while it is still open. */
function fenceEnd(lines: string[], from: number, fence: { char: string; size: number }) {
  for (let at = from + 1; at < lines.length; at++) if (closesFence(lines[at]!, fence)) return at
  return -1
}

/** Rows as the plain text a terminal shows: no styling, no trailing blanks. */
const plainRows = (rows: Line[]) => rows.map((row) => plainText(row).trimEnd()).join("\n").replace(/\n+$/, "")

function render(source: string, width: number, base: ColorName, context: RenderContext): Line[] {
  const { style, roles } = context
  const enhanced = style.enhanced
  const buttons = (kind: "code" | "block") => enhanced && (style.copy === "all" || (style.copy === "code" && kind === "code"))
  const out: Line[] = []
  const lines = source.split("\n")
  let fence: { char: string; size: number; lang: string; state: HighlightState; code: string } | undefined
  let paragraph: string[] = []
  let indents: number[] = []
  /** The list or quote run in progress: the first line after it, and its source (what the copy key puts on the clipboard). */
  let listEnd = 0
  let listText = ""
  let quoteEnd = 0
  let quoteStart = 0
  let quoteText = ""
  let quoteKind: Callout | undefined

  const flush = () => {
    if (paragraph.length) out.push(...paragraphRows(inline(paragraph.join(" "), base, {}, style), width, style))
    paragraph = []
  }

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    if (fence) {
      if (closesFence(raw, fence)) fence = undefined
      else {
        const rows = codeLines({ raw, width, lang: fence.lang, state: fence.state, style })
        out.push(...(enhanced ? tagCopy(rows, fence.code, `${fence.lang || "text"} code`) : rows))
      }
      continue
    }
    const open = FENCE_OPEN.exec(raw)
    if (open) {
      flush()
      indents = []
      const marker = { char: open[1]![0]!, size: open[1]!.length }
      const closing = fenceEnd(lines, index, marker)
      const body = lines.slice(index + 1, closing < 0 ? lines.length : closing)
      fence = { ...marker, lang: open[2]!, state: {}, code: body.join("\n") }
      if (open[2]!.toLowerCase() === "mermaid" && closing > index) {
        out.push(...diagramRows({ body, width, style, roles }))
        fence = undefined
        index = closing
        continue
      }
      if (enhanced) out.push(...tagCopy([codeHeader({ lang: open[2]!, code: fence.code, width, style, roles })], fence.code, `${open[2] || "text"} code`))
      else if (open[2]) out.push(chrome([{ text: GUTTER, fg: "border" }, { text: open[2], fg: "muted" }]))
      continue
    }
    if (!raw.trim()) {
      flush()
      if (out.length && out[out.length - 1]!.length) out.push([])
      continue
    }
    const details = detailsAt(lines, index)
    if (details) {
      flush()
      indents = []
      const ordinal = context.ordinal++
      out.push(...detailsBlock({ ...details, open: context.detailsOpen?.(ordinal) ?? details.open, width, base, context, ordinal }))
      index = details.end - 1
      continue
    }
    const math = displayMathAt(lines, index)
    if (math) {
      flush()
      indents = []
      for (const row of mathDisplay(math.source, Math.max(1, width - 2))) {
        // Stacked rows keep their spacing; only a flat row wider than the viewport is word-wrapped.
        if (textWidth(row) + 2 <= width) out.push([{ text: `  ${row}`, fg: "accent" }])
        else out.push(...wrapSpans([{ text: row, fg: "accent" }], width, [{ text: "  " }]))
      }
      index = math.end - 1
      continue
    }
    if (isTableStart(lines, index)) {
      flush()
      indents = []
      const end = tableEnd(lines, index)
      const drawn = tableRows({ source: lines.slice(index, end), width, base, style, roles, hasSeparator: isSeparatorAt(lines, index + 1) })
      if (enhanced) {
        const source = lines.slice(index, end).join("\n")
        if (buttons("block")) hintTable(drawn, { source, roles })
        tagCopy(drawn, source, "table")
      }
      out.push(...drawn)
      index = end - 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      flush()
      indents = []
      if (!enhanced) {
        out.push(...wrapSpans(inline(heading[2]!, "heading").map((s) => ({ ...s, bold: true })), width))
        continue
      }
      if (out.length && out[out.length - 1]!.length) out.push([])
      const level = heading[1]!.length
      const spans = inline(heading[2]!, levelRole(level, roles), {}, style)
      out.push(...headingRows({ level, spans, width, style, roles, sourceText: plainText(spans) }))
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flush()
      indents = []
      out.push(enhanced ? [{ text: "─".repeat(width), fg: roles.rule }] : [{ text: "─".repeat(Math.min(width, 40)), fg: "muted", dim: true }])
      continue
    }
    const quote = QUOTE_LINE.exec(raw)
    if (quote) {
      flush()
      indents = []
      if (!enhanced) {
        out.push(...wrapSpans(inline(quote[1]!, "muted"), width, [{ text: "│ ", fg: "muted" }]).map((row) => (markGutter(row, 2), row)))
        continue
      }
      if (index >= quoteEnd) {
        quoteStart = index
        quoteEnd = index
        while (quoteEnd < lines.length && QUOTE_LINE.test(lines[quoteEnd]!)) quoteEnd++
        quoteKind = calloutOf(raw)
        quoteText = lines.slice(index, quoteEnd).map((line) => line.replace(/^\s*>[ \t]?/, "")).join("\n")
      }
      out.push(...tagCopy(quoteRows({ raw, width, style, roles, kind: quoteKind, first: index === quoteStart }), quoteText, "quote"))
      continue
    }
    const footnote = enhanced ? FOOTNOTE_DEFINITION.exec(raw.trim()) : null
    if (footnote) {
      flush()
      indents = []
      const label = /^\d+$/.test(footnote[1]!) ? superscript(footnote[1]!) : `[${footnote[1]}]`
      out.push(...wrapSpans(inline(footnote[2]!, roles.quote, {}, style), width, [{ text: `${label} `, fg: roles.footnote }]))
      continue
    }
    const item = LIST_ITEM.exec(raw)
    if (item) {
      flush()
      if (index >= listEnd) {
        listEnd = index
        while (listEnd < lines.length && LIST_ITEM.test(lines[listEnd]!)) listEnd++
        listText = lines.slice(index, listEnd).join("\n")
      }
      const rows = listItem({ indent: item[1]!.replaceAll("\t", "    ").length, marker: item[2]!, text: item[3]!, indents, width, base, style })
      out.push(...(enhanced ? tagCopy(rows, listText, "list") : rows))
      continue
    }
    indents = []
    paragraph.push(raw.trim())
  }
  flush()
  while (out.length && out[out.length - 1]!.length === 0) out.pop()
  return out
}

/** A paragraph's rows; in the enhanced style a paragraph that starts with a right-to-left letter is reordered visually and right-aligned. */
function paragraphRows(spans: Span[], width: number, style: MarkdownStyle): Line[] {
  const rows = wrapSpans(spans, width)
  if (!style.enhanced || !style.rtl) return rows
  const text = plainText(spans)
  if (!hasRtl(text)) return rows
  const base = firstStrong(text) ?? "ltr"
  return rows.map((row) => {
    const visual = visualRow(row, base)
    return base === "rtl" ? alignRight(visual, width) : visual
  })
}

const countOf = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

type DetailsBlock = { summary: string; body: string; open: boolean; end: number }

/** A `<details>` element starting at `lines[index]`, through its matching `</details>` (or the end of a still-streaming source). */
function detailsAt(lines: string[], index: number): DetailsBlock | undefined {
  const first = lines[index]!.trim()
  if (!/^<details\b[^>]*>/i.test(first)) return undefined
  let depth = 0
  let end = index
  while (end < lines.length) {
    depth += countOf(lines[end]!, DETAILS_OPEN) - countOf(lines[end]!, DETAILS_CLOSE)
    end++
    if (depth <= 0) break
  }
  const raw = lines.slice(index, end).join("\n").trim()
  const closing = raw.toLowerCase().lastIndexOf("</details")
  const inner = (closing >= 0 && depth <= 0 ? raw.slice(0, closing) : raw).replace(/^<details\b[^>]*>/i, "")
  const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(inner)
  return {
    summary: summary?.[1]?.replace(/\s+/g, " ").trim() || "Details",
    body: (summary ? inner.replace(summary[0], "") : inner).trim(),
    open: /^<details\b[^>]*\sopen\b/i.test(first),
    end,
  }
}

/** The collapsed or expanded form of a `<details>` block: a ▸/▾ summary line, then the indented body when open. */
function detailsBlock(input: DetailsBlock & { width: number; base: ColorName; context: RenderContext; ordinal: number }): Line[] {
  const { summary, body, open, width, base, context, ordinal } = input
  const rows = render(body, Math.max(1, width - 2), base, context)
  const hidden = rows.filter((row) => row.length).length
  const summarySpans = inline(summary, "heading", {}, context.style).map((span): Span => ({ ...span, bold: true }))
  // The count of a folded block ends the wrapped summary, so it wraps with it instead of passing the width.
  const spans: Span[] = open ? summarySpans : [...summarySpans, { text: ` · ${hidden} ${hidden === 1 ? "line" : "lines"}`, fg: "muted", dim: true }]
  const out = wrapSpans(spans, width, [{ text: open ? "▾ " : "▸ ", fg: "primary" }], [{ text: "  " }])
  // Every row of a wrapped summary answers a click, not just the first.
  for (const row of out) markFold(row, ordinal)
  if (open) return [...out, ...rows.map((row): Line => (row.length ? carryPicture(row, carryCopy(row, carryFold(row, [{ text: "  " }, ...row]), 2), 2) : row))]
  return out
}

/** A `$$…$$` or `\[…\]` block on its own lines (or on one line), never one with trailing text or no closing delimiter. */
function displayMathAt(lines: string[], index: number): { source: string; end: number } | undefined {
  const first = lines[index]!.trim()
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : undefined
  if (!open) return undefined
  const close = open === "$$" ? "$$" : "\\]"
  const rest = first.slice(open.length)
  const sameLine = rest.indexOf(close)
  if (sameLine >= 0) return rest.slice(sameLine + close.length).trim() ? undefined : { source: rest.slice(0, sameLine), end: index + 1 }
  const body = [rest]
  for (let at = index + 1; at < lines.length && at <= index + MAX_MATH_LINES; at++) {
    const closing = lines[at]!.indexOf(close)
    if (closing < 0) {
      body.push(lines[at]!)
      continue
    }
    if (lines[at]!.slice(closing + close.length).trim()) return undefined
    body.push(lines[at]!.slice(0, closing))
    return { source: body.join("\n"), end: at + 1 }
  }
  return undefined
}

function listItem(input: { indent: number; marker: string; text: string; indents: number[]; width: number; base: ColorName; style: MarkdownStyle }): Line[] {
  const { indent, marker, indents, width, base, style } = input
  const roles = rolesOf(style)
  while (indents.length && indent < indents[indents.length - 1]!) indents.pop()
  if (!indents.length || indent > indents[indents.length - 1]!) indents.push(indent)
  const level = Math.min(indents.length - 1, MAX_LIST_LEVEL)
  const pad = " ".repeat(level * 2)
  const task = /^\[([ xX])\]\s+(.*)$/.exec(input.text)
  const ordered = /\d/.test(marker)
  const done = task ? task[1] !== " " : false
  const lead: Span = task
    ? style.enhanced
      ? { text: done ? "✓ " : "○ ", fg: done ? roles.taskDone : roles.taskOpen }
      : { text: done ? "[x] " : "[ ] ", fg: done ? "success" : "muted" }
    : { text: ordered ? `${marker} ` : `${BULLETS[Math.min(level, BULLETS.length - 1)]} `, fg: roles.listMarker }
  const spans = inline(task ? task[2]! : input.text, base, {}, style)
  const text = plainText(spans)
  if (style.enhanced && style.rtl && firstStrong(text) === "rtl") {
    // Right-to-left items hang from the right edge: the marker last, nested levels pulled in from the right.
    const room = Math.max(1, width - level * 2 - textWidth(lead.text))
    return wrapSpans(spans, room).map((row, at) => {
      const visual = visualRow(row, "rtl")
      const marked: Line = [...visual, { text: " " }, at ? { text: " ".repeat(textWidth(lead.text) - 1) } : { ...lead, text: lead.text.trimEnd() }]
      return alignRight(marked, width - level * 2)
    })
  }
  return wrapSpans(spans, width, [{ text: pad }, lead], [{ text: pad + " ".repeat(textWidth(lead.text)) }])
}

const CALLOUT_MARK = new RegExp(`^\\[!(${CALLOUTS.join("|")})\\]\\s*(.*)$`, "i")

/** A quote line as its nesting depth and text. */
function parseQuote(line: string) {
  let depth = 0
  let rest = line
  for (let match = /^\s*>[ \t]?/.exec(rest); match; match = /^\s*>[ \t]?/.exec(rest)) {
    depth++
    rest = rest.slice(match[0].length)
  }
  return { depth: Math.max(1, depth), text: rest }
}

/** The callout a quote group opens with (`> [!NOTE]`), when its first line is at depth 1. */
function calloutOf(firstLine: string): Callout | undefined {
  const first = parseQuote(firstLine)
  const mark = first.depth === 1 ? CALLOUT_MARK.exec(first.text.trim()) : null
  return mark ? (mark[1]!.toLowerCase() as Callout) : undefined
}

/** Rows of one `>` line of a quote group: bars per nesting depth, callout labels and coloured rails. */
function quoteRows(input: { raw: string; width: number; style: MarkdownStyle; roles: Roles; kind: Callout | undefined; first: boolean }): Line[] {
  const { raw, width, style, roles, kind, first } = input
  const at = parseQuote(raw)
  const rail: ColorName = kind ? calloutRole(kind, roles) : roles.quoteBar
  const bar = (glyph: string): Span[] => Array.from({ length: at.depth }, () => ({ text: `${glyph} `, fg: rail }))
  if (kind && first) {
    const title = CALLOUT_MARK.exec(at.text.trim())![2]!
    const label: Span[] = [{ text: CALLOUT_LABELS[kind], fg: rail, bold: true }, ...(title ? [{ text: " " }, ...inline(title, roles.quote, {}, style)] : [])]
    return wrapSpans(label, width, bar("┃")).map((row) => (markGutter(row, 2), row))
  }
  const spans = inline(at.text, roles.quote, {}, style)
  const prefix = bar(kind ? "┃" : "│")
  const text = plainText(spans)
  if (style.rtl && hasRtl(text) && firstStrong(text) === "rtl") {
    const room = Math.max(1, width - 2 * at.depth)
    return wrapSpans(spans, room).map((row) => alignRight([...visualRow(row, "rtl"), { text: " " }, ...prefix.map((span) => ({ ...span, text: span.text.trimEnd() }))], width))
  }
  return wrapSpans(spans, width, prefix).map((row) => (markGutter(row, 2 * at.depth), row))
}

function closesFence(raw: string, fence: { char: string; size: number }) {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(raw)
  return !!match && match[1]![0] === fence.char && match[1]!.length >= fence.size
}

/** Hard-wraps styled code spans at cell width, first chunk `first` cells and the rest `rest` cells. */
function chunkCode(spans: Span[], first: number, rest: number): Span[][] {
  const chunks: Span[][] = []
  let current: Span[] = []
  let used = 0
  let cap = first
  for (const span of spans) {
    let buffer = ""
    for (const { text: char, width: w } of cells(span.text)) {
      if (used + w > cap && used > 0) {
        if (buffer) current.push({ ...span, text: buffer })
        buffer = ""
        chunks.push(current)
        current = []
        used = 0
        cap = rest
      }
      buffer += char
      used += w
    }
    if (buffer) current.push({ ...span, text: buffer })
  }
  chunks.push(current)
  return chunks
}

/** The bar of a diff line in the enhanced style: green for an addition, red for a removal, blue for a hunk. */
function diffBar(lang: string, text: string): ColorName | undefined {
  if (!/^(diff|patch)$/i.test(lang) || /^(\+\+\+|---)/.test(text)) return undefined
  return text.startsWith("+") ? "success" : text.startsWith("-") ? "error" : text.startsWith("@@") ? "info" : undefined
}

/** One code line: a border gutter, then the line's tokens colored by `lang` (plain `code` for unknown languages). Long lines wrap behind a `↪` marker. */
function codeLines(input: { raw: string; width: number; lang?: string; state?: HighlightState; style?: MarkdownStyle }): Line[] {
  const { raw, width, lang = "", state, style = CLASSIC_STYLE } = input
  const roles = rolesOf(style)
  const text = raw.replaceAll("\t", "  ")
  const spans = highlight(text, lang, state)
  const chunks = chunkCode(spans, Math.max(1, width - GUTTER.length), Math.max(1, width - GUTTER.length - CONTINUATION.length))
  const bar = style.enhanced ? (diffBar(lang, text) ?? roles.codeBorder) : roles.codeBorder
  return chunks.map((chunk, i): Line => {
    const gutter: Span = { text: GUTTER, fg: bar }
    const row: Line = i === 0 ? [gutter, ...chunk] : [gutter, { text: CONTINUATION, fg: "muted", dim: true }, ...chunk]
    // A wrapped code line goes back together without a space, and neither the bar nor the `↪` is code.
    markGutter(row, i === 0 ? GUTTER.length : GUTTER.length + CONTINUATION.length)
    if (i > 0) markSoftWrapped(row, "none")
    return row
  })
}

/** The header of a fenced block in the enhanced style: its language and, when buttons are on, `copy` (the source). */
function codeHeader(input: { lang: string; code: string; width: number; style: MarkdownStyle; roles: Roles }): Line {
  const { lang, code, width, style, roles } = input
  const label = lang || "text"
  const buttons: HeaderButton[] = style.copy === "off" ? [] : [{ text: "copy", copy: code, label: `${label} code` }]
  return blockHeader({ label, width, roles, buttons })
}

/** A mermaid fence as a rendered diagram, or its source when it cannot be drawn (and a placeholder while the renderer loads). */
function diagramRows(input: { body: string[]; width: number; style: MarkdownStyle; roles: Roles }): Line[] {
  const { body, width, style, roles } = input
  const code = body.join("\n")
  const kind = body.find((line) => line.trim() && !line.trim().startsWith("%%"))?.trim().split(/\s+/)[0] ?? "mermaid"
  /** The header of a diagram shown as source: it reads as a code block, so it gets the code header. */
  const sourceHeader = (): Line =>
    style.enhanced
      ? tagCopy([blockHeader({ label: kind, width, roles, buttons: style.copy === "off" ? [] : [{ text: "copy", copy: code, label: "diagram" }] })], code, "diagram")[0]!
      : chrome([{ text: GUTTER, fg: "border" }, { text: "mermaid", fg: "muted" }])
  const render = ensureMermaid()
  if (!render) return style.enhanced ? [[{ text: "loading diagram…", fg: "muted", dim: true }]] : [sourceHeader(), [{ text: "loading diagram…", fg: "muted", dim: true }]]
  const diagram = render(code, width)
  if ("lines" in diagram) {
    if (!style.enhanced) return diagram.lines
    // The diagram's own lines are drawn in `heading` and `accent`; the enhanced style gives them their own slots.
    const recolored = diagram.lines.map((row) => carryPicture(row, row.map((span): Span => (span.fg === "heading" ? { ...span, fg: roles.diagramLine } : span.fg === "accent" ? { ...span, fg: roles.diagramAccent } : span))))
    // Some layouts pad their canvas with empty rows above and below.
    const blank = (row: Line) => !row.some((span) => span.text.trim())
    const first = recolored.findIndex((row) => !blank(row))
    const drawn = first < 0 ? recolored : recolored.slice(first, recolored.findLastIndex((row) => !blank(row)) + 1)
    if (style.copy === "all" && drawn.length) hintDiagram(drawn, { code, art: plainRows(drawn), width, roles })
    return tagCopy(drawn, code, "diagram")
  }
  return [sourceHeader(), ...body.flatMap((line) => codeLines({ raw: line, width, style })), ...wrapSpans([{ text: diagram.note, fg: "muted", dim: true }], width)]
}

/** Below this width a table or diagram has no room for a hint on its own art: the key is the only way to copy. */
const HINT_MIN_WIDTH = 12

/** `┌───────┬──── copy ┐`: the `copy` hint on a boxed table's top border, right-aligned to the table. Rules, minimal and stacked tables have no top border. */
function hintTable(rows: Line[], input: { source: string; roles: Roles }) {
  const top = rows[0]
  const text = top ? plainText(top) : ""
  const total = textWidth(text)
  if (!top || !text.startsWith("┌") || total < HINT_MIN_WIDTH) return
  const hinted = overlayHint({ row: top, end: total - 1, buttons: [{ text: "copy", copy: input.source, label: "table" }], roles: input.roles, accept: (cut) => /^─+$/.test(cut), tail: { ...top[0]!, text: text.slice(-1) } })
  if (hinted) rows[0] = hinted
}

/** `art  copy` after the first row of a diagram, to the right of its art (or flush right when it fills the width), only where those cells are blank. */
function hintDiagram(rows: Line[], input: { code: string; art: string; width: number; roles: Roles }) {
  const widest = Math.max(...rows.map((row) => textWidth(plainText(row).trimEnd())))
  if (widest < HINT_MIN_WIDTH) return
  const buttons: HeaderButton[] = [{ text: "art", copy: input.art, label: "diagram as drawn" }, { text: "copy", copy: input.code, label: "diagram" }]
  const hinted = overlayHint({ row: rows[0]!, end: Math.min(input.width, widest + 1 + 9), buttons, roles: input.roles, accept: (cut) => !cut.trim() })
  if (hinted) rows[0] = hinted
}

// ---------------------------------------------------------------------------------------------
// Tables

const SEPARATOR_ROW = /^\s*(\|[\s:|-]*|:?-+:?\s*\|[\s:|-]*)$/

/** A separator row; while streaming, a last line of only pipes/colons/spaces is a separator in progress. */
function isSeparatorAt(lines: string[], index: number) {
  const line = lines[index]
  if (line === undefined || !SEPARATOR_ROW.test(line) || !line.includes("|")) return false
  return line.includes("-") || index === lines.length - 1
}

function isTableStart(lines: string[], index: number) {
  if (!lines[index]!.includes("|")) return false
  if (index + 1 === lines.length) return lines[index]!.trimStart().startsWith("|")
  return isSeparatorAt(lines, index + 1)
}

function tableEnd(lines: string[], start: number) {
  let end = start + 1
  if (isSeparatorAt(lines, end)) end++
  while (end < lines.length && lines[end]!.trim() && lines[end]!.includes("|")) end++
  return end
}

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"))
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":")
  const right = cell.endsWith(":")
  return left && right ? "center" : right ? "right" : "left"
}

function tableRows(input: { source: string[]; width: number; base: ColorName; style: MarkdownStyle; roles: Roles; hasSeparator: boolean }): Line[] {
  const { source, width, base, style, roles, hasSeparator } = input
  const header = splitRow(source[0]!)
  const aligns = hasSeparator ? splitRow(source[1]!).map(alignOf) : []
  const columns = header.length
  const body = source.slice(hasSeparator ? 2 : 1).map((row) => {
    const cells = splitRow(row).slice(0, columns)
    while (cells.length < columns) cells.push("")
    return cells
  })
  const cellSpans = [header, ...body].map((row, r) => row.map((text) => (r === 0 ? inline(text, roles.tableHeader, {}, style).map((s) => ({ ...s, bold: true })) : inline(text, base, {}, style))))
  return renderTable({ cells: cellSpans, aligns, width, style, roles })
}

// ---------------------------------------------------------------------------------------------
// Inline

const INLINE = new RegExp(
  [
    "`([^`]+)`",
    "\\*\\*(.+?)\\*\\*",
    "~~(.+?)~~",
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)",
    "<(https?:\\/\\/[^>\\s]+)>",
    "(https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?)\\]'\"])",
    "(?<!\\*)\\*(?![\\s*])([^*]*?[^*\\s])\\*(?!\\*)",
    "(?<![\\w])_(?![\\s_])([^_]*?[^_\\s])_(?!\\w)",
    "\\$\\$(.+?)\\$\\$",
    "\\\\\\((.+?)\\\\\\)",
    "(?<![\\w$\\\\])\\$(?![\\s$])([^$\\n]*?[^$\\s\\\\])\\$(?![\\w$])",
    "<kbd>(.*?)<\\/kbd>",
    "<sub>(.*?)<\\/sub>",
    "<sup>(.*?)<\\/sup>",
    "<(?:b|strong)>(.*?)<\\/(?:b|strong)>",
    "<(?:i|em)>(.*?)<\\/(?:i|em)>",
    "<(?:s|del|strike)>(.*?)<\\/(?:s|del|strike)>",
    "<code>(.*?)<\\/code>",
    "<a\\s[^>]*?href=\"([^\"]*)\"[^>]*>(.*?)<\\/a>",
    "<img\\b[^>]*?\\balt=\"([^\"]*)\"[^>]*>",
    "&(nbsp|lt|gt|amp|quot|apos|#39|copy|mdash|ndash|hellip);",
    "(<br\\s*\\/?>)",
    "(<\\/?(?:p|div|span|center|small|u|ins|mark|font|abbr|cite|q|var|samp|tt|table|tr|td|th|thead|tbody|ul|ol|li|h[1-6]|hr|section|article|summary|details|figure|figcaption|picture|source|sup|sub|kbd|b|i|em|strong|s|del|strike|code|a|img)\\b[^>\\n]*>|<!--.*?-->)",
    "\\[\\^([^\\]\\s]+)\\](?!:)",
  ].join("|"),
  "g",
)
const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", "#39": "'", copy: "©", mdash: "—", ndash: "–", hellip: "…" }
const plainOf = (text: string) => text.replace(/<[^>]*>/g, "")
const HEX = /(?<![\w#&/.=?-])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![\w])/g

function expandHex(hex: string) {
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
}

/** Text with a colored `■` swatch inserted before every hex color. */
function withSwatches(text: string, style: RichSpan): RichSpan[] {
  const spans: RichSpan[] = []
  let last = 0
  for (const match of text.matchAll(HEX)) {
    if (match.index! > last) spans.push({ ...style, text: text.slice(last, match.index) })
    spans.push({ text: "■", fg: "muted", fgHex: expandHex(match[0]) }, { ...style, text: match[0] })
    last = match.index! + match[0].length
  }
  if (last < text.length) spans.push({ ...style, text: text.slice(last) })
  return spans
}

/** Inline styles: `code`, **bold**, ~~strike~~, *italic*, [label](url), autolinks, footnote references and hex swatches. `md` picks the colour roles and the enhanced touches (struck-through text, underlined links). */
export function inline(text: string, base: ColorName, style: Partial<RichSpan> = {}, md: MarkdownStyle = CLASSIC_STYLE): Span[] {
  const spans: RichSpan[] = []
  const roles = rolesOf(md)
  const styled = (fg: ColorName, extra: Partial<RichSpan> = {}): RichSpan => ({ text: "", fg, ...style, ...extra })
  const linked = (extra: Partial<RichSpan> | undefined): Partial<RichSpan> => (md.enhanced ? { underline: true, ...extra } : { ...extra })
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    if (match.index! > last) spans.push(...withSwatches(text.slice(last, match.index), styled(base)))
    if (match[1] !== undefined) spans.push(...withSwatches(match[1], styled(roles.inlineCode)))
    else if (match[2] !== undefined) spans.push(...inline(match[2], base, { ...style, bold: true }, md))
    else if (match[3] !== undefined) spans.push(...inline(match[3], roles.strike, md.enhanced ? { ...style, strike: true } : style, md))
    else if (match[4] !== undefined) {
      spans.push(...inline(match[4], roles.link, { ...style, ...linked(webLink(match[5]!)) }, md))
      if (match[4] !== match[5]) spans.push({ ...styled("muted", { dim: true }), text: ` (${match[5]})` })
    } else if (match[6] !== undefined) spans.push({ ...styled(roles.link, linked(webLink(match[6]))), text: match[6] })
    else if (match[7] !== undefined) spans.push({ ...styled(roles.link, linked(webLink(match[7]))), text: match[7] })
    else if (match[8] !== undefined || match[9] !== undefined) spans.push(...inline((match[8] ?? match[9])!, base, { ...style, italic: true }, md))
    else if (match[10] !== undefined || match[11] !== undefined || match[12] !== undefined) spans.push({ ...styled("accent"), text: mathInline((match[10] ?? match[11] ?? match[12])!) })
    else if (match[13] !== undefined) spans.push({ ...styled(roles.inlineCode, { bold: true }), text: `[${plainOf(match[13])}]` })
    else if (match[14] !== undefined) spans.push({ ...styled(base), text: subscript(plainOf(match[14])) })
    else if (match[15] !== undefined) spans.push({ ...styled(base), text: superscript(plainOf(match[15])) })
    else if (match[16] !== undefined) spans.push(...inline(match[16], base, { ...style, bold: true }, md))
    else if (match[17] !== undefined) spans.push(...inline(match[17], base, { ...style, italic: true }, md))
    else if (match[18] !== undefined) spans.push(...inline(match[18], roles.strike, md.enhanced ? { ...style, strike: true } : style, md))
    else if (match[19] !== undefined) spans.push(...withSwatches(match[19], styled(roles.inlineCode)))
    else if (match[20] !== undefined) {
      const label = match[21] ?? ""
      spans.push(...inline(label, roles.link, { ...style, ...linked(webLink(match[20])) }, md))
      if (label !== match[20] && match[20]) spans.push({ ...styled("muted", { dim: true }), text: ` (${match[20]})` })
    } else if (match[22] !== undefined) spans.push({ ...styled("muted"), text: match[22] ? `[${match[22]}]` : "[image]" })
    else if (match[23] !== undefined) spans.push({ ...styled(base), text: ENTITIES[match[23]] ?? token })
    else if (match[24] !== undefined) spans.push({ text: BREAK })
    else if (match[26] !== undefined) spans.push(md.enhanced ? { ...styled(roles.footnote), text: /^\d+$/.test(match[26]) ? superscript(match[26]) : `[${match[26]}]` } : { ...styled(base), text: token })
    last = match.index! + token.length
  }
  if (last < text.length) spans.push(...withSwatches(text.slice(last), styled(base)))
  return spans
}
