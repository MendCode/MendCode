import { limitBarVisible, limitDone, limitPrimary, limitStatus, parseLimitCommand, type LimitAction } from "../../view/usage-limit"
import type { AppContext } from "./context"

/** A turn paused by the provider's usage limit (docs/usage-limit.md): `/limit`, the bar's chips and ctrl+s. */
export function createUsageLimit(ctx: AppContext) {
  const { input, state, say, fail, now, requestFrame } = ctx

  async function act(action: LimitAction) {
    const view = state.transcript.usageLimit
    if (!view) return say("no turn is paused by a usage limit", "warning")
    const reply = await input.send({ type: "usage.limit", sessionId: state.sessionId, action })
    if (!reply.ok) return fail(reply.error.message.replace(/^\[[A-Z-]+\]:\s*/, ""))
    const resetsAt = typeof reply.result?.resetsAt === "number" ? reply.result.resetsAt : view.resetsAt
    say(limitDone(action, typeof reply.result?.state === "string" ? reply.result.state : undefined, resetsAt, now()), "success")
    requestFrame()
  }

  async function limitCommand(args: string) {
    const parsed = parseLimitCommand(args)
    if (!parsed.ok) {
      state.notice = parsed.error
      return requestFrame()
    }
    if (parsed.command.kind === "status") {
      state.notice = limitStatus(state.transcript.usageLimit, now())
      return requestFrame()
    }
    return act(parsed.command.action)
  }

  /** ctrl+s with the bar open and nothing queued: the bar's first chip. */
  async function limitKey(): Promise<boolean> {
    const view = state.transcript.usageLimit
    if (!limitBarVisible(view)) return false
    await act(limitPrimary(view))
    return true
  }

  /** esc in the minimal view cancels an armed auto-resume: the muted line above the prompt says `esc cancel` and there is no bar to click. */
  async function limitEscape(): Promise<boolean> {
    const view = state.transcript.usageLimit
    if (state.mode !== "minimal" || view?.state !== "scheduled" || state.transcript.activeTurn) return false
    await act("cancel")
    return true
  }

  /** A click on a chip of the bar. */
  async function limitClick(row: number, col: number): Promise<boolean> {
    const area = state.limitArea
    const chip = area?.chips.find((candidate) => row === area.top + candidate.row && col >= candidate.from && col < candidate.to)
    if (!chip) return false
    await act(chip.action)
    return true
  }

  return { limitCommand, limitKey, limitClick, limitEscape }
}
