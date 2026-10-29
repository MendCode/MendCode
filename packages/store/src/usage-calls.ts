import type { Database } from "bun:sqlite"
import type { SessionEvent } from "@mendcode/protocol"
import { parseEvent } from "./compress"

/**
 * One row per model call and one per finished compaction, for the waste report (docs/usage.md, "Waste"): the report needs each
 * call in its session's order (the gap before it, what the call before it held), which the daily sums cannot give. Written in
 * the store's event transaction; backfilled once from the event log. Rows follow their session when it is deleted.
 */

export type UsageCallRow = {
  sessionId: string; seq: number; at: number; turnId: string; provider: string; model: string
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number
  costMicros: number | null
  /** The engine's own context count: external engines (Claude Code, Codex, ACP) report sums of a whole turn and say this. */
  context: number | null
  /** Present on a native main call, the history MendCode packs. */
  compactAt: number | null
  ttl: "1h" | null
  durationMs: number | null
}
export type UsageCompactionRow = { sessionId: string; seq: number; at: number; reason: "auto" | "manual" | "idle"; state: "packed" | "failed"; waitMs: number | null }
export type UsageCallRange = { from: string; to: string; directories?: readonly string[] }

const BACKFILL_KEY = "usage_calls_backfill"
const FINISHED = new Set(["packed", "failed"])
const VISIBLE = "session_id IN (SELECT id FROM sessions WHERE directory IN (SELECT value FROM json_each(?)))"

type Recorded = Extract<SessionEvent, { type: "usage.recorded" }>
type Compaction = Extract<SessionEvent, { type: "compaction.updated" }>

export function createUsageCalls(input: { db: Database; dayOf(at: number): string }) {
  const { db, dayOf } = input
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_calls (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
      turn_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      cost_micros INTEGER, context INTEGER, compact_at INTEGER, ttl TEXT, duration_ms INTEGER,
      PRIMARY KEY(session_id, seq)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_calls_day ON usage_calls(day);
    CREATE TABLE IF NOT EXISTS usage_compactions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
      reason TEXT NOT NULL, state TEXT NOT NULL, wait_ms INTEGER,
      PRIMARY KEY(session_id, seq)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_compactions_day ON usage_compactions(day);
  `)
  const insertCall = db.query("INSERT OR IGNORE INTO usage_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  const insertCompaction = db.query("INSERT OR IGNORE INTO usage_compactions VALUES (?, ?, ?, ?, ?, ?, ?)")
  /** When each session's compaction started writing, by turn: its wait is the time to `packed`. */
  const writing = new Map<string, number>()

  function call(event: Recorded) {
    insertCall.run(event.sessionId, event.seq, event.at, dayOf(event.at), event.turnId, event.provider, event.model,
      event.input, event.output, event.reasoning, event.cacheRead, event.cacheWrite, event.costMicros ?? null,
      event.context ?? null, event.compactAt ?? null, event.cacheTtl ?? null, event.profile?.durationMs ?? null)
  }

  function compaction(event: Compaction) {
    const key = `${event.sessionId}\n${event.turnId}`
    if (event.state === "writing") return void writing.set(key, event.at)
    const started = writing.get(key)
    writing.delete(key)
    if (!FINISHED.has(event.state)) return
    const reason = event.idle ? "idle" : event.reason
    insertCompaction.run(event.sessionId, event.seq, event.at, dayOf(event.at), reason, event.state, started === undefined ? null : Math.max(0, event.at - started))
  }

  function record(event: SessionEvent) {
    if (event.type === "usage.recorded") call(event)
    else if (event.type === "compaction.updated") compaction(event)
  }

  /** One pass over the event log the first time these tables exist. */
  function backfill() {
    if (db.query("SELECT 1 FROM meta WHERE key = ?").get(BACKFILL_KEY)) return
    const rows = db.query<{ payload: string | Uint8Array }, []>("SELECT payload FROM events WHERE type IN ('usage.recorded', 'compaction.updated') ORDER BY session_id, seq")
    db.transaction(() => {
      for (const row of rows.iterate()) {
        try { record(parseEvent(row.payload)) } catch { /* a row this version cannot read adds nothing */ }
      }
      writing.clear()
      db.query("INSERT INTO meta(key, value) VALUES (?, '1')").run(BACKFILL_KEY)
    })()
  }

  const scoped = (range: UsageCallRange) => (range.directories ? ` AND ${VISIBLE}` : "")
  const args = (range: UsageCallRange) => [range.from, range.to, ...(range.directories ? [JSON.stringify(range.directories)] : [])]

  return {
    record,
    backfill,
    /** The calls of the range, each session's in order. */
    calls(range: UsageCallRange): UsageCallRow[] {
      return db.query<UsageCallRow, string[]>(`
        SELECT session_id AS sessionId, seq, at, turn_id AS turnId, provider, model, input, output, reasoning, cache_read AS cacheRead,
          cache_write AS cacheWrite, cost_micros AS costMicros, context, compact_at AS compactAt, ttl, duration_ms AS durationMs
        FROM usage_calls WHERE day BETWEEN ? AND ?${scoped(range)} ORDER BY session_id, seq`).all(...args(range))
    },
    compactions(range: UsageCallRange): UsageCompactionRow[] {
      return db.query<UsageCompactionRow, string[]>(`
        SELECT session_id AS sessionId, seq, at, reason, state, wait_ms AS waitMs
        FROM usage_compactions WHERE day BETWEEN ? AND ?${scoped(range)} ORDER BY at`).all(...args(range))
    },
    /** The saved settings after each change (`settings.changed`), oldest first: the report compares the days around a change. */
    settingsHistory(limit = 2_000): Array<{ at: number; settings: Record<string, unknown> }> {
      const rows = db.query<{ at: number; payload: string }, [number]>("SELECT at, payload FROM (SELECT gseq, at, payload FROM global_events WHERE type = 'settings.changed' ORDER BY gseq DESC LIMIT ?) ORDER BY gseq").all(limit)
      return rows.flatMap((row) => {
        try {
          const settings = (JSON.parse(row.payload) as { settings?: unknown }).settings
          return settings && typeof settings === "object" ? [{ at: row.at, settings: settings as Record<string, unknown> }] : []
        } catch { return [] }
      })
    },
    /** Titles and directories of the sessions named, for the report's rows. */
    sessions(ids: readonly string[]): Array<{ id: string; title: string; directory: string }> {
      if (ids.length === 0) return []
      return db.query<{ id: string; title: string; directory: string }, [string]>("SELECT id, title, directory FROM sessions WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))
    },
  }
}
export type UsageCalls = ReturnType<typeof createUsageCalls>
