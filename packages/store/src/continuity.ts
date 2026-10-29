import type { Database } from "bun:sqlite"
import { ContinuityRecord, type SessionId } from "@mendcode/protocol"

export function createContinuityRecords(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS continuity_records (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS continuity_generations (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, generation INTEGER NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS continuity_mailbox (
    id TEXT PRIMARY KEY REFERENCES continuity_records(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, state TEXT NOT NULL
  ) WITHOUT ROWID`)
  const get = (sessionId: SessionId, id: string): ContinuityRecord | undefined => {
    const row = db.query<{ payload: string }, [string, string]>("SELECT payload FROM continuity_records WHERE session_id = ? AND id = ?").get(sessionId, id)
    return row ? ContinuityRecord.parse(JSON.parse(row.payload)) : undefined
  }
  const list = (sessionId?: SessionId): ContinuityRecord[] => db.query<{ payload: string }, [string | null]>("SELECT payload FROM continuity_records WHERE (?1 IS NULL OR session_id = ?1)").all(sessionId ?? null).map((row) => ContinuityRecord.parse(JSON.parse(row.payload)))
  const put = (record: ContinuityRecord) => {
    const saved = db.query("INSERT INTO continuity_records VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE session_id = excluded.session_id").run(record.id, record.sessionId, JSON.stringify(ContinuityRecord.parse(record)))
    if (!saved.changes) throw new Error("Continuity id belongs to another session")
    return record
  }
  const generation = (sessionId: SessionId) => db.query<{ generation: number }, [string]>("SELECT generation FROM continuity_generations WHERE session_id = ?").get(sessionId)?.generation ?? 0
  return {
    get, list, put, generation,
    advance(sessionId: SessionId) {
      const next = generation(sessionId) + 1
      db.query("INSERT OR REPLACE INTO continuity_generations VALUES (?, ?)").run(sessionId, next)
      db.query("UPDATE continuity_mailbox SET state = 'cancelled' WHERE session_id = ? AND state = 'pending'").run(sessionId)
      return next
    },
    complete(record: ContinuityRecord) {
      db.transaction(() => {
        put(record)
        db.query("INSERT OR IGNORE INTO continuity_mailbox VALUES (?, ?, ?)").run(record.id, record.sessionId, record.generation === generation(record.sessionId) && !record.continuationCancelled ? "pending" : "cancelled")
      })()
      return record
    },
    pending(): ContinuityRecord[] {
      return db.query<{ payload: string }, []>("SELECT r.payload FROM continuity_mailbox m JOIN continuity_records r ON r.id = m.id WHERE m.state = 'pending' ORDER BY json_extract(r.payload, '$.createdAt')").all().map((row) => ContinuityRecord.parse(JSON.parse(row.payload)))
    },
    acknowledge(id: string) { db.query("UPDATE continuity_mailbox SET state = 'delivered' WHERE id = ? AND state = 'pending'").run(id) },
    cancelMail(id: string) { db.query("UPDATE continuity_mailbox SET state = 'cancelled' WHERE id = ?").run(id) },
    prune(sessionId: SessionId) {
      const terminal = list(sessionId).filter((record) => !["queued", "running", "pending"].includes(record.status)).sort((a, b) => b.createdAt - a.createdAt)
      const pending = new Set(this.pending().map((record) => record.id))
      for (const record of terminal.slice(256)) if (!pending.has(record.id)) db.query("DELETE FROM continuity_records WHERE id = ?").run(record.id)
    },
  }
}
