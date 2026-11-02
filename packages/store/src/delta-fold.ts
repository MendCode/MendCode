import type { Database } from "bun:sqlite"
import type { SessionEvent } from "@mendcode/protocol"
import { eventFromRow, type EventRow, type ObjectLoader } from "./compress"
import { isDeltaLengths, packDeltaLengths, unpackDeltaLengths } from "./delta-lengths"

/** Only finalized, self-contained items fold. The archive keeps exact historical cuts, not just concatenated text. */
export function createDeltaFold(db: Database, load?: ObjectLoader) {
  db.run(`CREATE TABLE IF NOT EXISTS folded_deltas (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, completed_seq INTEGER NOT NULL, first_seq INTEGER NOT NULL,
    data BLOB NOT NULL, PRIMARY KEY(session_id, item_id)
  ) WITHOUT ROWID`)
  const matching = "session_id = ?1 AND type IN ('item.started', 'item.delta', 'item.completed') AND json_extract(payload, '$.itemId') = ?2"
  // Bound peak memory of both folding and a historical cut. Huge items retain the existing representation.
  const size = db.query<{ bytes: number | null }, [string, string]>(`SELECT sum(length(payload)) AS bytes FROM events INDEXED BY events_message_item WHERE ${matching} AND type = 'item.delta'`)
  const rows = db.query<{ first_seq: number | null; payload: string }, [string, string]>(`SELECT min(seq) AS first_seq, json_group_array(json_array(seq,at,json(payload -> '$.text'),json_extract(payload,'$.input'),json_extract(payload,'$.z'),json_extract(payload,'$.zref'))) AS payload FROM
    (SELECT seq, at, payload FROM events INDEXED BY events_message_item WHERE ${matching} AND type = 'item.delta' ORDER BY seq)`)
  const put = db.query("INSERT INTO folded_deltas VALUES (?, ?, ?, ?, ?)")
  const exists = db.query("SELECT 1 FROM folded_deltas WHERE session_id = ? AND item_id = ?")
  const remove = db.query(`DELETE FROM events INDEXED BY events_message_item WHERE ${matching} AND type = 'item.delta'
    AND NOT EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.parent_id = events.session_id AND p.parent_seq = events.seq)`)
  const block = db.query<{ data: Uint8Array }, [string, string]>("SELECT data FROM folded_deltas WHERE session_id = ? AND item_id = ?")
  const crossing = db.query<{ item_id: string }, [string, number, number]>("SELECT item_id FROM folded_deltas WHERE session_id = ? AND first_seq < ? AND completed_seq >= ?")
  const migrationKey = "delta-fold-cursor-v1"
  type Delta = Extract<SessionEvent, { type: "item.delta" }>
  return {
    firstAt(sessionId: string, itemId: string): number | undefined {
      return db.query<{ at: number }, [string, string]>(`SELECT at FROM events INDEXED BY events_message_item WHERE ${matching} AND type = 'item.delta' ORDER BY seq LIMIT 1`).get(sessionId, itemId)?.at
    },
    /** Caller owns the completion transaction. No work is added to individual streaming writes. */
    fold(event: SessionEvent): number {
      // Missing/empty final text may mean that the transcript relies on partial output. Keep it untouched.
      if (event.type !== "item.completed" || !event.text || event.blob) return 0
      if (exists.get(event.sessionId, event.itemId)) return 0
      const bytes = size.get(event.sessionId, event.itemId)?.bytes ?? 0
      if (!bytes || bytes > 1024 * 1024) return 0
      const deltas = rows.get(event.sessionId, event.itemId)
      if (!deltas || deltas.first_seq === null) return 0
      const data = packDeltaLengths(deltas.payload, event.text) ?? Bun.zstdCompressSync(Buffer.from(deltas.payload), { level: 1 })
      put.run(event.sessionId, event.itemId, event.seq, deltas.first_seq, data)
      return remove.run(event.sessionId, event.itemId).changes
    },
    /** Decode one item's archive only. Stored z/zref forms remain intact for the normal event decoder. */
    cut(sessionId: string, itemId: string, beforeSeq: number): Delta[] {
      const row = block.get(sessionId, itemId)
      if (!row) return []
      if (isDeltaLengths(row.data)) {
        const completion = db.query<EventRow, [string, string]>(`SELECT session_id, seq, type, at, payload FROM events INDEXED BY events_message_item WHERE ${matching} AND type = 'item.completed' ORDER BY seq LIMIT 1`).get(sessionId, itemId)
        const event = completion ? eventFromRow(completion, load) : undefined
        if (event?.type !== "item.completed" || typeof event.text !== "string") throw new RangeError("delta completion unavailable")
        return unpackDeltaLengths(row.data, event.text).filter(([seq]) => seq < beforeSeq).map(([seq, at, text]) => ({ sessionId, itemId, type: "item.delta", seq, at, text } as Delta))
      }
      const entries = JSON.parse(Buffer.from(Bun.zstdDecompressSync(row.data)).toString("utf8")) as Array<Delta | [number, number, string, Delta["input"] | null, number | null, string | null]>
      const out: Delta[] = []
      for (const entry of entries) {
        if (!Array.isArray(entry)) { if (entry.seq < beforeSeq) out.push(entry); continue }
        const [seq, at, text, input, z, zref] = entry
        if (seq >= beforeSeq) continue
        out.push({ sessionId, itemId, type: "item.delta", seq, at, text, ...(input ? { input } : {}), ...(z === null ? {} : { z }), ...(zref === null ? {} : { zref }) } as Delta)
      }
      return out
    },
    range(sessionId: string, fromSeq: number, beforeSeq: number): Delta[] {
      return crossing.all(sessionId, beforeSeq, beforeSeq).flatMap(row => this.cut(sessionId, row.item_id, beforeSeq).filter(event => event.seq >= fromSeq))
    },
    /** Exact historical consumers (sync/export), bounded to the requested sequence window. */
    archived(sessionId: string, afterSeq: number, throughSeq: number): Delta[] {
      const found = db.query<{ item_id: string }, [string, number, number]>("SELECT item_id FROM folded_deltas WHERE session_id = ? AND completed_seq > ? AND first_seq <= ? ORDER BY first_seq").all(sessionId, afterSeq, throughSeq)
      const result: Delta[] = []
      for (const row of found) for (const event of this.cut(sessionId, row.item_id, throughSeq + 1)) if (event.seq > afterSeq) result.push(event)
      return result.sort((a, b) => a.seq - b.seq)
    },
    /** Bounded cursor over physical rows; invoked by idle maintenance, never on open. */
    migrate(limit = 100): { visited: number; removed: number; complete: boolean } {
      const saved = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(migrationKey)
      const [session, seq] = saved ? JSON.parse(saved.value) as [string, number] : ["", 0]
      const candidates = db.query<EventRow, [string, number, number]>(`SELECT session_id, seq, type, at, payload FROM events
        WHERE (session_id, seq) > (?1, ?2) ORDER BY session_id, seq LIMIT ?3`).all(session, seq, Math.max(1, Math.min(limit, 1000)))
      if (!candidates.length) {
        const key = "delta-lengths-cursor-v1"
        const saved = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
        const [session, item] = saved ? JSON.parse(saved.value) as [string, string] : ["", ""]
        const blocks = db.query<{ session_id: string; item_id: string; completed_seq: number; data: Uint8Array }, [string, string, number]>("SELECT session_id,item_id,completed_seq,data FROM folded_deltas WHERE (session_id,item_id)>(?1,?2) ORDER BY session_id,item_id LIMIT ?3").all(session, item, Math.max(1, Math.min(limit, 100)))
        let visited = 0
        db.transaction(() => {
          for (const block of blocks) {
            if (db.query("SELECT 1 FROM sessions WHERE id=? AND active_turn IS NOT NULL").get(block.session_id)) break
            if (!isDeltaLengths(block.data)) {
              const row = db.query<EventRow, [string, number]>("SELECT session_id, seq, type, at, payload FROM events WHERE session_id=? AND seq=?").get(block.session_id, block.completed_seq)
              const event = row ? eventFromRow(row, load) : undefined
              if (event?.type === "item.completed" && event.text && !event.blob) {
                const payload = Buffer.from(Bun.zstdDecompressSync(block.data)).toString("utf8")
                // Older object archives remain supported; only tuple archives enter this conversion.
                if (payload.startsWith("[[")) {
                  const data = packDeltaLengths(payload, event.text)
                  if (data && data.length < block.data.length) db.query("UPDATE folded_deltas SET data=? WHERE session_id=? AND item_id=?").run(data, block.session_id, block.item_id)
                }
              }
            }
            db.query("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify([block.session_id, block.item_id]))
            visited++
          }
        })()
        return { visited, removed: 0, complete: blocks.length === 0 }
      }
      let removed = 0
      let visited = 0
      db.transaction(() => {
        let last: typeof candidates[number] | undefined
        let checked: string | undefined
        for (const row of candidates) {
          if (checked !== row.session_id) {
            if (db.query("SELECT 1 FROM sessions WHERE id = ? AND active_turn IS NOT NULL").get(row.session_id)) break
            checked = row.session_id
          }
          const event = eventFromRow(row, load)
          if (event.type === "item.completed") removed += this.fold(event)
          visited++
          last = row
        }
        if (last) db.query("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(migrationKey, JSON.stringify([last.session_id, last.seq]))
      })()
      return { visited, removed, complete: candidates.length === 0 }
    },
  }
}
