import type { Database } from "bun:sqlite"

/** A turn a daemon shutdown interrupted, waiting for the next daemon to carry it on. */
export type PendingResume = { sessionId: string; turnId: string; launcher: string | undefined; attempts: number; at: number }

/**
 * Two small tables the daemon is the only writer of. `session_launchers` keeps which session started a child from its shell
 * (`run --bg`), so the link outlives the daemon; a session's `parent_id` stays empty for those. `restart_resumes` keeps the turns a
 * shutdown interrupted until the next start has resumed or reported each one: one row per session, removed when it is claimed.
 */
export function createRestartResume(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS session_launchers (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, launcher TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS restart_resumes (
    session_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, launcher TEXT, attempts INTEGER NOT NULL, at INTEGER NOT NULL
  ) WITHOUT ROWID`)
  return {
    launchers: {
      get(child: string): string | undefined { return db.query<{ launcher: string }, [string]>("SELECT launcher FROM session_launchers WHERE id = ?").get(child)?.launcher },
      set(child: string, launcher: string) { db.query("INSERT OR REPLACE INTO session_launchers VALUES (?, ?)").run(child, launcher) },
    },
    resumes: {
      /** Keeps the turn for the next start; a session already waiting keeps its first record. */
      put(entry: PendingResume) {
        db.query("INSERT OR IGNORE INTO restart_resumes VALUES (?, ?, ?, ?, ?)").run(entry.sessionId, entry.turnId, entry.launcher ?? null, entry.attempts, entry.at)
      },
      /** The oldest first, at most `limit`: the only read at start. */
      list(limit: number): PendingResume[] {
        return db.query<{ session_id: string; turn_id: string; launcher: string | null; attempts: number; at: number }, [number]>("SELECT * FROM restart_resumes ORDER BY at, session_id LIMIT ?").all(limit)
          .map((row) => ({ sessionId: row.session_id, turnId: row.turn_id, launcher: row.launcher ?? undefined, attempts: row.attempts, at: row.at }))
      },
      get(sessionId: string): PendingResume | undefined {
        const row = db.query<{ turn_id: string; launcher: string | null; attempts: number; at: number }, [string]>("SELECT turn_id, launcher, attempts, at FROM restart_resumes WHERE session_id = ?").get(sessionId)
        return row ? { sessionId, turnId: row.turn_id, launcher: row.launcher ?? undefined, attempts: row.attempts, at: row.at } : undefined
      },
      remove(sessionId: string) { db.query("DELETE FROM restart_resumes WHERE session_id = ?").run(sessionId) },
      count(): number { return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM restart_resumes").get()?.n ?? 0 },
    },
  }
}
