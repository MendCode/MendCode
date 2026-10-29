import type { Database } from "bun:sqlite"
import { unpackText, type ObjectLoader } from "./compress"
import type { ItemId, SessionEvent, SessionId, SessionNotesInput, SessionNotesReport } from "@mendcode/protocol"

type Start = Extract<SessionEvent, { type: "item.started" }>
type NoteRow = { version: number; text: string }

/** The kinds a recall page shows, and how many starts are read at once while looking for them. */
const RECALL_KINDS = new Set(["user_message", "agent_message", "tool_call"])
const RECALL_BATCH = 64

export function createSessionRecallRecords(db: Database, load: ObjectLoader) {
  db.run(`CREATE TABLE IF NOT EXISTS session_note_revisions (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (session_id, version)
  ) WITHOUT ROWID`)
  // `events_message_item` (message-revisions.ts) indexes exactly the same expression and rows; a second copy of it cost
  // about 14% of the events table for nothing. A database that has both loses this one (an index is rebuilt from the rows).
  db.run("DROP INDEX IF EXISTS recall_event_items")
  const visible = `FROM events_read e JOIN turns_read t ON t.session_id = e.session_id AND t.turn_id = json_extract(e.payload, '$.turnId')
    WHERE e.session_id = ?1 AND e.type = 'item.started' AND t.reverted = 0 AND t.notice = 0
    AND json_extract(e.payload, '$.kind') IN ('user_message', 'agent_message', 'tool_call')
    AND EXISTS (SELECT 1 FROM events_read c WHERE c.session_id = e.session_id
      AND c.type IN ('item.started', 'item.delta', 'item.completed') AND c.type = 'item.completed'
      AND json_extract(c.payload, '$.itemId') = json_extract(e.payload, '$.itemId')
      AND (json_extract(e.payload, '$.kind') != 'tool_call' OR json_extract(c.payload, '$.status') = 'ok'))`
  const item = db.query<{ payload: string }, [string, string]>(`SELECT e.payload ${visible} AND json_extract(e.payload, '$.itemId') = ?2 LIMIT 1`)
  const starts = db.query<{ seq: number; payload: string }, [string, number, number]>("SELECT seq, payload FROM events_read WHERE session_id = ? AND type = 'item.started' AND seq < ? ORDER BY seq DESC LIMIT ?")
  const turnFlags = db.query<{ reverted: number; notice: number }, [string, string]>("SELECT reverted, notice FROM turns_read WHERE session_id = ? AND turn_id = ? LIMIT 1")
  const completion = db.query<{ status: string | null }, [string, string]>(`SELECT json_extract(payload, '$.status') AS status FROM events_read
    WHERE session_id = ? AND json_extract(payload, '$.itemId') = ? AND type IN ('item.started', 'item.delta', 'item.completed')
    AND type = 'item.completed' ORDER BY seq DESC LIMIT 1`)
  const completed = db.query<{ text: string | null; z: number | null; zref: string | null }, [string, string]>(`SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.z') AS z, json_extract(payload, '$.zref') AS zref FROM events_read
    WHERE session_id = ? AND json_extract(payload, '$.itemId') = ? AND type IN ('item.started', 'item.delta', 'item.completed')
    AND type = 'item.completed' ORDER BY seq DESC LIMIT 1`)
  const deltas = db.query<{ seq: number; text: string; z: number | null; zref: string | null }, [string, string, number]>(`SELECT seq, json_extract(payload, '$.text') AS text, json_extract(payload, '$.z') AS z, json_extract(payload, '$.zref') AS zref FROM events_read
    WHERE session_id = ? AND json_extract(payload, '$.itemId') = ? AND type IN ('item.started', 'item.delta', 'item.completed')
    AND type = 'item.delta' AND seq > ? ORDER BY seq LIMIT 1`)
  const conversation = db.query<{ seq: number; payload: string }, [string, number]>(`SELECT seq, payload FROM events_read WHERE session_id = ? AND type = 'item.started' AND seq < ?
    AND json_extract(payload, '$.kind') IN ('user_message', 'agent_message') ORDER BY seq`)
  const sessionTurns = db.query<{ turn_id: string; reverted: number; notice: number }, [string]>("SELECT turn_id, reverted, notice FROM turns_read WHERE session_id = ?")
  const completedTexts = db.query<{ item_id: string; text: string | null; z: number | null; zref: string | null }, [string, number]>(`SELECT json_extract(payload, '$.itemId') AS item_id,
    json_extract(payload, '$.text') AS text, json_extract(payload, '$.z') AS z, json_extract(payload, '$.zref') AS zref FROM events_read
    WHERE session_id = ? AND type = 'item.completed' AND seq < ?`)
  const packed = db.query<{ seq: number | null }, [string]>(`SELECT max(seq) AS seq FROM events_read WHERE session_id = ? AND type = 'compaction.updated'
    AND json_extract(payload, '$.state') = 'packed'`)
  const head = db.query<NoteRow, [string]>("SELECT version, text FROM session_note_revisions WHERE session_id = ? ORDER BY version DESC LIMIT 1")
  const revision = db.query<NoteRow, [string, number]>("SELECT version, text FROM session_note_revisions WHERE session_id = ? AND version = ?")
  const put = db.query("INSERT INTO session_note_revisions VALUES (?, ?, ?)")
  const notes = db.transaction((sessionId: SessionId, input: SessionNotesInput): SessionNotesReport => {
    const current = head.get(sessionId) ?? { version: 0, text: "" }
    if (input.action === "read") {
      if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 0)) throw new RangeError("Invalid note version")
      const value = input.version === undefined ? current : input.version === 0 ? { version: 0, text: "" } : revision.get(sessionId, input.version)
      if (!value) throw new RangeError("Unknown note version in this session")
      return { ...value, current_version: current.version }
    }
    if (input.version !== current.version) throw new RangeError(`Notes changed or version missing; read current notes before writing (current version ${current.version})`)
    if (typeof input.text !== "string" || input.text.length > 16_000) throw new RangeError("Notes require text of at most 16,000 characters")
    if (current.version >= Number.MAX_SAFE_INTEGER) throw new RangeError("Note version limit reached")
    const version = current.version + 1
    put.run(sessionId, version, input.text)
    return { version, text: input.text, current_version: version }
  })
  return {
    item(sessionId: SessionId, messageId: ItemId): Start | undefined {
      const row = item.get(sessionId, messageId)
      return row ? JSON.parse(row.payload) : undefined
    },
    page(sessionId: SessionId, before: number, limit: number): Start[] {
      // Newest first, a batch of starts at a time, each checked on its own (its turn, its completion): one query over the whole
      // session re-read every event for each candidate and took 32 s on a session of 165,000 events.
      const found: Start[] = []
      let cursor = before
      while (found.length < limit) {
        const batch = starts.all(sessionId, cursor, RECALL_BATCH)
        for (const row of batch) {
          cursor = row.seq
          const start = JSON.parse(row.payload) as Start
          if (!RECALL_KINDS.has(start.kind)) continue
          const turn = typeof start.turnId === "string" ? turnFlags.get(sessionId, start.turnId) : null
          if (!turn || turn.reverted !== 0 || turn.notice !== 0) continue
          const done = completion.get(sessionId, start.itemId)
          if (!done || start.kind === "tool_call" && done.status !== "ok") continue
          found.push(start)
          if (found.length === limit) break
        }
        if (batch.length < RECALL_BATCH) break
      }
      return found
    },
    *chunks(start: Start): IterableIterator<string> {
      if (start.kind === "tool_call") yield `${typeof start.meta?.tool === "string" ? start.meta.tool : "tool"}: `
      const final = completed.get(start.sessionId, start.itemId)
      if (typeof final?.text === "string") { yield unpackText(final.text, final.z, final.zref, load) ?? final.text; return }
      let after = start.seq
      for (;;) {
        const delta = deltas.get(start.sessionId, start.itemId, after)
        if (!delta) return
        after = delta.seq
        yield unpackText(delta.text, delta.z, delta.zref, load) ?? delta.text
      }
    },
    /** The seq of the latest finished compaction of this session, if any. */
    packedAt(sessionId: SessionId): number | undefined {
      return packed.get(sessionId)?.seq ?? undefined
    },
    /**
     * The turns before `before`, oldest first: each one's user messages and assistant messages joined, from completed items of
     * turns that were neither reverted nor notices. `turn` counts every such turn of the session from 1.
     */
    turns(sessionId: SessionId, before: number): Array<{ turn: number; at: number; user: string; assistant: string }> {
      // Three reads of the whole session instead of one query per item: per item, 42 turns of a 180,000-event session took 22 s.
      const kept = new Set(sessionTurns.all(sessionId).filter((turn) => turn.reverted === 0 && turn.notice === 0).map((turn) => turn.turn_id))
      const texts = new Map(completedTexts.all(sessionId, before).map((row) => [row.item_id, row]))
      const found = new Map<string, { turn: number; at: number; user: string[]; assistant: string[] }>()
      for (const row of conversation.all(sessionId, before)) {
        const start = JSON.parse(row.payload) as Start
        if (typeof start.turnId !== "string" || !kept.has(start.turnId)) continue
        const done = texts.get(start.itemId)
        if (!done) continue
        let turn = found.get(start.turnId)
        if (!turn) found.set(start.turnId, turn = { turn: found.size + 1, at: start.at, user: [], assistant: [] })
        const text = (typeof done.text === "string" ? unpackText(done.text, done.z, done.zref, load) ?? done.text : [...this.chunks(start)].join("")).trim()
        if (text) (start.kind === "user_message" ? turn.user : turn.assistant).push(text)
      }
      return [...found.values()].filter((turn) => turn.user.length || turn.assistant.length)
        .map((turn) => ({ turn: turn.turn, at: turn.at, user: turn.user.join("\n\n"), assistant: turn.assistant.join("\n\n") }))
    },
    notes(sessionId: SessionId, input: SessionNotesInput) { return notes(sessionId, input) },
  }
}
