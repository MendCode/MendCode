import type { SessionNotesReport, SessionRecallMessage, SessionRecallPage } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { wrapSpans } from "./markdown"

export function sessionRecallCard(input: { name: string; text: string; width: number; expanded: boolean; failed: boolean }): Line[] | undefined {
  const title = input.name === "session_notes" ? "Session notes" : input.name === "session_search" ? "Session search" : input.name === "session_read" ? "Session history" : undefined
  if (!title) return
  const panel = (label: string, body: (width: number) => Line[]) => panelGrid({ width: input.width, padding: true, maxColumns: 1, rows: [[{ title: label, body }]] })
  if (input.failed) return panel(title, (width) => wrapSpans([{ text: input.text, fg: "error" }], width))
  let data: SessionNotesReport | SessionRecallPage | SessionRecallMessage
  try { data = JSON.parse(input.text) }
  catch { return }
  if (!data || typeof data !== "object") return
  const bodyText = (text: string, width: number) => {
    const rows = text.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" }], width))
    return input.expanded || rows.length <= 8 ? rows : [...rows.slice(0, 8), ...wrapSpans([{ text: `… ${rows.length - 8} more lines`, fg: "muted" }], width)]
  }
  if (input.name === "session_notes") {
    if (!("version" in data) || !Number.isSafeInteger(data.version) || typeof data.text !== "string" || !Number.isSafeInteger(data.current_version)) return
    const notes = data
    return panel(`${title} · v${notes.version}`, (width) => [
      ...wrapSpans([{ text: `${notes.text.length} chars${notes.version !== notes.current_version ? ` · current v${notes.current_version}` : ""}`, fg: "muted" }], width),
      ...(notes.text ? [[], ...bodyText(notes.text, width)] : []),
    ])
  }
  if (!("session_id" in data) || typeof data.session_id !== "string") return
  if ("messages" in data) {
    if (!Array.isArray(data.messages) || data.messages.length > 10 || data.messages.some((message) => !message || typeof message.text !== "string" || typeof message.message_id !== "string" || !["user", "assistant"].includes(message.role))) return
    const page = data
    return panel(title, (width) => [
      ...wrapSpans([{ text: `${page.messages.length} ${input.name === "session_search" ? page.messages.length === 1 ? "match" : "matches" : page.messages.length === 1 ? "message" : "messages"} · ${page.session_id}`, fg: "muted" }], width),
      ...page.messages.flatMap((message): Line[] => [[], ...wrapSpans([{ text: `${message.role === "user" ? "User" : "Assistant"} · ${message.message_id}${message.truncated ? " · truncated" : ""}`, fg: "primary" }], width), ...bodyText(message.text, width)]),
      ...(page.next_cursor ? [[], ...wrapSpans([{ text: `Before ${page.next_cursor}`, fg: "muted" }], width)] : []),
    ])
  }
  if (!("message_id" in data) || typeof data.message_id !== "string" || typeof data.text !== "string") return
  const message = data
  return panel(title, (width) => [
    ...wrapSpans([{ text: message.message_id, fg: "muted" }], width), [], ...bodyText(message.text, width),
    ...(message.next_offset !== undefined ? [[], ...wrapSpans([{ text: `Next offset ${message.next_offset}`, fg: "muted" }], width)] : []),
  ])
}
