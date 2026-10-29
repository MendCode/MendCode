import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

export type SessionSearchHit = { sessionId: SessionId; snippet: string }
export type SessionSearchOptions = { text: string; regex?: boolean; sessionIds?: SessionId[]; directory?: string; limit?: number }

const MAX_SESSIONS = 200
const SCAN_EVENTS = 3000
const SCAN_MESSAGES = 300
const SNIPPET = 120
const MAX_TEXT = 20_000

/** A window of `text` around the match, on one line. */
export function snippetAround(text: string, at: number, length: number): string {
  const flat = text.replace(/\s+/g, " ")
  const start = Math.max(0, Math.min(at, flat.length) - Math.floor((SNIPPET - length) / 2))
  const slice = flat.slice(start, start + SNIPPET).trim()
  return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET < flat.length ? "…" : ""}`
}

/**
 * A bounded search over the messages (the user's and the assistant's, never tool output) of sessions: at most 200 sessions,
 * the newest 300 messages inside the last 3000 events of each. A phrase is matched without regard to case; `regex` reads
 * it as an expression instead.
 */
export function createSessionSearch(db: Database) {
  const candidates = db.query<{ id: string; last_seq: number }, [string, number]>("SELECT id, last_seq FROM sessions WHERE (?1 = '' OR directory = ?1) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?2")
  const known = db.query<{ id: string; last_seq: number }, [string]>("SELECT id, last_seq FROM sessions WHERE id = ?")
  // The message items are listed once per session (an uncorrelated IN), not looked up again for every completed event:
  // a correlated EXISTS scanned the whole session per row, 0.7 s for one search over a 10,000-message session.
  // A message edited or deleted since (`message_revisions`) is searched as it reads now: its revised text, or not at all.
  const texts = db.query<{ text: string | null }, [string, number, number]>(`SELECT CASE WHEN json_extract(r.payload, '$.deleted') THEN NULL ELSE COALESCE(json_extract(r.payload, '$.snapshot.text'), json_extract(e.payload, '$.text')) END AS text
    FROM events_read e LEFT JOIN message_revisions r ON r.session_id = e.session_id AND r.item_id = json_extract(e.payload, '$.itemId')
    WHERE e.session_id = ?1 AND e.seq > ?2 AND e.type = 'item.completed' AND json_extract(e.payload, '$.text') IS NOT NULL
    AND json_extract(e.payload, '$.itemId') IN (SELECT json_extract(s.payload, '$.itemId') FROM events_read s WHERE s.session_id = ?1 AND s.type = 'item.started'
      AND json_extract(s.payload, '$.kind') IN ('user_message', 'agent_message'))
    ORDER BY e.seq DESC LIMIT ?3`)

  return {
    /** Sessions whose messages contain the phrase (or match the expression), newest session first, with the first matching line. */
    search(options: SessionSearchOptions): SessionSearchHit[] {
      let matcher: RegExp
      try {
        matcher = options.regex ? new RegExp(options.text.slice(0, 200), "i") : new RegExp(options.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      } catch {
        throw new SyntaxError("[STORE]: invalid regular expression")
      }
      const sessions = options.sessionIds
        ? options.sessionIds.slice(0, MAX_SESSIONS).flatMap((id) => known.get(id) ?? [])
        : candidates.all(options.directory ?? "", MAX_SESSIONS)
      const hits: SessionSearchHit[] = []
      const limit = options.limit ?? 50
      for (const session of sessions) {
        for (const row of texts.all(session.id, session.last_seq - SCAN_EVENTS, SCAN_MESSAGES)) {
          const text = row.text?.slice(0, MAX_TEXT)
          const match = text ? matcher.exec(text) : null
          if (!text || !match) continue
          hits.push({ sessionId: session.id as SessionId, snippet: snippetAround(text, match.index, match[0].length) })
          break
        }
        if (hits.length >= limit) break
      }
      return hits
    },
  }
}
