import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"
import { unpackText, type ObjectLoader } from "./compress"
import type { SealedTurns } from "./sealed-turns"

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
export function createSessionSearch(db: Database, load?: ObjectLoader, sealed?: Pick<SealedTurns, "sealedThrough" | "rows">) {
  const candidates = db.query<{ id: string; last_seq: number }, [string, number]>("SELECT id, last_seq FROM sessions WHERE (?1 = '' OR directory = ?1) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?2")
  const known = db.query<{ id: string; last_seq: number }, [string]>("SELECT id, last_seq FROM sessions WHERE id = ?")
  // The message items are listed once per session (an uncorrelated IN), not looked up again for every completed event:
  // a correlated EXISTS scanned the whole session per row, 0.7 s for one search over a 10,000-message session.
  // A message edited or deleted since (`message_revisions`) is searched as it reads now: its revised text, or not at all.
  const texts = db.query<{ text: string | null; z: number | null; zref: string | null }, [string, number, number]>(`SELECT CASE WHEN json_extract(r.payload, '$.deleted') THEN NULL ELSE COALESCE(json_extract(r.payload, '$.snapshot.text'), json_extract(e.payload, '$.text')) END AS text,
    CASE WHEN r.payload IS NULL THEN json_extract(e.payload, '$.z') END AS z,
    CASE WHEN r.payload IS NULL THEN json_extract(e.payload, '$.zref') END AS zref
    FROM events_read e LEFT JOIN message_revisions r ON r.session_id = e.session_id AND r.item_id = json_extract(e.payload, '$.itemId')
    WHERE e.session_id = ?1 AND e.seq > ?2 AND e.type = 'item.completed' AND json_extract(e.payload, '$.text') IS NOT NULL
    AND json_extract(e.payload, '$.itemId') IN (SELECT json_extract(s.payload, '$.itemId') FROM events_read s WHERE s.session_id = ?1 AND s.type = 'item.started'
      AND json_extract(s.payload, '$.kind') IN ('user_message', 'agent_message'))
    ORDER BY e.seq DESC LIMIT ?3`)
  const revisionOf = db.query<{ payload: string }, [string, string]>("SELECT payload FROM message_revisions WHERE session_id = ? AND item_id = ?")
  type TextRow = { text: string | null; z: number | null; zref: string | null }

  /** The `texts` statement's rows for a session's sealed turns after `afterSeq`, newest first: the same messages, revisions applied. */
  function sealedTexts(sessionId: string, afterSeq: number, limit: number): TextRow[] {
    const through = sealed!.sealedThrough(sessionId)
    if (through <= afterSeq || limit <= 0) return []
    // A message's start can sit a little before the window its completion falls in.
    const rows = sealed!.rows(sessionId, Math.max(0, afterSeq - SCAN_EVENTS), through)
    const messages = new Set<string>()
    for (const row of rows) {
      if (row.type !== "item.started") continue
      const fields = JSON.parse(row.payload) as { itemId?: string; kind?: string }
      if (fields.itemId && (fields.kind === "user_message" || fields.kind === "agent_message")) messages.add(fields.itemId)
    }
    const out: TextRow[] = []
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const row = rows[i]!
      if (row.seq <= afterSeq || row.type !== "item.completed") continue
      const fields = JSON.parse(row.payload) as { itemId?: string; text?: unknown; z?: number; zref?: string }
      if (!fields.itemId || !messages.has(fields.itemId) || fields.text === undefined || fields.text === null) continue
      const revision = revisionOf.get(sessionId, fields.itemId)
      if (revision) {
        const revised = JSON.parse(revision.payload) as { deleted?: boolean; snapshot?: { text?: string } }
        out.push({ text: revised.deleted ? null : revised.snapshot?.text ?? String(fields.text), z: null, zref: null })
        continue
      }
      out.push({ text: String(fields.text), z: fields.z ?? null, zref: fields.zref ?? null })
    }
    return out
  }

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
        const rows = texts.all(session.id, session.last_seq - SCAN_EVENTS, SCAN_MESSAGES)
        // Sealed turns (sealed-turns.ts) are older than every row still in `events`, so they continue the newest-first scan.
        if (sealed && rows.length < SCAN_MESSAGES) rows.push(...sealedTexts(session.id, session.last_seq - SCAN_EVENTS, SCAN_MESSAGES - rows.length))
        for (const row of rows) {
          const text = unpackText(row.text, row.z, row.zref, load)?.slice(0, MAX_TEXT)
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
