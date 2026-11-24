import type { Database } from "bun:sqlite"
import { parseEvent, eventFromRow, type EventRow, type ObjectLoader } from "./compress"
import type { EngineHistory } from "./engine-history"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import type { SessionEventDraft } from "@mendcode/kernel"
import type { createDeltaFold } from "./delta-fold"
import type { SealedTurns } from "./sealed-turns"

export function createProjectSyncRecords(db: Database, append: (event: SessionEventDraft, at?: number, ingest?: { seq: number }) => SessionEvent, history: EngineHistory, load: ObjectLoader, folded?: ReturnType<typeof createDeltaFold>, sealed?: Pick<SealedTurns, "rows" | "newest">) {
  /**
   * Every stored event of one session after native seq `after` (events, sealed blocks and folded deltas), appended to `events`
   * until a page is full (2,000 events or 160 KB); true when the page filled before the session's end.
   */
  function fill(sessionId: SessionId, lastSeq: number, after: number, events: SessionEvent[], budget: { bytes: number }): boolean {
    while (after < lastSeq) {
      const through = Math.min(after + 256, lastSeq)
      const physical = db.query<EventRow, [string, number, number]>("SELECT session_id, seq, type, at, payload FROM events_read WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq").all(sessionId, after, through).map(row => eventFromRow(row, load))
      for (const row of sealed?.rows(sessionId, after, through) ?? []) physical.push(eventFromRow({ session_id: sessionId, ...row }, load))
      const page = new Map(physical.map(event => [event.seq, event]))
      for (const delta of folded!.archived(sessionId, after, through)) if (!page.has(delta.seq)) page.set(delta.seq, parseEvent(JSON.stringify(delta), load))
      for (const event of [...page.values()].sort((a, b) => a.seq - b.seq)) {
        const size = Buffer.byteLength(JSON.stringify(event)) + 250
        if (events.length >= 2000 || budget.bytes + size > 160_000) return true
        events.push(event)
        budget.bytes += size
      }
      after = through
    }
    return false
  }
  return {
    history(directories: string[], cursors: Record<string, number>) {
      if (!directories.length) return { events: [], hasMore: false }
      if (folded) {
        const events: SessionEvent[] = []
        const budget = { bytes: 0 }
        const sessions = db.query<{ id: SessionId; last_seq: number }, string[]>(`SELECT id, last_seq FROM sessions WHERE directory IN (${directories.map(() => "?").join(",")}) ORDER BY id`).all(...directories)
        for (const session of sessions) if (fill(session.id, session.last_seq, (cursors[session.id] ?? -1) + 1, events, budget)) return { events, hasMore: true }
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
    /** One session's exact stored events after native seq `after`, one page at a time (session sync). */
    sessionHistory(sessionId: SessionId, after: number) {
      const lastSeq = db.query<{ last_seq: number }, [string]>("SELECT last_seq FROM sessions WHERE id = ?").get(sessionId)?.last_seq
      if (lastSeq === undefined) return undefined
      const events: SessionEvent[] = []
      const hasMore = fill(sessionId, lastSeq, after, events, { bytes: 0 })
      return { events, hasMore, lastSeq }
    },
    /**
     * Session sync ingest: events another machine stored, kept at their own seq, with the model messages they add, in one
     * transaction; `create` makes the session first. `lastSeq` is the owner's stored end once this tail is complete (an owner may
     * have pruned superseded snapshots at the end), so both machines continue from the same seq.
     */
    ingest(input: { sessionId: SessionId; events: SessionEvent[]; messages: unknown[]; create?: { directory: string; title: string; createdAt: number }; lastSeq?: number }) {
      return db.transaction(() => {
        if (input.create) db.query("INSERT INTO sessions(id, directory, title, parent_id, created_at) VALUES (?, ?, ?, NULL, ?)").run(input.sessionId, input.create.directory, input.create.title, input.create.createdAt)
        const result = input.events.map(({ seq, at, ...draft }) => append(draft as SessionEventDraft, at, { seq }))
        const next = history.count(input.sessionId, "native")
        input.messages.forEach((message, i) => history.insert(input.sessionId, "native", next + i, JSON.stringify(message)))
        if (input.lastSeq !== undefined) db.query("UPDATE sessions SET last_seq = max(last_seq, ?) WHERE id = ?").run(input.lastSeq, input.sessionId)
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
        ?? sealed?.newest(sessionId, (candidate) => candidate.type === "session.workspace.changed", 1)[0]
      return row ? JSON.parse(row.payload).workspaceID : null
    },
    move(sessionIds: SessionId[], directory: string, workspaceID: string | null) {
      return db.transaction(() => sessionIds.map((sessionId) => append({ type: "session.workspace.changed", sessionId, directory, workspaceID })))()
    },
  }
}
