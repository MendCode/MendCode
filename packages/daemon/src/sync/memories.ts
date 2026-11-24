import type { SyncMemoryRow } from "@mendcode/protocol"
import type { MemoryRecord } from "@mendcode/store/sync-state"
import type { ProjectIndex } from "./projects"
import type { SyncState } from "@mendcode/store"

/**
 * Memories sync per row, last writer wins by `updated_at`; a delete travels as a tombstone with its time. User and project
 * memories only: session memories stay with their session's machine. A project memory names its project, so it lands in this
 * machine's clone.
 */
export async function memoryToWire(state: SyncState, change: { id: string; deleted: boolean; at: number }, projects: ProjectIndex): Promise<SyncMemoryRow | undefined> {
  const row = change.deleted ? undefined : state.memories.get(change.id)
  if (!row) return { id: change.id, deleted: true, updatedAt: change.at }
  if (row.scope !== "user" && row.scope !== "project") return undefined
  const project = row.scope === "project" && row.directory ? await projects.ref(row.directory) : undefined
  return {
    id: row.id, updatedAt: row.updated_at, scope: row.scope, ...(row.directory ? { directory: projects.toRemote(row.directory) } : {}), ...(project ? { project } : {}),
    text: row.text, category: row.category, status: row.status, source: row.source, createdAt: row.created_at, kind: row.kind,
    ...(row.target_id ? { targetId: row.target_id } : {}), reason: row.reason, profile: row.profile, pinned: row.pinned === 1, ...(row.model_data ? { details: row.model_data } : {}),
  }
}

/**
 * Applies one row from the other machine; true when it changed something here. `winTies`: equal times with different content
 * take the incoming row (the hub's copy wins on a device, so both converge).
 */
export async function applyMemory(state: SyncState, row: SyncMemoryRow, projects: ProjectIndex, winTies: boolean): Promise<boolean> {
  const local = state.memories.get(row.id)
  if (row.deleted) {
    if (!local || local.updated_at > row.updatedAt) return false
    state.memories.delete(row.id)
    return true
  }
  if (row.text === undefined || !row.scope) return false
  const directory = row.scope === "project" && row.directory ? (await projects.resolve({ directory: row.directory, ...(row.project ? { project: row.project } : {}) })).directory : null
  const next: MemoryRecord = {
    id: row.id, scope: row.scope, directory, text: row.text, category: row.category ?? "", status: row.status === "pending" || row.status === "archived" ? row.status : "saved",
    source: row.source === "agent" ? "agent" : "user", created_at: row.createdAt ?? row.updatedAt, updated_at: row.updatedAt, kind: row.kind === "update" || row.kind === "archive" ? row.kind : "new",
    target_id: row.targetId ?? null, reason: row.reason ?? "", profile: row.profile ?? "", session_id: null, pinned: row.pinned ? 1 : 0, model_data: row.details ?? null,
  }
  if (local) {
    if (local.updated_at > row.updatedAt) return false
    const same = local.text === next.text && local.category === next.category && local.status === next.status && local.pinned === next.pinned && local.directory === next.directory && local.model_data === next.model_data
    if (same || local.updated_at === row.updatedAt && !winTies) return false
  }
  state.memories.put(next)
  return true
}
