import type { MemoryEntry } from "@mendcode/protocol"
import type { MemoryAssistantState } from "../ui/app/memory-assistant"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid, fit } from "./deck"
import { renderMarkdown } from "./markdown"
import { sideInput } from "../ui/app/aside"

export function renderMemoryAssistant(input: { chat: MemoryAssistantState; memories: MemoryEntry[]; width: number; height: number }): Line[] {
  const { chat, width, height } = input
  const compact = width < 70
  const pending = input.memories.filter((memory) => memory.status === "pending" && chat.thread.proposals.includes(memory.memoryId))
  const selected = input.memories.find((memory) => memory.memoryId === chat.selection.memoryId)
  const subtitle = `${chat.selection.root ?? chat.directory} · ${chat.selection.tab ?? "memory"}${chat.selection.category ? ` · ${chat.selection.category}` : ""}`
  const mainHeight = Math.max(4, height - 9)
  const archived = (cols: number): Line[] => {
    const archive = chat.archive!
    if (!archive.items.length) return [[{ text: "No archived chats", fg: "muted" }]]
    return archive.items.slice(0, Math.max(1, mainHeight - 4)).map((item, index) => fit([
      { text: index === archive.selected ? "› " : "  ", fg: index === archive.selected ? "primary" : "muted" },
      { text: `${new Date(item.archivedAt).toISOString().slice(0, 16).replace("T", " ")} · ${item.messages} msg${item.proposals ? ` · ${item.proposals} drafts` : ""} · `, fg: "muted" },
      { text: item.title || "(empty)", fg: index === archive.selected ? "text" : "muted" },
    ], cols))
  }
  const conversation = (cols: number): Line[] => {
    if (chat.archive) return archived(cols)
    const lines: Line[] = []
    for (const message of chat.thread.messages) {
      const rendered = renderMarkdown(message.text, Math.max(1, cols - 2))
      lines.push([{ text: message.role === "user" ? "› " : "◆ ", fg: message.role === "user" ? "muted" : "primary" }, ...(rendered[0] ?? [])], ...rendered.slice(1).map((line) => [{ text: "  " }, ...line]), [])
    }
    if (chat.loading) lines.push([{ text: "Loading history…", fg: "muted" }])
    else if (!lines.length) lines.push([{ text: "No messages", fg: "muted" }])
    if (chat.thread.busy) lines.push([{ text: "Answering…", fg: "primary" }])
    if (chat.thread.canceled) lines.push([{ text: "Canceled", fg: "muted" }])
    if (chat.thread.error) lines.push(...renderMarkdown(chat.thread.error, cols).map((line) => line.map((span) => ({ ...span, fg: "error" as const }))))
    const room = Math.max(1, mainHeight - 4)
    chat.scroll = Math.min(chat.scroll, Math.max(0, lines.length - room))
    const end = Math.max(room, lines.length - chat.scroll)
    return lines.slice(Math.max(0, end - room), end)
  }
  const detail = (cols: number): Line[] => [
    [{ text: `${chat.selection.view ?? "project"} · ${chat.selection.tab ?? "memory"}`, fg: "primary" }], [],
    ...(selected ? renderMarkdown(selected.text, cols) : [[{ text: "No memory selected", fg: "muted" as const }]]), [],
    [{ text: `${pending.length} pending action${pending.length === 1 ? "" : "s"}`, fg: "primary" }],
    ...pending.flatMap((memory) => renderMarkdown(`${memory.details?.action?.kind ?? "proposal"}: ${memory.text}`, cols)),
  ]
  const editor = sideInput({ editor: chat.editor, draft: chat.editor.text } as Parameters<typeof sideInput>[0], width - 4)
  const body = panelGrid({ width: width - 4, compact: false, maxColumns: compact ? 1 : 2, padding: true, heights: [mainHeight, 5], rows: [
    [{ title: chat.archive ? "Archived chats" : "Memory assistant", weight: 2, body: conversation },...(!compact ? [{ title: "Selection / Pending", body: detail }] : [])],
    [{ title: "Question", active: true, body: (cols) => [fit([{ text: `› ${editor.text}`, fg: "text" }], cols)] }],
  ] })
  return appearancePage({ title: "Memory assistant", subtitle, hints: chat.archive ? "↑↓ select · enter restore · x forget · esc close" : compact ? "↵ ask · ^N new · ^O chats · ^L clear" : "enter ask · ^N new chat · ^O chats · ^R pending · ^X cancel · ^L clear · pgup/dn · esc back", body, width, height })
}

export function memoryAssistantCursor(chat: MemoryAssistantState, width: number, height: number) {
  const editor = sideInput({ editor: chat.editor, draft: chat.editor.text } as Parameters<typeof sideInput>[0], width - 4)
  return { row: Math.max(0, height - 4), col: Math.min(width - 3, 6 + editor.cursor) }
}
