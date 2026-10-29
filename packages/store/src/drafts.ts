import type { Database } from "bun:sqlite"
import type { BlobRef, SessionId } from "@mendcode/protocol"

export type Draft = { text: string; attachments: BlobRef[]; updatedAt: number }
/**
 * One unsent draft as the picker lists it: size and a one-line preview, never the whole text. `chars` and `preview` are of what was
 * typed: an attachment's token (`[Image #1]`) is neither, `attachments` (and `images` among them) says what came with the text.
 */
export type DraftSummary = { sessionId: SessionId; title: string; directory: string; chars: number; attachments: number; images: number; preview: string; updatedAt: number }
/** What a session's list row needs of its draft: the first line the user typed (empty when only attachments), the size, the kinds. */
export type DraftHead = { preview: string; chars: number; attachments: number; images: number; updatedAt: number }

const PREVIEW_CHARS = 160
/** The first line a list row shows; the terminal cuts it to its own width. */
const HEAD_CHARS = 80
/** How much of a draft's text a list row reads: its first line is always inside. */
const HEAD_WINDOW = 400

/**
 * The unsent prompt of each session, so closing a terminal (or losing it) keeps what was typed. Last write wins
 * between terminals; an empty draft (no text but whitespace, no attachment) is removed. Blobs a draft attaches are kept by blob cleaning (see `draftBlobsSql`).
 */
export function createDrafts(input: { db: Database; now: () => number }) {
  const { db, now } = input
  // Whitespace alone was kept as a draft by earlier versions: it holds nothing and would list its session as a draft.
  db.query("DELETE FROM drafts WHERE trim(text, ' ' || char(9, 10, 13)) = '' AND attachments_json = '[]'").run()
  return {
    /** Newest first. `directory` limits it to one project; `excludeSessionId` leaves out the session being typed in. */
    list(input: { directory?: string; excludeSessionId?: SessionId; limit?: number } = {}): DraftSummary[] {
      const rows = db
        .query<{ session_id: string; title: string; directory: string; text: string; attachments_json: string; updated_at: number }, [string, string, number]>(
          "SELECT d.session_id, s.title, s.directory, d.text, d.attachments_json, d.updated_at FROM drafts d JOIN sessions s ON s.id = d.session_id WHERE (?1 = '' OR s.directory = ?1) AND d.session_id != ?2 AND s.archived_at IS NULL AND (trim(d.text, ' ' || char(9, 10, 13)) != '' OR d.attachments_json != '[]') ORDER BY d.updated_at DESC, d.session_id LIMIT ?3",
        )
        .all(input.directory ?? "", input.excludeSessionId ?? "", Math.max(1, Math.min(input.limit ?? 20, 100)))
      return rows.map((row) => {
        const attachments = parseAttachments(row.attachments_json)
        return {
          sessionId: row.session_id as SessionId,
          title: row.title,
          directory: row.directory,
          chars: typedChars(row.text, attachments),
          attachments: attachments.length,
          images: imageCount(attachments),
          preview: withoutTokens(row.text, attachments).replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
          updatedAt: row.updated_at,
        }
      })
    },
    /**
     * The drafts of these sessions for a session list, in one query: only the start of each text is read. A session without a draft is not in the map.
     * `preview` is the first line with something on it, whitespace collapsed, so a draft that begins with blank lines still reads.
     */
    heads(sessionIds: readonly SessionId[]): Map<SessionId, DraftHead> {
      const heads = new Map<SessionId, DraftHead>()
      if (sessionIds.length === 0) return heads
      const rows = db
        .query<{ session_id: string; head: string; length: number; attachments_json: string; updated_at: number }, [string]>(
          `SELECT session_id, substr(text, 1, ${HEAD_WINDOW}) AS head, length(text) AS length, attachments_json, updated_at FROM drafts WHERE session_id IN (SELECT value FROM json_each(?)) AND (trim(text, ' ' || char(9, 10, 13)) != '' OR attachments_json != '[]')`,
        )
        .all(JSON.stringify(sessionIds))
      for (const row of rows) {
        const attachments = parseAttachments(row.attachments_json)
        const line = withoutTokens(row.head, attachments).split(/\r?\n/).map((part) => part.replace(/\s+/g, " ").trim()).find((part) => part !== "") ?? ""
        heads.set(row.session_id as SessionId, { preview: line.slice(0, HEAD_CHARS), chars: row.length <= HEAD_WINDOW ? typedChars(row.head, attachments) : Math.max(0, row.length - labelChars(attachments)), attachments: attachments.length, images: imageCount(attachments), updatedAt: row.updated_at })
      }
      return heads
    },
    /** Deletes drafts last written before `cutoff` (epoch ms); returns how many went. */
    prune(cutoff: number): number {
      return db.query("DELETE FROM drafts WHERE updated_at < ?").run(cutoff).changes
    },
    get(sessionId: SessionId): Draft | undefined {
      const row = db.query<{ text: string; attachments_json: string; updated_at: number }, [string]>("SELECT text, attachments_json, updated_at FROM drafts WHERE session_id = ?").get(sessionId)
      if (!row) return undefined
      return { text: row.text, attachments: parseAttachments(row.attachments_json), updatedAt: row.updated_at }
    },
    /** False when the session does not exist. No text but whitespace and no attachment clears the draft: an empty prompt is not a draft. */
    set(sessionId: SessionId, text: string, attachments: BlobRef[] = []): boolean {
      if (!db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) return false
      if (text.trim() === "" && attachments.length === 0) {
        db.query("DELETE FROM drafts WHERE session_id = ?").run(sessionId)
        return true
      }
      db.query("INSERT INTO drafts (session_id, text, attachments_json, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(session_id) DO UPDATE SET text = ?2, attachments_json = ?3, updated_at = ?4").run(
        sessionId,
        text,
        JSON.stringify(attachments),
        now(),
      )
      return true
    },
  }
}

/** Blob hashes that drafts still point at, as a subquery for the orphan sweep. */
export const draftBlobsSql = "SELECT json_extract(value, '$.sha256') FROM drafts, json_each(drafts.attachments_json)"

const imageCount = (attachments: readonly BlobRef[]) => attachments.filter((item) => item.mime.startsWith("image/")).length
const labelChars = (attachments: readonly BlobRef[]) => attachments.reduce((sum, item) => sum + (item.label?.length ?? 0), 0)
/** The text without the tokens that stand for its attachments (one occurrence each): previews show what was typed, the attachments are counted beside it. */
const withoutTokens = (text: string, attachments: readonly BlobRef[]) => attachments.reduce((rest, item) => (item.label ? rest.replace(item.label, "") : rest), text)
/** What the user typed: the text without the tokens that stand for its attachments. */
const typedChars = (text: string, attachments: readonly BlobRef[]) => (withoutTokens(text, attachments).trim() === "" ? 0 : Math.max(0, text.length - labelChars(attachments)))

function parseAttachments(json: string): BlobRef[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as BlobRef[]) : []
  } catch {
    return []
  }
}
