import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { readSidebar, sidebarScope, updateSidebar } from "../../../packages/daemon/src/sidebar"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_PRESETS, type PanelPreset } from "../src/view/sidebar-spec"

export type ReviewOptions = {
  width?: number
  height?: number
  tier?: "minimalist" | "balanced" | "full"
  /** `home`: a new session with no messages. `active`: several turns, tool calls over files, a sub-agent, a queued message. */
  session?: "home" | "active"
  preset?: PanelPreset
  /** Stored spec, overriding `preset` (for custom/empty-spec cases). */
  widgets?: ReturnType<typeof structuredClone<unknown>>
  rightSidebar?: boolean
  quotaAgeMs?: number
  /** Reply of `sidebar.update` when the daemon is stale. */
  staleSchema?: boolean
  /** Answers `codegraph.overview` (the galaxy's code mode); unset, the daemon answers nothing useful. */
  codeOverview?: () => unknown
  /** Opens the same session again (a restart): its data dir, project and id, with the stored profile left as it is. */
  reopen?: { dataDir: string; directory: string; sessionId: string }
}

/** One fixture for the panel review: the real daemon sidebar store behind a scripted session. */
export function reviewFixture(options: ReviewOptions = {}) {
  const { width = 180, height = 50, tier = "full", session = "active" } = options
  const dataDir = options.reopen?.dataDir ?? tempDir(), directory = options.reopen?.directory ?? tempDir(), sessionId = (options.reopen?.sessionId ?? ids("session")) as ReturnType<typeof ids>, childId = ids("session"), forkId = ids("session")
  const widgets = options.widgets ?? (options.preset ? structuredClone(SIDEBAR_PRESETS[options.preset]) : [])
  if (!options.reopen) writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", sidebarWidgets: widgets as never, rightSidebar: options.rightSidebar ?? (widgets as unknown[]).length > 0 })
  const active = session === "active"
  const nodes = [
    { sessionId, title: "Panel session", createdAt: NOW - 60_000, updatedAt: NOW, current: true, labels: [] },
    ...(active ? [
      { sessionId: childId, parentId: sessionId, title: "Inspect renderer", kind: "task", state: "completed", agent: "explore", model: "local-test", headline: "Found 3 callers of render", createdAt: NOW - 30_000, updatedAt: NOW, current: false, labels: [] },
      { sessionId: forkId, parentId: sessionId, title: "Try alternative layout", kind: "fork", state: "running", model: "local-test", createdAt: NOW - 20_000, updatedAt: NOW, current: false, labels: [] },
    ] : []),
  ]
  const changed = active ? [
    { path: "src/panel.ts", touchedAt: NOW, status: "modified", additions: 14, deletions: 3, diff: "@@ -1 +1 @@\n-before\n+after\n", binary: false, truncated: false },
    { path: "src/orbit.ts", touchedAt: NOW - 1000, status: "added", additions: 40, deletions: 0, diff: "@@ -0,0 +1 @@\n+x\n", binary: false, truncated: false },
  ] : []
  const sidebarReply = (command: { type: string; change?: unknown }) => {
    if (options.staleSchema) return { ok: false, error: { code: "invalid", message: "Invalid command: unknown sidebar action" } } as never
    return { ok: true, result: { widgets: updateSidebar(dataDir, directory, (command as { change: never }).change) } } as never
  }
  const h = appHarness({ width, height, directory, dataDir, sessionId, mode: tier === "full" ? "full" : tier === "balanced" ? "balanced" : "minimal", now: () => NOW, reply: (command) => {
    switch (command.type) {
      case "sidebar.get": return { ok: true, result: { widgets: readSidebar(dataDir, directory), scope: sidebarScope(dataDir, directory) } }
      case "sidebar.update": return sidebarReply(command as never)
      case "session.tree": return { ok: true, result: { nodes } }
      case "session.changes": return { ok: true, result: { root: directory, files: changed, omittedFiles: 0, complete: true, scope: "session" } }
      case "session.savings": return { ok: true, result: { savings: active ? [{ source: "graft", calls: 5, tokens: 3400 }, { source: "git", calls: 2, tokens: 1800 }] : [] } }
      case "context.query": return { ok: true, result: { rent: [{ tool: "graph_callers", tokens: 310, uses: 5 }, { tool: "read", tokens: 180, uses: 4 }] } }
      case "git.status": return { ok: true, result: { branch: "night/panel", ahead: 1, behind: 0, dirty: active ? 2 : 0 } }
      case "models.list": return { ok: true, result: { effective: { model: "local-test", effort: "high" }, roles: {}, models: [{ id: "local-test", provider: "faux", contextWindow: 200_000 }], selectable: false } }
      case "session.list": return { ok: true, result: { sessions: nodes.map((node) => ({ ...node, directory, state: "idle", queued: 0, lastSeq: 0 })) } }
      case "background.list": return { ok: true, result: { tasks: active ? [{ id: "job1", sessionId, command: "bun test --watch", status: "running", startedAt: NOW - 5000, output: "" }] : [] } }
      case "loop.list": return { ok: true, result: { loops: active ? [{ name: "nightly-review", state: "waiting", directory }] : [] } }
      case "workflow.list": return { ok: true, result: { workflows: [] } }
      case "mcp.status": return { ok: true, result: { servers: [{ name: "local-graph", state: "connected", enabled: true, tools: 2, command: "local fake", stderr: [] }], issues: [] } }
      case "agent.debug": return { ok: true, result: { tools: { read: true, edit: true, shell: true, graph_callers: true } } }
      case "tools.list": return { ok: true, result: { tools: [], issues: [], directory } }
      case "codegraph.overview": return (options.codeOverview?.() ?? { ok: true }) as never
      default: return { ok: true }
    }
  } })
  h.app.applySettings({ onboarded: true, tier, ...(tier === "balanced" ? { view: "balanced" } : tier === "minimalist" ? { view: "minimal" } : {}), compactAtTokens: 160_000, reducedMotion: true })
  h.app.onGlobal({ type: "quota.snapshot", gseq: 1, at: NOW, provider: "codex", windows: [{ id: "5h", label: "5h", usedPercent: 35, resetsAt: NOW + 7_200_000 }, { id: "weekly", label: "weekly", usedPercent: 62, resetsAt: NOW + 86_400_000 }], fetchedAt: NOW - (options.quotaAgeMs ?? 0), source: "local test fixture" })
  const chat = conversation(sessionId, (event) => h.app.onEvent(event))
  if (active) {
    const tools: Array<[string, string, string]> = [["read", "read: src/panel.ts", "src/panel.ts"], ["edit", "edit: src/panel.ts", "src/panel.ts"], ["write", "write: src/orbit.ts", "src/orbit.ts"]]
    tools.forEach(([, title, file], index) => {
      chat.exchange(`Inspect turn ${index + 1}`, "LATEST ANSWER · session data")
      const turnId = ids("turn"), itemId = ids("item"), taskId = ids("item"), todoId = ids("item")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
      chat.emit({ type: "item.completed", itemId, status: "ok", meta: { path: `${directory}/${file}`, savedTokens: 100, filter: "graft", durationMs: 120 + index * 40 } })
      if (index === 1) {
        chat.emit({ type: "item.started", turnId, itemId: taskId, kind: "tool_call", meta: { tool: "task: inspect renderer" } })
        chat.emit({ type: "item.completed", itemId: taskId, status: "ok", meta: { durationMs: 4200 } })
        chat.emit({ type: "item.started", turnId, itemId: todoId, kind: "tool_call", meta: { tool: "todo" } })
        chat.emit({ type: "item.completed", itemId: todoId, status: "ok", text: "[x] Read the panel code\n[~] Fix the next cycle\n[ ] Add regression tests", meta: { durationMs: 5 } })
      }
      chat.emit({ type: "usage.recorded", turnId, provider: "faux", model: index === 1 ? "local-fast" : "local-test", input: 10_000 + index * 6_000, output: 900 + index * 200, reasoning: 200, cacheRead: 12_000, cacheWrite: 0, costMicros: 20_000, profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 500, durationMs: 10_000 + index * 1000, toolCount: 1, imageCount: 0 } })
      chat.emit({ type: "turn.completed", turnId })
    })
    chat.exchange("Layout request", "LATEST ANSWER · session data")
    chat.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "Verify next", delivery: "queue" }, { queueId: ids("queue"), preview: "Keep the terminal responsive", delivery: "steer" }] })
  }
  return { ...h, dataDir, directory, sessionId, chat, childId, forkId }
}
