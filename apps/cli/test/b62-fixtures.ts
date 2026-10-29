import type { AgentViewMetadata, SessionBackgroundEntry, SessionDetail, TaskRecord } from "@mendcode/protocol"
import { parityHarness } from "./parity-b01-b02-harness"
import { ids, NOW } from "./session-ui-harness"

export function b62Harness(width = 100, height = 30) {
  const parent = ids("session"), first = ids("session"), second = ids("session")
  const root = { sessionId: parent, title: "Review daemon lifecycle", directory: "/work/mendcode", createdAt: NOW - 40_000, updatedAt: NOW, lastSeq: 0, queued: 0, state: "idle", status: "idle", permission: "ask" } as SessionDetail
  const sessions: SessionDetail[] = [root, { ...root, sessionId: first, parentId: parent, title: "Inspect actor wake", createdAt: NOW - 20_000 }, { ...root, sessionId: second, parentId: parent, title: "Review writer presence", createdAt: NOW - 10_000 }]
  const task: TaskRecord = { taskId: first, parentId: parent, rootId: parent, depth: 1, generation: 2, description: "Inspect actor wake", agent: "explore", background: true, state: "completed", result: "The outbox uses a stable queue id. Restart checks queue.added before delivering a child notice.\nCancelling the owner dismisses pending notices.\nThe child transcript stays navigable.", createdAt: NOW - 20_000, updatedAt: NOW }
  let tasks: TaskRecord[] = [task, { ...task, taskId: second, generation: 1, description: "Review writer presence", state: "needs_input", result: "Awaiting approval to read the local report." }]
  let metadata: AgentViewMetadata[] = [{ sessionId: first, title: "Wake reliability", tags: ["daemon", "review"], group: "Parity", priority: "high", notes: "Inspect the saved child transcript before resuming.", pinned: true, archived: false }]
  let backgrounds: SessionBackgroundEntry[] = tasks.map((task) => ({ sessionId: task.taskId, state: task.state === "completed" ? "completed" : "needs_input", summary: task.result, pinned: false, createdAt: task.createdAt, updatedAt: task.updatedAt, session: { sessionId: task.taskId, title: task.description, directory: root.directory, parentId: parent, agent: task.agent }, ...(task.taskId === first ? { metadata: metadata[0]! } : {}) }))
  const h = parityHarness({ width, height, sessionId: parent, reply: (command) => {
    if (command.type === "session.list") return { ok: true, result: { sessions } }
    if (command.type === "session.get") return { ok: true, result: { session: sessions.find((session) => session.sessionId === command.sessionId) } }
    if (command.type === "session.children") return { ok: true, result: { sessions: sessions.filter((session) => session.parentId === command.sessionId) } }
    if (command.type === "task.list") return { ok: true, result: { tasks: tasks.filter((task) => task.parentId === command.sessionId) } }
    if (command.type === "task.status") {
      tasks = tasks.map((task) => task.taskId === command.taskId ? { ...task, ...(command.action === "cancel" ? { state: "cancelled" as const } : {}), ...(command.action === "detach" ? { background: true } : {}) } : task)
      return { ok: true, result: { task: tasks.find((task) => task.taskId === command.taskId) } }
    }
    if (command.type === "session.background.list") return { ok: true, result: { sessions: backgrounds } }
    if (command.type === "session.agent-view.metadata.list") return { ok: true, result: { metadata } }
    if (command.type === "session.agent-command.list") return { ok: true, result: { commands: [], metadata } }
    if (command.type === "session.background.writer.acquire") return { ok: true, result: { acquired: backgrounds.some((entry) => entry.sessionId === command.sessionId) } }
    if (command.type === "session.background.writer.release") return { ok: true, result: { info: null } }
    return undefined
  } })
  return { ...h, parent, first, second, sessions, get tasks() { return tasks }, get backgrounds() { return backgrounds }, setTasks(value: TaskRecord[]) { tasks = value }, setBackgrounds(value: SessionBackgroundEntry[]) { backgrounds = value }, setMetadata(value: AgentViewMetadata[]) { metadata = value } }
}
