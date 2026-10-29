import type { LedgerExport, LedgerPage, LoopId, WorkflowId } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"

export function createAutomationLedger(ctx: AppContext) {
  const { state, input, requestFrame, copyText } = ctx
  let generation = 0

  async function load() {
    const current = state.automationLedger
    if (!current) return
    const token = ++generation
    current.loading = true
    requestFrame()
    const before = current.cursors.at(-1)
    const query = { ...(before ? { before } : {}), limit: current.operation === "receipt" ? 20 : 50 }
    const command = current.scope === "workflow"
      ? { type: `workflow.${current.operation}` as const, workflowId: current.ownerId as WorkflowId, ...query }
      : { type: `loop.${current.operation}` as const, loopId: current.ownerId as LoopId, ...query }
    const reply = await input.send(command)
    if (token !== generation || state.automationLedger !== current) return
    current.loading = false
    if (reply.ok) { current.page = reply.result?.ledger as LedgerPage; delete current.error }
    else current.error = reply.error.message
    requestFrame()
  }

  async function open(scope: "workflow" | "loop", ownerId: string, name: string) {
    await preload("automationLedger")
    state.automationLedger = { scope, ownerId, name, operation: "events", selected: 0, scroll: 0, cursors: [undefined] }
    await load()
  }

  async function key(key: string) {
    const current = state.automationLedger
    if (!current) return
    if (key === "\x1b" || key === "q") {
      if (current.exported) { delete current.exported; current.scroll = 0 }
      else { delete state.automationLedger; generation++ }
    } else if (key === "y" && current.exported) copyText(current.exported.text, "the evidence export")
    else if (key === "\x1b[6~" || key === "\x1b[5~") current.scroll = Math.max(0, current.scroll + (key === "\x1b[6~" ? 8 : -8))
    else if (!current.exported) {
      if (key === "1" || key === "2" || key === "3") {
        current.operation = key === "1" ? "events" : key === "2" ? "artifacts" : "receipt"
        current.selected = current.scroll = 0
        current.cursors = [undefined]
        await load()
      } else if (key === "\x1b[A" || key === "\x1b[B") {
        current.selected = Math.max(0, Math.min(current.selected + (key === "\x1b[B" ? 1 : -1), (current.page?.entries.length ?? 1) - 1))
        current.scroll = 0
      } else if (key === "]" && !current.loading && current.page?.nextBefore) {
        current.cursors.push(current.page.nextBefore)
        current.selected = current.scroll = 0
        await load()
      } else if (key === "[" && !current.loading && current.cursors.length > 1) {
        current.cursors.pop()
        current.selected = current.scroll = 0
        await load()
      } else if (key === "r") { current.cursors = [undefined]; current.selected = current.scroll = 0; await load() }
      else if (key === "e" || key === "m") {
        const format = key === "e" ? "json" : "markdown"
        const before = current.cursors.at(-1)
        const query = { format, ...(before ? { before } : {}) } as const
        const reply = await input.send(current.scope === "workflow" ? { type: "workflow.export", workflowId: current.ownerId as WorkflowId, ...query } : { type: "loop.export", loopId: current.ownerId as LoopId, ...query })
        if (state.automationLedger !== current) return
        if (reply.ok) { current.exported = reply.result?.export as LedgerExport; current.scroll = 0 }
        else current.error = reply.error.message
      }
    }
    requestFrame()
  }
  return { open, key }
}
