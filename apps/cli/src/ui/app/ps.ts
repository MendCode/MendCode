import { psKey, type PsItem } from "../../view/ps-card"
import type { AppContext } from "./context"

/** `/ps`: lists what runs in the background of the open session and stops one item or all of them, as Codex's `/ps` and `/stop` do. */
export function createPs(ctx: AppContext, actions: { loadAgentShells(): Promise<void> }) {
  const { state } = ctx

  const items = (): PsItem[] => state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId)

  async function open() {
    state.psCard = { selected: 0 }
    ctx.requestFrame()
    await actions.loadAgentShells()
  }

  async function stop(taskId?: string) {
    const reply = await ctx.input.send({ type: "background.stop", sessionId: state.sessionId, ...(taskId ? { taskId } : {}) })
    if (!reply.ok) return ctx.fail(reply.error.message)
    const result = (reply.result ?? {}) as { stopped?: number; failed?: string[] }
    const stopped = result.stopped ?? 0
    const failed = result.failed ?? []
    state.notice = failed.length ? `could not stop ${failed.join(", ")}` : `stopped ${stopped} background ${stopped === 1 ? "item" : "items"}`
    await actions.loadAgentShells()
  }

  /** True when the open card took the key. */
  async function key(key: string): Promise<boolean> {
    if (!state.psCard) return false
    const result = psKey(state.psCard, key, items())
    state.psCard = result.state
    if (result.stop) await stop(result.stop.taskId)
    ctx.requestFrame()
    return true
  }

  return { open, key, items }
}
