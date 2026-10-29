import type { Database } from "bun:sqlite"
import { AgentCommandRecord, AgentViewMetadata, type AgentViewMetadataPatch, type AgentCommandsReport } from "@mendcode/protocol"

export function createAgentCommandRecords(db: Database, now = Date.now) {
  db.run(`CREATE TABLE IF NOT EXISTS agent_commands (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS agent_view_metadata (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS agent_commands_source ON agent_commands(source_id)")
  db.run("CREATE INDEX IF NOT EXISTS agent_commands_target ON agent_commands(target_id)")
  return {
    list(sessionId: string, now: number): AgentCommandRecord[] {
      return db.query<{ payload: string }, [string, string, number]>("SELECT payload FROM agent_commands WHERE source_id = ? OR target_id = ? ORDER BY (json_extract(payload, '$.state') IN ('accepted', 'running') OR (json_extract(payload, '$.state') = 'pending' AND json_extract(payload, '$.expiresAt') > ?)) DESC, json_extract(payload, '$.updatedAt') DESC LIMIT 100").all(sessionId, sessionId, now).map((row) => AgentCommandRecord.parse(JSON.parse(row.payload)))
    },
    active(sessionId: string, now: number, direction: "source" | "target"): AgentCommandRecord[] {
      const column = direction === "source" ? "source_id" : "target_id"
      return db.query<{ payload: string }, [string, number]>(`SELECT payload FROM agent_commands WHERE ${column} = ? AND (json_extract(payload, '$.state') IN ('accepted', 'running') OR (json_extract(payload, '$.state') = 'pending' AND json_extract(payload, '$.expiresAt') > ?))`).all(sessionId, now).map((row) => AgentCommandRecord.parse(JSON.parse(row.payload)))
    },
    unfinished(): AgentCommandRecord[] {
      return db.query<{ payload: string }, []>("SELECT payload FROM agent_commands WHERE json_extract(payload, '$.state') IN ('accepted', 'running')").all().map((row) => AgentCommandRecord.parse(JSON.parse(row.payload)))
    },
    get(id: string): AgentCommandRecord | undefined {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM agent_commands WHERE id = ?").get(id)
      return row ? AgentCommandRecord.parse(JSON.parse(row.payload)) : undefined
    },
    put(record: AgentCommandRecord) {
      db.query("INSERT OR REPLACE INTO agent_commands VALUES (?, ?, ?, ?)").run(record.commandId, record.sourceSessionId, record.targetSessionId, JSON.stringify(AgentCommandRecord.parse(record)))
    },
    metadata(directory?: string): AgentCommandsReport["metadata"] {
      return db.query<{ payload: string }, [string | null]>("SELECT payload FROM agent_view_metadata JOIN sessions ON sessions.id = agent_view_metadata.id WHERE (?1 IS NULL OR sessions.directory = ?1) ORDER BY json_extract(payload, '$.updatedAt') DESC LIMIT 100").all(directory ?? null).map((row) => AgentViewMetadata.parse(JSON.parse(row.payload)))
    },
    getMetadata(sessionId: string): AgentViewMetadata | undefined {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM agent_view_metadata WHERE id = ?").get(sessionId)
      return row ? AgentViewMetadata.parse(JSON.parse(row.payload)) : undefined
    },
    all(directory?: string, target?: string, at = now()): AgentCommandRecord[] {
      const entries = db.query<{ payload: string }, [string | null, string | null]>("SELECT agent_commands.payload FROM agent_commands JOIN sessions ON sessions.id = target_id WHERE (?1 IS NULL OR sessions.directory = ?1) AND (?2 IS NULL OR target_id = ?2) ORDER BY json_extract(agent_commands.payload, '$.updatedAt') DESC LIMIT 100").all(directory ?? null, target ?? null).map((row) => AgentCommandRecord.parse(JSON.parse(row.payload)))
      return entries.map((entry) => entry.state === "pending" && entry.expiresAt <= at ? { ...entry, state: "expired" as const, error: "Command expired before the target accepted it." } : entry)
    },
    patchMetadata(sessionId: string, patch: AgentViewMetadataPatch) {
      const current = this.getMetadata(sessionId)
      const next: Record<string, unknown> = { ...current, sessionId, tags: current?.tags ?? [], pinned: current?.pinned ?? false, archived: current?.archived ?? false, createdAt: current?.createdAt ?? now(), updatedAt: now() }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (key === "tags") next.tags = [...new Set((value as string[] | null ?? []).map((tag) => tag.trim()).filter(Boolean))]
        else if (key === "pinned" || key === "archived") next[key] = value ?? false
        else if (value === null || typeof value === "string" && !value.trim()) delete next[key]
        else next[key] = typeof value === "string" ? value.trim() : value
      }
      const metadata = AgentViewMetadata.parse(next)
      if (!metadata.title && !metadata.color && !metadata.group && !metadata.priority && !metadata.notes && !metadata.pinned && !metadata.archived && !metadata.tags.length) db.query("DELETE FROM agent_view_metadata WHERE id = ?").run(sessionId)
      else db.query("INSERT OR REPLACE INTO agent_view_metadata VALUES (?, ?)").run(sessionId, JSON.stringify(metadata))
      return metadata
    },
  }
}
