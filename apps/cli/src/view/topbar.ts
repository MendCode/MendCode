import type { Line, Span } from "../ui/theme"
import { clip, lineWidth } from "./deck"
import { compact } from "./format"
import { cells, textWidth } from "./wrap"

/**
 * v1's session top bar (routes/session/index.tsx:4428-4482, util/session-layout.ts): `<branch> <path>` on the left,
 * the session title centered, and `+A -R | ▓▓▓▓░░░░ 42%` on the right. One row, exactly `width` cells.
 */
export type TopbarInput = {
  width: number
  path: string
  /** The user's home, shown as `~`. */
  home?: string
  branch?: string
  hideProject?: boolean
  files?: number
  title: string
  /** Lines added/removed in the working tree; hidden when both are zero. */
  diff?: { added: number; removed: number }
  /** Context in use against the budget (the compaction threshold, or the engine's own window); `approx` when the figure was clamped. */
  context?: { tokens: number; limit: number; approx?: boolean }
  /** Animation step for a title longer than its box (one cell per step); undefined keeps it still. */
  tick?: number
  contextHover?: boolean
  contextStyle?: "bar" | "percent" | "both"
  navigation?: string
  /** Stat parts drawn before the rest of the right side (the registry's spans, from `topbarStats`); left out when they do not fit. */
  stats?: Line
}

const BAR_CELLS = 8
const MIN_TITLE = 8
const MIN_LEFT = 10
const MARQUEE_GAP = " · "
const lineText = (line: Line) => line.map((span) => span.text).join("")

/** `…` in the middle so both the start (project) and the end (folder) of a path stay readable. */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return ""
  if (textWidth(text) <= width) return text
  if (width === 1) return "…"
  const all = [...cells(text)]
  const keepEnd = Math.floor((width - 1) / 2)
  const keepStart = width - 1 - keepEnd
  let start = ""
  let used = 0
  for (const cell of all) {
    if (used + cell.width > keepStart) break
    start += cell.text
    used += cell.width
  }
  let end = ""
  used = 0
  for (const cell of all.reverse()) {
    if (used + cell.width > keepEnd) break
    end = cell.text + end
    used += cell.width
  }
  return `${start}…${end}`
}

/** The title fitted to `width`: cut with `…`, or scrolling with ` · ` between repeats when `tick` is set. */
function titleText(title: string, width: number, tick: number | undefined): string {
  if (textWidth(title) <= width) return title
  if (tick === undefined) return `${lineText(clip([{ text: title }], width - 1))}…`
  const loop = [...cells(`${title}${MARQUEE_GAP}`)]
  const offset = tick % loop.length
  const rotated = [...loop.slice(offset), ...loop.slice(0, offset)]
  let out = ""
  let used = 0
  for (const cell of rotated) {
    if (used + cell.width > width) break
    out += cell.text
    used += cell.width
  }
  return out
}

const usageNumber = (value: number) => value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1_000 ? `${Number((value / 1_000).toFixed(1))}K` : String(value)

export function contextBar(context: { tokens: number; limit: number; approx?: boolean }, hover = false, style: "bar" | "percent" | "both" = "both"): Line {
  const ratio = context.limit > 0 ? context.tokens / context.limit : 0
  const filled = ratio <= 0 ? 0 : Math.max(1, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)))
  const mark = context.approx ? "~" : ""
  const percent = `${mark}${ratio >= 1 ? ">99%" : `${Math.max(1, Math.min(99, Math.round(ratio * 100)))}%`}`
  const detail = `${mark}${usageNumber(context.tokens)} / ${usageNumber(context.limit)}`
  const width = Math.max(BAR_CELLS + 1 + textWidth(percent), textWidth(detail))
  if (hover) return [{ text: `${" ".repeat(Math.floor((width - textWidth(detail)) / 2))}${detail}`.padEnd(width), fg: "muted" }]
  if (style === "percent") return [{ text: percent, fg: "muted" }]
  if (style === "bar") return [{ text: " ".repeat(filled), bg: "text" }, { text: " ".repeat(BAR_CELLS - filled), bg: "element" }]
  return [
    { text: " ".repeat(width - BAR_CELLS - 1 - textWidth(percent)) },
    { text: " ".repeat(filled), bg: "text" },
    { text: " ".repeat(BAR_CELLS - filled), bg: "element" },
    { text: ` ${percent}`, fg: "muted" },
  ]
}

/** The right side: the stat parts the profile places (`topbarStats`) first, when they fit beside the left side's minimum, then what the bar always carries. */
function rightSide(input: TopbarInput): Line {
  const base = fixedRight(input)
  if (!input.stats?.length) return base
  const joined: Line = [...input.stats, ...(base.length ? [{ text: "  " }] : []), ...base]
  return lineWidth(joined) <= input.width - MIN_LEFT - 1 ? joined : base
}

function fixedRight(input: TopbarInput): Line {
  const parts: Line = []
  if (input.navigation) parts.push({ text: input.navigation + "  ", fg: "muted" })
  if (input.files !== undefined) parts.push({ text: `${input.files} file${input.files === 1 ? "" : "s"} `, fg: "muted" })
  if (input.diff && (input.diff.added > 0 || input.diff.removed > 0)) parts.push({ text: `+${compact(input.diff.added)}`, fg: "success" }, { text: " " }, { text: `-${compact(input.diff.removed)}`, fg: "error" })
  if (input.context && input.context.limit > 0) {
    if (parts.length) parts.push({ text: " | ", fg: "muted" })
    parts.push(...contextBar(input.context, input.contextHover, input.contextStyle))
  }
  return parts
}

export function topbarContextArea(input: TopbarInput): { from: number; to: number } | undefined {
  if (!input.context || input.context.limit <= 0 || lineWidth(rightSide(input)) > input.width - MIN_LEFT - 1) return undefined
  return { from: input.width - lineWidth(contextBar(input.context, false, input.contextStyle)), to: input.width }
}

export function renderTopbar(input: TopbarInput): Line {
  const { width } = input
  if (width <= 0) return []
  const path = input.home && input.path.startsWith(input.home) ? `~${input.path.slice(input.home.length)}` : input.path
  const leftText = input.hideProject ? "" : `${input.branch || "git"} ${path}`
  let right = rightSide(input)
  if (lineWidth(right) > width - MIN_LEFT - 1) right = []
  const rightWidth = lineWidth(right)
  const room = width - rightWidth - (rightWidth ? 1 : 0)
  // The title box: about a third of the width, never less than MIN_TITLE, only if the left keeps MIN_LEFT cells.
  const wantTitle = input.title.trim() ? Math.min(textWidth(input.title.trim()), Math.max(MIN_TITLE, Math.floor(0.34 * width) + 2)) : 0
  const titleWidth = wantTitle && room - wantTitle - 2 >= MIN_LEFT ? wantTitle : 0
  const leftWidth = Math.max(0, room - (titleWidth ? titleWidth + 2 : 0))
  // The branch stays whole; the path gives way in the middle.
  const branch = input.branch || "git"
  const left: Span = { text: input.hideProject ? "" : textWidth(branch) + 2 >= leftWidth ? truncateMiddle(leftText, leftWidth) : `${branch} ${truncateMiddle(path, leftWidth - textWidth(branch) - 1)}`, fg: "muted" }
  const row: Line = [left]
  if (titleWidth) {
    const title = titleText(input.title.trim(), titleWidth, input.tick)
    // Centered on the whole row when the left side leaves room, otherwise right after it.
    const centered = Math.floor((width - textWidth(title)) / 2)
    const start = Math.max(textWidth(left.text) + 2, Math.min(centered, room - textWidth(title)))
    row.push({ text: " ".repeat(Math.max(0, start - textWidth(left.text))) }, { text: title, fg: "text" })
  }
  const used = lineWidth(row)
  row.push({ text: " ".repeat(Math.max(0, width - used - rightWidth)) }, ...right)
  return clip(row, width)
}

/** Whether the title is scrolling (the caller then repaints every 350 ms, and only then). */
export function topbarAnimates(input: Pick<TopbarInput, "width" | "title">): boolean {
  const box = Math.max(MIN_TITLE, Math.floor(0.34 * input.width) + 2)
  return textWidth(input.title.trim()) > box
}

/** Rows of an extension's `header.replace` slot (at most `MAX_HEADER_ROWS`), each exactly `width` cells. */
export const MAX_HEADER_ROWS = 3
export function renderHeaderSlot(lines: readonly Line[], width: number): Line[] {
  return lines.slice(0, MAX_HEADER_ROWS).map((line) => {
    const row = clip(line, width)
    const room = width - lineWidth(row)
    return room > 0 ? [...row, { text: " ".repeat(room) }] : row
  })
}
