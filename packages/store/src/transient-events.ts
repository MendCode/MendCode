import type { Database } from "bun:sqlite"
import type { SessionEvent } from "@mendcode/protocol"

/** Snapshot rows one session may have waiting to be deleted; a longer backlog is left on disk rather than held in memory. */
const MAX_WAITING_PER_SESSION = 256
/** Sessions with rows waiting; the oldest entry goes when more arrive. */
const MAX_WAITING_SESSIONS = 512

/**
 * `foreground.state` and `queue.changed` are snapshots: each says the whole state, and every reader of a stored history
 * keeps only the last one. When a session settles (its foreground state becomes `idle`) the earlier snapshots of that run
 * are superseded; the daemon's idle step deletes them later (`prune`), so a client that streamed the run and one that
 * replays it a moment later see the same events for as long as anyone compares them. The newest of each kind stays, and so
 * does everything of a run that compacted (the compaction view reads the state change that ended it) and every row another
 * session's transcript points at. Only rows written by this process are tracked: nothing is scanned, nothing existing converts.
 */
export function createTransientEvents(db: Database) {
  type Window = { foreground: number[]; queue: number[]; keep: boolean }
  const windows = new Map<string, Window>()
  const waiting = new Map<string, Array<{ type: "foreground.state" | "queue.changed"; seq: number }>>()
  const remove = db.query(`DELETE FROM events WHERE session_id = ?1 AND seq = ?2 AND type = ?3
    AND NOT EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.parent_id = ?1 AND p.parent_seq = ?2)`)
  const running = db.query<{ active_turn: string | null }, [string]>("SELECT active_turn FROM sessions WHERE id = ?")

  function settle(sessionId: string, window: Window) {
    if (!window.keep) {
      const list = waiting.get(sessionId) ?? []
      for (const [type, seqs] of [["foreground.state", window.foreground], ["queue.changed", window.queue]] as const) {
        for (const seq of seqs.slice(0, -1)) list.push({ type, seq })
      }
      if (list.length) {
        if (waiting.size >= MAX_WAITING_SESSIONS && !waiting.has(sessionId)) waiting.delete(waiting.keys().next().value!)
        waiting.set(sessionId, list.slice(-MAX_WAITING_PER_SESSION))
      }
    }
    window.foreground = window.foreground.slice(-1)
    window.queue = window.queue.slice(-1)
    window.keep = false
  }

  return {
    /** Called for each stored event, inside its transaction. */
    record(event: SessionEvent) {
      if (event.type !== "foreground.state" && event.type !== "queue.changed") return
      let window = windows.get(event.sessionId)
      if (!window) windows.set(event.sessionId, (window = { foreground: [], queue: [], keep: false }))
      if (event.type === "queue.changed") return void window.queue.push(event.seq)
      window.foreground.push(event.seq)
      if (event.state === "compacting") window.keep = true
      else if (event.state === "idle") settle(event.sessionId, window)
    },
    /**
     * Deletes the superseded snapshots of up to `limit` settled sessions that are not running a turn. `complete` is false when
     * the limit stopped the pass; a session with a turn in progress waits for the next call.
     */
    prune(limit = 20): { visited: number; removed: number; complete: boolean } {
      let visited = 0, removed = 0, more = false
      db.transaction(() => {
        for (const [sessionId, list] of [...waiting]) {
          if (visited >= limit) { more = true; break }
          if (running.get(sessionId)?.active_turn) continue
          visited++
          waiting.delete(sessionId)
          for (const row of list) removed += remove.run(sessionId, row.seq, row.type).changes
        }
      })()
      return { visited, removed, complete: !more }
    },
    pending: () => waiting.size,
    forget(sessionId: string) {
      windows.delete(sessionId)
      waiting.delete(sessionId)
    },
  }
}
export type TransientEvents = ReturnType<typeof createTransientEvents>
