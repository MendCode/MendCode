import { SCRATCH_MAX_CHARS } from "../scratchpad"
import { DOCK_HEIGHT } from "../../view/dock"
import type { AppContext } from "./context"

export function createScratch(ctx: AppContext, actions: { loadAgentShells(): Promise<void> }) {
  const { input, state, say, scratchEditor, requestFrame, fail } = ctx
  let loaded = false
  let loading: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes = Promise.resolve()

  function ensureScratch() {
    const directory = input.directory ?? ""
    if (state.scratchFor === directory) return loading ?? Promise.resolve()
    state.scratchFor = directory
    loaded = false
    state.scratchNote = ""
    scratchEditor.replaceAll("")
    if (!directory) { loaded = true; return Promise.resolve() }
    loading = input.send({ type: "scratchpad.get", directory }).then((reply) => {
      if (reply.ok) {
        loaded = true
        state.scratchNote = typeof reply.result?.text === "string" ? reply.result.text.slice(0, SCRATCH_MAX_CHARS) : ""
        scratchEditor.replaceAll(state.scratchNote)
        scratchEditor.resetHistory()
      } else fail(reply.error.message)
      requestFrame()
    }).catch((error) => fail(String(error))).finally(() => { loading = undefined })
    return loading
  }

  async function editScratch() {
    // While the compaction panel shows the note, it is edited there and the dock stays shut.
    const inPanel = state.compactionLive.scratchPanel
    if (!inPanel && (state.mode === "minimal" || input.screen.size.height < DOCK_HEIGHT + 8)) return say("scratchpad needs a taller terminal and the balanced or full view", "warning")
    if (input.remote?.readOnly) return say("read-only terminal", "warning")
    if (!loaded && !loading) state.scratchFor = undefined
    await ensureScratch()
    if (!loaded) return
    if (!inPanel) {
      if (!state.dockOpen) void actions.loadAgentShells()
      state.dockOpen = true
    }
    state.editingScratch = true
    requestFrame()
  }

  function saveScratch() {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!loaded) return
    const text = state.scratchNote
    const directory = input.directory
    if (!directory) return say("scratchpad is session-only: no project directory", "warning")
    writes = writes.then(async () => {
      const reply = await input.send({ type: "scratchpad.set", directory, text })
      if (!reply.ok) fail(reply.error.message)
    }).catch((error) => fail(String(error)))
    return writes
  }

  function changed() {
    if (scratchEditor.text.length > SCRATCH_MAX_CHARS) scratchEditor.replaceAll(scratchEditor.text.slice(0, SCRATCH_MAX_CHARS))
    if (state.scratchNote !== scratchEditor.text) {
      state.scratchNote = scratchEditor.text
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void saveScratch(), 500)
      timer.unref?.()
    }
    requestFrame()
  }

  function endScratchEdit() {
    state.editingScratch = undefined
    if (timer) void saveScratch()
    requestFrame()
  }

  function scratchKey(key: string) {
    if (key === "\x1b" || key === "\x03" || key === "\x14") return endScratchEdit()
    if (key === "\x1f") scratchEditor.undo()
    else if (key === "\x1b[90;6u") scratchEditor.redo()
    else {
      const mapped = state.bindings.inline.get(key)
      if (mapped?.startsWith("edit.")) scratchEditor.action(mapped.slice(5) as import("../../view/editor-actions").EditAction)
      else if (!state.bindings.disabled.has(key)) scratchEditor.key(key === "\r" ? "\n" : key)
    }
    changed()
  }

  function scratchPaste(text: string) {
    scratchEditor.insert(text)
    changed()
  }

  return { ensureScratch, editScratch, endScratchEdit, saveScratch, scratchKey, scratchPaste }
}
