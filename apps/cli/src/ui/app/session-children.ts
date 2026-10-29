import type { AgentActivity, StripTask } from "../../view/agents-strip"
import type { AgentShell } from "../../view/agents-page"
import { modelLabel } from "../../view/model-label"
import type { PaneChild } from "../../herdr"
import type { AppState } from "./context"

/**
 * The open session's sub-agents as one list: the daemon's child tasks (any engine, `task` and `delegate_task`), and the
 * sub-agents an engine runs inside the session (Claude Code's Agent calls, foreground and background). The Agents strip
 * draws it and the multiplexer's pane reports it (`paneChildren`), so both always show the same children.
 */
export function sessionChildren(state: AppState, input: { now: number; sep: string }) {
  const threads = (state.agentRoot ?? state.transcript).agentThreads()
  // Only Claude Code reports its Agent calls as threads: one runs on the model it named, or on the session's when it named none.
  const threadRun = (model: string | undefined): StripTask["run"] => { const id = model ?? state.effectiveModel?.model; return id ? { model: id, engine: "claude" } : undefined }
  const threadTasks: StripTask[] = threads.map((thread) => ({ taskId: thread.itemId as never, description: thread.description, agent: thread.agent, background: thread.background, state: thread.running ? "running" : thread.status === "ok" ? "completed" : thread.status === "error" ? "failed" : "interrupted", createdAt: thread.startedAt ?? input.now, updatedAt: thread.endedAt ?? thread.startedAt ?? 0, ...(threadRun(thread.model) ? { run: threadRun(thread.model)! } : {}) }))
  const threadActivity = (taskId: string): AgentActivity | undefined => {
    const thread = threads.find((entry) => entry.itemId === taskId)
    return thread?.running && thread.last ? { state: "tool", tool: `${thread.last} ${input.sep} ${thread.tools} tool${thread.tools === 1 ? "" : "s"}` } : undefined
  }
  // What runs in the background of this session (the model's shells, Claude Code's own agents and commands).
  const running = state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId && !threads.some((thread) => thread.running && thread.description === shell.command))
  // Claude Code's background agents are sub-agents like the others: its call ends at once, so the thread looks done while the
  // agent works on. They join the list as running agents (their thread's row, when the transcript has one).
  const backgroundAgents = running.filter((shell) => shell.kind === "agent")
  const commands: AgentShell[] = running.filter((shell) => shell.kind !== "agent")
  const agentTasks: StripTask[] = backgroundAgents.map((shell) => {
    const thread = threadTasks.find((task) => task.description === shell.command)
    return { ...(thread ?? { taskId: shell.id as never, description: shell.command, agent: "agent", createdAt: shell.startedAt, updatedAt: shell.startedAt }), background: true, state: "running" }
  })
  const tasks: StripTask[] = [...(state.liveTasks ?? []), ...threadTasks.filter((task) => !agentTasks.some((agent) => agent.taskId === task.taskId)), ...agentTasks]
  const activity = (taskId: string) => state.agentSessions.get(taskId) ?? threadActivity(taskId)
  // The model a thread's engine named, by the thread's item.
  const threadModel = (taskId: string) => threads.find((entry) => entry.itemId === taskId)?.model
  return { tasks, commands, activity, threadModel }
}

/** The same children as the multiplexer's pane reports them: who each is, what it runs on, and where it stands. */
export function paneChildren(state: AppState, now: number): PaneChild[] {
  const { tasks, activity, threadModel } = sessionChildren(state, { now, sep: "·" })
  const results = new Map((state.liveTasks ?? []).map((task) => [task.taskId as string, task.result]))
  return tasks.map((task) => {
    const doing = activity(task.taskId)
    const model = task.run ? modelLabel(task.run.model, state.modelReport) : threadModel(task.taskId)
    const waiting = task.state === "needs_input" || doing?.state === "waiting_approval"
    return {
      id: task.taskId,
      type: [task.agent, ...(model ? [model] : []), ...(task.run ? [task.run.engine] : [])].join(" · "),
      description: task.description,
      state: waiting ? "waiting" : task.state === "queued" || task.state === "running" ? "running" : task.state === "completed" ? "done" : task.state === "failed" ? "failed" : "stopped",
      ...(doing?.state === "tool" && doing.tool ? { tool: doing.tool } : {}),
      ...(waiting && doing?.pending ? { pending: doing.pending } : {}),
      ...(results.get(task.taskId) ? { result: results.get(task.taskId)! } : {}),
    }
  })
}
