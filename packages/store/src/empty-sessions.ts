import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"

/** Meta key set on a session an API client created on purpose (`session.create` without `reuseEmpty`): it is never treated as an empty chat. */
export const EXPLICIT_SESSION_KEY = "session.explicit:"

export type EmptySession = { sessionId: SessionId; directory: string; createdAt: number; updatedAt: number }

/**
 * An empty session is a chat nobody typed in: a root session without title, turns, draft, queue entry, goal, attachment, label,
 * child or any other record, running as the project's default agent and permission mode. It holds nothing, so it is never listed
 * for people and can be handed out again by the next "new chat" or removed without losing anything.
 *
 * The check is structural: every table that keeps rows per session is asked, so a table added later keeps its sessions alive
 * without this file knowing it. Its only events are `session.created` and the default permission mode recorded right after.
 */
export function createEmptySessions(input: { db: Database; agents: () => string[] }) {
  const { db } = input

  /** Tables, other than the event log, that keep rows per session. */
  function referencing(): string[] {
    return db
      .query<{ name: string }, []>("SELECT m.name AS name FROM sqlite_master m WHERE m.type = 'table' AND m.name != 'events' AND m.name != 'sessions' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'session_id')")
      .all()
      .map((row) => row.name)
  }

  /** The SQL condition (and its parameters) that selects the empty sessions of the table aliased `s`. */
  function condition(alias = "s") {
    const agents = input.agents()
    const agentIn = agents.length ? ` OR ${alias}.agent IN (${agents.map(() => "?").join(", ")})` : ""
    const sql = [
      `${alias}.parent_id IS NULL AND ${alias}.archived_at IS NULL AND ${alias}.pinned_at IS NULL AND ${alias}.title = ''`,
      `${alias}.lifecycle IS NULL AND ${alias}.fanout IS NULL AND ${alias}.model IS NULL AND ${alias}.effort IS NULL AND ${alias}.model_options IS NULL AND ${alias}.active_turn IS NULL`,
      `(${alias}.agent IS NULL${agentIn})`,
      `NOT EXISTS (SELECT 1 FROM sessions child WHERE child.parent_id = ${alias}.id)`,
      `NOT EXISTS (SELECT 1 FROM meta WHERE meta.key = '${EXPLICIT_SESSION_KEY}' || ${alias}.id)`,
      `NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = ${alias}.id AND e.type != 'session.created' AND NOT (e.type = 'session.permission' AND e.seq = 2))`,
      ...referencing().map((table) => `NOT EXISTS (SELECT 1 FROM "${table}" t WHERE t.session_id = ${alias}.id)`),
    ].join(" AND ")
    return { sql, params: agents }
  }

  return {
    condition,
    /** The empty sessions, newest first; `directory` limits them to one project. */
    list(options: { directory?: string } = {}): EmptySession[] {
      const { sql, params } = condition()
      return db
        .query<{ id: string; directory: string; created_at: number; updated_at: number }, Array<string>>(`SELECT s.id, s.directory, s.created_at, s.updated_at FROM sessions s WHERE ${sql}${options.directory ? " AND s.directory = ?" : ""} ORDER BY MAX(s.updated_at, s.created_at) DESC, s.id DESC`)
        .all(...params, ...(options.directory ? [options.directory] : []))
        .map((row) => ({ sessionId: row.id as SessionId, directory: row.directory, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at }))
    },
    /** Whether one session is empty right now. */
    has(sessionId: SessionId): boolean {
      const { sql, params } = condition()
      return db.query<{ n: number }, string[]>(`SELECT 1 AS n FROM sessions s WHERE s.id = ? AND ${sql}`).get(sessionId, ...params) !== null
    },
  }
}
export type EmptySessions = ReturnType<typeof createEmptySessions>
