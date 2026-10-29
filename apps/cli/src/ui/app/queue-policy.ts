import type { AppState } from "./context"

export type QueuePolicy = "after-response" | "after-tools" | "immediate"

/**
 * The queue policy in force for the open session: the saved one (`/queue`), else what its engine can do. A message sent while
 * a turn runs joins it after the current tool iteration, as in Claude Code, wherever the engine takes one mid-turn (MendCode's
 * own, Claude Code, pi); Codex and ACP agents cannot, so there it waits for the response.
 */
export function queuePolicy(state: Pick<AppState, "settingsNow" | "modelReport" | "effectiveModel">): QueuePolicy {
  const saved = state.settingsNow.queue?.mode
  if (saved) return saved
  const model = state.effectiveModel?.model
  const engine = state.modelReport?.models?.find((entry) => entry.id === model)?.engine
  return model?.startsWith("acp:") || (engine && engine !== "claude" && engine !== "pi") ? "after-response" : "after-tools"
}
