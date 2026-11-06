import type { AppState } from "./context"

/** The daemon's own notes for the agent (a session it started waits for approval): hidden from the queue panel. */
const INTERNAL_NOTICE = /^Internal notification\. /

/** Whether a queued entry is one of the daemon's internal notes for the agent, which the queue panel never lists. */
export function internalQueued(entry: { preview: string; notice?: true }): boolean {
  return entry.notice === true && INTERNAL_NOTICE.test(entry.preview)
}

/** The queue as the panel shows it: what the user's actions (send now, drop last, edit last) act on. */
export function userQueue<Entry extends { preview: string; notice?: true }>(queue: readonly Entry[]): Entry[] {
  return queue.filter((entry) => !internalQueued(entry))
}

export type QueuePolicy ="after-response" | "after-tools" | "immediate"

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
