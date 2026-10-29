import type { Database } from "bun:sqlite"

/** One journal row: an opaque JSON payload under a key the script engine chose (`call:<key>`, `spec:<id>`, `memo:<key>`, ...). */
export type WorkflowJournalRow = { key: string; payload: string }

/** Upper bound of one journal payload. */
export const MAX_JOURNAL_PAYLOAD_BYTES = 96 * 1024
/** Upper bound of one run's whole journal (200 agent calls with their results stay well inside it). */
export const MAX_JOURNAL_RUN_BYTES = 24 * 1024 * 1024

/**
 * The event-sourced journal of script workflows: append-or-replace rows per run, kept outside the run row (which stays
 * under 160 KB). Rows are written before the run row that refers to them, so a crash never leaves a task whose spec or
 * result is missing. Deleting a run deletes its journal (`removeOrphans` after pruning).
 */
export function createWorkflowJournal(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_journal (
    workflow_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (workflow_id, key)
  ) WITHOUT ROWID;`)
  return {
    get(workflowId: string, key: string): string | undefined {
      return db.query<{ payload: string }, [string, string]>("SELECT payload FROM workflow_journal WHERE workflow_id = ? AND key = ?").get(workflowId, key)?.payload
    },
    set(workflowId: string, key: string, payload: string) {
      const bytes = Buffer.byteLength(payload)
      if (bytes > MAX_JOURNAL_PAYLOAD_BYTES) throw new RangeError(`[STORE]: journal entry ${key} is ${bytes} bytes; the limit is ${MAX_JOURNAL_PAYLOAD_BYTES}`)
      const total = db.query<{ total: number | null }, [string, string]>("SELECT SUM(bytes) AS total FROM workflow_journal WHERE workflow_id = ? AND key <> ?").get(workflowId, key)?.total ?? 0
      if (total + bytes > MAX_JOURNAL_RUN_BYTES) throw new RangeError(`[STORE]: the journal of ${workflowId} exceeds ${MAX_JOURNAL_RUN_BYTES} bytes`)
      db.query("INSERT INTO workflow_journal(workflow_id, key, payload, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id, key) DO UPDATE SET payload = excluded.payload, bytes = excluded.bytes").run(workflowId, key, payload, bytes)
    },
    delete(workflowId: string, key: string) {
      db.query("DELETE FROM workflow_journal WHERE workflow_id = ? AND key = ?").run(workflowId, key)
    },
    /** Every row of one run whose key starts with `prefix` (all rows when empty), in key order. */
    list(workflowId: string, prefix = ""): WorkflowJournalRow[] {
      return db.query<WorkflowJournalRow, [string, string, string]>("SELECT key, payload FROM workflow_journal WHERE workflow_id = ? AND substr(key, 1, length(?)) = ? ORDER BY key").all(workflowId, prefix, prefix)
    },
    removeRun(workflowId: string) {
      db.query("DELETE FROM workflow_journal WHERE workflow_id = ?").run(workflowId)
    },
    /** Journals whose run no longer exists (pruned finished runs). */
    removeOrphans() {
      db.exec("DELETE FROM workflow_journal WHERE workflow_id NOT IN (SELECT id FROM workflows)")
    },
  }
}
