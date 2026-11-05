import { subagentColor } from "../../view/agent-color"
import type { AgentThread } from "../../view/transcript"
import type { ColorName } from "../theme"
import type { AppState } from "./context"

/** The sub-agent the chat shows in place of the conversation: a thread of this session, or the session of a child task. */
export type ViewedAgent = { kind: "thread"; name: string; color: ColorName; thread: AgentThread } | { kind: "child"; name: string; color: ColorName; taskId: string }

/** Who the chat shows now when it is not the conversation itself; undefined in the conversation. */
export function viewedAgent(state: AppState): ViewedAgent | undefined {
  if (state.agentView) {
    const thread = (state.agentRoot ?? state.transcript).agentThreads().find((each) => each.itemId === state.agentView)
    return thread ? { kind: "thread", name: thread.description, color: subagentColor(thread.description), thread } : undefined
  }
  if (!state.sessionParentId) return undefined
  const name = state.liveTasks?.find((task) => task.taskId === state.sessionId)?.description ?? state.sessions.find((session) => session.sessionId === state.sessionId)?.title ?? "sub-agent"
  return { kind: "child", name, color: subagentColor(name), taskId: state.sessionId }
}

/** The title of the session the viewed sub-agent belongs to. */
export function parentTitle(state: AppState, viewed: ViewedAgent): string {
  const id = viewed.kind === "child" ? state.sessionParentId : state.sessionId
  return state.sessions.find((session) => session.sessionId === id)?.title.trim() || (viewed.kind === "child" ? "parent session" : "this session")
}
