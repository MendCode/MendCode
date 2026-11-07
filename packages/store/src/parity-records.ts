import type { Database } from "bun:sqlite"
import { TaskRecord, ExtractionJob } from "@mendcode/protocol"

const FAILED_KEPT = 20
/** Rows of the review record kept (one per review job or skip); older ones are pruned on every insert. */
export const REVIEW_LOG_KEPT = 300

/** What one memory review did, or why it did not run. */
export type MemoryReviewRow = {
  at: number
  sessionId: string
  directory: string
  /** What asked for it: `turns`, `idle`, `compaction`, `retry`. */
  trigger: string
  /** Substantive user turns the digest covered. */
  turns: number
  /** Extractor calls made (attempts). */
  calls: number
  proposed: number
  outcome: "ran" | "failed" | "skipped"
  reason: string
}

/** The daemon is the only writer. Claims and admission never cross an await. */
export function createParityRecords(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS child_tasks (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS memory_extractions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id, turn_id)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS memory_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL, trigger TEXT NOT NULL,
    turns INTEGER NOT NULL, calls INTEGER NOT NULL, proposed INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS detached_sessions (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  return {
    detached: {
      has(id: string) { return db.query("SELECT 1 FROM detached_sessions WHERE id = ?").get(id) !== null },
      set(id: string) { db.query("INSERT OR IGNORE INTO detached_sessions VALUES (?)").run(id) },
    },
    tasks: {
      list(): TaskRecord[] {
        return db.query<{ payload: string }, []>("SELECT payload FROM child_tasks").all().map((row) => TaskRecord.parse(JSON.parse(row.payload)))
      },
      put(task: TaskRecord) {
        db.query("INSERT OR REPLACE INTO child_tasks VALUES (?, ?)").run(task.taskId, JSON.stringify(TaskRecord.parse(task)))
      },
    },
    /** The bounded record of memory reviews: yield per call (`proposed` over `calls`) and the reasons for skips. */
    reviews: {
      add(row: MemoryReviewRow) {
        db.query("INSERT INTO memory_reviews (at, session_id, directory, trigger, turns, calls, proposed, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.at, row.sessionId, row.directory, row.trigger, row.turns, row.calls, row.proposed, row.outcome, row.reason.slice(0, 200))
        db.query("DELETE FROM memory_reviews WHERE id <= (SELECT MAX(id) FROM memory_reviews) - ?").run(REVIEW_LOG_KEPT)
      },
      list(limit = REVIEW_LOG_KEPT): Array<MemoryReviewRow & { id: number }> {
        return db.query<MemoryReviewRow & { id: number }, [number]>("SELECT id, at, session_id AS sessionId, directory, trigger, turns, calls, proposed, outcome, reason FROM memory_reviews ORDER BY id DESC LIMIT ?").all(limit)
      },
      /** Extractor calls made at or after `since`. */
      callsSince(since: number): number {
        return db.query<{ calls: number | null }, [number]>("SELECT SUM(calls) AS calls FROM memory_reviews WHERE at >= ?").get(since)?.calls ?? 0
      },
    },
    extraction: {
      remove(jobId: string) { db.query("DELETE FROM memory_extractions WHERE id = ?").run(jobId) },
      list(): ExtractionJob[] {
        return db.query<{ payload: string }, []>("SELECT payload FROM memory_extractions ORDER BY rowid").all().map((row) => ExtractionJob.parse(JSON.parse(row.payload)))
      },
      put(job: ExtractionJob) {
        db.query("INSERT OR REPLACE INTO memory_extractions VALUES (?, ?, ?, ?)").run(job.jobId, job.sessionId, job.turnId, JSON.stringify(ExtractionJob.parse(job)))
      },
      /**
       * Writes the job's proposals and removes the job in one transaction: a finished job leaves no row (a row per turn grew every
       * session). A turn is observed once, from its live `turn.completed` event, so nothing is extracted twice after a restart.
       */
      settle(job: ExtractionJob, commit: () => number): number {
        return db.transaction(() => {
          const proposed = commit()
          db.query("DELETE FROM memory_extractions WHERE id = ?").run(job.jobId)
          return proposed
        })()
      },
      /** Only queued and running jobs (to resume them) and the newest FAILED_KEPT failed or skipped ones (to retry them) stay. */
      prune() {
        const terminal = this.list().filter((job) => !["queued", "running"].includes(job.state))
        for (const job of terminal.slice(0, Math.max(0, terminal.length - FAILED_KEPT))) db.query("DELETE FROM memory_extractions WHERE id = ?").run(job.jobId)
      },
    },
  }
}
