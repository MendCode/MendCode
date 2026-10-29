import type { MemoryAssistantArchive, MemoryAssistantSelection, MemoryAssistantThread } from "@mendcode/protocol"
import { createEditor } from "../../view/editor"
import type { AppContext } from "./context"
import { visibleMemories } from "../lazy-pages"

export type MemoryAssistantState = {
  thread: MemoryAssistantThread
  editor: ReturnType<typeof createEditor>
  directory: string
  selection: MemoryAssistantSelection
  scroll: number
  serial: number
  loading: boolean
  /** The archived chats while their list is open (^O). */
  archive?: { items: MemoryAssistantArchive[]; selected: number } | undefined
}

export function createMemoryAssistant(ctx: AppContext, loadMemories: () => Promise<void>) {
  const { state, input, requestFrame } = ctx
  async function openMemoryAssistant() {
    const directory = input.directory
    if (!directory) {
      ctx.fail("Memory assistant needs a project")
      return
    }
    const tab = state.memoryState.tab
    const listed = tab === "pending" || tab === "saved" || tab === "archived" ? visibleMemories(state.memories, tab, state.memoryState.filter)[state.memoryState.selected] : undefined
    const selected = tab === "graph" ? state.memoryGraph?.nodes.find((memory) => memory.memoryId === state.memoryState.graph.selected) ?? state.memoryGraph?.nodes[0] : listed
    const category = tab === "policies" ? state.memoryCategories?.[state.memoryState.policies.row]?.id : selected?.category
    const selection: MemoryAssistantSelection = { view: state.memoryState.workspace.view, ...(state.memoryState.workspace.root ? { root: state.memoryState.workspace.root } : {}), tab, ...(selected ? { memoryId: selected.memoryId } : {}), ...(category ? { category } : {}) }
    const chat = state.memoryAssistant?.directory === directory ? state.memoryAssistant : { thread: { messages: [], busy: false, proposals: [] }, editor: createEditor(), directory, selection, scroll: 0, serial: 0, loading: false }
    state.memoryAssistant = chat
    chat.selection = selection
    state.page = "memory-assistant"
    if (!chat.thread.busy) {
      chat.loading = true
      const serial = chat.serial
      requestFrame()
      const reply = await input.send({ type: "memory.assistant.get", directory })
      if (serial === chat.serial) {
        if (reply.ok && reply.result?.thread) chat.thread = reply.result.thread as MemoryAssistantThread
        else if (!reply.ok) chat.thread = { ...chat.thread, error: reply.error.message }
        chat.loading = false
      }
    }
    requestFrame()
  }
  async function ask(chat: MemoryAssistantState, text: string) {
    if (chat.thread.busy || chat.loading) return
    const serial = ++chat.serial
    chat.thread = { ...chat.thread, error: undefined, messages: [...chat.thread.messages.slice(-22), { role: "user", text }], busy: true }
    chat.scroll = 0
    requestFrame()
    const reply = await input.send({ type: "memory.assistant.send", directory: chat.directory, text, selection: chat.selection })
    if (serial !== chat.serial) return
    if (reply.ok && reply.result?.thread) chat.thread = reply.result.thread as MemoryAssistantThread
    else chat.thread = { ...chat.thread, busy: false, ...(reply.ok ? {} : { error: reply.error.message }) }
    await loadMemories()
    requestFrame()
  }
  /** One archive operation; the live thread and the list come back together. */
  async function archiveCall(chat: MemoryAssistantState, action: "archive" | "list" | "restore" | "delete", archiveId?: string) {
    chat.serial++
    chat.loading = false
    const reply = await input.send({ type: "memory.assistant.archive", directory: chat.directory, action, ...(archiveId ? { archiveId } : {}) })
    if (!reply.ok) {
      chat.thread = { ...chat.thread, busy: false, error: reply.error.message }
      return undefined
    }
    if (reply.result?.thread) chat.thread = reply.result.thread as MemoryAssistantThread
    return (reply.result?.archives ?? []) as MemoryAssistantArchive[]
  }
  async function archiveKey(chat: MemoryAssistantState, archive: NonNullable<MemoryAssistantState["archive"]>, key: string) {
    const current = archive.items[archive.selected]
    if (key === "\x1b" || key === "\x0f") chat.archive = undefined
    else if (key === "\x1b[A" || key === "k") archive.selected = Math.max(0, archive.selected - 1)
    else if (key === "\x1b[B" || key === "j") archive.selected = Math.min(Math.max(0, archive.items.length - 1), archive.selected + 1)
    else if (key === "\r" && current) {
      const items = await archiveCall(chat, "restore", current.archiveId)
      if (items) {
        chat.archive = undefined
        chat.scroll = 0
      }
    } else if ((key === "x" || key === "\x7f") && current) {
      const items = await archiveCall(chat, "delete", current.archiveId)
      if (items) chat.archive = { items, selected: Math.min(archive.selected, Math.max(0, items.length - 1)) }
    }
  }
  async function memoryAssistantKey(key: string) {
    const chat = state.memoryAssistant
    if (!chat) return
    if (chat.archive) await archiveKey(chat, chat.archive, key)
    else if (key === "\x0e") {
      await archiveCall(chat, "archive")
      chat.editor.clear()
      chat.scroll = 0
    } else if (key === "\x0f") {
      const items = await archiveCall(chat, "list")
      if (items) chat.archive = { items, selected: 0 }
    } else if (key === "\x1b") state.page = "memory"
    else if (key === "\x12") {
      state.memoryState.tab = "pending"
      state.page = "memory"
      await loadMemories()
    }
    else if (key === "\x0c" || key === "\x18") {
      chat.serial++
      chat.loading = false
      const reply = await input.send({ type: key === "\x0c" ? "memory.assistant.clear" : "memory.assistant.cancel", directory: chat.directory })
      if (reply.ok && reply.result?.thread) chat.thread = reply.result.thread as MemoryAssistantThread
      else if (!reply.ok) chat.thread = { ...chat.thread, busy: false, error: reply.error.message }
      if (key === "\x0c") {
        chat.editor.clear()
        chat.scroll = 0
      }
    } else if (key === "\r") {
      const text = chat.editor.text.trim().slice(0, 4_000)
      if (text && !chat.thread.busy && !chat.loading) {
        chat.editor.clear()
        void ask(chat, text)
      }
    } else if (key === "\x1b[5~" || key === "\x1b[6~") chat.scroll = Math.max(0, chat.scroll + (key === "\x1b[5~" ? 6 : -6))
    else {
      chat.editor.key(key === "\n" ? " " : key)
      if (chat.editor.text.length > 4_000) chat.editor.replaceAll(chat.editor.text.slice(0, 4_000))
    }
    requestFrame()
  }
  return { openMemoryAssistant, memoryAssistantKey }
}
