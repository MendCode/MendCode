import type { ItemId, SessionDetail, SessionId, TaskRecord } from "@mendcode/protocol"
import { createAgentView } from "./agent-view"
import type { AppContext } from "./context"

export type SessionNavigation = "session.child.first" | "session.child.next" | "session.child.previous" | "session.parent"

export function createSubagents(ctx: AppContext, actions: { switchSession(id: SessionId): Promise<void>; loadPage(name: "tasks"): Promise<void> }) {
  const { state, input, fail, requestFrame } = ctx
  const agentView = createAgentView(ctx)
  async function loadTasks() {
    const sessionId = state.sessionId
    const reply = await input.send({ type: "task.list", sessionId })
    if (sessionId !== state.sessionId) return
    if (reply.ok) {
      const selected = state.childTasks?.[state.taskSelected ?? 0]?.taskId
      state.childTasks = (reply.result?.tasks as TaskRecord[] | undefined) ?? []
      state.taskSelected = Math.max(0, selected ? state.childTasks.findIndex((task) => task.taskId === selected) : 0)
      state.taskError = ""
    } else state.taskError = reply.error.message
    requestFrame()
  }
  async function openTasks() {
    await actions.loadPage("tasks")
    state.page = "tasks"
    state.taskSelected = 0
    state.taskScroll = 0
    state.childTasks = []
    await loadTasks()
  }
  async function tasksKey(key: string) {
    const tasks = state.childTasks ?? []
    const selected = state.taskSelected ?? 0
    const task = tasks[selected]
    if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "\x1b[A" || key === "\x1bOA" || key === "k") { state.taskSelected = Math.max(0, selected - 1); state.taskScroll = 0 }
    else if (key === "\x1b[B" || key === "\x1bOB" || key === "j") { state.taskSelected = Math.min(Math.max(0, tasks.length - 1), selected + 1); state.taskScroll = 0 }
    else if (key === "\x1b[5~") state.taskScroll = Math.max(0, (state.taskScroll ?? 0) - 5)
    else if (key === "\x1b[6~" && task) state.taskScroll = Math.min(task.result.length, (state.taskScroll ?? 0) + 5)
    else if (key === "\r" && task) await actions.switchSession(task.taskId)
    else if (key === "r") await loadTasks()
    else if ((key === "x" || key === "b" || key === "w") && task) {
      const sessionId = state.sessionId
      const reply = await input.send({ type: "task.status", sessionId, taskId: task.taskId, action: key === "x" ? "cancel" : key === "b" ? "detach" : "wait", ...(key === "w" ? { timeoutMs: 1000 } : {}) })
      if (sessionId !== state.sessionId) return
      if (!reply.ok) state.taskError = reply.error.message
      else { state.taskError = ""; await loadTasks() }
    }
    requestFrame()
  }
  async function navigate(action: SessionNavigation) {
    // A sub-agent thread open in the chat: the same keys return to the conversation and change sibling, with no session to switch.
    if (agentView.open) return action === "session.parent" ? agentView.close() : action === "session.child.first" ? false : agentView.cycle(action === "session.child.next" ? 1 : -1)
    const current = state.sessionId
    const reply = await input.send({ type: "session.get", sessionId: current })
    if (!reply.ok) { fail(reply.error.message); return false }
    if (current !== state.sessionId) return false
    const session = reply.result?.session as SessionDetail | undefined
    if (!session) return false
    let next: SessionId | undefined
    if (action === "session.parent") next = session.parentId
    else {
      const parent = action === "session.child.first" ? session.parentId ?? current : session.parentId
      if (!parent) return false
      const listed = await input.send({ type: "session.children", sessionId: parent })
      if (current !== state.sessionId) return false
      if (!listed.ok) { fail(listed.error.message); return false }
      const children = (listed.result?.sessions as SessionDetail[] | undefined) ?? []
      children.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      const at = children.findIndex((child) => child.sessionId === current)
      const offset = action === "session.child.previous" ? 1 : -1
      next = action === "session.child.first" ? children[0]?.sessionId : children[(Math.max(0, at) + offset + children.length) % children.length]?.sessionId
    }
    // No child session to open: the session's own sub-agents (an engine's, as Claude Code's) open as a thread.
    if ((!next || next === current) && action === "session.child.first") return agentView.first()
    if (!next || next === current) return false
    await actions.switchSession(next)
    return true
  }
  /**
   * Opens what a strip row carries: a thread of this session, a child session, or something running in the background (an engine's
   * own agent with no thread, a command), which opens `/ps` on it. Anything else says so instead of doing nothing.
   */
  async function open(id: string) {
    if (agentView.show(id as never)) return
    if (agentView.open) agentView.close()
    if (id.startsWith("ses_")) return actions.switchSession(id as SessionId)
    const running = state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId)
    const at = running.findIndex((shell) => shell.id === id)
    if (at >= 0) { state.psCard = { selected: at }; requestFrame(); return }
    state.notice = "that agent is no longer running"
    requestFrame()
  }
  /**
   * A click on a sub-agent's call in the chat opens it, as in the strip. A thread of this session opens by its item; a child
   * session by the id its result carries, or while it runs by the live task that was asked the same thing.
   */
  function openCard(itemId: ItemId): boolean {
    const block = state.transcript.blocks().find((entry) => entry.itemId === itemId)
    if (!block || block.kind !== "tool_call") return false
    if (block.meta?.subagent === true) return agentView.show(itemId)
    const described = /^task:\s*(.*)$/s.exec(block.title ?? "")?.[1]?.trim()
    if (described === undefined) return false
    const live = state.liveTasks?.filter((task) => task.description.trim() === described)
    const target = typeof block.meta?.taskId === "string" ? block.meta.taskId : live?.length === 1 ? live[0]!.taskId : undefined
    if (!target) return false
    void actions.switchSession(target as SessionId)
    return true
  }
  return { loadTasks, openTasks, tasksKey, navigate, agentView, open, openCard }
}
