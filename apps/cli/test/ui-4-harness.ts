import type { AsideThread, SidebarWidget } from "@mendcode/protocol"
import { readSidebar, sidebarScope, updateSidebar } from "../../../packages/daemon/src/sidebar"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export function ui4Harness(width = 180, height = 50, widgets: SidebarWidget[] = [], panelNarrow: "hide" | "sheet" = "sheet") {
  const dataDir = tempDir()
  const directory = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow, sidebarWidgets: widgets, rightSidebar: widgets.length > 0 })
  const threads = new Map<string, AsideThread>()
  const sessionId = ids("session")
  const other = ids("session")
  let creations = 0
  const h = appHarness({ width, height, dataDir, directory, sessionId, reply: (command) => {
    if (command.type === "sidebar.get") return { ok: true, result: { widgets: readSidebar(dataDir, directory), scope: sidebarScope(dataDir, directory) } }
    if (command.type === "sidebar.update") return { ok: true, result: { widgets: updateSidebar(dataDir, directory, command.change) } }
    if (command.type === "session.create") return { ok: true, result: { sessionId: creations++ ? sessionId : other } }
    if (command.type === "session.list") return { ok: true, result: { sessions: [sessionId, other].map((sessionId) => ({ sessionId, directory, title: "UI-4 session", createdAt: NOW - 60_000, updatedAt: NOW, state: "idle", queued: 0, lastSeq: 0 })) } }
    if (command.type === "session.aside.get") return { ok: true, result: { thread: structuredClone(threads.get(command.sessionId) ?? { messages: [], busy: false }) } }
    if (command.type === "session.aside.clear") { threads.set(command.sessionId, { messages: [], busy: false }); return { ok: true } }
    if (command.type === "session.aside") {
      const thread = threads.get(command.sessionId) ?? { messages: [], busy: false }
      thread.messages.push({ role: "user", text: command.text }, { role: "assistant", text: `Side answer ${thread.messages.length / 2 + 1}` })
      threads.set(command.sessionId, thread)
      return { ok: true, result: { text: thread.messages.at(-1)!.text } }
    }
    if (command.type === "mcp.status") return { ok: true, result: { servers: [{ name: "local-mcp", state: "running", enabled: true, tools: 7 }], issues: [] } }
    if (command.type === "git.status") return { ok: true, result: { branch: "ui-four", ahead: 2, behind: 1, dirty: 3 } }
    if (command.type === "background.list") return { ok: true, result: { tasks: [{ sessionId, command: "bun test", status: "running", startedAt: NOW }] } }
    if (command.type === "loop.list") return { ok: true, result: { loops: [{ name: "Watch checks", state: "running", directory }] } }
    if (command.type === "workflow.list") return { ok: true, result: { workflows: [{ name: "Build UI", state: "running", directory }] } }
    if (command.type === "models.list") return { ok: true, result: { effective: { model: "local-fake-model" }, roles: {}, models: [], selectable: false } }
    if (command.type === "changes.query") return { ok: true, result: { root: directory, files: [{ path: "changed.ts", status: "modified", additions: 5, deletions: 2, diff: "", binary: false, truncated: false }], omittedFiles: 0 } }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(sessionId, (event) => h.app.onEvent(event))
  chat.exchange("Main user message", "Main answer")
  return { ...h, chat, threads, dataDir, directory, other }
}

