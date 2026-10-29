import type { Database } from "bun:sqlite"

/**
 * The model history of a session (`engine_messages`), with copy-on-write forks.
 *
 * A fork does not copy the rows it starts from: it records a prefix (`engine_prefix`): "messages 0..upto-1 of this
 * engine are the ones of `parent_id`". The fork's own rows start at index `upto`, so reading a history is the parent's
 * rows below `upto` (resolved through that parent's own prefix, recursively) followed by the session's own rows. Every
 * write that would change rows a fork still reads (undo, compaction, deleting the parent) hands those rows over first:
 * deleting a session gives its rows to the fork that needs the most of them (an UPDATE, no copy) and points the other
 * forks at it; a cut or rewrite copies only the affected tail into each fork that reads it.
 *
 * Invariant: a session's own rows for an engine are contiguous from its `upto` (0 without a prefix), so its length is
 * `upto + own rows` and an append goes at that index.
 */
export type HistoryRow = { idx: number; payload: string | Uint8Array }
type Prefix = { parent: string; upto: number }

const NO_LIMIT = 2147483647

export function createEngineHistory(db: Database) {
  const q = {
    prefix: db.query<{ parent_id: string; upto: number }, [string, string]>("SELECT parent_id, upto FROM engine_prefix WHERE session_id = ? AND engine = ?"),
    setPrefix: db.query("INSERT INTO engine_prefix(session_id, engine, parent_id, upto) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, engine) DO UPDATE SET parent_id = excluded.parent_id, upto = excluded.upto"),
    dropPrefix: db.query("DELETE FROM engine_prefix WHERE session_id = ? AND engine = ?"),
    own: db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM engine_messages WHERE session_id = ? AND engine = ?"),
    first: db.query<HistoryRow, [string, string]>("SELECT idx, payload FROM engine_messages WHERE session_id = ? AND engine = ? ORDER BY idx LIMIT 1"),
    engines: db.query<{ engine: string }, [string, string]>("SELECT engine FROM engine_messages WHERE session_id = ? GROUP BY engine UNION SELECT engine FROM engine_prefix WHERE session_id = ?"),
    referrers: db.query<{ session_id: string; upto: number }, [string, string, number]>("SELECT session_id, upto FROM engine_prefix WHERE parent_id = ? AND engine = ? AND upto > ? ORDER BY upto DESC, session_id"),
    referrerEngines: db.query<{ engine: string }, [string]>("SELECT DISTINCT engine FROM engine_prefix WHERE parent_id = ?"),
    insert: db.query("INSERT INTO engine_messages(session_id, engine, idx, payload) VALUES (?, ?, ?, ?)"),
    cut: db.query("DELETE FROM engine_messages WHERE session_id = ? AND engine = ? AND idx >= ?"),
    handOver: db.query("UPDATE engine_messages SET session_id = ?1 WHERE session_id = ?2 AND engine = ?3 AND idx >= ?4 AND idx < ?5"),
    repoint: db.query("UPDATE engine_prefix SET parent_id = ? WHERE session_id = ? AND engine = ?"),
    rows: db.query<HistoryRow, [string, string, number]>(`
      WITH RECURSIVE chain(sid, lim) AS (
        SELECT ?1, ${NO_LIMIT}
        UNION ALL
        SELECT p.parent_id, MIN(chain.lim, p.upto) FROM chain JOIN engine_prefix p ON p.session_id = chain.sid AND p.engine = ?2
      )
      SELECT m.idx AS idx, m.payload AS payload FROM chain
      JOIN engine_messages m ON m.session_id = chain.sid AND m.engine = ?2 AND m.idx < chain.lim AND m.idx >= ?3
        AND m.idx >= COALESCE((SELECT upto FROM engine_prefix WHERE session_id = chain.sid AND engine = ?2), 0)
      ORDER BY m.idx`),
    bytes: db.query<{ n: number | null }, [string, string, number]>(`
      WITH RECURSIVE chain(sid, lim) AS (
        SELECT ?1, ?3
        UNION ALL
        SELECT p.parent_id, MIN(chain.lim, p.upto) FROM chain JOIN engine_prefix p ON p.session_id = chain.sid AND p.engine = ?2
      )
      SELECT SUM(octet_length(m.payload)) AS n FROM chain
      JOIN engine_messages m ON m.session_id = chain.sid AND m.engine = ?2 AND m.idx < chain.lim
        AND m.idx >= COALESCE((SELECT upto FROM engine_prefix WHERE session_id = chain.sid AND engine = ?2), 0)`),
    prefixes: db.query<{ session_id: string; engine: string; upto: number; parent_id: string }, [number]>("SELECT session_id, engine, upto, parent_id FROM engine_prefix ORDER BY session_id LIMIT ?"),
  }

  const prefixOf = (sessionId: string, engine: string): Prefix | undefined => {
    const row = q.prefix.get(sessionId, engine)
    return row ? { parent: row.parent_id, upto: row.upto } : undefined
  }

  /** How many messages the session's `engine` history holds, shared prefix included. */
  function count(sessionId: string, engine: string): number {
    return (prefixOf(sessionId, engine)?.upto ?? 0) + (q.own.get(sessionId, engine)?.n ?? 0)
  }

  /** The messages from index `from` on, in order, resolved through the prefix chain. */
  function rows(sessionId: string, engine: string, from = 0): HistoryRow[] {
    return q.rows.all(sessionId, engine, from)
  }

  /** Every engine that holds messages for the session, own or shared. */
  function engines(sessionId: string): string[] {
    return q.engines.all(sessionId, sessionId).map((row) => row.engine)
  }

  /** The deepest session whose own rows serve indexes below `cut` of `from`: where a new reference should point. */
  function anchor(from: string, engine: string, cut: number): string {
    let current = from
    for (let prefix = prefixOf(current, engine); prefix && prefix.upto >= cut; prefix = prefixOf(current, engine)) current = prefix.parent
    return current
  }

  /**
   * Copy-on-write: forks that still read `session`'s rows from `from` on get their own copy of that tail, and their
   * reference shrinks to `from`. Runs before anything removes or rewrites those rows.
   */
  function detach(sessionId: string, engine: string, from: number) {
    const children = q.referrers.all(sessionId, engine, from)
    if (!children.length) return
    const tail = rows(sessionId, engine, from)
    for (const child of children) {
      for (const row of tail) if (row.idx < child.upto) q.insert.run(child.session_id, engine, row.idx, row.payload)
      if (from > 0) q.setPrefix.run(child.session_id, engine, sessionId, from)
      else q.dropPrefix.run(child.session_id, engine)
    }
  }

  /** Removes the session's messages from `from` on (the stash of an undo has already copied what redo needs). */
  function cut(sessionId: string, engine: string, from: number) {
    detach(sessionId, engine, from)
    const prefix = prefixOf(sessionId, engine)
    if (prefix && prefix.upto > from) {
      if (from > 0) q.setPrefix.run(sessionId, engine, prefix.parent, from)
      else q.dropPrefix.run(sessionId, engine)
    }
    q.cut.run(sessionId, engine, from)
  }

  /** The new session starts from the first `cut` messages of `from`'s `engine` history, by reference. */
  function share(from: string, to: string, engine: string, cutAt: number): number {
    const upto = Math.min(cutAt, count(from, engine))
    if (upto <= 0) return 0
    if (count(to, engine) > 0) throw new RangeError(`[STORE]: the ${engine} history of the new session is not empty`)
    q.setPrefix.run(to, engine, anchor(from, engine, upto), upto)
    return upto
  }

  /** Before a session is deleted: the rows its forks read move to a fork, so no fork loses its history. */
  function release(sessionId: string) {
    for (const { engine } of q.referrerEngines.all(sessionId)) {
      const children = q.referrers.all(sessionId, engine, 0)
      const heir = children[0]
      if (!heir) continue
      const own = prefixOf(sessionId, engine)
      const base = own?.upto ?? 0
      const keep = Math.min(base, heir.upto)
      if (heir.upto > base) q.handOver.run(heir.session_id, sessionId, engine, base, heir.upto)
      if (own && keep > 0) q.setPrefix.run(heir.session_id, engine, own.parent, keep)
      else q.dropPrefix.run(heir.session_id, engine)
      for (const other of children.slice(1)) q.repoint.run(anchor(heir.session_id, engine, other.upto), other.session_id, engine)
    }
  }

  /** What sharing keeps off the disk: the messages forks read from a parent, and their size. Bounded: it stops at `limit` forks. */
  function shared(limit = 5_000): { messages: number; bytes: number; forks: number } {
    let messages = 0
    let bytes = 0
    const all = q.prefixes.all(limit)
    for (const prefix of all) {
      messages += prefix.upto
      bytes += Number(q.bytes.get(prefix.parent_id, prefix.engine, prefix.upto)?.n ?? 0)
    }
    return { messages, bytes, forks: all.length }
  }

  return { count, rows, first: (sessionId: string, engine: string) => q.first.get(anchor(sessionId, engine, 1), engine) ?? undefined, engines, share, cut, detach, release, shared, insert: (sessionId: string, engine: string, idx: number, payload: string | Uint8Array) => q.insert.run(sessionId, engine, idx, payload) }
}
export type EngineHistory = ReturnType<typeof createEngineHistory>
