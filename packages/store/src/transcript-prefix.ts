import type { Database } from "bun:sqlite"

/** Flat addresses keep fork-of-fork SQL reads bounded and old physical copies unchanged. */
export function createTranscriptPrefix(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS transcript_prefix (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, parent_id TEXT NOT NULL, parent_seq INTEGER NOT NULL,
    PRIMARY KEY(session_id, seq)
  ) WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS transcript_prefix_parent ON transcript_prefix(parent_id, parent_seq)")
  db.run(`CREATE TABLE IF NOT EXISTS turn_prefix (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_id TEXT NOT NULL,
    PRIMARY KEY(session_id, turn_id)
  ) WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS turn_prefix_parent ON turn_prefix(parent_id, turn_id)")
  db.run(`CREATE VIEW IF NOT EXISTS events_read AS
    SELECT session_id, seq, type, at, payload, session_id AS source_id, seq AS source_seq FROM events
    UNION ALL
    SELECT p.session_id, p.seq, e.type, e.at,
      json_set(e.payload, '$.sessionId', p.session_id, '$.seq', p.seq), p.parent_id, p.parent_seq
    FROM transcript_prefix p JOIN events e ON e.session_id = p.parent_id AND e.seq = p.parent_seq`)
  db.run(`CREATE VIEW IF NOT EXISTS turns_read AS
    SELECT *, session_id AS source_id FROM turns
    UNION ALL
    SELECT p.session_id, t.turn_id, p.seq, t.at, t.item_id, t.preview, t.status, t.reverted,
      t.shell, t.notice, t.compacted, t.shell_tool, t.history, p.parent_id
    FROM turn_prefix p JOIN turns t ON t.session_id = p.parent_id AND t.turn_id = p.turn_id`)

  function ownTurn(sessionId: string, turnId: string) {
    if (!db.query("SELECT 1 FROM turn_prefix WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId)) return
    db.run(`INSERT OR IGNORE INTO turns
      SELECT session_id, turn_id, seq, at, item_id, preview, status, reverted, shell, notice, compacted, shell_tool, history
      FROM turns_read WHERE session_id = ? AND turn_id = ?`, [sessionId, turnId])
    db.run("DELETE FROM turn_prefix WHERE session_id = ? AND turn_id = ?", [sessionId, turnId])
  }

  const writeTurn = db.transaction((sessionId: string, turnId: string) => {
    // Freeze children before changing a shared projection (undo, revised preview, compaction marks).
    const children = db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM turn_prefix WHERE parent_id = ? AND turn_id = ?").all(sessionId, turnId)
    for (const child of children) ownTurn(child.session_id, turnId)
    ownTurn(sessionId, turnId)
  })

  function release(sessionId: string) {
    // Hand physical rows to the first reader, then retarget the rest. No N-way transcript copy on deletion.
    const rows = db.query<{ seq: number }, [string]>("SELECT DISTINCT parent_seq AS seq FROM transcript_prefix WHERE parent_id = ?").all(sessionId)
    for (const { seq } of rows) {
      const heir = db.query<{ session_id: string; seq: number }, [string, number]>("SELECT session_id, seq FROM transcript_prefix WHERE parent_id = ? AND parent_seq = ? ORDER BY session_id LIMIT 1").get(sessionId, seq)!
      db.run(`INSERT INTO events SELECT session_id, seq, type, at, payload FROM events_read WHERE session_id = ? AND seq = ?`, [heir.session_id, heir.seq])
      db.run("DELETE FROM transcript_prefix WHERE session_id = ? AND seq = ?", [heir.session_id, heir.seq])
      db.run("UPDATE transcript_prefix SET parent_id = ?, parent_seq = ? WHERE parent_id = ? AND parent_seq = ?", [heir.session_id, heir.seq, sessionId, seq])
    }
    const turns = db.query<{ turn_id: string }, [string]>("SELECT DISTINCT turn_id FROM turn_prefix WHERE parent_id = ?").all(sessionId)
    for (const { turn_id } of turns) {
      const heir = db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM turn_prefix WHERE parent_id = ? AND turn_id = ? ORDER BY session_id LIMIT 1").get(sessionId, turn_id)!
      ownTurn(heir.session_id, turn_id)
      db.run("UPDATE turn_prefix SET parent_id = ? WHERE parent_id = ? AND turn_id = ?", [heir.session_id, sessionId, turn_id])
    }
  }

  return { writeTurn, release }
}
