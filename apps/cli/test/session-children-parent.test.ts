import { expect, test } from "bun:test"
import { sessionChildren } from "../src/ui/app/session-children"
import type { AppState } from "../src/ui/app/context"

/** A native sub-agent's own session open: the strip keeps its parent's other sub-agents, Claude Code's background agents included. */

const parent = "ses_01M7C3T9P0JHRKP0"
const child = "ses_01M7C3T9P0JHRKC1"

function state(sessionParentId: string | undefined): AppState {
  return {
    sessionId: child,
    sessionParentId,
    transcript: { agentThreads: () => [] },
    liveTasks: [{ taskId: "tsk_b4", description: "Backend B4: terminar", agent: "general", state: "running", createdAt: 1, updatedAt: 1 }],
    agentSessions: new Map(),
    relaunched: new Set(),
    agentShells: [
      { id: "bg_fable", sessionId: parent, command: "Rediseño P1 fiel al escritorio", startedAt: 1, status: "running", kind: "agent" },
      { id: "bg_cmd", sessionId: parent, command: "sleep 9", startedAt: 1, status: "running", kind: "command" },
      { id: "bg_own", sessionId: child, command: "pytest -q", startedAt: 1, status: "running" },
    ],
  } as unknown as AppState
}

test("inside a sub-agent's session, the parent's background agents stay in the list; its commands stay the parent's", () => {
  const { tasks, commands } = sessionChildren(state(parent), { now: 2, sep: "·" })
  expect(tasks.map((task) => task.description)).toEqual(["Backend B4: terminar", "Rediseño P1 fiel al escritorio"])
  expect(commands.map((shell) => shell.command)).toEqual(["pytest -q"])
})

test("a session with no parent lists only its own", () => {
  const { tasks } = sessionChildren(state(undefined), { now: 2, sep: "·" })
  expect(tasks.map((task) => task.description)).toEqual(["Backend B4: terminar"])
})

test("a parent's agent is never merged with a thread of the child that has the same description", () => {
  const thread = (running: boolean) => ({ itemId: "itm_child", description: "Rediseño P1 fiel al escritorio", agent: "general", background: false, running, status: running ? undefined : "ok", startedAt: 1, endedAt: running ? undefined : 2, tools: 0 })
  for (const running of [true, false]) {
    const base = state(parent)
    const withThread = { ...base, transcript: { agentThreads: () => [thread(running)] } } as unknown as AppState
    const { tasks } = sessionChildren(withThread, { now: 3, sep: "·" })
    const parentRow = tasks.find((task) => task.taskId === ("bg_fable" as never))
    expect(parentRow?.state).toBe("running")
    const childRow = tasks.find((task) => task.taskId === ("itm_child" as never))
    expect(childRow?.state).toBe(running ? "running" : "completed")
  }
})
