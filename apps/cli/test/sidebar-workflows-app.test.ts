import { afterAll, expect, test } from "bun:test"
import type { CommandInput, CommandReply, SessionSummary, WorkflowSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { PULSE_OTHERS_MS } from "../src/ui/app/ticks"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000

/**
 * The all-projects list with the owner's shape of data: the open chat, a chat of another project that streams an answer, a
 * finished workflow run, a workflow run whose task works, and that task. `session.list` with a folder answers that folder only,
 * as the daemon does, so the terminal's own list never holds the other project's chat.
 */
function workflowApp() {
  const current = ids("session")
  const running = ids("session")
  const finished = ids("session")
  const task = ids("session")
  const make = (over: Partial<SessionSummary> & Pick<SessionSummary, "title" | "directory">): SessionSummary => ({ sessionId: ids("session"), createdAt: NOW, updatedAt: NOW - MINUTE, lastSeq: 40, state: "idle", queued: 0, ...over }) as SessionSummary
  const sessions: SessionSummary[] = [
    make({ sessionId: current, title: "Chrome", directory: "/work/app" }),
    make({ title: "Answering elsewhere", directory: "/other/api", state: "generating", since: NOW - MINUTE }),
    make({ sessionId: finished, title: "workflow · mend", directory: "/work/app", updatedAt: NOW - 2 * MINUTE, origin: "auto" }),
    make({ sessionId: running, title: "workflow · mend-council", directory: "/work/app", agents: 1, origin: "auto" }),
    make({ sessionId: task, title: "workflow · mend-council · review", directory: "/work/app", parentId: running, state: "generating", origin: "auto" }),
    make({ title: "workflow · renamed by me", directory: "/work/app", named: true, updatedAt: NOW - 3 * MINUTE }),
  ]
  const run = { workflowId: ids("workflow"), name: "mend-council", directory: "/work/app", objective: "Council review", planHash: "a".repeat(64), permission: "edits", state: "running", rootSessionId: running, tasks: [{ id: "review", title: "review", kind: "agent", mode: "read", needs: [], state: "running", attempt: 1, sessionId: task, startedAt: NOW - MINUTE }], rounds: 0, repairs: 0, startedAt: NOW - 2 * MINUTE, updatedAt: NOW } as unknown as WorkflowSummary
  const other = { ...run, workflowId: ids("workflow"), name: "mend", state: "completed", rootSessionId: finished, tasks: [] } as unknown as WorkflowSummary
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebarProjects: "all", sidebarProjectsFrom: "all" })
  const h = appHarness({
    width: 120, height: 40, mode: "balanced", sessionId: current, dataDir, directory: "/work/app",
    inspectProject: async () => ({ git: true }),
    reply: (command: CommandInput) => {
      if (command.type === "session.list") return reply({ sessions: "directory" in command && command.directory ? sessions.filter((session) => session.directory === command.directory) : sessions })
      if (command.type === "workflow.list") return reply({ workflows: [other, run] })
      if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
      if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
      return undefined
    },
  })
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, running }
}
type App = ReturnType<typeof workflowApp>
const sidebarText = (h: App) => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH)).join("\n")
async function until(h: App, needle: string) {
  for (let turn = 0; turn < 100; turn++) {
    h.app.render()
    if (sidebarText(h).includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${sidebarText(h)}`)
}

test("a workflow's sessions are never chats in the list: a finished run and a working one (with its task) are all off the sidebar", async () => {
  const h = workflowApp()
  await until(h, "Answering elsewhere")
  const side = sidebarText(h)
  expect(side).not.toContain("◇")
  expect(side).not.toContain("mend-council")
  expect(side).not.toContain("workflow · mend")
  expect(side).not.toContain("◇ mend ")
  expect(side).not.toContain("review")
  // A title the user gave is a session like any other.
  expect(side).toContain("workflow · renamed by me")
  h.app.stop?.()
})

test("another project's chat that streams moves its spinner while the open chat rests, though the terminal's own list holds only this folder", async () => {
  const h = workflowApp()
  await until(h, "Answering elsewhere")
  const row = () => sidebarText(h).split("\n").find((line) => line.includes("Answering elsewhere"))
  const before = row()
  await Bun.sleep(PULSE_OTHERS_MS + 150)
  h.app.render()
  expect(row()).not.toBe(before)
  h.app.stop?.()
})
