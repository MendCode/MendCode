import { runSpans, type StripTask } from "../../view/agents-strip"
import { modelLabel } from "../../view/model-label"
import type { AppState } from "./context"

/**
 * What a sub-agent runs on (model, provider, engine, effort, fast), as the daemon recorded it when it launched it. Said only in the
 * full tier: the smaller ones keep a sub-agent's row and card to what it was asked and what it is doing.
 */
export function subagentRunOf(state: AppState, sep: string) {
  const shown = () => state.settingsNow.tier === "full"
  const label = (run: StripTask["run"]) => (run ? runSpans(run, (id) => modelLabel(id, state.modelReport), sep) : undefined)
  return {
    /** For a row of the Agents strip. */
    ofTask: (task: StripTask) => (shown() ? label(task.run) : undefined),
    /** For a `task` card of the chat: by the child's session id once the call has ended, by what it was asked while it runs. */
    ofCall(ref: { taskId?: string; description: string }) {
      if (!shown()) return undefined
      const tasks = state.liveTasks ?? []
      const named = tasks.filter((task) => task.description.trim() === ref.description)
      return label((ref.taskId ? tasks.find((task) => task.taskId === ref.taskId) : named.length === 1 ? named[0] : undefined)?.run)
    },
  }
}
