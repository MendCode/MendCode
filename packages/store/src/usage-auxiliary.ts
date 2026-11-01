import type { Database } from "bun:sqlite"
import type { UsageAuxiliary } from "@mendcode/protocol"

/**
 * Model calls the daemon makes outside a turn (title, summary, recap, memory, hooks, the permission reviewer, setup...), one daily
 * row per role, model and session (docs/usage.md, "Auxiliary calls"). They emit no `usage.recorded`, so `usage_daily` and the
 * scope projections never see them: this table is their only count besides the budget ledger. Rows outlive their session, like
 * the global daily sums; a call with no session has an empty `session_id`, and `directory` scopes it.
 */

export type AuxiliaryUsageRecord = {
  at: number
  role: string
  provider: string
  model: string
  sessionId?: string | undefined
  directory?: string | undefined
  input: number
  output: number
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  /** Undefined: no price is known for the call (counted in `costUnknownCalls`). */
  costMicros?: number | undefined
}
export type AuxiliaryUsageRange = { from: string; to: string; directories?: readonly string[] }

const MAX_ROWS = 200
const count = (value: number | undefined) => (value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0)

export function createUsageAuxiliary(input: { db: Database; dayOf(at: number): string }) {
  const { db, dayOf } = input
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_auxiliary_daily (
      day TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      cost_unknown_calls INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, role, provider, model, session_id)
    ) WITHOUT ROWID;
  `)
  const upsert = db.query(`INSERT INTO usage_auxiliary_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(day, role, provider, model, session_id) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
      reasoning = reasoning + excluded.reasoning, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
      cost_micros = cost_micros + excluded.cost_micros, cost_unknown_calls = cost_unknown_calls + excluded.cost_unknown_calls, calls = calls + 1`)

  function record(entry: AuxiliaryUsageRecord) {
    const priced = entry.costMicros !== undefined && Number.isSafeInteger(entry.costMicros) && entry.costMicros >= 0
    upsert.run(dayOf(entry.at), entry.role.slice(0, 40), entry.provider.slice(0, 200), entry.model.slice(0, 200), entry.sessionId ?? "", entry.directory ?? "",
      count(entry.input), count(entry.output), count(entry.reasoning), count(entry.cacheRead), count(entry.cacheWrite), priced ? entry.costMicros! : 0, priced ? 0 : 1)
  }

  /** The range's calls by role and model, most tokens first; `directories` keeps the calls made for those directories. */
  function report(range: AuxiliaryUsageRange): UsageAuxiliary[] {
    const scoped = range.directories ? " AND directory IN (SELECT value FROM json_each(?3))" : ""
    const args = [range.from, range.to, ...(range.directories ? [JSON.stringify(range.directories)] : [])]
    return db.query<UsageAuxiliary, string[]>(`
      SELECT role, provider, model, SUM(input) AS input, SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(cache_read) AS cacheRead,
        SUM(cache_write) AS cacheWrite, SUM(calls) AS calls, SUM(cost_micros) AS costMicros, SUM(cost_unknown_calls) AS costUnknownCalls
      FROM usage_auxiliary_daily WHERE day BETWEEN ?1 AND ?2${scoped}
      GROUP BY role, provider, model ORDER BY input + output DESC, calls DESC, role, model LIMIT ${MAX_ROWS}`).all(...args)
  }

  return { record, report }
}
export type UsageAuxiliaryStore = ReturnType<typeof createUsageAuxiliary>
