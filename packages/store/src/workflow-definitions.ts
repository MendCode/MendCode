import type { Database } from "bun:sqlite"
import { WorkflowDefinition, WorkflowRevision } from "@mendcode/protocol"

/** Revisions are insert-only; the head moves in the same transaction. No run pruning touches them. */
export function createWorkflowDefinitionRecords(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_definitions (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS workflow_definitions_directory ON workflow_definitions(directory, updated_at);
  CREATE TABLE IF NOT EXISTS workflow_revisions (
    id TEXT PRIMARY KEY, definition_id TEXT NOT NULL REFERENCES workflow_definitions(id), revision INTEGER NOT NULL,
    payload TEXT NOT NULL, UNIQUE(definition_id, revision)
  ) WITHOUT ROWID;`)
  return {
    list(directory: string, limit: number): WorkflowDefinition[] {
      return db.query<{ payload: string }, [string, number]>("SELECT payload FROM workflow_definitions WHERE directory = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(directory, Math.max(1, Math.min(100, limit))).map((row) => WorkflowDefinition.parse(JSON.parse(row.payload)))
    },
    definition(id: string): WorkflowDefinition | undefined {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM workflow_definitions WHERE id = ?").get(id)
      return row ? WorkflowDefinition.parse(JSON.parse(row.payload)) : undefined
    },
    revision(id: string): WorkflowRevision | undefined {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM workflow_revisions WHERE id = ?").get(id)
      return row ? WorkflowRevision.parse(JSON.parse(row.payload)) : undefined
    },
    save(definition: WorkflowDefinition, revision: WorkflowRevision) {
      WorkflowDefinition.parse(definition)
      WorkflowRevision.parse(revision)
      if (definition.definitionId !== revision.definitionId || definition.currentRevisionId !== revision.revisionId || definition.currentRevision !== revision.revision) throw new RangeError("workflow revision/head mismatch")
      const payload = JSON.stringify(revision)
      if (Buffer.byteLength(payload) > 128 * 1024) throw new RangeError("workflow revision exceeds 128 KB")
      db.transaction(() => {
        const current = db.query<{ payload: string }, [string]>("SELECT payload FROM workflow_definitions WHERE id = ?").get(definition.definitionId)
        const head = current ? WorkflowDefinition.parse(JSON.parse(current.payload)) : undefined
        if ((head?.currentRevision ?? 0) + 1 !== revision.revision || head && head.directory !== definition.directory) throw new RangeError("workflow definition changed; reload before saving")
        db.query("INSERT INTO workflow_definitions(id, directory, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").run(definition.definitionId, definition.directory, JSON.stringify(definition), definition.updatedAt)
        db.query("INSERT INTO workflow_revisions(id, definition_id, revision, payload) VALUES (?, ?, ?, ?)").run(revision.revisionId, revision.definitionId, revision.revision, payload)
      })()
    },
  }
}
