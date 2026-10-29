import type { MemoryAssistantThread, MemoryEntry } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function b63Harness(width = 100, height = 30) {
  const saved: MemoryEntry = { memoryId: ids("memory"), scope: "project", directory: "/work/mendcode", text: "Run bun test and pnpm typecheck before delivery.", category: "commands", status: "saved", source: "user", createdAt: NOW, updatedAt: NOW }
  const pending: MemoryEntry = { ...saved, memoryId: ids("memory"), status: "pending", source: "agent", text: "Connect the validation rules.", details: { action: { kind: "graph-link", text: "Connect the validation rules.", fromFactID: saved.memoryId, toFactID: ids("memory"), linkKind: "supports" } } }
  let thread: MemoryAssistantThread = { messages: [], busy: false, proposals: [] }
  let memories = [saved]
  let error = ""
  let archived: Array<{ archiveId: string; archivedAt: number; thread: MemoryAssistantThread }> = []
  const listing = () => archived.map(({ archiveId, archivedAt, thread: chat }) => ({ archiveId, archivedAt, messages: chat.messages.length, proposals: chat.proposals.length, title: chat.messages[0]?.text ?? "" }))
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode", reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { engine: "native", selectable: true, defaults: { model: "local-test-model" }, roles: { memoryAssistant: { model: "local-memory-model" } }, effective: { model: "local-test-model" }, models: [{ id: "local-memory-model", name: "Memory test model", provider: "local", contextWindow: 128000, efforts: [] }] } }
    if (command.type === "memory.list") return { ok: true, result: { memories: [...memories, ...(thread.proposals.length ? [pending] : [])] } }
    if (command.type === "memory.workspaces") return { ok: true, result: { workspaces: [], omitted: 0 } }
    if (command.type === "memory.graph") return { ok: true, result: { nodes: [saved], links: [], health: { nodes: 1, links: 0, connected: 0, isolated: 1, conflicts: 0, state: "disconnected" } } }
    if (command.type === "memory.categories") return { ok: true, result: { categories: [] } }
    if (command.type === "memory.assistant.get") return { ok: true, result: { thread } }
    if (command.type === "memory.assistant.send") {
      if (error) return { ok: false, error: { code: "invalid_command", message: error } }
      thread = { messages: [...thread.messages, { role: "user", text: command.text }, { role: "assistant", text: "The selected rule requires **bun test** and `pnpm typecheck`. A graph link is pending your review." }], busy: false, proposals: [pending.memoryId], selection: command.selection }
      return { ok: true, result: { thread } }
    }
    if (command.type === "memory.assistant.clear") {
      thread = { messages: [], busy: false, proposals: [] }
      return { ok: true, result: { thread } }
    }
    if (command.type === "memory.assistant.archive") {
      if (command.action === "archive" && thread.messages.length) {
        archived = [{ archiveId: `chat-${archived.length + 1}`, archivedAt: NOW, thread }, ...archived]
        thread = { messages: [], busy: false, proposals: [] }
      } else if (command.action === "restore") {
        const found = archived.find((item) => item.archiveId === command.archiveId)
        if (!found) return { ok: false, error: { code: "invalid_command", message: "Unknown archived chat" } }
        archived = [...(thread.messages.length ? [{ archiveId: "swap", archivedAt: NOW, thread }] : []), ...archived.filter((item) => item !== found)]
        thread = found.thread
      } else if (command.action === "delete") archived = archived.filter((item) => item.archiveId !== command.archiveId)
      return { ok: true, result: { thread, archives: listing() } }
    }
    if (command.type === "memory.assistant.cancel") {
      thread = { ...thread, busy: false, canceled: true }
      return { ok: true, result: { thread } }
    }
    return undefined
  } })
  return { ...h, error: (value: string) => { error = value }, thread: (value: MemoryAssistantThread) => { thread = value }, memories: (value: MemoryEntry[]) => { memories = value } }
}
