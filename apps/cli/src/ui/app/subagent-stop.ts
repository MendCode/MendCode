import type { SessionId } from "@mendcode/protocol"
import type { AppContext } from "./context"

/** A child task that still works: the daemon's own states for one. */
const ACTIVE_CHILD = new Set(["queued", "running", "needs_input"])

type Send = AppContext["input"]["send"]

type Found = { children: string[]; engine: string[] }

/**
 * The session's running sub-agents: its child tasks (MendCode's `task`) and the agents its engine runs by itself in the
 * background (Claude Code's), as the daemon lists them. Background shell commands are not sub-agents and are left out.
 */
async function find(send: Send, sessionId: SessionId): Promise<Found> {
  const [tasks, background] = await Promise.all([
    send({ type: "task.list", sessionId }),
    send({ type: "background.list", sessionId }),
  ])
  const children = tasks.ok ? ((tasks.result as { tasks?: Array<{ taskId: string; state: string }> } | undefined)?.tasks ?? []).filter((task) => ACTIVE_CHILD.has(task.state)).map((task) => task.taskId) : []
  const listed = background.ok ? (background.result as { tasks?: Array<{ id: string; kind?: string; status?: string }> } | undefined)?.tasks ?? [] : []
  const engine = listed.filter((task) => task.id.startsWith("engine:") && /agent/i.test(task.kind ?? "")).map((task) => task.id)
  return { children, engine }
}

export async function runningSubagents({ send, sessionId }: { send: Send; sessionId: SessionId }): Promise<number> {
  const found = await find(send, sessionId)
  return found.children.length + found.engine.length
}

/** Stops every running sub-agent of the session; resolves to how many were stopped. */
export async function stopSubagents({ send, sessionId }: { send: Send; sessionId: SessionId }): Promise<number> {
  const found = await find(send, sessionId)
  const replies = await Promise.all([
    ...found.children.map((taskId) => send({ type: "task.status", sessionId, taskId: taskId as SessionId, action: "cancel" })),
    ...found.engine.map((taskId) => send({ type: "background.stop", sessionId, taskId })),
  ])
  return replies.filter((reply) => reply.ok).length
}
