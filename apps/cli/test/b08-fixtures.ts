import type { CommandReply } from "@mendcode/client"
import type { MemoryBrowseReport, MemoryEntry, MemoryWorkspacesReport, SharingResult, SharingScope, SharingStatusReport } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export const B08_CURRENT = "/work/mendcode"
export const B08_OTHER = "/work/api"
export function b08Harness(width = 100, height = 30) {
  const current = ids("memory")
  const other = ids("memory")
  const personal = ids("memory")
  let memories: MemoryEntry[] = [
    { memoryId: current, scope: "project", directory: B08_CURRENT, text: "Run bun test before release", category: "commands", status: "saved", source: "user", pinned: true, createdAt: NOW - 3_600_000, updatedAt: NOW - 1_000 },
    { memoryId: other, scope: "project", directory: B08_OTHER, text: "API responses keep additive fields", category: "architecture", status: "saved", source: "agent", createdAt: NOW - 7_200_000, updatedAt: NOW - 2_000 },
    { memoryId: personal, scope: "user", text: "Keep replies terse", category: "preferences", status: "saved", source: "user", createdAt: NOW - 9_000_000, updatedAt: NOW - 3_000 },
  ]
  const workspaces: MemoryWorkspacesReport = { omitted: 0, workspaces: [
    { root: B08_CURRENT, label: "mendcode", group: "/work", profile: "personal", source: "current-session", pending: 0, saved: 1, archived: 0, user: 1, agent: 0, sessions: 4, firstActiveAt: NOW - 3_600_000, lastActiveAt: NOW - 1_000 },
    { root: B08_OTHER, label: "api", group: "/work", profile: "personal", source: "historical-session", pending: 0, saved: 1, archived: 0, user: 0, agent: 1, sessions: 2, firstActiveAt: NOW - 7_200_000, lastActiveAt: NOW - 2_000 },
  ] }
  const enabled = { project: false, user: false }
  let error = ""
  let badEdit = false
  let statusError = false
  const status = (scope: SharingScope): SharingStatusReport => ({ scope, enabled: enabled[scope], directory: `/tmp/mendcode-data/memory-sharing/${scope}-snapshot`, format: "mendcode-v2", entries: enabled[scope] ? 1 : 0 })
  const result = (scope: SharingScope, action: "export" | "import"): SharingResult => ({ ...status(scope), action, exported: action === "export" ? [scope === "project" ? current : personal] : [], proposals: [], conflicts: badEdit ? [{ id: current, reason: "Internal revision changed" }] : [], skipped: [] })
  const graph = (entries: MemoryEntry[]): MemoryBrowseReport["graph"] => {
    const nodes = entries.filter((entry) => entry.status === "saved")
    return { nodes, links: [], health: { nodes: nodes.length, links: 0, connected: 0, isolated: nodes.length, conflicts: 0, state: nodes.length ? "disconnected" : "empty" } }
  }
  const h = appHarness({ width, height, dataDir: tempDir(), directory: B08_CURRENT, reply: (command) => {
    if (error && command.type === "memory.sharing.configure") return { ok: false, error: { code: "invalid_command", message: error } }
    if (command.type === "memory.sharing.status" && statusError) return { ok: false, error: { code: "invalid_command", message: "Sharing inventory is invalid" } }
    if (command.type === "memory.sharing.configure") enabled[command.scope] = command.enabled
    if (command.type === "memory.sharing.export" || command.type === "memory.sharing.import") {
      if (!enabled[command.scope]) return { ok: false, error: { code: "invalid_command", message: `Sharing is disabled for ${command.scope}` } }
      const outcome = result(command.scope, command.type === "memory.sharing.export" ? "export" : "import")
      if (command.type === "memory.sharing.import" && !badEdit) {
        const id = ids("memory")
        const target = memories.find((entry) => entry.memoryId === (command.scope === "project" ? current : personal))!
        memories = [...memories, { ...target, memoryId: id, status: "pending", pinned: false, kind: "update", targetId: target.memoryId, text: "Run focused tests and the default suite", reason: "Markdown sharing import · manual review", updatedAt: NOW }]
        outcome.proposals = [id]
      }
      return { ok: true, result: outcome }
    }
    const listed = memories.filter((entry) => entry.scope === "user" || entry.directory === B08_CURRENT)
    const browse = command.type === "memory.browse" ? memories.filter((entry) => command.view === "user" ? entry.scope === "user" : command.view === "all" || entry.scope === "user" || entry.directory === (command.root ?? command.directory)) : listed
    const report = command.type === "memory.workspaces" ? workspaces : command.type === "memory.browse" ? { memories: browse, graph: graph(browse), omitted: 0 }
      : command.type === "memory.list" ? { memories: listed } : command.type === "memory.graph" ? graph(listed)
        : command.type === "memory.sharing.status" || command.type === "memory.sharing.configure" ? status(command.scope)
          : command.type === "memory.categories" ? { categories: [{ id: "commands", label: "Commands", description: "Recurring checks", defaultPolicy: "review", policy: "review" }] }
            : command.type === "memory.extraction.list" ? { jobs: [], configured: false }
              : command.type === "evolution.list" ? { mode: "off", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } }
                : command.type === "dream.list" ? { runs: [] } : undefined
    return { ok: true, ...(report ? { result: report } : {}) } as CommandReply
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, workspaces, current, other, personal, enabled, error: (message: string) => { error = message }, conflicts: (value: boolean) => { badEdit = value }, statusError: (value: boolean) => { statusError = value } }
}
