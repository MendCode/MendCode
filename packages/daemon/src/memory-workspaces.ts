import path from "node:path"
import type { MemoryBrowseReport, MemoryWorkspacesReport } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { memoryGraph } from "./memory-graph"

/** v2 workspaces come from its indexed sessions and memories; no filesystem crawl or v1 data reads. */
export function createMemoryWorkspaces(input: { store: Store; profile(directory?: string): string }) {
  function list(directory?: string): MemoryWorkspacesReport {
    const current = directory ? path.resolve(directory) : undefined
    const profile = input.profile(current)
    const workspaces = input.store.memorySharing.workspaces().filter((item) => input.profile(item.root) === profile).map((item) => ({ ...item, label: path.basename(item.root) || item.root, group: path.dirname(item.root), profile, source: item.root === current ? "current-session" as const : item.sessions ? "historical-session" as const : "imported-root" as const }))
    if (current && !workspaces.some((item) => item.root === current)) workspaces.unshift({ root: current, label: path.basename(current) || current, group: path.dirname(current), profile, source: "current-session", pending: 0, saved: 0, archived: 0, user: 0, agent: 0, sessions: 0, firstActiveAt: 0, lastActiveAt: 0 })
    return { workspaces: workspaces.slice(0, 200), omitted: Math.max(0, workspaces.length - 200) }
  }
  function browse(directory: string | undefined, view: "project" | "user" | "all", root?: string): MemoryBrowseReport {
    const active = root ?? directory
    const profile = input.profile(directory)
    if (view === "project" && !active) throw new Error("Select a project first")
    if (active && input.profile(active) !== profile) throw new Error("Project belongs to another profile")
    const entries = input.store.memories.list({ ...(view === "project" && active ? { directory: active } : {}), profile, session: "all" }).filter((entry) => view === "user" ? entry.scope === "user" : entry.scope === "user" || (entry.directory && input.profile(entry.directory) === profile))
    const memories = entries.slice(0, 200)
    const saved = memories.filter((entry) => entry.status === "saved" && entry.scope !== "session")
    return { memories, graph: memoryGraph(saved, input.store.memories.links(saved.map((entry) => entry.memoryId))), omitted: Math.max(0, entries.length - memories.length) }
  }
  return { list, browse }
}
