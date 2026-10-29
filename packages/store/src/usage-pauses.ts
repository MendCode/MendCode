import type { Database } from "bun:sqlite"
import { USAGE_LIMIT_OPEN_STATES, type SessionId, type TurnId } from "@mendcode/protocol"

/** A turn paused by the provider's usage limit, kept so Resume at reset survives a daemon restart (docs/usage-limit.md). */
export type UsagePause = {
  sessionId: SessionId
  turnId?: TurnId
  /** Always an open state: a resolved pause is deleted. */
  state: (typeof USAGE_LIMIT_OPEN_STATES)[number]
  provider?: string
  /** The session's effective model when the turn stopped: a resume into another model asks first. */
  model?: string
  message: string
  /** When the window resets (ms since epoch); absent when the provider did not say. */
  resetsAt?: number
  createdAt: number
  updatedAt: number
}

type Row = { session_id: string; turn_id: string | null; state: string; provider: string | null; model: string | null; message: string; resets_at: number | null; created_at: number; updated_at: number }

const toPause = (row: Row): UsagePause => ({
  sessionId: row.session_id as SessionId,
  ...(row.turn_id ? { turnId: row.turn_id as TurnId } : {}),
  state: row.state as UsagePause["state"],
  ...(row.provider ? { provider: row.provider } : {}),
  ...(row.model ? { model: row.model } : {}),
  message: row.message,
  ...(row.resets_at !== null ? { resetsAt: row.resets_at } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** One open usage-limit pause per session; deleting the session deletes its pause. */
export function createUsagePauses(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS usage_pauses (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT, state TEXT NOT NULL, provider TEXT, message TEXT NOT NULL, resets_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`)
  // A database created before the model column existed keeps its open pauses.
  if (!db.query<{ name: string }, []>("PRAGMA table_info(usage_pauses)").all().some((column) => column.name === "model")) db.run("ALTER TABLE usage_pauses ADD COLUMN model TEXT")
  return {
    get(sessionId: SessionId): UsagePause | undefined {
      const row = db.query<Row, [string]>("SELECT * FROM usage_pauses WHERE session_id = ?").get(sessionId)
      return row ? toPause(row) : undefined
    },
    /** Every open pause, oldest first: the daemon re-arms their timers when it starts. */
    all(): UsagePause[] {
      return db.query<Row, []>("SELECT * FROM usage_pauses ORDER BY created_at, session_id").all().map(toPause)
    },
    put(pause: UsagePause) {
      if (!USAGE_LIMIT_OPEN_STATES.includes(pause.state)) throw new RangeError("[STORE]: a resolved usage pause cannot be stored")
      db.query("INSERT OR REPLACE INTO usage_pauses (session_id, turn_id, state, provider, model, message, resets_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(pause.sessionId, pause.turnId ?? null, pause.state, pause.provider ?? null, pause.model ?? null, pause.message, pause.resetsAt ?? null, pause.createdAt, pause.updatedAt)
    },
    delete(sessionId: SessionId): boolean {
      return db.query("DELETE FROM usage_pauses WHERE session_id = ?").run(sessionId).changes > 0
    },
  }
}
