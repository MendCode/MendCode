import type { ColorName, Line, Span } from "../ui/theme"
import type { CompactionSnapshot, UsageSample } from "./compaction-facts"
import type { ArcadeView } from "./arcade/types"
import type { TuiProfile } from "./tui-profile"
import { clip, fit, spread } from "./deck"
import { editorRows } from "./editor"
import { formatElapsed } from "./time"
import { textWidth } from "./wrap"

export type LiveMode = TuiProfile["compactionPanel"]

/** Narrower than this the panels drop their frame and keep three or four plain rows. */
export const LIVE_COMPACT_WIDTH = 70
export type LiveInput = {
  mode: LiveMode
  /** Cells available, margins already taken off. */
  width: number
  /** Rows available, borders included; the mode degrades to a smaller panel when it does not fit. */
  maxRows: number
  facts: CompactionSnapshot
  /** The last model call before the compaction (cache read/write figures). */
  lastCall?: UsageSample
  /** The window of the model, or the compaction threshold when the window is unknown. */
  limit?: { tokens: number; kind: "window" | "threshold" }
  now: number
  spinner: string
  arcade?: { view: ArcadeView; focused: boolean; fieldRows: number }
  scratch?: { text: string; editing: boolean; editor?: ReturnType<typeof import("./editor").createEditor>; readOnly: boolean }
}

export type LiveOutput = {
  rows: Line[]
  /** The mode that was drawn: a smaller one when `maxRows` did not leave room for the chosen one. */
  mode: LiveMode
  /** Where the scratchpad's rows are inside `rows`, for clicks and the cursor. */
  scratch?: { top: number; left: number; width: number; rows: number; first: number; cursor?: { row: number; col: number } }
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const
const SPARK = "▁▂▃▄▅▆▇█"

/** `84200` is `84.2k`, `1250000` is `1.25M`; whole numbers below a thousand. */
export function compactTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1).replace(/\.?0+$/, "")}k`
  return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
}

/** A bar `width` cells wide filled to `ratio` with eighth-block precision, on a dim track. */
export function bar(ratio: number, width: number, tone: ColorName): Span[] {
  const total = Math.max(0, width) * 8
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * total)
  const whole = Math.floor(filled / 8)
  const part = EIGHTHS[filled % 8]!
  const rest = Math.max(0, width - whole - (part ? 1 : 0))
  return [{ text: "█".repeat(whole) + part, fg: tone }, { text: "░".repeat(rest), fg: "border" }]
}

/** One block per sample, scaled between the smallest and the largest. */
export function sparkline(samples: readonly number[], width: number): string {
  const shown = samples.slice(-width)
  if (!shown.length) return ""
  const low = Math.min(...shown)
  const span = Math.max(1, Math.max(...shown) - low)
  return shown.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor(((value - low) / span) * SPARK.length))]!).join("")
}

const STEPS = ["Capture transcript", "Write memory", "Pack context"] as const
const stepOf = (facts: CompactionSnapshot) => (facts.phase === "packed" ? 3 : facts.phase === "memory" ? 2 : 1)
const elapsedOf = (input: LiveInput) => (input.facts.startedAt === undefined ? undefined : Math.max(0, (input.facts.endedAt ?? input.now) - input.facts.startedAt))

/** The memory call has no real progress to report, so the bar rides the stages: it eases toward the next one while the call runs. */
export function progressOf(facts: CompactionSnapshot, elapsedMs: number): number {
  if (facts.phase === "packed") return 1
  if (facts.phase === "capture") return 0.12
  return 0.12 + 0.76 * (1 - Math.exp(-elapsedMs / 25_000))
}

const phaseText = (facts: CompactionSnapshot) =>
  facts.phase === "packed" ? "Packing context" : facts.phase === "memory" ? (facts.method === "native" ? "Writing checkpoint" : "Writing memory") : "Capturing transcript"

/** Tokens the compacted context holds: the kept tail plus the memory the model wrote; undefined until both are known. */
function afterTokens(facts: CompactionSnapshot): number | undefined {
  return facts.tailTokens !== undefined && facts.summaryTokens !== undefined ? facts.tailTokens + facts.summaryTokens : undefined
}

function boxed(input: { title: string; right?: string; rows: Line[]; width: number; tone?: ColorName }): Line[] {
  const { width } = input
  const border: ColorName = input.tone ?? "border"
  const inner = Math.max(1, width - 4)
  const title: Line = [{ text: "╭─ ", fg: border }, { text: input.title, fg: "primary", bold: true }, { text: " ", fg: border }]
  const right: Line = input.right ? [{ text: ` ${input.right} `, fg: "muted" }, { text: "─╮", fg: border }] : [{ text: "╮", fg: border }]
  const gap = Math.max(0, width - textWidth(title.map((span) => span.text).join("")) - textWidth(right.map((span) => span.text).join("")))
  const top = clip([...title, { text: "─".repeat(gap), fg: border }, ...right], width)
  const row = (line: Line): Line => [{ text: "│ ", fg: border }, ...fit(line, inner), { text: " │", fg: border }]
  return [top, ...input.rows.map(row), [{ text: `╰${"─".repeat(Math.max(0, width - 2))}╯`, fg: border }]]
}

const label = (text: string): Span => ({ text: text.padEnd(9), fg: "muted" })

function stageRow(facts: CompactionSnapshot, spinner: string): Line {
  const step = stepOf(facts)
  const memory = facts.method === "native" ? "Checkpoint" : "Memory"
  const names = ["Capture", memory, "Pack"]
  const spans: Span[] = []
  names.forEach((name, index) => {
    const done = index + 1 < step || (index + 1 === step && facts.phase === "packed")
    const current = index + 1 === step && !done
    if (index) spans.push({ text: "   " })
    spans.push({ text: `${done ? "●" : current ? spinner : "○"} ${name}`, fg: done ? "success" : current ? "primary" : "muted", ...(current ? { bold: true } : {}) })
  })
  if (facts.tailTokens) spans.push({ text: `   tail ~${compactTokens(facts.tailTokens)} kept`, fg: "muted" })
  return spans
}

/** `84.2k → …`: the context the compaction replaces, then what replaces it once both the tail and the memory are known. */
function contextShift(facts: CompactionSnapshot): Span[] {
  if (!facts.before) return [{ text: "no model call recorded yet", fg: "muted" }]
  const before = compactTokens(facts.before.context)
  const after = afterTokens(facts)
  const tail = facts.tailTokens !== undefined ? `tail ~${compactTokens(facts.tailTokens)} + memory` : undefined
  return [
    { text: before, fg: "text", bold: true },
    { text: "  →  ", fg: "muted" },
    after !== undefined ? { text: `~${compactTokens(after)}`, fg: "success", bold: true } : { text: tail ?? "…", fg: "muted" },
    ...(after !== undefined && facts.before.context > 0 ? [{ text: `   saved ~${compactTokens(Math.max(0, facts.before.context - after))} (${Math.max(0, Math.round((1 - after / facts.before.context) * 100))}%)`, fg: "success" as const }] : []),
  ]
}

function progressRow(input: LiveInput, width: number): Line {
  const elapsed = elapsedOf(input) ?? 0
  const step = stepOf(input.facts)
  const tail = `  step ${step} of ${STEPS.length}`
  return [...bar(progressOf(input.facts, elapsed), Math.max(4, width - tail.length), input.facts.phase === "packed" ? "success" : "primary"), { text: tail, fg: "muted" }]
}

const elapsedText = (input: LiveInput) => {
  const elapsed = elapsedOf(input)
  return elapsed === undefined ? undefined : formatElapsed(elapsed)
}

function quietRow(input: LiveInput): Line {
  const elapsed = elapsedText(input)
  const text = [`${input.spinner} Compacting context`, phaseText(input.facts).toLowerCase(), input.facts.before ? `${compactTokens(input.facts.before.context)} tokens` : undefined, elapsed].filter(Boolean).join(" · ")
  return fit([{ text, fg: "muted" }], input.width)
}

function panelRows(input: LiveInput): Line[] {
  const { facts, width } = input
  const elapsed = elapsedText(input)
  if (width < LIVE_COMPACT_WIDTH) {
    return [
      fit([{ text: `${input.spinner} `, fg: "primary" }, { text: "Compacting", fg: "text", bold: true }, { text: ` · ${phaseText(facts).toLowerCase()}${elapsed ? ` · ${elapsed}` : ""}`, fg: "muted" }], width),
      fit(progressRow(input, width), width),
      fit(contextShift(facts), width),
    ]
  }
  const body: Line[] = [
    spread([{ text: `${input.spinner} `, fg: "primary" }, { text: phaseText(facts), fg: "text", bold: true }], [{ text: facts.reason ? `${facts.reason} compaction` : "compaction", fg: "muted" }], width - 4),
    progressRow(input, width - 4),
    [label("Context"), ...contextShift(facts)],
    stageRow(facts, input.spinner),
  ]
  return boxed({ title: "Compacting context", ...(elapsed ? { right: elapsed } : {}), rows: body, width })
}

function statsRows(input: LiveInput): Line[] {
  const { facts, width, lastCall, limit } = input
  const inner = width < LIVE_COMPACT_WIDTH ? width : width - 4
  const compact = width < LIVE_COMPACT_WIDTH
  const used = facts.before?.context
  const usedShare = used !== undefined && limit ? used / limit.tokens : undefined
  const contextText = used === undefined || usedShare === undefined || !limit ? "" : compact ? `${compactTokens(used)}/${compactTokens(limit.tokens)} ${Math.round(usedShare * 100)}%` : `${compactTokens(used)} / ${compactTokens(limit.tokens)} ${limit.kind} · ${Math.round(usedShare * 100)}%`
  const prompt = lastCall ? lastCall.input + lastCall.cacheRead + lastCall.cacheWrite : 0
  const share = (value: number) => (prompt > 0 ? value / prompt : 0)
  const percent = (value: number) => Math.round(share(value) * 100)
  const cacheText = !lastCall || prompt <= 0 ? "" : compact ? `r ${percent(lastCall.cacheRead)}% w ${percent(lastCall.cacheWrite)}%` : `read ${compactTokens(lastCall.cacheRead)} ${percent(lastCall.cacheRead)}% · write ${compactTokens(lastCall.cacheWrite)} ${percent(lastCall.cacheWrite)}%`
  const barWidth = Math.max(4, inner - 9 - Math.max(textWidth(contextText), textWidth(cacheText)) - 2)
  const contextRow: Line = [label("Context"), ...(used === undefined
    ? [{ text: "no model call recorded yet", fg: "muted" as const }]
    : usedShare !== undefined
      ? [...bar(usedShare, barWidth, usedShare >= 0.9 ? "error" : usedShare >= 0.7 ? "warning" : "primary"), { text: `  ${contextText}`, fg: "text" as const }]
      : [{ text: `${compactTokens(used)} tokens`, fg: "text" as const, bold: true }])]
  const cacheRow: Line = [label("Cache"), ...(lastCall && prompt > 0
    ? [
        ...stacked([{ ratio: share(lastCall.cacheRead), tone: "success" }, { ratio: share(lastCall.cacheWrite), tone: "info" }, { ratio: share(lastCall.input), tone: "muted" }], barWidth),
        { text: `  ${cacheText}`, fg: "text" as const },
      ]
    : [{ text: "no cache figures recorded", fg: "muted" as const }])]
  const trend: Line = [label("Trend"), ...(facts.history.length > 1
    ? [{ text: sparkline(facts.history, Math.max(4, Math.min(24, inner - 30))), fg: "accent" as const }, { text: `  last ${facts.history.length} calls · peak ${compactTokens(Math.max(...facts.history))}`, fg: "muted" as const }]
    : [{ text: "needs two model calls", fg: "muted" as const }])]
  const after = afterTokens(facts)
  const saved: Line = [label("Saved"), ...(facts.before && after !== undefined
    ? [{ text: `~${compactTokens(Math.max(0, facts.before.context - after))} tokens`, fg: "success" as const, bold: true }, { text: `  tail ${compactTokens(facts.tailTokens ?? 0)} + memory ${compactTokens(facts.summaryTokens ?? 0)}`, fg: "muted" as const }]
    : [{ text: facts.tailTokens !== undefined ? `pending · tail ~${compactTokens(facts.tailTokens)} kept` : "pending until the memory is written", fg: "muted" as const }])]
  const progress: Line = [label("Progress"), ...progressRow(input, inner - 9)]
  const elapsed = elapsedText(input)
  if (width < LIVE_COMPACT_WIDTH) return [fit([{ text: `${input.spinner} `, fg: "primary" }, { text: "Compaction stats", fg: "text", bold: true }, { text: elapsed ? ` · ${elapsed}` : "", fg: "muted" }], width), contextRow, cacheRow, saved, progress].map((line) => fit(line, width))
  return boxed({ title: "Compaction stats", ...(elapsed ? { right: elapsed } : {}), rows: [contextRow, cacheRow, trend, saved, progress], width })
}

/** A bar split into proportional segments; whatever the segments do not cover stays on the track. */
function stacked(parts: Array<{ ratio: number; tone: ColorName }>, width: number): Span[] {
  const spans: Span[] = []
  let left = width
  for (const part of parts) {
    const size = Math.min(left, Math.round(part.ratio * width))
    if (size > 0) spans.push({ text: "█".repeat(size), fg: part.tone })
    left -= size
  }
  if (left > 0) spans.push({ text: "░".repeat(left), fg: "border" })
  return spans
}

const ARCADE_INFO_WIDTH = 30

function arcadeRows(input: LiveInput): Line[] {
  const { width, facts, arcade } = input
  if (!arcade) return panelRows(input)
  const { view, focused } = arcade
  const elapsed = elapsedText(input)
  const keys: Line[] = focused
    ? [[{ text: "←↑↓→ / wasd  move", fg: "text" }], [{ text: "space       start · pause", fg: "text" }], [{ text: "r restart · n next game", fg: "muted" }], [{ text: "esc / q     leave the game", fg: "muted" }]]
    : [[{ text: "tab · click  play", fg: "primary", bold: true }], [{ text: "the game only runs while", fg: "muted" }], [{ text: "you have it focused", fg: "muted" }]]
  if (width < LIVE_COMPACT_WIDTH || width - 4 < view.width + ARCADE_INFO_WIDTH) {
    const pad = Math.max(0, Math.floor((width - view.width) / 2))
    return [
      fit([{ text: `${input.spinner} `, fg: "primary" }, { text: view.title, fg: "text", bold: true }, { text: ` · ${view.status}`, fg: "muted" }], width),
      ...view.rows.map((row) => fit([{ text: " ".repeat(pad) }, ...row], width)),
      fit(focused ? [{ text: "arrows move · space · r · n · esc leaves", fg: "muted" }] : [{ text: "tab plays", fg: "primary" }, { text: ` · ${phaseText(facts).toLowerCase()}${elapsed ? ` · ${elapsed}` : ""}`, fg: "muted" }], width),
    ]
  }
  const info: Line[] = [
    [{ text: `${input.spinner} `, fg: "primary" }, { text: phaseText(facts), fg: "text", bold: true }],
    [{ text: `step ${stepOf(facts)} of ${STEPS.length}${elapsed ? ` · ${elapsed}` : ""}`, fg: "muted" }],
    [{ text: view.status, fg: "warning" }],
    ...keys,
  ]
  const rows = view.rows.map((row, index): Line => [{ text: " " }, ...row, { text: "   " }, ...(info[index] ?? [])])
  return boxed({ title: `Arcade · ${view.title}`, ...(elapsed ? { right: elapsed } : {}), rows, width, tone: focused ? "borderActive" : "border" })
}

function scratchRows(input: LiveInput): { rows: Line[]; scratch?: NonNullable<LiveOutput["scratch"]> } {
  const { width, scratch } = input
  if (!scratch) return { rows: panelRows(input) }
  const compact = width < LIVE_COMPACT_WIDTH
  const room = Math.max(2, Math.min(5, input.maxRows - (compact ? 1 : 2)))
  const inner = compact ? width : width - 4
  const textWidthRoom = Math.max(1, inner - 1)
  scratch.editor?.setVisualWidth(textWidthRoom)
  const lines = scratch.editing && scratch.editor ? scratch.editor.visualLines() : editorRows(scratch.text, textWidthRoom, true)
  const cursorIndex = scratch.editing && scratch.editor ? Math.max(0, lines.findLastIndex((line) => line.start <= scratch.editor!.cursorOffset)) : 0
  const first = Math.max(0, cursorIndex - room + 1)
  const selected = scratch.editing ? scratch.editor?.selection : undefined
  const body = lines.slice(first, first + room).map((line, index): Line => {
    const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.text)].map((s) => s.segment)
    const from = selected ? Math.max(0, selected.start - line.start) : 0
    const to = selected ? Math.max(0, Math.min(chars.length, selected.end - line.start)) : 0
    const spans: Line = selected && to > from ? [{ text: chars.slice(0, from).join(""), fg: "text" }, { text: chars.slice(from, to).join(""), fg: "background", bg: "primary" }, { text: chars.slice(to).join(""), fg: "text" }] : [{ text: line.text, fg: "text" }]
    const mark = lines.length > room ? (index === Math.round((first / Math.max(1, lines.length - room)) * (room - 1)) ? "┃" : "│") : " "
    return [...fit(spans, textWidthRoom), { text: mark, fg: "border" }]
  })
  if (!scratch.editing && scratch.text.trim() === "") body[0] = [{ text: scratch.readOnly ? "read-only terminal" : "empty · tab to write a project note while you wait", fg: "muted" }]
  while (body.length < room) body.push([])
  const current = lines[cursorIndex]
  const column = current && scratch.editing && scratch.editor ? textWidth([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current.text)].slice(0, scratch.editor.cursorOffset - current.start).map((s) => s.segment).join("")) : undefined
  const hint = scratch.editing ? "esc prompt" : scratch.readOnly ? "read-only" : "tab edit"
  const elapsed = elapsedText(input)
  const area = { top: compact ? 1 : 1, left: compact ? 0 : 2, width: textWidthRoom, rows: room, first }
  const cursor = column !== undefined && current ? { row: area.top + cursorIndex - first, col: area.left + column } : undefined
  const out = { ...area, ...(cursor ? { cursor } : {}) }
  if (compact) return { rows: [fit([{ text: `${input.spinner} `, fg: "primary" }, { text: "Scratchpad", fg: "text", bold: true }, { text: ` · ${hint}${elapsed ? ` · ${elapsed}` : ""}`, fg: "muted" }], width), ...body.map((line) => fit(line, width))], scratch: out }
  return { rows: boxed({ title: "Scratchpad", right: `${hint}${elapsed ? ` · ${elapsed}` : ""}`, rows: body, width, tone: scratch.editing ? "borderActive" : "border" }), scratch: out }
}

/** Rows each mode takes at most for `width`: the controller sizes the arcade field with it. */
export function liveRowsNeeded(mode: LiveMode, width: number, field = 0): number {
  const compact = width < LIVE_COMPACT_WIDTH
  if (mode === "quiet") return 1
  if (mode === "panel") return compact ? 3 : 6
  if (mode === "stats") return compact ? 5 : 7
  if (mode === "scratchpad") return compact ? 3 : 4
  return field + 2
}

/**
 * The compaction panel while the context is being compacted. `panel` is the framed default (phase, stage bar,
 * tokens before and after), `stats` charts what the events reported, `arcade` and `scratchpad` host a game and the
 * project note, `quiet` is one line. A mode that does not fit `maxRows` gives way to a smaller one.
 */
export function renderLiveCompaction(input: LiveInput): LiveOutput {
  const fits = (mode: LiveMode) => liveRowsNeeded(mode, input.width, input.arcade?.fieldRows ?? 0) <= input.maxRows
  const order: LiveMode[] = input.mode === "arcade" || input.mode === "stats" || input.mode === "scratchpad" ? [input.mode, "panel", "quiet"] : input.mode === "panel" ? ["panel", "quiet"] : ["quiet"]
  const mode = order.find(fits) ?? "quiet"
  const sized = { ...input, mode }
  if (mode === "quiet") return { rows: [quietRow(input)], mode }
  if (mode === "scratchpad") return { ...scratchRows(sized), mode }
  return { rows: mode === "stats" ? statsRows(sized) : mode === "arcade" ? arcadeRows(sized) : panelRows(sized), mode }
}
