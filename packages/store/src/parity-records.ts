import type { Database } from "bun:sqlite"
import { TaskRecord, ExtractionJob } from "@mendcode/protocol"

const FAILED_KEPT = 20

/** The daemon is the only writer. Claims and admission never cross an await. */
export function createParityRecords(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS child_tasks (
    id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, payload TEXT NOT NULL
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS memory_extractions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id, turn_id)
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
    extraction: {
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
