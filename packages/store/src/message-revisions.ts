import type { Database } from "bun:sqlite"
import { parseEvent, type ObjectLoader } from "./compress"
import type { ItemId, MessageRevision, SessionEvent, SessionId } from "@mendcode/protocol"
import { projectMessageEvent } from "@mendcode/protocol/wire"

export function createMessageRevisions(db: Database, load: ObjectLoader) {
  db.run(`CREATE TABLE IF NOT EXISTS message_revisions (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, item_id)
  )`)
  db.run("CREATE INDEX IF NOT EXISTS events_message_item ON events(session_id, json_extract(payload, '$.itemId'), seq) WHERE type IN ('item.started', 'item.delta', 'item.completed')")
  const get = db.query<{ payload: string }, [string, string]>("SELECT payload FROM message_revisions WHERE session_id = ? AND item_id = ?")
  const put = db.query("INSERT INTO message_revisions(session_id, item_id, payload) VALUES (?, ?, ?) ON CONFLICT(session_id, item_id) DO UPDATE SET payload = excluded.payload")
  const item = db.query<{ payload: string }, [string, string]>("SELECT payload FROM events_read WHERE session_id = ? AND type IN ('item.started', 'item.delta', 'item.completed') AND json_extract(payload, '$.itemId') = ? ORDER BY seq LIMIT 10001")
  const revision = (sessionId: SessionId, itemId: ItemId): MessageRevision | undefined => {
    const row = get.get(sessionId, itemId)
    return row ? JSON.parse(row.payload) as MessageRevision : undefined
  }
  return {
    revision,
    has(sessionId: SessionId, itemId: ItemId) {
      return db.query("SELECT 1 FROM events_read WHERE session_id = ? AND type = 'item.started' AND json_extract(payload, '$.itemId') = ? LIMIT 1").get(sessionId, itemId) !== null
    },
    record(event: SessionEvent) {
      if (event.type === "message.revised") put.run(event.sessionId, event.itemId, JSON.stringify(event))
    },
    project(events: SessionEvent[]) {
      const revisions = new Map<ItemId, MessageRevision | undefined>()
      return events.flatMap((event) => {
        if (!("itemId" in event) || !event.itemId) return [event]
        if (!revisions.has(event.itemId)) revisions.set(event.itemId, revision(event.sessionId, event.itemId))
        const projected = projectMessageEvent(event, revisions.get(event.itemId))
        return projected ? [projected] : []
      })
    },
    read(sessionId: SessionId, itemId: ItemId) {
      const rows = item.all(sessionId, itemId)
      if (rows.length > 10000) throw new RangeError("message event limit exceeded")
      const events = rows.map((row) => parseEvent(row.payload, load))
      const start = events.find((event): event is Extract<SessionEvent, { type: "item.started" }> => event.type === "item.started")
      const completed = events.findLast((event): event is Extract<SessionEvent, { type: "item.completed" }> => event.type === "item.completed")
      if (!start || !completed) return undefined
      let text = ""
      for (const event of events) if (event.type === "item.delta") text += event.text
      if (completed.text !== undefined && (start.kind !== "tool_call" || completed.text || !text)) text = completed.text
      if (text.length > 65536) throw new RangeError("message is blob-backed or exceeds revision limit")
      const { type, sessionId: _, seq, at, itemId: __, ...snapshot } = completed
      const latest = revision(sessionId, itemId)
      return { start, revision: latest?.revision ?? 0, deleted: latest?.deleted ?? false, snapshot: latest?.snapshot ?? { ...snapshot, text } }
    },
  }
}
