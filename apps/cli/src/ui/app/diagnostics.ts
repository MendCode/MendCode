import type { AppContext } from "./context"
import type { DiagnosticsReport } from "../../view/diagnostics-page"
import { preload } from "../lazy-pages"

export function createDiagnostics(ctx: AppContext) {
  const { input, state, requestFrame, say } = ctx
  async function loadDiagnostics() {
    if (!input.diagnostics) return
    state.diagnosticsMemory = input.diagnostics.memory()
    const reply = await input.send({ type: "diagnostics.resources" })
    state.diagnosticsError = reply.ok ? "" : reply.error.message
    state.diagnosticsReport = reply.ok ? reply.result as DiagnosticsReport : undefined
    requestFrame()
  }
  async function snapshot() {
    if (!input.diagnostics) return
    if (input.remote?.readOnly) { say("heap snapshots disabled in read-only mode", "warning"); return }
    try {
      const daemon = await input.send({ type: "diagnostics.snapshot" })
      if (!daemon.ok) throw new Error(daemon.error.message)
      state.diagnosticsSnapshots = [String(daemon.result?.path)]
      requestFrame()
      state.diagnosticsSnapshots.push(await input.diagnostics.snapshot())
      state.diagnosticsError = ""
    } catch (error) {
      state.diagnosticsError = error instanceof Error ? error.message : String(error)
    }
    requestFrame()
  }
  async function diagnosticsCommand(text: string) {
    const match = /^\/(diagnostics|diag|snapshot)(?:\s+.*)?$/.exec(text.trim())
    if (!match) return false
    if (!input.diagnostics) { say("restart with --diagnostics to enable diagnostics", "warning"); return true }
    await preload("diagnostics")
    state.page = "diagnostics"
    state.diagnosticsScroll = 0
    await loadDiagnostics()
    if (match[1] === "snapshot") await snapshot()
    return true
  }
  async function diagnosticsKey(key: string) {
    if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "r") await loadDiagnostics()
    else if (key === "s") { await loadDiagnostics(); await snapshot() }
    else if (["\x1b[A", "k", "\x1b[5~"].includes(key)) state.diagnosticsScroll = Math.max(0, (state.diagnosticsScroll ?? 0) - (key === "\x1b[5~" ? 10 : 1))
    else if (["\x1b[B", "j", "\x1b[6~"].includes(key)) state.diagnosticsScroll = (state.diagnosticsScroll ?? 0) + (key === "\x1b[6~" ? 10 : 1)
    requestFrame()
  }
  return { diagnosticsCommand, diagnosticsKey }
}
