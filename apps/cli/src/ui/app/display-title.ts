import type { AppContext } from "./context"
import { labelString, sessionLabel } from "../../view/session-label"

/**
 * The title as the top bar and the terminal title show it: the session's own, else `Draft · …` for an untitled session that holds an
 * unsent draft (the daemon's list says so), else nothing. Export names, the exit summary and extensions keep reading the plain title.
 */
export function sessionDisplayTitle(state: AppContext["state"], title: string): string {
  if (title) return title
  const summary = state.sessions.find((listed) => listed.sessionId === state.sessionId) ?? state.paletteSessions.find((listed) => listed.sessionId === state.sessionId)
  return summary?.draft ? labelString(sessionLabel(summary, { untitled: "", marker: "Draft" })) : ""
}
