import type { HistoryItem, HistoryReport, HistoryTurn } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid, clip } from "./deck"
import { pickerFrame } from "./picker-frame"
import { renderMarkdown } from "./markdown"
import { todayTimeOrDateTime } from "./time"
import { readableText } from "./reply-comments"

export type HistoryState = { selected: number; view: "timeline" | "tree" | "pages"; split: boolean; tools: "hidden" | "count" | "tree"; query: string; editing: boolean; reader: boolean; scroll: number; collapsed: string[]; page: number; queryBefore?: string }
export const createHistoryState = (width = 100): HistoryState => ({ selected: 0, view: width < 70 ? "timeline" : "tree", split: width >= 110, tools: "count", query: "", editing: false, reader: false, scroll: 0, collapsed: [], page: 0 })
export function firstPlainLine(text: string): string {
  // A set of comments reads as its count and the first comment; any other text is drawn as Markdown as it is.
  const readable = readableText(text, { quotes: false })
  const first = renderMarkdown(readable === text ? text : readable.split("\n").slice(0, 2).join(" · "), 100_000).find((row) => row.some((span) => span.text.trim()))
  return first?.map((span) => span.text).join("").trim() ?? ""
}
export function historyTurns(report: HistoryReport | undefined, query: string): HistoryTurn[] {
  const needle = query.toLowerCase().trim()
  return (report?.turns ?? []).filter((turn) => !needle || [turn.preview, ...turn.items.map((item) => `${item.text} ${item.tool ?? ""} ${item.title ?? ""}`)].join(" ").toLowerCase().includes(needle))
}

function itemRows(item: HistoryItem, width: number, full: boolean): Line[] {
  const name = item.kind === "user_message" ? "You" : item.kind === "agent_message" ? "Assistant" : item.tool ?? item.kind
  const rows: Line[] = [[{ text: name, fg: "primary", bold: true }, ...(item.kind === "tool_call" ? [{ text: ` · ${item.status}`, fg: "muted" as const }] : [])], []]
  rows.push(...renderMarkdown(readableText(item.text), width))
  if (item.attachments?.length) rows.push(...item.attachments.map((name): Line => [{ text: `file ${name}`, fg: "muted" }]))
  if (item.truncated) rows.push([{ text: "Additional output omitted", fg: "warning" }])
  rows.push([])
  return rows
}

export function historyReaderRows(turn: HistoryTurn | undefined, state: HistoryState, w: number, now: number): Line[] {
  if (!turn) return [[{ text: "No matching turns", fg: "muted" }]]
  const messages = state.reader ? turn.items.filter((item) => state.tools === "tree" || item.kind !== "tool_call") : [turn.items.find((item) => item.kind === "user_message"), turn.items.findLast((item) => item.kind === "agent_message")].filter((item): item is HistoryItem => Boolean(item))
  const tools = turn.items.filter((item) => item.kind === "tool_call")
  const rows: Line[] = [[{ text: todayTimeOrDateTime(turn.at, now), fg: "muted" }], [], ...messages.flatMap((item) => itemRows(item, w, state.reader))]
  if (state.tools !== "hidden" && tools.length) rows.push([{ text: `${tools.length} tool call${tools.length === 1 ? "" : "s"}`, fg: "primary" }], ...(state.tools === "tree" && !state.reader ? tools.flatMap((item) => [[{ text: `├─ ${item.tool ?? "tool"} · ${item.title ?? item.status}`, fg: "text" }]] as Line[]) : []))
  if (turn.truncated) rows.push([{ text: "Additional items omitted", fg: "warning" }])
  return rows
}

export function renderHistoryPage(input: { state: HistoryState; report: HistoryReport | undefined; detail?: HistoryTurn | undefined; error: string; loading: boolean; width: number; height: number; now: number }): Line[] {
  const { state, report, width, height } = input
  const turns = historyTurns(report, state.query)
  const selected = turns[Math.max(0, Math.min(state.selected, turns.length - 1))]
  const room = Math.max(0, height - 2)
  const hints = state.editing ? "enter search · esc cancel" : state.reader ? "↑↓ scroll · esc back · l live" : width < 70 ? "/ search · enter open · v view · esc back" : "↑↓ · enter open · / search · v view · s split · t tools · Pg↑↓ page · l live · esc back"
  const summary = input.error ? input.error : state.editing ? `Quick Jump / ${state.query}` : `Page ${state.page + 1} · ${state.view} · ${turns.length} turns · tools ${state.tools}${state.query ? ` · / ${state.query}` : ""}${input.loading ? " · loading…" : ""}`
  const preview = (w: number) => historyReaderRows(state.reader ? input.detail ?? selected : selected, state, w, input.now)
  if (state.reader) return pickerFrame("History / Turn", hints, width, height, panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [room], rows: [[{ title: "Conversation turn", body: preview, scroll: state.scroll }]] }), summary)
  let focus = 0
  const list = (w: number): Line[] => {
    const rows: Line[] = []
    turns.forEach((turn, index) => {
      const on = index === state.selected
      if (on) focus = rows.length
      const tools = turn.items.filter((item) => item.kind === "tool_call")
      rows.push(clip([{ text: on ? "› " : "  ", fg: "primary" }, { text: `${index + 1} ${firstPlainLine(turn.preview)}`, fg: on ? "primary" : "text", bold: on }], w))
      if (state.view !== "pages") rows.push(clip([{ text: `  ${todayTimeOrDateTime(turn.at, input.now)} · ${turn.outcome}${state.tools !== "hidden" && tools.length ? ` · ${tools.length} tools` : ""}`, fg: "muted" }], w))
      if (state.view === "tree" && !state.collapsed.includes(turn.turnId)) {
        for (const item of turn.items.filter((item) => item.kind === "agent_message")) rows.push(clip([{ text: `  └─ ${firstPlainLine(item.text)}`, fg: "muted" }], w))
      }
      if (state.tools === "tree" && !(state.view === "tree" && state.collapsed.includes(turn.turnId))) for (const tool of tools) rows.push(clip([{ text: `  ├─ ${tool.tool ?? "tool"} · ${tool.status}`, fg: "muted" }], w))
    })
    if (!turns.length) rows.push([{ text: input.error || (input.loading ? "Loading history…" : state.query ? "No matching turns" : "No conversation turns"), fg: input.error ? "error" : "muted" }])
    return rows
  }
  // Compute the selection's row before asking the grid to slice it.
  list(width)
  const split = width >= 70 && state.split
  const grid = panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [room], maxColumns: split ? 2 : 1, rows: [[{ title: "Conversation", body: list, weight: 2, scroll: Math.max(0, focus - room + 7), active: true }, ...(split ? [{ title: "Preview", body: preview, weight: 3 }] : [])]] })
  return pickerFrame("History", hints, width, height, grid, summary)
}
