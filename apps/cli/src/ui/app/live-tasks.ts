import type { TaskRecord } from "@mendcode/protocol"
import type { AppContext } from "./context"

/**
 * The open session's sub-agents for the strip above the prompt. One `task.list` at a time: a change that arrives while one is
 * in flight asks once more when it lands, so a burst of `task.changed` costs two requests, not one each.
 */
export async function refreshLiveTasks(ctx: AppContext): Promise<void> {
  const { state, input } = ctx
  if (state.liveTasksAsk) { state.liveTasksAsk.again = true; return }
  const ask = (state.liveTasksAsk = { again: false })
  try {
    const sessionId = state.sessionId
    const reply = await input.send({ type: "task.list", sessionId }).catch(() => undefined)
    // A refused or failed list reads as none, so the first frame of a session asks once, not on every frame.
    if (sessionId === state.sessionId) {
      state.liveTasks = reply?.ok ? (reply.result?.tasks as TaskRecord[] | undefined) ?? [] : state.liveTasks ?? []
      ctx.requestFrame()
    }
  } finally {
    state.liveTasksAsk = undefined
    if (ask.again) void refreshLiveTasks(ctx)
  }
}
