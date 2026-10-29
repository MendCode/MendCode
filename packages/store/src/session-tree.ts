import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

export const LABEL_MAX_CHARS = 80
const FAMILY_LIMIT = 400

/** One session of a fork family. `parentId` is set when the session was forked from another one that still exists. */
export type TreeSession = { sessionId: SessionId; parentId?: SessionId; atItemId?: string; atPreview?: string; title: string; directory: string; createdAt: number; updatedAt: number; archived: boolean }
export type Label = { itemId: string; label: string; updatedAt: number }

/**
 * Fork lineage, message labels and the cached recap. A fork records its parent and the message it branched at, so the
 * family of a session (every ancestor and every branch) can be drawn as a tree. Labels and recaps belong to a session
 * and go with it when it is deleted; a deleted parent leaves its branches as roots.
 */
export function createSessionTree(input: { db: Database; now: () => number }) {
  const { db, now } = input
  const parentOf = (sessionId: string) => db.query<{ parent_id: string }, [string]>("SELECT f.parent_id FROM session_forks f JOIN sessions p ON p.id = f.parent_id WHERE f.session_id = ?").get(sessionId)?.parent_id
  return {
    /** Records that `sessionId` branched from `parentId`, at a message or (without `atItemId`) at the end. */
    recordFork(fork: { sessionId: SessionId; parentId: SessionId; atItemId?: string; atPreview?: string }) {
      db.query("INSERT OR REPLACE INTO session_forks(session_id, parent_id, at_item_id, at_preview, created_at) VALUES (?, ?, ?, ?, ?)").run(fork.sessionId, fork.parentId, fork.atItemId ?? null, (fork.atPreview ?? "").slice(0, 120), now())
    },
    /** Where `sessionId` was forked from, when that parent still exists. */
    forkOf(sessionId: SessionId): { parentId: SessionId; createdAt: number; atItemId?: string } | undefined {
      const row = db.query<{ parent_id: string; created_at: number; at_item_id: string | null }, [string]>("SELECT f.parent_id, f.created_at, f.at_item_id FROM session_forks f JOIN sessions p ON p.id = f.parent_id WHERE f.session_id = ?").get(sessionId)
      return row ? { parentId: row.parent_id as SessionId, createdAt: row.created_at, ...(row.at_item_id ? { atItemId: row.at_item_id } : {}) } : undefined
    },
    /** Every session of the family `sessionId` belongs to, depth first from the root, oldest branch first. Bounded. */
    family(sessionId: SessionId): TreeSession[] {
      let root: string = sessionId
      for (let hops = 0; hops < FAMILY_LIMIT; hops++) {
        const parent = parentOf(root)
        if (!parent) break
        root = parent
      }
      const out: TreeSession[] = []
      const seen = new Set<string>()
      const visit = (id: string, parent?: string) => {
        if (seen.has(id) || out.length >= FAMILY_LIMIT) return
        seen.add(id)
        const row = db
          .query<{ title: string; directory: string; created_at: number; updated_at: number; archived_at: number | null; at_item_id: string | null; at_preview: string | null }, [string]>(
            "SELECT s.title, s.directory, s.created_at, s.updated_at, s.archived_at, f.at_item_id, f.at_preview FROM sessions s LEFT JOIN session_forks f ON f.session_id = s.id WHERE s.id = ?",
          )
          .get(id)
        if (!row) return
        out.push({
          sessionId: id as SessionId,
          ...(parent ? { parentId: parent as SessionId } : {}),
          ...(row.at_item_id ? { atItemId: row.at_item_id } : {}),
          ...(row.at_preview ? { atPreview: row.at_preview } : {}),
          title: row.title,
          directory: row.directory,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          archived: row.archived_at !== null,
        })
        for (const child of db.query<{ session_id: string }, [string]>("SELECT f.session_id FROM session_forks f JOIN sessions s ON s.id = f.session_id WHERE f.parent_id = ? ORDER BY f.created_at, f.session_id").all(id)) visit(child.session_id, id)
      }
      visit(root)
      return out
    },
    /** Sets a label on a message (trimmed, one line, bounded); an empty label removes it. */
    setLabel(sessionId: SessionId, itemId: string, label: string) {
      const text = label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX_CHARS)
      if (!text) db.query("DELETE FROM session_labels WHERE session_id = ? AND item_id = ?").run(sessionId, itemId)
      else db.query("INSERT INTO session_labels(session_id, item_id, label, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, item_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at").run(sessionId, itemId, text, now())
      return text || undefined
    },
    labels(sessionId: SessionId): Label[] {
      return db.query<{ item_id: string; label: string; updated_at: number }, [string]>("SELECT item_id, label, updated_at FROM session_labels WHERE session_id = ? ORDER BY updated_at, item_id").all(sessionId).map((row) => ({ itemId: row.item_id, label: row.label, updatedAt: row.updated_at }))
    },
    /** A branch keeps the labels of the messages it carried over. */
    copyLabels(from: SessionId, to: SessionId, itemIds: ReadonlySet<string>) {
      for (const label of this.labels(from)) if (itemIds.has(label.itemId)) db.query("INSERT OR IGNORE INTO session_labels(session_id, item_id, label, updated_at) VALUES (?, ?, ?, ?)").run(to, label.itemId, label.label, label.updatedAt)
    },
    /** The cached recap, only while the session has not grown since it was written. */
    recap(sessionId: SessionId, sourceSeq: number): { text: string; updatedAt: number } | undefined {
      const row = db.query<{ text: string; updated_at: number }, [string, number]>("SELECT text, updated_at FROM session_recaps WHERE session_id = ? AND source_seq = ?").get(sessionId, sourceSeq)
      return row ? { text: row.text, updatedAt: row.updated_at } : undefined
    },
    putRecap(sessionId: SessionId, sourceSeq: number, text: string) {
      db.query("INSERT INTO session_recaps(session_id, source_seq, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET source_seq = excluded.source_seq, text = excluded.text, updated_at = excluded.updated_at").run(sessionId, sourceSeq, text, now())
    },
  }
}
