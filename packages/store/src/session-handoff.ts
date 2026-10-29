import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

/** Contexts waiting for one session's next turn (merged forks); the oldest go first when more arrive. */
export const PENDING_CONTEXT_LIMIT = 4
/** One waiting context, in characters: a merge is already budgeted, this only keeps a bad caller from filling the disk. */
const PENDING_CONTEXT_CHARS = 200_000

export type PendingContext = { id: number; fromSessionId: SessionId; title: string; text: string; createdAt: number }

/**
 * What a session knows about the engines that ran it and about its fork relationship, for portable handoff and
 * merge-back (docs/sessions.md). `seen` is the last turn each engine took part in, so a switch back to it only hands over
 * what happened elsewhere; the base of a fork is its last copied turn, so merge-back brings only the fork's own turns.
 * Everything belongs to its session and goes with it when it is deleted.
 */
export function createSessionHandoff(input: { db: Database; now: () => number }) {
  const { db, now } = input
  db.run(`CREATE TABLE IF NOT EXISTS session_engine_seen (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, engine TEXT NOT NULL, turn_id TEXT NOT NULL,
    PRIMARY KEY (session_id, engine)
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS session_fork_base (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, base_turn_id TEXT, merged_turn_id TEXT
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS session_pending_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    from_session_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  db.run("CREATE INDEX IF NOT EXISTS session_pending_context_session ON session_pending_context(session_id, id)")
  return {
    seen(sessionId: SessionId, engine: string): string | undefined {
      return db.query<{ turn_id: string }, [string, string]>("SELECT turn_id FROM session_engine_seen WHERE session_id = ? AND engine = ?").get(sessionId, engine)?.turn_id
    },
    seenEngines(sessionId: SessionId): Array<{ engine: string; turnId: string }> {
      return db.query<{ engine: string; turn_id: string }, [string]>("SELECT engine, turn_id FROM session_engine_seen WHERE session_id = ? ORDER BY engine").all(sessionId).map((row) => ({ engine: row.engine, turnId: row.turn_id }))
    },
    markSeen(sessionId: SessionId, engine: string, turnId: string) {
      db.query("INSERT INTO session_engine_seen(session_id, engine, turn_id) VALUES (?, ?, ?) ON CONFLICT(session_id, engine) DO UPDATE SET turn_id = excluded.turn_id").run(sessionId, engine.slice(0, 120), turnId)
    },
    /** A fork's branch point: the last turn it carried over (none when it started empty). Written once, when the fork is made. */
    setBase(sessionId: SessionId, baseTurnId: string | undefined) {
      db.query("INSERT INTO session_fork_base(session_id, base_turn_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET base_turn_id = excluded.base_turn_id").run(sessionId, baseTurnId ?? null)
    },
    base(sessionId: SessionId): { known: boolean; baseTurnId?: string; mergedTurnId?: string } {
      const row = db.query<{ base_turn_id: string | null; merged_turn_id: string | null }, [string]>("SELECT base_turn_id, merged_turn_id FROM session_fork_base WHERE session_id = ?").get(sessionId)
      return row ? { known: true, ...(row.base_turn_id ? { baseTurnId: row.base_turn_id } : {}), ...(row.merged_turn_id ? { mergedTurnId: row.merged_turn_id } : {}) } : { known: false }
    },
    setMerged(sessionId: SessionId, turnId: string) {
      db.query("INSERT INTO session_fork_base(session_id, merged_turn_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET merged_turn_id = excluded.merged_turn_id").run(sessionId, turnId)
    },
    /** Queues `text` for the next turn of `sessionId`; returns how many contexts now wait there. */
    queueContext(entry: { sessionId: SessionId; fromSessionId: SessionId; title: string; text: string }): number {
      db.transaction(() => {
        db.query("INSERT INTO session_pending_context(session_id, from_session_id, title, text, created_at) VALUES (?, ?, ?, ?, ?)").run(entry.sessionId, entry.fromSessionId, entry.title.slice(0, 200), entry.text.slice(0, PENDING_CONTEXT_CHARS), now())
        db.query("DELETE FROM session_pending_context WHERE session_id = ?1 AND id NOT IN (SELECT id FROM session_pending_context WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2)").run(entry.sessionId, PENDING_CONTEXT_LIMIT)
      })()
      return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session_pending_context WHERE session_id = ?").get(entry.sessionId)?.n ?? 0
    },
    pendingContext(sessionId: SessionId): PendingContext[] {
      return db.query<{ id: number; from_session_id: string; title: string; text: string; created_at: number }, [string]>("SELECT id, from_session_id, title, text, created_at FROM session_pending_context WHERE session_id = ? ORDER BY id").all(sessionId)
        .map((row) => ({ id: row.id, fromSessionId: row.from_session_id as SessionId, title: row.title, text: row.text, createdAt: row.created_at }))
    },
    clearContext(sessionId: SessionId, ids: readonly number[]) {
      for (const id of ids) db.query("DELETE FROM session_pending_context WHERE session_id = ? AND id = ?").run(sessionId, id)
    },
  }
}
