import type { Database } from "bun:sqlite"
import { parseEvent, eventFromRow, type EventRow, type ObjectLoader } from "./compress"
import type { EngineHistory } from "./engine-history"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import type { SessionEventDraft } from "@mendcode/kernel"
import type { createDeltaFold } from "./delta-fold"

export function createProjectSyncRecords(db: Database, append: (event: SessionEventDraft, at?: number) => SessionEvent, history: EngineHistory, load: ObjectLoader, folded?: ReturnType<typeof createDeltaFold>) {
  return {
    history(directories: string[], cursors: Record<string, number>) {
      if (!directories.length) return { events: [], hasMore: false }
      if (folded) {
        const events: SessionEvent[] = []
        let bytes = 0
        const sessions = db.query<{ id: SessionId; last_seq: number }, string[]>(`SELECT id, last_seq FROM sessions WHERE directory IN (${directories.map(() => "?").join(",")}) ORDER BY id`).all(...directories)
        for (const session of sessions) {
          let after = (cursors[session.id] ?? -1) + 1
          while (after < session.last_seq) {
            const through = Math.min(after + 256, session.last_seq)
            const physical = db.query<EventRow, [string, number, number]>("SELECT session_id, seq, type, at, payload FROM events_read WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq").all(session.id, after, through).map(row => eventFromRow(row, load))
            const page = new Map(physical.map(event => [event.seq, event]))
            for (const delta of folded.archived(session.id, after, through)) if (!page.has(delta.seq)) page.set(delta.seq, parseEvent(JSON.stringify(delta), load))
            for (const event of [...page.values()].sort((a, b) => a.seq - b.seq)) {
              const size = Buffer.byteLength(JSON.stringify(event)) + 250
              if (events.length >= 2000 || bytes + size > 160_000) return { events, hasMore: true }
              events.push(event)
              bytes += size
            }
            after = through
          }
        }
        return { events, hasMore: false }
      }
      const rows: SessionEvent[] = []
      let bytes = 0
      let hasMore = false
      // Leaving the loop early must finalize the statement: a cached, half-read cursor keeps the table locked until GC.
      const statement = db.prepare<EventRow, string[]>(`SELECT e.session_id, e.seq, e.type, e.at, e.payload FROM events_read e JOIN sessions s ON s.id = e.session_id WHERE s.directory IN (${directories.map(() => "?").join(",")}) ORDER BY e.seq, e.session_id`)
      try {
        for (const row of statement.iterate(...directories)) {
          const event = eventFromRow(row, load)
          if (cursors[event.sessionId] !== undefined && event.seq - 1 <= cursors[event.sessionId]!) continue
          const size = Buffer.byteLength(row.payload) + 250
          if (rows.length >= 2000 || bytes + size > 160_000) { hasMore = true; break }
          bytes += size
          rows.push(event)
        }
      } finally { statement.finalize() }
      return { events: rows, hasMore }
    },
    replay(events: SessionEvent[], messages: unknown[]) {
      return db.transaction(() => {
        const first = events[0]!
        if (first.type !== "session.created") throw new Error("Complete history required")
        db.query("INSERT INTO sessions(id, directory, title, parent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(first.sessionId, first.directory, first.title, first.parentId ?? null, first.at)
        const result = events.map(({ seq: _seq, at, ...draft }) => append(draft, at))
        const insert = db.query("INSERT INTO engine_messages(session_id, engine, idx, payload) VALUES (?, 'native', ?, ?)")
        messages.forEach((message, i) => insert.run(first.sessionId, i, JSON.stringify(message)))
        return result
      })()
    },
    /**
     * Incremental replay: the new tail of a session this store already has, with the model messages of that tail, in one
     * transaction. The caller has checked that the tail continues the stored history.
     */
    extend(sessionId: SessionId, events: SessionEvent[], messages: unknown[]) {
      return db.transaction(() => {
        const result = events.map(({ seq: _seq, at, ...draft }) => append(draft, at))
        const next = history.count(sessionId, "native")
        messages.forEach((message, i) => history.insert(sessionId, "native", next + i, JSON.stringify(message)))
        return result
      })()
    },
    /** Size and type of a blob some session in `directories` references; undefined when none does (a blob of another project is not readable here). */
    blobInfo(directories: string[], sha256: string): { bytes: number; mime: string } | undefined {
      if (!directories.length) return undefined
      return db.query<{ bytes: number; mime: string }, string[]>(`SELECT b.bytes, b.mime FROM blobs b JOIN blob_refs r ON r.sha256 = b.sha256 JOIN sessions s ON s.id = r.session_id WHERE b.sha256 = ? AND s.directory IN (${directories.map(() => "?").join(",")}) LIMIT 1`).get(sha256, ...directories) ?? undefined
    },
    workspaceId(sessionId: SessionId): string | null {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM events_read WHERE session_id = ? AND type = 'session.workspace.changed' ORDER BY seq DESC LIMIT 1").get(sessionId)
      return row ? JSON.parse(row.payload).workspaceID : null
    },
    move(sessionIds: SessionId[], directory: string, workspaceID: string | null) {
      return db.transaction(() => sessionIds.map((sessionId) => append({ type: "session.workspace.changed", sessionId, directory, workspaceID })))()
    },
  }
}
