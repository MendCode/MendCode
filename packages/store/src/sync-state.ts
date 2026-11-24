import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

/**
 * Session sync's tables (docs/sync.md). They are created the first time sync is turned on, never by the store itself, so a
 * machine without sync has none of them and pays nothing per session or per turn.
 *
 * - `sync_changes`: a change feed, one row per session or memory with a rising `cseq` (deleted rows stay as tombstones).
 *   Filled by triggers: memory triggers on every syncing machine, session triggers only on a hub.
 * - `sync_sessions` (device): what this machine knows of each synced session: its role, the hub's last seq it has, its lease.
 * - `sync_leases` (hub): which device writes a session, with a rising epoch that fences a device whose lease ran out.
 * - `sync_meta`: cursors and the last synced value of things merged three ways (session metadata, settings).
 */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
const nextSeq = (kind: string) => `(SELECT coalesce(max(cseq), 0) + 1 FROM sync_changes WHERE kind = '${kind}')`
const change = (kind: string, id: string, deleted: 0 | 1) => `INSERT OR REPLACE INTO sync_changes(kind, id, cseq, deleted, at) VALUES ('${kind}', ${id}, ${nextSeq(kind)}, ${deleted}, ${NOW_MS});`

const TABLES = `
CREATE TABLE IF NOT EXISTS sync_changes (kind TEXT NOT NULL, id TEXT NOT NULL, cseq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (kind, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_changes_seq ON sync_changes(kind, cseq);
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_sessions (session_id TEXT PRIMARY KEY, role TEXT NOT NULL, remote_seq INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'ok', note TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '', active_at INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_leases (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, epoch INTEGER NOT NULL, until INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS sync_memory_insert AFTER INSERT ON memories WHEN new.scope != 'session' BEGIN ${change("memory", "new.id", 0)} END;
CREATE TRIGGER IF NOT EXISTS sync_memory_update AFTER UPDATE ON memories WHEN new.scope != 'session' BEGIN ${change("memory", "new.id", 0)} END;
CREATE TRIGGER IF NOT EXISTS sync_memory_delete AFTER DELETE ON memories WHEN old.scope != 'session' BEGIN ${change("memory", "old.id", 1)} END;
`
const HUB_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS sync_session_insert AFTER INSERT ON sessions WHEN new.parent_id IS NULL BEGIN ${change("session", "new.id", 0)} END;
CREATE TRIGGER IF NOT EXISTS sync_session_update AFTER UPDATE OF last_seq, title, archived_at, pinned_at, directory ON sessions WHEN new.parent_id IS NULL BEGIN ${change("session", "new.id", 0)} END;
CREATE TRIGGER IF NOT EXISTS sync_session_delete AFTER DELETE ON sessions WHEN old.parent_id IS NULL BEGIN ${change("session", "old.id", 1)} END;
`
const DROP = ["sync_session_insert", "sync_session_update", "sync_session_delete", "sync_memory_insert", "sync_memory_update", "sync_memory_delete"]

export type SyncRole = "mirror" | "owned"
export type SyncSessionRow = { sessionId: SessionId; role: SyncRole; remoteSeq: number; epoch: number; leaseUntil: number; state: "ok" | "diverged" | "unsyncable"; note: string; meta: string; activeAt: number }
export type SyncLease = { sessionId: SessionId; holder: string; epoch: number; until: number }
export type SyncChange = { id: string; cseq: number; deleted: boolean; at: number }
export type MemoryRecord = {
  id: string; scope: string; directory: string | null; text: string; category: string; status: string; source: string; created_at: number; updated_at: number
  kind: string; target_id: string | null; reason: string; profile: string; session_id: string | null; pinned: number; model_data: string | null
}

type SessionRowDb = { session_id: string; role: string; remote_seq: number; epoch: number; lease_until: number; state: string; note: string; meta: string; active_at: number }
const toSession = (row: SessionRowDb): SyncSessionRow => ({ sessionId: row.session_id as SessionId, role: row.role === "owned" ? "owned" : "mirror", remoteSeq: row.remote_seq, epoch: row.epoch, leaseUntil: row.lease_until, state: row.state === "diverged" || row.state === "unsyncable" ? row.state : "ok", note: row.note, meta: row.meta, activeAt: row.active_at })

export function createSyncState(db: Database, now: () => number) {
  db.run(TABLES)
  return {
    /** Hub role: session triggers, and every existing root session enters the feed once. */
    enableHub() {
      db.transaction(() => {
        db.run(HUB_TRIGGERS)
        if (!db.query("SELECT 1 FROM sync_meta WHERE key = 'hub-seeded'").get()) {
          const ids = db.query<{ id: string }, []>("SELECT id FROM sessions WHERE parent_id IS NULL ORDER BY updated_at, id").all()
          const insert = db.query("INSERT OR IGNORE INTO sync_changes(kind, id, cseq, deleted, at) VALUES ('session', ?, ?, 0, ?)")
          let cseq = db.query<{ n: number }, []>("SELECT coalesce(max(cseq), 0) AS n FROM sync_changes WHERE kind = 'session'").get()!.n
          for (const { id } of ids) insert.run(id, ++cseq, now())
          db.query("INSERT INTO sync_meta(key, value) VALUES ('hub-seeded', '1')").run()
        }
      })()
    },
    /** Removes every trigger and table of sync: the machine goes back to having none. */
    dropAll() {
      db.transaction(() => {
        for (const name of DROP) db.run(`DROP TRIGGER IF EXISTS ${name}`)
        for (const table of ["sync_changes", "sync_meta", "sync_sessions", "sync_leases"]) db.run(`DROP TABLE IF EXISTS ${table}`)
      })()
    },
    changes(kind: "session" | "memory", after: number, limit: number): SyncChange[] {
      return db.query<{ id: string; cseq: number; deleted: number; at: number }, [string, number, number]>("SELECT id, cseq, deleted, at FROM sync_changes WHERE kind = ? AND cseq > ? ORDER BY cseq LIMIT ?").all(kind, after, limit).map((row) => ({ id: row.id, cseq: row.cseq, deleted: row.deleted === 1, at: row.at }))
    },
    /** A device that applied a row from the hub drops its own change record of it, so it is not sent back. */
    forgetChange(kind: "memory", id: string) {
      db.query("DELETE FROM sync_changes WHERE kind = ? AND id = ?").run(kind, id)
    },
    meta: {
      get: (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM sync_meta WHERE key = ?").get(key)?.value,
      set: (key: string, value: string) => void db.query("INSERT OR REPLACE INTO sync_meta(key, value) VALUES (?, ?)").run(key, value),
      delete: (key: string) => void db.query("DELETE FROM sync_meta WHERE key = ?").run(key),
    },
    sessions: {
      get(sessionId: string) {
        const row = db.query<SessionRowDb, [string]>("SELECT * FROM sync_sessions WHERE session_id = ?").get(sessionId)
        return row ? toSession(row) : undefined
      },
      list(): SyncSessionRow[] {
        return db.query<SessionRowDb, []>("SELECT * FROM sync_sessions ORDER BY session_id").all().map(toSession)
      },
      owned(): SyncSessionRow[] {
        return db.query<SessionRowDb, []>("SELECT * FROM sync_sessions WHERE role = 'owned' ORDER BY session_id").all().map(toSession)
      },
      put(row: SyncSessionRow) {
        db.query("INSERT OR REPLACE INTO sync_sessions(session_id, role, remote_seq, epoch, lease_until, state, note, meta, active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.sessionId, row.role, row.remoteSeq, row.epoch, row.leaseUntil, row.state, row.note, row.meta, row.activeAt)
      },
      delete: (sessionId: string) => void db.query("DELETE FROM sync_sessions WHERE session_id = ?").run(sessionId),
    },
    leases: {
      get(sessionId: string): SyncLease | undefined {
        const row = db.query<{ session_id: string; holder: string; epoch: number; until: number }, [string]>("SELECT * FROM sync_leases WHERE session_id = ?").get(sessionId)
        return row ? { sessionId: row.session_id as SessionId, holder: row.holder, epoch: row.epoch, until: row.until } : undefined
      },
      list(): SyncLease[] {
        return db.query<{ session_id: string; holder: string; epoch: number; until: number }, []>("SELECT * FROM sync_leases").all().map((row) => ({ sessionId: row.session_id as SessionId, holder: row.holder, epoch: row.epoch, until: row.until }))
      },
      put: (lease: SyncLease) => void db.query("INSERT OR REPLACE INTO sync_leases(session_id, holder, epoch, until) VALUES (?, ?, ?, ?)").run(lease.sessionId, lease.holder, lease.epoch, lease.until),
      delete: (sessionId: string) => void db.query("DELETE FROM sync_leases WHERE session_id = ?").run(sessionId),
    },
    memories: {
      get: (id: string) => db.query<MemoryRecord, [string]>("SELECT id, scope, directory, text, category, status, source, created_at, updated_at, kind, target_id, reason, profile, session_id, pinned, model_data FROM memories WHERE id = ?").get(id) ?? undefined,
      /** Writes a row as the other machine has it (its own `updated_at`), with its search entry, in one step. */
      put(row: MemoryRecord) {
        db.transaction(() => {
          db.query("INSERT OR REPLACE INTO memories(id, scope, directory, text, category, status, source, created_at, updated_at, kind, target_id, reason, profile, session_id, pinned, model_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(row.id, row.scope, row.directory, row.text, row.category, row.status, row.source, row.created_at, row.updated_at, row.kind, row.target_id, row.reason, row.profile, row.session_id, row.pinned, row.model_data)
          db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(row.id)
          db.query("INSERT INTO memories_fts(memory_id, text, category) VALUES (?, ?, ?)").run(row.id, row.text, row.category)
        })()
      },
      delete(id: string) {
        db.transaction(() => {
          db.query("DELETE FROM memory_links WHERE from_id = ? OR to_id = ?").run(id, id)
          db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(id)
          db.query("DELETE FROM memories WHERE id = ?").run(id)
        })()
      },
    },
    /** Size and type of a blob a stored session references; undefined for any other hash. */
    blobInfo(sha256: string) {
      return db.query<{ bytes: number; mime: string }, [string]>("SELECT b.bytes, b.mime FROM blobs b WHERE b.sha256 = ? AND EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256 = b.sha256)").get(sha256) ?? undefined
    },
    /** Root sessions of this machine with their stored end (a device's sessions it may hand to the hub). */
    sessionHead(sessionId: string) {
      return db.query<{ last_seq: number; active_turn: string | null; parent_id: string | null; title: string; directory: string; created_at: number; updated_at: number; archived_at: number | null; pinned_at: number | null }, [string]>("SELECT last_seq, active_turn, parent_id, title, directory, created_at, updated_at, archived_at, pinned_at FROM sessions WHERE id = ?").get(sessionId) ?? undefined
    },
    /** Every user and project memory enters this machine's change feed once, so what existed before sync turned on travels too. */
    seedMemories() {
      db.transaction(() => {
        if (db.query("SELECT 1 FROM sync_meta WHERE key = 'memory-seeded'").get()) return
        let cseq = db.query<{ n: number }, []>("SELECT coalesce(max(cseq), 0) AS n FROM sync_changes WHERE kind = 'memory'").get()!.n
        const insert = db.query("INSERT OR IGNORE INTO sync_changes(kind, id, cseq, deleted, at) VALUES ('memory', ?, ?, 0, ?)")
        for (const { id } of db.query<{ id: string }, []>("SELECT id FROM memories WHERE scope != 'session' ORDER BY updated_at, id").all()) insert.run(id, ++cseq, now())
        db.query("INSERT INTO sync_meta(key, value) VALUES ('memory-seeded', '1')").run()
      })()
    },
  }
}
export type SyncState = ReturnType<typeof createSyncState>
