import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import type { MemoryEntry, MemoryId } from "@mendcode/protocol"

/** Includes the placement and metadata: moving, pinning or reclassifying invalidates a shared revision too. */
export function sharedMemoryRevision(entry: MemoryEntry) {
  return createHash("sha256").update(JSON.stringify([entry.memoryId, entry.scope, entry.directory ?? "", entry.profile ?? "", entry.sessionId ?? "", entry.text, entry.category, entry.status, entry.source, entry.pinned === true, entry.createdAt, entry.updatedAt, ...(entry.details ? [entry.details] : [])])).digest("hex")
}

export function createMemorySharingRecords(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS memory_sharing_reviews (
    proposal_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    evidence TEXT NOT NULL UNIQUE,
    revision TEXT NOT NULL
  ) WITHOUT ROWID`)
  return {
    revision(id: string) {
      return db.query<{ revision: string }, [string]>("SELECT revision FROM memory_sharing_reviews WHERE proposal_id = ?").get(id)?.revision
    },
    propose(evidence: string, revision: string, create: () => MemoryId): MemoryId {
      return db.transaction(() => {
        const existing = db.query<{ proposal_id: MemoryId }, [string]>("SELECT r.proposal_id FROM memory_sharing_reviews r JOIN memories m ON m.id = r.proposal_id WHERE r.evidence = ? AND m.status = 'pending'").get(evidence)
        if (existing) return existing.proposal_id
        const id = create()
        db.query("INSERT INTO memory_sharing_reviews VALUES (?, ?, ?)").run(id, evidence, revision)
        return id
      })()
    },
    workspaces() {
      return db.query<{ root: string; sessions: number; pending: number; saved: number; archived: number; user: number; agent: number; firstActiveAt: number; lastActiveAt: number }, []>(`SELECT directory AS root,
        SUM(session) AS sessions, SUM(pending) AS pending, SUM(saved) AS saved, SUM(archived) AS archived,
        SUM(user) AS user, SUM(agent) AS agent, MIN(first_at) AS firstActiveAt, MAX(last_at) AS lastActiveAt
        FROM (
          SELECT directory, 1 AS session, 0 AS pending, 0 AS saved, 0 AS archived, 0 AS user, 0 AS agent, created_at AS first_at, MAX(created_at, updated_at) AS last_at FROM sessions
          UNION ALL
          SELECT directory, 0, status = 'pending', status = 'saved', status = 'archived', source = 'user', source = 'agent', created_at, updated_at FROM memories WHERE scope <> 'user'
        ) WHERE directory IS NOT NULL AND directory <> '' GROUP BY directory ORDER BY lastActiveAt DESC, directory`).all()
    },
  }
}
