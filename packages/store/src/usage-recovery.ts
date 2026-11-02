import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

export type RecoveredDay = { day: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export type RecoveryRow = RecoveredDay & { sessionId: SessionId; engine: string }

/** Separate, reversible observations; never rewrite events or the original usage projections. */
export function createUsageRecovery(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS usage_recovery (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    engine TEXT NOT NULL, day TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    PRIMARY KEY(session_id, engine, day)) WITHOUT ROWID`)
  const saved = () => db.query<RecoveryRow, []>(`SELECT session_id AS sessionId, engine, day, input, output, cache_read AS cacheRead, cache_write AS cacheWrite FROM usage_recovery`).all()
  function baseline(sessionId: SessionId, engine: string, day: string): RecoveredDay {
    // Pi can use any provider. Counting all providers is conservative and avoids double counting native usage.
    return db.query<RecoveredDay, [string, string, string]>(`SELECT ?3 AS day, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
      COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(cache_write),0) AS cacheWrite FROM usage_scope_daily
      WHERE session_id = ?1 AND day = ?3 AND (?2 = 'pi' OR provider = ?2)`).get(sessionId, engine, day)!
  }
  function difference(row: RecoveryRow): RecoveryRow {
    const base = baseline(row.sessionId, row.engine, row.day)
    return { ...row, input: Math.max(0, row.input - base.input), output: Math.max(0, row.output - base.output), cacheRead: Math.max(0, row.cacheRead - base.cacheRead), cacheWrite: Math.max(0, row.cacheWrite - base.cacheWrite) }
  }
  return {
    preview(sessionId: SessionId, engine: string, days: RecoveredDay[]) {
      const previous = saved().filter((row) => row.sessionId === sessionId && row.engine === engine)
      return days.map((day) => {
        const old = previous.find((row) => row.day === day.day)
        const merged = { ...day, sessionId, engine }
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) merged[key] = Math.max(merged[key], old?.[key] ?? 0)
        return { observed: merged, recovered: difference(merged), previous: old ? difference(old) : { ...day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      })
    },
    save: db.transaction((rows: RecoveryRow[]) => {
      const insert = db.query(`INSERT INTO usage_recovery VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, engine, day) DO UPDATE SET
        input = MAX(input, excluded.input), output = MAX(output, excluded.output), cache_read = MAX(cache_read, excluded.cache_read), cache_write = MAX(cache_write, excluded.cache_write)`)
      for (const row of rows) insert.run(row.sessionId, row.engine, row.day, row.input, row.output, row.cacheRead, row.cacheWrite)
    }),
    undo(sessionId: SessionId, engine: string) { db.query("DELETE FROM usage_recovery WHERE session_id = ? AND engine = ?").run(sessionId, engine) },
    rows(range: { from: string; to: string; directories?: string[] }) {
      return saved().filter((row) => row.day >= range.from && row.day <= range.to && (range.directories === undefined || range.directories.includes(db.query<{ directory: string }, [string]>("SELECT directory FROM sessions WHERE id = ?").get(row.sessionId)?.directory ?? ""))).map(difference)
    },
  }
}
