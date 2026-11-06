import type { Database } from "bun:sqlite"
import { compactEnvelope, eventPayload, hasEnvelope, type EventRow } from "./compress"

const CURSOR_KEY = "event-envelope-cursor-v1"
const MAX_BATCH = 1000

/**
 * Idle conversion of rows written with their envelope (session, sequence, time, type) inside the JSON payload to the
 * compact form whose envelope is read from the row's columns. A row changes only when its rebuilt payload is
 * byte-identical to the original; anything else stays as written. Bounded, resumable, never run on open.
 */
export function createEventEnvelopes(db: Database) {
  const page = db.query<EventRow, [string, number, number]>("SELECT session_id, seq, type, at, payload FROM events WHERE (session_id, seq) > (?1, ?2) ORDER BY session_id, seq LIMIT ?3")
  const update = db.query("UPDATE events SET payload = ? WHERE session_id = ? AND seq = ?")
  const cursor = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
  const saveCursor = db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")

  return {
    migrate(limit = 500): { visited: number; compacted: number; complete: boolean } {
      const saved = cursor.get(CURSOR_KEY)
      const [session, seq] = saved ? JSON.parse(saved.value) as [string, number] : ["", 0]
      const rows = page.all(session, seq, Math.max(1, Math.min(limit, MAX_BATCH)))
      let compacted = 0
      db.transaction(() => {
        for (const row of rows) {
          if (typeof row.payload !== "string" || !hasEnvelope(row.payload)) continue
          const compact = compactEnvelope(row.payload, { sessionId: row.session_id, seq: row.seq, at: row.at, type: row.type })
          if (compact === row.payload || eventPayload({ ...row, payload: compact }) !== row.payload) continue
          update.run(compact, row.session_id, row.seq)
          compacted++
        }
        const last = rows.at(-1)
        if (last) saveCursor.run(CURSOR_KEY, JSON.stringify([last.session_id, last.seq]))
      })()
      return { visited: rows.length, compacted, complete: rows.length === 0 }
    },
  }
}
export type EventEnvelopes = ReturnType<typeof createEventEnvelopes>
