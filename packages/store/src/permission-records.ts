import type { Database } from "bun:sqlite"
import { parseEvent, type ObjectLoader } from "./compress"
import { PermissionGrant, PermissionReview, type PermissionGrantHistory, type SessionEvent, type SessionId } from "@mendcode/protocol"

/** Audit only: reopening the database never reactivates an approval. */
export function createPermissionRecords(db: Database, now: () => number = Date.now, load?: ObjectLoader) {
  db.run(`CREATE TABLE IF NOT EXISTS permission_grants (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    payload TEXT NOT NULL, revoked_at INTEGER
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS permission_grants_session ON permission_grants(session_id)`)
  db.run(`CREATE TABLE IF NOT EXISTS permission_reviews (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS permission_reviews_session ON permission_reviews(session_id)`)
  db.transaction(() => {
    const pending = db.query<{ payload: string }, []>("SELECT payload FROM permission_reviews WHERE json_extract(payload, '$.status') IN ('reviewing', 'waiting_manual')").all()
    for (const row of pending) {
      const record = PermissionReview.parse(JSON.parse(row.payload))
      db.query("UPDATE permission_reviews SET payload = ? WHERE id = ?").run(JSON.stringify({ ...record, status: "cancelled", reason: "Daemon restarted before approval settled", updatedAt: now() }), record.reviewId)
    }
  })()
  const prune = (table: "permission_grants" | "permission_reviews", sessionId: SessionId, count: number) => {
    db.query(`DELETE FROM ${table} WHERE session_id = ? AND id NOT IN (SELECT id FROM ${table} WHERE session_id = ? ORDER BY rowid DESC LIMIT ?)`).run(sessionId, sessionId, count)
  }
  return {
    authorityAnchors(sessionId: SessionId): Array<{ sourceId: string; text: string; complete: boolean }> {
      const turns = db.query<{ item_id: string; seq: number }, [string]>("SELECT item_id, seq FROM turns_read WHERE session_id = ? AND item_id IS NOT NULL AND notice = 0 AND reverted = 0 ORDER BY seq DESC LIMIT 12").all(sessionId)
      return turns.reverse().map((turn) => {
        const events = db.query<{ payload: string }, [string, number]>("SELECT payload FROM events_read WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 8").all(sessionId, turn.seq).map((row) => parseEvent(row.payload, load))
        const message = events.find((event) => event.type === "item.completed" && event.itemId === turn.item_id)
        return { sourceId: turn.item_id, text: message?.type === "item.completed" ? message.authorityText ?? message.text ?? "" : "", complete: message?.type === "item.completed" && (message.authorityText !== undefined || !message.blob) }
      })
    },
    grant(sessionId: SessionId, grant: PermissionGrant) {
      if (!grant.recordId) return
      db.transaction(() => {
        db.query("INSERT INTO permission_grants VALUES (?, ?, ?, NULL)").run(grant.recordId!, sessionId, JSON.stringify(PermissionGrant.parse(grant)))
        prune("permission_grants", sessionId, 100)
      })()
    },
    revoke(sessionId: SessionId, recordId: string, at: number) {
      db.query("UPDATE permission_grants SET revoked_at = ? WHERE session_id = ? AND id = ? AND revoked_at IS NULL").run(at, sessionId, recordId)
    },
    grants(sessionId: SessionId, limit = 100): PermissionGrantHistory[] {
      return db.query<{ payload: string; revoked_at: number | null }, [string, number]>("SELECT payload, revoked_at FROM permission_grants WHERE session_id = ? ORDER BY rowid DESC LIMIT ?").all(sessionId, limit).map((row) => ({ grant: PermissionGrant.parse(JSON.parse(row.payload)), active: false, ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }) }))
    },
    review(record: PermissionReview) {
      db.transaction(() => {
        db.query("INSERT INTO permission_reviews VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(record.reviewId, record.sessionId, JSON.stringify(PermissionReview.parse(record)))
        prune("permission_reviews", record.sessionId, 500)
      })()
    },
    reviews(sessionId: SessionId, limit = 100): PermissionReview[] {
      return db.query<{ payload: string }, [string, number]>("SELECT payload FROM permission_reviews WHERE session_id = ? ORDER BY rowid DESC LIMIT ?").all(sessionId, limit).map((row) => PermissionReview.parse(JSON.parse(row.payload)))
    },
  }
}
