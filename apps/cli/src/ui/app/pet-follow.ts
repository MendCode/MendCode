import type { AppState } from "./context"

const WORKING = new Set(["generating", "tool", "compacting", "cancelling", "waiting_approval"])

/** Whether a sub-agent of the open session is at work: a session the Agent View lists whose parent a `task.changed` (or the agents card's tree) named as this one. */
function agentsWorking(state: AppState): boolean {
  for (const session of state.agentSessions.values()) {
    if (!WORKING.has(session.state)) continue
    if (state.agentParents.get(session.sessionId) === state.sessionId) return true
    if (state.sidebarTree?.some((node) => node.sessionId === session.sessionId && node.kind === "task" && node.parentId === state.sessionId)) return true
  }
  return false
}

/**
 * Tells the session pet what the session is doing, from what the app already keeps: the transcript's foreground state, the
 * item in flight (`turnState.current`: reasoning is thinking, a compaction compacting, a `task` call agents) and, once the
 * main agent rests, whether its sub-agents still work. Called after every session event and when a sub-agent's activity changes.
 */
export function followPet(state: AppState) {
  const pet = state.pet
  if (!pet) return
  const foreground = state.transcript.foreground
  pet.setForeground(foreground, { current: state.turnState.current, ...(foreground === "idle" ? { agents: agentsWorking(state) } : {}) })
}
