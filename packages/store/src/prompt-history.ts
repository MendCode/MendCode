import type { Database } from "bun:sqlite"

/** What the user entered: a message, a slash command, a shell line, or text left unsent in the editor. */
export type PromptKind = "sent" | "command" | "shell" | "draft"
export type PromptEntry = { id: number; kind: PromptKind; text: string; at: number }

/** Entries kept per project; the oldest go first. */
export const PROMPT_HISTORY_LIMIT = 2000
export const PROMPT_HISTORY_MAX_CHARS = 16_000
/** Room kept for the truncation note, so a capped entry never exceeds PROMPT_HISTORY_MAX_CHARS. */
const PROMPT_HISTORY_NOTE_CHARS = 80
/** A line made only of secret markers says nothing a user could recall. */
const MARKERS_ONLY = /^(?:\s*‹secret:\d{1,6}›)+\s*$/

/**
 * What prompt recall keeps of a prompt: itself up to PROMPT_HISTORY_MAX_CHARS, else its head and a closing note with the
 * original length (a capped reference: the full text stays in the session's own events, never copied a second time).
 */
export function cappedPromptHistoryEntry(text: string): string {
  if (text.length <= PROMPT_HISTORY_MAX_CHARS) return text
  let kept = PROMPT_HISTORY_MAX_CHARS - PROMPT_HISTORY_NOTE_CHARS
  // Never cut a surrogate pair in half.
  const last = text.charCodeAt(kept - 1)
  if (last >= 0xd800 && last <= 0xdbff) kept--
  return `${text.slice(0, kept)}\n… [truncated: ${text.length} chars, first ${kept} kept]`
}

const asKind = (value: string): PromptKind => (value === "command" || value === "shell" || value === "draft" ? value : "sent")

/**
 * One chronological list per project (directory), shared by its sessions: sent messages, slash commands, shell lines and
 * discarded drafts. A text is never listed twice: entering it again moves it to the top, and a draft equal to an entry
 * that is already there only moves that entry up. Secrets arrive already as markers (the daemon masks before calling).
 */
export function createPromptHistory(input: { db: Database }) {
  const { db } = input
  const directoryOf = db.query<{ directory: string }, [string]>("SELECT directory FROM sessions WHERE id = ?")
  const sameText = db.query<{ id: number; kind: string }, [string, string]>("SELECT id, kind FROM prompt_history WHERE directory = ? AND text = ? ORDER BY id DESC LIMIT 1")
  const dropSame = db.query("DELETE FROM prompt_history WHERE directory = ? AND text = ?")
  const insert = db.query("INSERT INTO prompt_history(directory, at, text, kind) VALUES (?, ?, ?, ?)")
  const prune = db.query(
    "DELETE FROM prompt_history WHERE directory = ?1 AND id <= (SELECT id FROM prompt_history WHERE directory = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
  )
  return {
    /** The kind that ended up listed, or undefined when nothing was stored (blank, only markers, unknown session). */
    record(sessionId: string, text: string, at: number, kind: PromptKind = "sent"): PromptKind | undefined {
      if (!text.trim() || MARKERS_ONLY.test(text)) return undefined
      const directory = directoryOf.get(sessionId)?.directory
      if (directory === undefined) return undefined
      const capped = cappedPromptHistoryEntry(text)
      return db.transaction((): PromptKind => {
        const existing = sameText.get(directory, capped)
        // An unsent draft never demotes a text that was entered for real.
        const keep = existing && kind === "draft" ? asKind(existing.kind) : kind
        dropSame.run(directory, capped)
        insert.run(directory, at, capped, keep)
        prune.run(directory, PROMPT_HISTORY_LIMIT)
        return keep
      })()
    },
    /** Newest first. */
    list(directory: string, limit = 100): PromptEntry[] {
      return db
        .query<{ id: number; kind: string; text: string; at: number }, [string, number]>("SELECT id, kind, text, at FROM prompt_history WHERE directory = ? ORDER BY id DESC LIMIT ?")
        .all(directory, Math.max(1, Math.min(limit, PROMPT_HISTORY_LIMIT)))
        .map((row) => ({ id: row.id, kind: asKind(row.kind), text: row.text, at: row.at }))
    },
    /** Deletes one entry of a project; false when it is not there. */
    remove(directory: string, id: number): boolean {
      return db.query("DELETE FROM prompt_history WHERE directory = ? AND id = ?").run(directory, id).changes > 0
    },
    /** Deletes every draft entry of a project; returns how many went. */
    clearDrafts(directory: string): number {
      return db.query("DELETE FROM prompt_history WHERE directory = ? AND kind = 'draft'").run(directory).changes
    },
  }
}
