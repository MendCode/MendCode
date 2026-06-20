import { reasoningSummary, type MendPresentationProfile } from "../presentation"
import { normalizeToolEvent, shouldRenderCompactTool } from "./normalize"
import type { TimelineCollapse, TimelineRow, TimelineToolState } from "./types"
import { Locale } from "@/util/locale"

export type TimelinePart = {
  id?: string
  type: string
  tool?: string
  state?: {
    status: TimelineToolState
    input?: Record<string, unknown>
    output?: unknown
    metadata?: Record<string, unknown>
    time?: {
      start?: number
      end?: number
    }
  }
  text?: string
  time?: {
    start?: number
    end?: number
  }
}

export type TimelineNode = TimelinePart | TimelineRow | TimelineCollapse

export type TimelineGroupOptions = {
  showReasoningRows?: boolean
  completed?: boolean
}

const MAX_VISIBLE_COMPLETED_ROWS = 10

export function shouldGroupTimeline(profile: MendPresentationProfile) {
  return profile === "minimal" || profile === "mendcode"
}

export function isTimelineStackStart(nodes: Array<{ type: string; text?: string }>, index: number) {
  if (index === 0) return false
  const previous = nodes[index - 1]
  return previous?.type === "text" && Boolean(previous.text?.trim())
}

export function groupTimelineParts(profile: MendPresentationProfile, parts: TimelinePart[], options: TimelineGroupOptions = {}) {
  if (!shouldGroupTimeline(profile)) return parts

  const nodes = parts.flatMap((part): TimelineNode[] => {
    if (isInvisiblePart(part)) return []
    return [rowNode(profile, part, options) ?? part]
  })
  return collapseCompletedRows(nodes)
}

function rowNode(profile: MendPresentationProfile, part: TimelinePart, options: TimelineGroupOptions): TimelineRow | undefined {
  if (part.type === "reasoning") return profile === "minimal" && options.showReasoningRows ? reasoningRow(part) : undefined
  if (part.type !== "tool" || !part.tool || !part.state) return
  if (!shouldRenderCompactTool(profile, part.tool)) return

  const event = normalizeToolEvent({
    tool: part.tool,
    state: part.state.status,
    input: part.state.input,
    metadata: part.state.metadata,
    output: part.state.output,
  })
  return {
    type: "row",
    id: part.id ?? `${part.tool}-${event.title}`,
    tool: part.tool,
    class: event.class,
    state: event.state,
    title: event.title,
    ...(event.lines.length > 0 ? { lines: event.lines } : {}),
  }
}

function reasoningRow(part: TimelinePart): TimelineRow | undefined {
  const content = part.text?.replace("[REDACTED]", "").trim() ?? ""
  if (!content) return
  const start = part.time?.start
  if (start === undefined) return
  const end = part.time?.end
  const summary = reasoningSummary(content)
  const label = summary.title || Locale.truncate(summary.body.replace(/\s+/g, " "), 80)
  return {
    type: "row",
    id: part.id ?? `reasoning-${start}`,
    state: end === undefined ? "running" : "completed",
    class: "planning",
    title: end === undefined ? `Thinking: ${label}` : `Thought: ${label} · ${formatSeconds(end - start)}`,
  }
}

function collapseCompletedRows(nodes: TimelineNode[]) {
  const result: TimelineNode[] = []
  let run: TimelineNode[] = []

  const flush = () => {
    if (!run.length) return
    result.push(...collapseRun(run))
    run = []
  }

  for (const node of nodes) {
    if (node.type === "row") {
      run.push(node)
      continue
    }
    flush()
    result.push(node)
  }
  flush()
  return result
}

function collapseRun(run: TimelineNode[]) {
  const completed = run.filter((node): node is TimelineRow => node.type === "row" && node.state === "completed")
  const collapseCount = completed.length - MAX_VISIBLE_COMPLETED_ROWS
  if (collapseCount <= 0) return run

  let remainingToCollapse = collapseCount
  let collapseIndex = -1
  const collapsedRows: TimelineRow[] = []
  const result: TimelineNode[] = []
  for (const node of run) {
    if (node.type === "row" && node.state === "completed" && remainingToCollapse > 0) {
      remainingToCollapse -= 1
      collapsedRows.push(node)
      if (collapseIndex === -1) {
        collapseIndex = result.length
        result.push({ type: "collapse", id: `collapse-${node.id}`, count: collapseCount, rows: [] })
      }
      continue
    }
    result.push(node)
  }
  if (collapseIndex >= 0) {
    result[collapseIndex] = { ...(result[collapseIndex] as TimelineCollapse), rows: collapsedRows }
  }
  return result
}

function isInvisiblePart(part: TimelinePart) {
  if (part.type === "text") return !part.text?.trim()
  if (part.type === "reasoning") return !part.text?.replace("[REDACTED]", "").trim()
  return false
}

function formatSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}
