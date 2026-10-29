import type { AppContext } from "./context"
import { createEditor } from "../../view/editor"
import { preload } from "../lazy-pages"

export function createCompaction(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  const data = () => state.transcript.compactions().find((entry) => entry.turnId === state.compactionView?.turnId) ?? state.transcript.compactions().at(-1)

  async function openCompaction() {
    await preload("compaction")
    const current = state.transcript.compactions().at(-1)
    state.compactionView = { expanded: false, scroll: 0, editing: false, editor: createEditor({ wordWrap: true }), ...(current ? { turnId: current.turnId } : {}) }
    state.page = "compaction"
    requestFrame()
  }

  async function save() {
    const view = state.compactionView!
    const current = data()
    if (!current) return
    const reply = await input.send({ type: "session.compaction.set", sessionId: state.sessionId, turnId: current.turnId, text: view.editor.text })
    view.error = reply.ok ? undefined : reply.error.message.replace(/^\[[A-Z]+\]: /, "")
  }

  async function compactionKey(key: string) {
    const view = state.compactionView!
    const current = data()
    if (view.editing && current?.state !== "writing") {
      view.editing = false
      return requestFrame()
    }
    if (view.editing) {
      if (key === "\x1b" || key === "\x03") view.editing = false
      else {
        const before = view.editor.text
        const binding = state.bindings.direct.get(key)
        const mapped = binding && "action" in binding ? binding.action : state.bindings.inline.get(key)
        if (mapped === "edit.undo") view.editor.undo()
        else if (mapped === "edit.redo") view.editor.redo()
        else {
          if (mapped?.startsWith("edit.")) view.editor.action(mapped.slice(5) as import("../../view/editor-actions").EditAction)
          else if (!state.bindings.disabled.has(key)) view.editor.key(key === "\r" ? "\n" : key)
        }
        if (view.editor.text.length > 8_000) view.editor.replaceAll(view.editor.text.slice(0, 8_000))
        if (before !== view.editor.text) await save()
      }
    } else if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "m" || key === "\r") { view.expanded = !view.expanded; view.scroll = 0 }
    else if (key === "e" && current?.state === "writing" && state.tuiProfile.compactionScratchpad && !input.remote?.readOnly) {
      view.editor.replaceAll(current.followUp)
      view.editor.resetHistory()
      view.editing = true
      view.error = undefined
    } else if (key === "[" || key === "]") {
      const entries = state.transcript.compactions()
      const selected = entries.findIndex((entry) => entry.turnId === current?.turnId)
      const next = entries[Math.max(0, Math.min(entries.length - 1, selected + (key === "[" ? -1 : 1)))]
      if (next) { view.turnId = next.turnId; view.scroll = 0 }
    } else if (key === "\x1b[A") view.scroll = Math.max(0, view.scroll - 1)
    else if (key === "\x1b[B") view.scroll++
    requestFrame()
  }

  async function compactionPaste(text: string) {
    const view = state.compactionView
    if (!view?.editing || data()?.state !== "writing") return
    view.editor.insert(text.replace(/\r\n?/g, "\n"))
    if (view.editor.text.length > 8_000) view.editor.replaceAll(view.editor.text.slice(0, 8_000))
    await save()
    requestFrame()
  }

  return { openCompaction, compactionKey, compactionPaste }
}
