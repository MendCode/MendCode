import type { AppContext } from "./context"

export function createStartup(ctx: AppContext, actions: { submit(): Promise<void>; syncDraft(): void; restoreDraft(target: AppContext["state"]["sessionId"]): Promise<void> }) {
  let applied = false
  async function applyStartup() {
    if (applied) return
    applied = true
    const startup = ctx.input.startup
    const text = startup?.prompt ?? startup?.initialMessage
    if (text === undefined) { await actions.restoreDraft(ctx.state.sessionId); return }
    ctx.editor.replaceAll(text)
    actions.syncDraft()
    if (startup?.prompt !== undefined) await actions.submit()
    ctx.requestFrame()
  }
  return { applyStartup }
}
