import type { BlobRef, HistoryItem, HistoryReport, ItemId, TurnId } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread } from "./deck"
import { renderMarkdown } from "./markdown"
import { truncateEnd } from "./session-list"
import { todayTimeOrDateTime } from "./time"
import { wrap } from "./wrap"

export type MessageEntry = HistoryItem & { turnId: TurnId; at: number; anchorId: ItemId; prompt: string; promptImages: BlobRef[]; promptTruncated: boolean }
export type MessageActionsState = {
  report?: HistoryReport
  entries: MessageEntry[]
  selected: number
  pick: boolean
  /** Esc-Esc backtrack: only the user's prompts, Enter reverts to the selected one and `f` forks from it. */
  backtrack?: boolean
  menu: boolean
  action: number
  scroll: number
  loading: boolean
  error: string
}
export type ExportOptionsState = {
  filename: string
  format: "markdown" | "json" | "html"
  reasoning: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  timestamps: boolean
  sanitize?: boolean
  destination: "file" | "editor" | "clipboard"
  openEditor: boolean
  selected: number
  error: string
  busy: boolean
}
export const EXPORT_FIELDS = ["filename", "format", "reasoning", "toolDetails", "assistantMetadata", "timestamps", "destination", "openEditor", "sanitize"] as const
export const MESSAGE_ACTIONS = ["Copy", "Revert", "Fork", "Quote + comment"] as const

export function messageEntries(report: HistoryReport | undefined, answers = false, promptsOnly = false): MessageEntry[] {
  return (report?.turns ?? []).flatMap((turn) => {
    const prompt = turn.items.find((item) => item.kind === "user_message")
    if (!prompt) return []
    return turn.items.filter((item) => !promptsOnly && item.kind === "agent_message" || !answers && item.kind === "user_message").map((item) => ({ ...item, turnId: turn.turnId, at: turn.at, anchorId: prompt.itemId, prompt: prompt.text, promptImages: prompt.attachmentRefs ?? [], promptTruncated: !!prompt.truncated }))
  })
}

function page(title: string, hints: string, body: Line[], width: number, height: number): Line[] {
  const header = spread([{ text: title, fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], width)
  const out = [fit(header, width), [{ text: "─".repeat(width), fg: "border" }], ...body].slice(0, height) as Line[]
  while (out.length < height) out.push([])
  return out.map((row) => fit(row, width))
}

export function renderMessageActions(input: { state: MessageActionsState; width: number; height: number; now: number }): Line[] {
  const { state: s, width, height, now } = input
  const selected = s.entries[s.selected]
  const hints = s.menu ? "↑↓ action · enter apply · esc back" : width < 70 ? "↑↓ · enter · esc" : "↑↓ select · enter actions · PgUp/PgDn pages · esc back"
  const room = Math.max(0, height - 2)
  const title = s.backtrack ? "Backtrack" : s.pick ? "Copy response" : s.menu ? "Message Actions" : "Messages"
  const actions: Line[] = MESSAGE_ACTIONS.map((name, i) => [{ text: `${i === s.action ? "›" : " "} ${name}`, fg: i === s.action ? "primary" : "text", bold: i === s.action }])
  const list = (w: number): Line[] => s.loading ? [[{ text: "Loading messages…", fg: "muted" }]] : s.entries.length ? s.entries.map((entry, i): Line => [{ text: `${i === s.selected ? "›" : " "} ${entry.kind === "user_message" ? "User" : "Assistant"} · ${todayTimeOrDateTime(entry.at, now)}  ${truncateEnd(entry.text.replace(/\s+/g, " "), Math.max(1, w - 25))}`, fg: i === s.selected ? "primary" : "text", bold: i === s.selected }]) : [[{ text: s.error || (s.pick ? "No responses in this page" : "No messages in this session"), fg: s.error ? "warning" : "muted" }]]
  const preview = (w: number): Line[] => selected ? [
    ...(s.error ? wrap(s.error, w).map((text): Line => [{ text, fg: "warning" }]) : []),
    ...(selected.truncated ? [[{ text: "Truncated · copy unavailable", fg: "warning" }] as Line] : []),
    ...renderMarkdown(selected.text, Math.max(1, w), "text"),
    ...(selected.attachments?.length ? wrap(`Attachments: ${selected.attachments.join(", ")}`, w).map((text): Line => [{ text, fg: "muted" }]) : []),
  ] : []
  const main = { title: s.menu ? "Actions" : s.pick ? "Responses" : s.backtrack ? "Prompts" : "Messages", body: s.menu ? actions : list, weight: 2, active: true, scroll: s.menu ? 0 : Math.max(0, s.selected - Math.max(1, room - 5) + 1) }
  let body: Line[]
  if (width < 70) {
    const topHeight = Math.min(room, s.menu ? 7 : Math.max(5, Math.floor(room / 2)))
    main.scroll = s.menu ? 0 : Math.max(0, s.selected + 1 - Math.max(1, topHeight - 4))
    body = panelGrid({ width, rows: [[main]], heights: [topHeight], padding: true })
    if (selected && room - body.length > 3) body.push(...panelGrid({ width, rows: [[{ title: selected.kind === "user_message" ? "User" : "Assistant", body: preview, scroll: s.scroll }]], heights: [room - body.length], padding: true }))
  } else body = panelGrid({ width, rows: [[main, { title: selected ? `${selected.kind === "user_message" ? "User" : "Assistant"} · ${todayTimeOrDateTime(selected.at, now)}` : "Message", body: preview, scroll: s.scroll, weight: 3 }]], heights: [room], padding: true })
  const backtrackHints = width < 70 ? "↑↓ · enter edit · f fork · esc" : "↑↓ pick a prompt · enter revert and edit · f fork · PgUp/PgDn pages · esc cancel"
  return page(title, s.backtrack ? backtrackHints : s.pick && !s.menu ? width < 70 ? "↑↓ · enter copy · esc" : "↑↓ select · enter copy · PgUp/PgDn pages · esc back" : hints, body, width, height)
}

export function renderExportOptions(input: { state: ExportOptionsState; width: number; height: number }): Line[] {
  const { state: s, width, height } = input
  const rows = (w: number): Line[] => EXPORT_FIELDS.flatMap((field, i) => {
    const label = { filename: "Filename", format: "Format", reasoning: "Include thinking", toolDetails: "Include tool details", assistantMetadata: "Assistant metadata", timestamps: "Timestamps", destination: "Destination", openEditor: "Open in editor", sanitize: "Sanitize content" }[field]
    const value = field === "sanitize" ? s.sanitize ?? false : s[field]
    const text = typeof value === "boolean" ? `${value ? "[x]" : "[ ]"} ${label}` : `${label}: ${value}`
    return [[{ text: truncateEnd(`${i === s.selected ? "›" : " "} ${text}`, w), fg: i === s.selected ? "primary" : "text", bold: i === s.selected }]]
  })
  const destination = s.destination === "editor" ? "Temporary file · no project file" : s.destination === "clipboard" ? "Terminal clipboard · OSC 52" : s.filename
  const detail = (w: number): Line[] => [
    [{ text: truncateEnd(destination, w), fg: "text" }],
    ...(s.busy ? [[{ text: "Exporting…", fg: "primary" }] as Line] : []),
    ...(s.error ? wrap(s.error, w).map((text): Line => [{ text, fg: "warning" }]) : []),
  ]
  const room = Math.max(0, height - 2)
  const panels = [{ title: "Options", body: rows, active: true, weight: 3 }, { title: "Destination", body: detail, weight: 2 }]
  const body = width < 70
    ? panelGrid({ width, compact: false, rows: [[{ ...panels[0]!, body: (w) => [...rows(w), ...(s.error ? [[], ...wrap(s.error, w).map((text): Line => [{ text, fg: "warning" }])] : []), ...(s.busy ? [[{ text: "Exporting…", fg: "primary" }] as Line] : [])] }]], heights: [room], padding: true })
    : panelGrid({ width, rows: [panels], heights: [room], padding: true })
  return page("Export Options", width < 70 ? "tab · space · enter · esc" : "tab/↑↓ select · space/←→ toggle · enter export · esc back", body, width, height)
}
