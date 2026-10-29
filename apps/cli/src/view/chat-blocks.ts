import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { clip as clipRow } from "./deck"
import { compact } from "./format"
import { formatCost } from "./stat-parts"
import { renderMarkdown, wrapSpans } from "./markdown"
import { formatDuration } from "./time"
import { lineWidth as widthOf } from "./wrap"

/**
 * The non-tool blocks of v1's live transcript (`routes/session/index.tsx`): the user message panel, the
 * per-turn completion line, the error box, reasoning and compaction. Pure: data and a width in, styled rows out.
 */

const INDENT = "  "
/** v1 `userMessageDisplayText` defaults. */
export const USER_MAX_LINES = 18
export const USER_MAX_CHARS = 2400
const ERROR_MAX_ROWS = 10
const MAX_CHIPS = 4
export const FULL_REASONING_ROWS = 40


/** A row on v1's panel fill: one column of margin each side, `bar` (an error rail) first, the row padded to the panel's edge. */
export function panelRow(line: Line, width: number, bar?: Span): Line {
  const lead = bar ? [{ ...bar, bg: "panel" as const }] : []
  const used = widthOf(line) + lead.length
  return [{ text: " " }, ...lead, ...line.map((span) => ({ ...span, bg: span.bg ?? ("panel" as const) })), { text: " ".repeat(Math.max(0, width - 2 - used)), bg: "panel" as const }]
}

/** The first `USER_MAX_LINES` lines / `USER_MAX_CHARS` characters of a message, and what was left out. */
export function truncateMessage(text: string, limits: { lines?: number; chars?: number } = {}) {
  const maxLines = limits.lines ?? USER_MAX_LINES
  const maxChars = limits.chars ?? USER_MAX_CHARS
  const all = text.split("\n")
  if (all.length <= maxLines && text.length <= maxChars) return { text, hiddenChars: 0, hiddenLines: 0 }
  const kept: string[] = []
  let chars = 0
  for (const line of all) {
    if (kept.length >= maxLines || chars + line.length > maxChars) break
    kept.push(line)
    chars += line.length + 1
  }
  if (!kept.length) kept.push(text.slice(0, maxChars))
  const shown = kept.join("\n")
  return { text: shown, hiddenChars: Math.max(0, text.length - shown.length), hiddenLines: Math.max(0, all.length - kept.length) }
}

/** `label` is the token the attachment stood for in the sent text (`[Image #1]`), when it had one. */
export type Attachment = { name?: string; mime: string; sha256?: string; label?: string; bytes?: number }

/** The attachments the sentence does not show: those with no token, and those whose token is not in the part of the text on screen. Those get a chip row under the message. */
export function outsideText(attachments: readonly Attachment[], shown: string): Attachment[] {
  const seen = new Map<string, number>()
  return attachments.filter((file) => {
    if (!file.label) return true
    const used = (seen.get(file.label) ?? 0) + 1
    seen.set(file.label, used)
    return shown.split(file.label).length - 1 < used
  })
}

/** Stands in for the space inside a token while a message is wrapped, so a token is one word; put back as a space afterwards. */
const TOKEN_SPACE = ""

/**
 * The text of a sent message as styled rows: each attachment token in it drawn as the chip badge of its kind (the prompt draws it
 * the same way), kept on one row. Plain text when no attachment has a token.
 */
export function messageRows(text: string, attachments: readonly Attachment[], width: number, first: Span[], rest?: Span[]): Line[] {
  const hits: Array<{ start: number; end: number; bg: ColorName }> = []
  for (const file of attachments) {
    if (!file.label) continue
    const bg: ColorName = file.mime.startsWith("image/") ? "accent" : file.mime === "application/pdf" ? "primary" : "secondary"
    for (let at = text.indexOf(file.label); at >= 0; at = text.indexOf(file.label, at + file.label.length)) {
      if (!hits.some((hit) => hit.start < at + file.label!.length && at < hit.end)) {
        hits.push({ start: at, end: at + file.label.length, bg })
        break
      }
    }
  }
  // A text file or folder is not a ref: its fenced block sits in the text right after its token, which is how the token is known.
  for (const match of text.matchAll(/\[[^\[\]\n]+\](?=\n\n\[attached file: )/g)) {
    const start = match.index!
    const end = start + match[0].length
    if (!hits.some((hit) => hit.start < end && start < hit.end)) hits.push({ start, end, bg: "secondary" })
  }
  if (!hits.length) return wrapSpans([{ text, fg: "text" }], width, first, rest)
  hits.sort((a, b) => a.start - b.start)
  const rows: Line[] = []
  const hanging = rest ?? first.map((span): Span => ({ text: " ".repeat(widthOf([span])) }))
  let lineStart = 0
  for (const line of text.split("\n")) {
    const spans: Span[] = []
    let at = lineStart
    const lineEnd = lineStart + line.length
    for (const hit of hits) {
      if (hit.start < at || hit.end > lineEnd) continue
      if (hit.start > at) spans.push({ text: text.slice(at, hit.start), fg: "text" })
      spans.push({ text: text.slice(hit.start, hit.end).replaceAll(" ", TOKEN_SPACE), fg: "background", bg: hit.bg })
      at = hit.end
    }
    if (at < lineEnd) spans.push({ text: text.slice(at, lineEnd), fg: "text" })
    const wrapped = wrapSpans(spans.length ? spans : [{ text: "", fg: "text" }], width, rows.length ? hanging : first, hanging)
    rows.push(...wrapped.map((row): Line => row.map((span) => (span.text.includes(TOKEN_SPACE) ? { ...span, text: span.text.replaceAll(TOKEN_SPACE, " ") } : span))))
    lineStart = lineEnd + 1
  }
  return rows
}

/** v1's attachment chips: a ` img `/` pdf `/` txt ` badge (accent/primary/secondary) and the file name on an element chip. */
function chipRows(files: Attachment[], width: number, expanded: boolean): Line[] {
  const chips = files.map((file, at): Span[] => {
    const image = file.mime.startsWith("image/")
    const badge = { text: image ? " img " : file.mime === "application/pdf" ? " pdf " : " txt ", fg: "background" as const, bg: image ? ("accent" as const) : file.mime === "application/pdf" ? ("primary" as const) : ("secondary" as const) }
    const name = file.name ?? `${image ? "image" : "file"} ${at + 1}`
    return [badge, { text: ` ${name} `, fg: "muted", bg: "element" }]
  })
  const shown = expanded ? chips : chips.slice(0, MAX_CHIPS)
  const rows: Line[] = []
  let row: Line = []
  for (const chip of shown) {
    const chipWidth = widthOf(chip)
    if (row.length && widthOf(row) + 1 + chipWidth > width) {
      rows.push(row)
      row = []
    }
    row.push(...(row.length ? [{ text: " " }] : []), ...chip)
  }
  if (row.length) rows.push(row)
  if (chips.length > MAX_CHIPS) rows.push([{ text: expanded ? `▾ hide ${chips.length - MAX_CHIPS} extra attachments` : `▸ show ${chips.length - MAX_CHIPS} more`, fg: "muted" }])
  return rows
}

/**
 * v1's live user message: a `● You` header and the time right-aligned, no left bar or fill,
 * the text inset by two, chips for attachments. Long text is cut at 18 lines / 2400 chars.
 */
export function userBlock(input: { text: string; time: string; attachments: Attachment[]; width: number; expanded: boolean; glyphs: Glyphs; queued?: boolean; username?: string; header?: Line }): Line[] {
  const { width, glyphs } = input
  const inner = Math.max(4, width - 2 - 4)
  const shown = input.expanded ? { text: input.text, hiddenChars: 0, hiddenLines: 0 } : truncateMessage(input.text)
  const left: Line = input.header ?? [{ text: INDENT }, { text: glyphs.dot, fg: "primary" }, { text: ` ${input.username || "You"}`, fg: "muted" }]
  const right: Line = input.time ? [{ text: input.time, fg: "muted" }] : []
  const gap = Math.max(1, width - 2 - 2 - widthOf(left) - widthOf(right))
  const rows: Line[] = [[...left, ...(right.length ? [{ text: " ".repeat(gap) }, ...right, { text: INDENT }] : [])]]
  rows.push(...messageRows(shown.text, input.attachments, inner + INDENT.length, [{ text: INDENT }]))
  if (shown.hiddenChars > 0 || shown.hiddenLines > 0) {
    const lines = shown.hiddenLines > 0 ? ` · ${compact(shown.hiddenLines)} more line${shown.hiddenLines === 1 ? "" : "s"}` : ""
    rows.push([{ text: INDENT }, { text: `… ${compact(shown.hiddenChars)} chars hidden${lines} · ctrl+o to expand`, fg: "muted" }])
  }
  const unplaced = outsideText(input.attachments, shown.text)
  if (unplaced.length) rows.push([], ...chipRows(unplaced, inner, input.expanded).map((row): Line => [{ text: INDENT }, ...row]))
  rows.push([])
  return rows.map((row): Line => [{ text: " " }, ...row])
}

/** A `!command` the user ran: one command line in primary bold on the panel fill, the time on the right. */
export function shellUserBlock(input: { command: string; time: string; width: number; local?: boolean }): Line[] {
  const { width } = input
  const inner = Math.max(4, width - 2 - 4)
  const time: Line = input.time ? [{ text: input.time, fg: "muted" }] : []
  // `!!command`: the card says its output stays here and never reaches the model.
  const rows = wrapSpans([{ text: `$ ${input.command}`, fg: "primary", bold: true }, ...(input.local ? [{ text: "  local · not sent to the model", fg: "muted" as const }] : [])], inner + INDENT.length, [{ text: INDENT }])
  const first = rows[0]!
  const gap = width - 2 - 2 - widthOf(first) - widthOf(time)
  if (time.length && gap >= 2) rows[0] = [...first, { text: " ".repeat(gap) }, ...time, { text: INDENT }]
  return rows.map((row) => panelRow(row, width))
}

export type TurnEnd = {
  /** `paused`: a failed turn the provider's usage limit stopped; the limit card and bar carry the news instead of an error box. */
  outcome: "completed" | "cancelled" | "interrupted" | "failed" | "paused"
  agent?: string
  model?: string
  input: number
  output: number
  reasoning?: number
  /** Whether any model call reported usage. */
  usage: boolean
  /** The turn's model calls (a tool loop is several) and the prompt tokens of them read from the cache. */
  calls?: number
  cached?: number
  /** What the turn cost, when every call had a known price. */
  costMicros?: number
  ms?: number
  reason?: string
  error?: { code: string; message: string }
  /** When the turn ended, formatted; only with timestamps on. */
  doneAt?: string
}

const INTERRUPT_REASONS: Readonly<Record<string, string>> = { restart: "daemon restarted", transport: "connection lost", stream_idle: "stream stalled" }
export const interruptReason = (reason: string) => INTERRUPT_REASONS[reason] ?? reason

/** v1's completion line: `◈ model · ↑12.3K ↓1.1K · $0.18 · 4 calls · 12.3s` (full adds `92% cached`), muted and marked when the turn did not finish. */
export function statusLine(end: TurnEnd, width: number, glyphs: Glyphs, indent = INDENT, showReasoning = false): Line[] {
  const aborted = end.outcome === "cancelled" || end.outcome === "interrupted" || end.outcome === "paused"
  const parts: Span[][] = []
  if (end.agent) parts.push([{ text: end.agent, fg: "text" }])
  if (end.model) parts.push([{ text: end.model, fg: "muted" }])
  if (end.usage) parts.push([{ text: `↑${compact(end.input)} ↓${compact(end.output + (end.reasoning ?? 0))}`, fg: "muted" }])
  if (end.costMicros !== undefined && end.costMicros > 0) parts.push([{ text: formatCost(end.costMicros), fg: "muted" }])
  if (end.calls !== undefined && end.calls > 1) parts.push([{ text: `${end.calls} calls`, fg: "muted" }])
  if (showReasoning && end.cached !== undefined && end.input > 0) parts.push([{ text: `${Math.round((end.cached / end.input) * 100)}% cached`, fg: "muted" }])
  if (showReasoning && end.reasoning) parts.push([{ text: `${compact(end.reasoning)} reasoning tokens`, fg: "muted" }])
  if (end.ms !== undefined) parts.push([{ text: formatDuration(end.ms), fg: "muted" }])
  if (end.outcome === "cancelled") parts.push([{ text: "cancelled", fg: "muted" }])
  if (end.outcome === "paused") parts.push([{ text: "paused · usage limit", fg: "warning" }])
  if (end.outcome === "interrupted") parts.push([{ text: `interrupted${end.reason ? ` (${interruptReason(end.reason)})` : ""}`, fg: "warning" }])
  if (end.doneAt) parts.push([{ text: `done ${end.doneAt}`, fg: "muted" }])
  if (!parts.length) return []
  const spans: Span[] = parts.flatMap((part, at): Span[] => (at ? [{ text: " · ", fg: "muted" }, ...part] : part))
  return wrapSpans(spans, width, [{ text: indent }, { text: `${glyphs.done} `, fg: aborted ? "muted" : "primary" }], [{ text: `${indent}  ` }])
}

/** v1's error box: an error-colored `┃` rail on the panel fill, the provider message muted, the error code small under it. */
export function errorBox(error: { code: string; message: string }, width: number, glyphs: Glyphs): Line[] {
  const inner = Math.max(4, width - 2 - 1 - 2 - 2)
  const body = error.message
    .replace(/\s+$/, "")
    .split("\n")
    .flatMap((line) => wrapSpans([{ text: line, fg: "muted" }], inner))
  const shown = body.length > ERROR_MAX_ROWS ? [...body.slice(0, ERROR_MAX_ROWS), [{ text: `… ${body.length - ERROR_MAX_ROWS} more lines`, fg: "muted" as const, dim: true }]] : body
  const rows: Line[] = [[], ...shown, ...(error.code ? [[{ text: error.code, fg: "muted" as const, dim: true }]] : []), []]
  const bar: Span = { text: glyphs.rail, fg: "error" }
  return rows.map((row) => panelRow([{ text: "  " }, ...row], width, bar))
}

/** A short title from a reasoning body: its first `**Bold**` line, else its first non-empty line (v1 `reasoningSummary`). */
export function reasoningTitle(text: string): { title: string | undefined; rest: string } {
  const lines = text.replace(/^\s+/, "").split("\n")
  const first = lines[0]?.trim() ?? ""
  if (!first) return { title: undefined, rest: "" }
  const bold = /^\*\*(.+?)\*\*$/.exec(first)
  if (bold) return { title: bold[1]!.trim(), rest: lines.slice(1).join("\n") }
  // A long first line is prose, not a title: the body keeps it and the header does not repeat it. A short one moves into the title.
  return first.length > 120 ? { title: undefined, rest: text } : { title: first, rest: lines.slice(1).join("\n") }
}

/**
 * v1's reasoning block: a left rail in the `element` color, a `Thinking`/`Thought: <title> · <duration>` header in
 * `warning` (dim when done) and the body bounded to `rows` (the last rows while it streams).
 */
export function reasoningBlock(input: { text: string; running: boolean; ms?: number; width: number; rows: number; glyphs: Glyphs; oneLine: boolean }): Line[] {
  const { width, glyphs } = input
  const parsed = reasoningTitle(input.text)
  const { rest } = parsed
  // With no body under it (one-line view), a long first line is previewed clipped in the header instead.
  const lead = input.text.trim().split("\n")[0]?.trim() ?? ""
  const title = parsed.title ?? (input.oneLine && lead ? `${lead.slice(0, 119)}…` : undefined)
  const duration = !input.running && input.ms !== undefined ? formatDuration(input.ms) : undefined
  const label = input.running ? "Thinking" : "Thought"
  const headText = `${label}${title ? `: ${title}` : ""}${duration ? ` · ${duration}` : ""}`
  const tone: Span = { text: "", fg: "warning", ...(input.running ? {} : { dim: true }) }
  if (input.oneLine) return wrapSpans([{ ...tone, text: headText }], width, [{ text: INDENT }])
  const rail: Span = { text: `${glyphs.rail} `, fg: "element" }
  const inner = Math.max(4, width - INDENT.length - 2)
  const wrapped = wrapSpans([{ ...tone, text: headText }], inner)
  // The header keeps two rows; a title that needs more ends its second row in `…` instead of losing the rest.
  const kept = wrapped.length > 2 ? [wrapped[0]!, [...clipRow(wrapped[1]!, inner - 1), { ...tone, text: "…" }]] : wrapped
  const head = kept.map((row): Line => [{ text: INDENT }, rail, ...row])
  const body = rest.trim() ? renderMarkdown(rest.trim(), inner, "muted") : []
  const room = Math.max(1, input.rows)
  const shown = body.length > room ? [[{ text: `… ${body.length - room + 1} earlier lines`, fg: "muted" as const, dim: true }], ...body.slice(-(room - 1))] : body
  return [...head, ...shown.map((row): Line => [{ text: INDENT }, rail, ...row])]
}

/** `── Packing context ──`, centered in the row. */
export function titledRule(title: string, width: number, fg: ColorName): Line {
  const room = Math.max(0, width - INDENT.length * 2 - title.length - 2)
  const left = Math.floor(room / 2)
  return [{ text: INDENT }, { text: `${"─".repeat(left)} `, fg: "border" }, { text: title, fg, bold: true }, { text: ` ${"─".repeat(room - left)}`, fg: "border" }]
}
