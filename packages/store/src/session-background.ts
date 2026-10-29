import type { Database } from "bun:sqlite"
import { SessionBackground, type ClientId, type SessionId, type SessionBackgroundPatch, type TaskRecord, type QueueId } from "@mendcode/protocol"

export type OwnerWake = { task: TaskRecord; queueId: QueueId }

export function createSessionBackgroundRecords(db: Database, now: () => number) {
  db.run(`CREATE TABLE IF NOT EXISTS background_sessions (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS child_owner_wakes (
    id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS child_owner_wakes_pending ON child_owner_wakes(delivered, parent_id, id)")
  const get = (id: string): SessionBackground | undefined => {
    const row = db.query<{ payload: string }, [string]>("SELECT payload FROM background_sessions WHERE id = ?").get(id)
    return row ? SessionBackground.parse(JSON.parse(row.payload)) : undefined
  }
  const put = (entry: SessionBackground) => {
    db.query("INSERT OR REPLACE INTO background_sessions VALUES (?, ?)").run(entry.sessionId, JSON.stringify(SessionBackground.parse(entry)))
    return entry
  }
  return {
    get,
    list(): SessionBackground[] {
      return db.query<{ payload: string }, []>("SELECT payload FROM background_sessions ORDER BY json_extract(payload, '$.updatedAt') DESC, id DESC").all().map((row) => SessionBackground.parse(JSON.parse(row.payload)))
    },
    register(sessionId: SessionId, patch: SessionBackgroundPatch = {}) {
      const current = get(sessionId)
      const entry = { ...current, ...patch, sessionId, state: patch.state ?? current?.state ?? "queued", pinned: patch.pinned ?? current?.pinned ?? false, createdAt: current?.createdAt ?? now(), updatedAt: now() }
      if (["completed", "failed", "stopped"].includes(entry.state)) delete entry.writer
      return put(entry)
    },
    remove(sessionId: SessionId) {
      db.query("DELETE FROM detached_sessions WHERE id = ?").run(sessionId)
      return db.query("DELETE FROM background_sessions WHERE id = ?").run(sessionId).changes > 0
    },
    acquire(sessionId: SessionId, clientId: ClientId, ttlMs = 30_000) {
      const entry = get(sessionId)
      if (!entry) return { acquired: false as const }
      // v1 uses last-writer presence, not an exclusive permission or execution lock.
      return { acquired: true as const, info: put({ ...entry, writer: { clientId, acquiredAt: now(), expiresAt: now() + ttlMs }, updatedAt: now() }) }
    },
    release(sessionId: SessionId, clientId: NonNullable<SessionBackground["writer"]>["clientId"]) {
      const entry = get(sessionId)
      if (!entry || entry.writer?.clientId !== clientId) return undefined
      const { writer, ...next } = entry
      return put({ ...next, updatedAt: now() })
    },
    wakes: {
      finish(task: TaskRecord, queueId: QueueId) {
        db.transaction(() => {
          db.query("INSERT OR REPLACE INTO child_tasks VALUES (?, ?)").run(task.taskId, JSON.stringify(task))
          db.query("INSERT OR IGNORE INTO child_owner_wakes VALUES (?, ?, ?, ?, 0)").run(`${task.taskId}:${task.generation}`, task.parentId, queueId, JSON.stringify({ task, queueId }))
        })()
      },
      parents(): SessionId[] {
        return db.query<{ parent_id: SessionId }, []>("SELECT DISTINCT parent_id FROM child_owner_wakes WHERE delivered = 0 ORDER BY parent_id").all().map((row) => row.parent_id)
      },
      pending(limit = 16, parentId?: SessionId): OwnerWake[] {
        return db.query<{ payload: string }, [string | null, number]>("SELECT payload FROM child_owner_wakes WHERE delivered = 0 AND (?1 IS NULL OR parent_id = ?1) ORDER BY id LIMIT ?2").all(parentId ?? null, limit).map((row) => JSON.parse(row.payload))
      },
      batch(entries: OwnerWake[]) {
        const queueId = entries[0]!.queueId
        return db.transaction(() => entries.map((entry) => {
          const wake = { ...entry, queueId }
          db.query("UPDATE child_owner_wakes SET queue_id = ?, payload = ? WHERE id = ? AND delivered = 0").run(queueId, JSON.stringify(wake), `${wake.task.taskId}:${wake.task.generation}`)
          return wake
        }))()
      },
      dismiss(parentId: SessionId) { db.query("UPDATE child_owner_wakes SET delivered = 1 WHERE parent_id = ? AND delivered = 0").run(parentId) },
      delivered(wake: OwnerWake) { db.query("UPDATE child_owner_wakes SET delivered = 1 WHERE id = ?").run(`${wake.task.taskId}:${wake.task.generation}`) },
      queued(wake: OwnerWake) {
        return db.query("SELECT 1 FROM events WHERE session_id = ? AND type = 'queue.added' AND json_extract(payload, '$.queueId') = ? LIMIT 1").get(wake.task.parentId, wake.queueId) !== null
      },
    },
  }
}
