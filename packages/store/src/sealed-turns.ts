import type { Database } from "bun:sqlite"
import { decodeIdTime } from "@mendcode/protocol"
import type { OwnEventRow } from "./compress"
import { decodeTurnBlock, encodeTurnBlock } from "./turn-blocks"

/** A turn over this many stored bytes stays in rows. */
const MAX_BLOCK_SOURCE_BYTES = 64 * 1024 * 1024
/**
 * A larger turn is sealed as consecutive blocks of about this many stored bytes, so the newest page of a session decodes a
 * small block rather than a whole turn of tool output.
 */
const BLOCK_CHUNK_BYTES = 64 * 1024

/** Consecutive runs of rows of at most BLOCK_CHUNK_BYTES each (a single larger row is a run of its own). */
function chunksOf(rows: readonly OwnEventRow[]): OwnEventRow[][] {
  const out: OwnEventRow[][] = []
  let current: OwnEventRow[] = []
  let bytes = 0
  for (const row of rows) {
    if (current.length && bytes + row.payload.length > BLOCK_CHUNK_BYTES) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += row.payload.length
  }
  if (current.length) out.push(current)
  return out
}
/** Decoded blocks kept for repeated reads of the same session (a history page, then a replay). */
const DECODED_CACHE = 16
/** Sessions whose sealed rows stay in the temp table for SQL readers at once. */
const THAWED_SESSIONS = 4

/** An item's rows can be written a little before its id's clock reading (another process's clock, a corrected clock). */
const ID_CLOCK_SLACK_MS = 60_000

/**
 * Which sealed rows a reader's statements can match, named so two readers of one session share a thaw. `accept` must keep
 * every row the reader's SQL could select (a superset is fine: the SQL still filters); it only spares copying the rest.
 */
export type ThawFilter = { key: string; accept(row: OwnEventRow): boolean }

const ITEM_TYPES = ["item.started", "item.delta", "item.completed"] as const
const END_TYPES = "'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'"

/**
 * Settled history in blocks. A session's blocks always cover one contiguous prefix of its sequence, from its first event
 * through the end of its last sealed turn (`sealedThrough`); every event after that is an `events` row as before. Sealing
 * moves rows into a block in the idle step, only for a session that is not running a turn, is not a fork with a shared
 * transcript, and whose range no fork's transcript points into. Blocks decode to rows byte-identical to the moved ones.
 */
export function createSealedTurns(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS turn_blocks (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, row_count INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY(session_id, first_seq)
  ) WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS turn_blocks_time ON turn_blocks(session_id, last_at, first_at)")
  // Blocks are contiguous and keyed by first_seq: the last one ends the sealed prefix, and the first block that can hold a
  // sequence after `?2` is the last one starting at or before `?2 + 1`. Both are seeks on the key; `last_seq` has no index.
  const FROM_BLOCK = "first_seq >= coalesce((SELECT max(b.first_seq) FROM turn_blocks b WHERE b.session_id = ?1 AND b.first_seq <= ?2 + 1), 0)"
  const through = db.query<{ last: number | null }, [string]>("SELECT last_seq AS last FROM turn_blocks WHERE session_id = ? ORDER BY first_seq DESC LIMIT 1")
  const covering = db.query<{ first_seq: number; last_seq: number; data: Uint8Array }, [string, number, number]>(
    `SELECT first_seq, last_seq, data FROM turn_blocks WHERE session_id = ?1 AND ${FROM_BLOCK} AND last_seq > ?2 AND first_seq <= ?3 ORDER BY first_seq`)
  const ends = db.query<{ seq: number }, [string, number, number]>(
    `SELECT seq FROM events WHERE session_id = ?1 AND seq > ?2 AND type IN (${END_TYPES}) ORDER BY seq LIMIT ?3`)
  const candidates = db.query<{ id: string }, [number]>(
    `SELECT s.id FROM sessions s WHERE s.active_turn IS NULL AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type IN (${END_TYPES})) LIMIT ?`)
  const range = db.query<OwnEventRow, [string, number, number]>("SELECT seq, type, at, payload FROM events WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq")
  const blocked = db.query<{ one: number }, [string, number, number]>(`SELECT 1 AS one WHERE
    EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.parent_id = ?1 AND p.parent_seq > ?2 AND p.parent_seq <= ?3)
    OR EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.session_id = ?1)
    OR EXISTS (SELECT 1 FROM events r WHERE r.session_id = ?1 AND r.seq > ?2 AND r.seq <= ?3 AND r.type = 'server.request'
      AND COALESCE(json_extract(r.payload, '$.async'), 0) != 0 AND NOT EXISTS (SELECT 1 FROM events x WHERE x.session_id = ?1
      AND x.seq > r.seq AND x.type = 'server.request.resolved' AND json_extract(x.payload, '$.requestId') = json_extract(r.payload, '$.requestId')))`)
  const running = db.query<{ active_turn: string | null }, [string]>("SELECT active_turn FROM sessions WHERE id = ?")
  const insert = db.query("INSERT INTO turn_blocks(session_id, first_seq, last_seq, first_at, last_at, row_count, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
  const aroundTime = db.query<{ first_seq: number }, [string, number, number]>(
    "SELECT first_seq FROM turn_blocks INDEXED BY turn_blocks_time WHERE session_id = ?1 AND last_at >= ?2 AND first_at <= ?3 ORDER BY first_seq")
  const blockAt = db.query<Block, [string, number]>("SELECT first_seq, last_seq, data FROM turn_blocks WHERE session_id = ? AND first_seq = ?")
  const remove = db.query("DELETE FROM events WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3")
  type Block = { first_seq: number; last_seq: number; data: Uint8Array }
  const blocksAfter = db.query<Block, [string, number, number]>(
    `SELECT first_seq, last_seq, data FROM turn_blocks WHERE session_id = ?1 AND ${FROM_BLOCK} AND last_seq > ?2 ORDER BY first_seq LIMIT ?3`)
  const blocksBefore = db.query<Block, [string, number, number]>(
    "SELECT first_seq, last_seq, data FROM turn_blocks WHERE session_id = ?1 AND first_seq < ?2 ORDER BY first_seq DESC LIMIT ?3")
  const BATCH = 8
  const everyBlock = db.query<{ session_id: string; first_seq: number; data: Uint8Array }, [string, number, number]>(
    "SELECT session_id, first_seq, data FROM turn_blocks WHERE (session_id, first_seq) > (?1, ?2) ORDER BY session_id, first_seq LIMIT ?3")
  /** Blocks after `afterSeq` ascending, or before `beforeSeq` descending, read a few at a time. */
  function* walk(sessionId: string, from: number, direction: "after" | "before"): Generator<Block> {
    for (let cursor = from; ;) {
      const batch = direction === "after" ? blocksAfter.all(sessionId, cursor, BATCH) : blocksBefore.all(sessionId, cursor, BATCH)
      yield* batch
      if (batch.length < BATCH) return
      cursor = direction === "after" ? batch.at(-1)!.last_seq : batch.at(-1)!.first_seq
    }
  }
  const restore = db.query("INSERT OR IGNORE INTO events(session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)")
  const dropBlocks = db.query("DELETE FROM turn_blocks WHERE session_id = ?")
  /** Sessions sealing found nothing to do for since this process started; cleared when they append a turn end. */
  const settled = new Set<string>()
  const decoded = new Map<string, OwnEventRow[]>()

  function rowsOf(sessionId: string, block: { first_seq: number; data: Uint8Array }): OwnEventRow[] {
    const key = `${sessionId}\0${block.first_seq}`
    let rows = decoded.get(key)
    if (rows) {
      decoded.delete(key)
    } else {
      rows = decodeTurnBlock(block.data)
      if (decoded.size >= DECODED_CACHE) decoded.delete(decoded.keys().next().value!)
    }
    decoded.set(key, rows)
    return rows
  }

  const sealedThrough = (sessionId: string) => through.get(sessionId)?.last ?? 0

  // SQL readers of a sealed session query a temp view: `events_all` (recall: `events_read` plus `sealed_rows`, indexed by
  // item like `events`) or `events_own_all` (stats: `events` plus `sealed_own_rows`, which no statement reads by item, so
  // it skips that index, most of the cost of copying). Only the last few sessions read stay thawed in each.
  db.run("CREATE TEMP TABLE IF NOT EXISTS sealed_rows (session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, seq)) WITHOUT ROWID")
  db.run("CREATE INDEX IF NOT EXISTS temp.sealed_rows_item ON sealed_rows(session_id, json_extract(payload, '$.itemId'), seq) WHERE type IN ('item.started', 'item.delta', 'item.completed')")
  db.run("CREATE TEMP TABLE IF NOT EXISTS sealed_own_rows (session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, seq)) WITHOUT ROWID")
  db.run(`CREATE TEMP VIEW IF NOT EXISTS events_all AS
    SELECT session_id, seq, type, at, payload, source_id, source_seq FROM events_read
    UNION ALL SELECT session_id, seq, type, at, payload, session_id AS source_id, seq AS source_seq FROM temp.sealed_rows`)
  db.run(`CREATE TEMP VIEW IF NOT EXISTS events_own_all AS
    SELECT session_id, seq, type, at, payload FROM main.events UNION ALL SELECT session_id, seq, type, at, payload FROM temp.sealed_own_rows`)
  const summaryOf = db.query<{ rows: number; lastAt: number | null }, [string]>("SELECT coalesce(sum(row_count), 0) AS rows, max(last_at) AS lastAt FROM turn_blocks WHERE session_id = ?")

  /** A temp table that holds the sealed rows of the last few sessions read, each with the window and filters it was filled for. */
  function thawTarget(table: "sealed_rows" | "sealed_own_rows") {
    const insert = db.query(`INSERT OR IGNORE INTO temp.${table}(session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)`)
    const drop = db.query(`DELETE FROM temp.${table} WHERE session_id = ?`)
    /** Thawed sessions, least recently read first, with the sealed sequence each was thawed through. */
    const thawed = new Map<string, { through: number; after: number; filters: Map<string, ThawFilter["accept"]> | undefined }>()
    function dropThawed(sessionId: string) {
      if (thawed.delete(sessionId)) drop.run(sessionId)
    }
    function thaw(sessionId: string, options: { afterSeq?: number; filter?: ThawFilter } = {}) {
      const afterSeq = options.afterSeq ?? 0
      const sealed = sealedThrough(sessionId)
      const current = thawed.get(sessionId)
      let filters = options.filter ? new Map([[options.filter.key, options.filter.accept]]) : undefined
      if (current !== undefined) {
        thawed.delete(sessionId)
        thawed.set(sessionId, current)
        const covers = !current.filters || (options.filter !== undefined && current.filters.has(options.filter.key))
        if (current.through === sealed && current.after <= afterSeq && covers) return
        // Another reader of the same session keeps what it needed: thaw the union once instead of alternating.
        if (current.through === sealed) filters = filters && current.filters ? new Map([...current.filters, ...filters]) : undefined
      }
      dropThawed(sessionId)
      if (!sealed || afterSeq >= sealed) return
      while (thawed.size >= THAWED_SESSIONS) dropThawed(thawed.keys().next().value!)
      const after = Math.min(afterSeq, current?.through === sealed ? current.after : afterSeq)
      const accepts = filters ? [...filters.values()] : undefined
      db.transaction(() => {
        for (const row of sealedRows(sessionId, after, sealed)) {
          if (!accepts || accepts.some((accept) => accept(row))) insert.run(sessionId, row.seq, row.type, row.at, row.payload)
        }
      })()
      thawed.set(sessionId, { through: sealed, after, filters })
    }
    return { thaw, drop: dropThawed }
  }
  const forAll = thawTarget("sealed_rows")
  const forOwn = thawTarget("sealed_own_rows")
  function dropThawed(sessionId: string) {
    forAll.drop(sessionId)
    forOwn.drop(sessionId)
  }

  /** The sealed rows with `afterSeq < seq <= throughSeq`, in sequence order. */
  function sealedRows(sessionId: string, afterSeq: number, throughSeq: number): OwnEventRow[] {
    if (throughSeq <= afterSeq) return []
    const out: OwnEventRow[] = []
    for (const block of covering.all(sessionId, afterSeq, throughSeq)) {
      for (const row of rowsOf(sessionId, block)) if (row.seq > afterSeq && row.seq <= throughSeq) out.push(row)
    }
    return out
  }

  return {
    sealedThrough,
    /**
     * Makes a session's sealed rows after `afterSeq` visible to SQL through `events_all` until it is evicted
     * (THAWED_SESSIONS newer sessions thawed) or sealed again. Call before any statement on that view for that session, with
     * the lowest sequence the statement can read; `filter` copies only the rows its statements can select.
     */
    thaw: forAll.thaw,
    /** The same for `events_own_all`, the view whose statements never look a row up by item. */
    thawOwn: forOwn.thaw,
    /** How many rows the session's blocks hold and their latest time, from the block table alone. */
    summary(sessionId: string): { rows: number; lastAt: number | null } {
      return summaryOf.get(sessionId) ?? { rows: 0, lastAt: null }
    },
    /** The sealed rows with `afterSeq < seq <= throughSeq`, in sequence order. */
    rows: sealedRows,
    /**
     * The sealed rows whose top-level `key` field is `id`, in sequence order, optionally of `types` only. An id carries
     * its creation time (id-factory.ts), so only the blocks whose time range holds it are decoded; an id without a
     * readable time decodes every block.
     */
    withId(sessionId: string, key: string, id: string, types?: readonly string[]): OwnEventRow[] {
      if (!sealedThrough(sessionId)) return []
      const time = decodeIdTime(id)
      const rows = time === undefined ? this.all(sessionId)
        : aroundTime.all(sessionId, time - ID_CLOCK_SLACK_MS, time + ID_CLOCK_SLACK_MS).flatMap(({ first_seq }) => {
          const block = blockAt.get(sessionId, first_seq)
          return block ? rowsOf(sessionId, block) : []
        })
      const quoted = JSON.stringify(id)
      return rows.filter((row) => (!types || types.includes(row.type)) && row.payload.includes(quoted)
        && (JSON.parse(row.payload) as Record<string, unknown>)[key] === id)
    },
    /** The sealed `item.started`, `item.delta` and `item.completed` rows of one item. */
    item(sessionId: string, itemId: string): OwnEventRow[] {
      return this.withId(sessionId, "itemId", itemId, ITEM_TYPES)
    },
    /** The sealed row at `seq`, if that sequence is sealed. */
    rowAt(sessionId: string, seq: number): OwnEventRow | undefined {
      return seq <= sealedThrough(sessionId) ? this.rows(sessionId, seq - 1, seq)[0] : undefined
    },
    /** Every sealed row of a session, oldest first. */
    all(sessionId: string): OwnEventRow[] {
      return this.rows(sessionId, 0, Number.MAX_SAFE_INTEGER)
    },
    /** The first `limit` sealed rows after `afterSeq`, decoding only the blocks it needs. */
    after(sessionId: string, afterSeq: number, limit: number): OwnEventRow[] {
      const out: OwnEventRow[] = []
      if (limit <= 0) return out
      for (const block of walk(sessionId, afterSeq, "after")) {
        for (const row of rowsOf(sessionId, block)) {
          if (row.seq <= afterSeq) continue
          out.push(row)
          if (out.length >= limit) return out
        }
      }
      return out
    },
    /**
     * Every sealed row of every session (of `types` only, when given), session by session in sequence order: for the
     * maintenance and rebuild passes that read the whole `events` table. Blocks are read in batches, not all at once.
     */
    *everyRow(types?: readonly string[]): Generator<OwnEventRow & { session_id: string }> {
      for (let cursor: [string, number] = ["", 0]; ;) {
        const batch = everyBlock.all(cursor[0], cursor[1], BATCH * 8)
        for (const block of batch) {
          for (const row of decodeTurnBlock(block.data)) if (!types || types.includes(row.type)) yield { session_id: block.session_id, ...row }
        }
        if (batch.length < BATCH * 8) return
        cursor = [batch.at(-1)!.session_id, batch.at(-1)!.first_seq]
      }
    },
    /** Up to `limit` sealed rows `accept` keeps, newest first, decoding blocks only until enough are found. */
    newest(sessionId: string, accept: (row: OwnEventRow) => boolean, limit: number): OwnEventRow[] {
      const out: OwnEventRow[] = []
      if (limit <= 0) return out
      for (const block of walk(sessionId, Number.MAX_SAFE_INTEGER, "before")) {
        const rows = rowsOf(sessionId, block)
        for (let i = rows.length - 1; i >= 0; i--) {
          if (!accept(rows[i]!)) continue
          out.push(rows[i]!)
          if (out.length >= limit) return out
        }
      }
      return out
    },
    /** The last `limit` sealed rows before `beforeSeq`, ascending, decoding only the blocks it needs. */
    before(sessionId: string, beforeSeq: number, limit: number): OwnEventRow[] {
      const out: OwnEventRow[] = []
      if (limit <= 0) return out
      for (const block of walk(sessionId, beforeSeq, "before")) {
        const rows = rowsOf(sessionId, block)
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.seq >= beforeSeq) continue
          out.push(rows[i]!)
          if (out.length >= limit) return out.reverse()
        }
      }
      return out.reverse()
    },
    /** Puts a session's sealed rows back into `events` (a fork is about to point into them). */
    unseal(sessionId: string): number {
      const rows = this.all(sessionId)
      if (!rows.length) return 0
      db.transaction(() => {
        for (const row of rows) restore.run(sessionId, row.seq, row.type, row.at, row.payload)
        dropBlocks.run(sessionId)
      })()
      this.forget(sessionId)
      return rows.length
    },
    /** A stored turn end reopens the session for sealing. Called inside the append transaction. */
    noteEnd(sessionId: string) {
      settled.delete(sessionId)
    },
    /**
     * Seals up to `limit` settled turns, one block each, oldest first within a session. A turn over the size bound or a
     * fork's range stops that session's prefix there; it is tried again after its next turn end. `fold` gets the turn's
     * rows first when it streamed deltas, so whatever can still fold does (it returns how many rows it removed); the deltas
     * left (an item whose completion has no text, such as reasoning) are the item's content and seal with the turn.
     */
    seal(limit = 50, fold?: (sessionId: string, rows: readonly OwnEventRow[]) => number): { blocks: number; rows: number; complete: boolean } {
      let blocks = 0
      let moved = 0
      const ids = candidates.all(limit + settled.size).map((row) => row.id).filter((id) => !settled.has(id))
      db.transaction(() => {
        for (const sessionId of ids) {
          if (blocks >= limit) break
          if (running.get(sessionId)?.active_turn) continue
          let from = sealedThrough(sessionId)
          let stopped = false
          for (const { seq: end } of ends.all(sessionId, from, limit - blocks)) {
            if (blocked.get(sessionId, from, end)) { stopped = true; break }
            let rows = range.all(sessionId, from, end)
            if (fold && rows.some((row) => row.type === "item.delta") && fold(sessionId, rows) > 0) rows = range.all(sessionId, from, end)
            if (rows.reduce((sum, row) => sum + row.payload.length, 0) > MAX_BLOCK_SOURCE_BYTES) { stopped = true; break }
            if (rows.length) {
              for (const chunk of chunksOf(rows)) {
                let firstAt = chunk[0]!.at, lastAt = chunk[0]!.at
                for (const row of chunk) { if (row.at < firstAt) firstAt = row.at; if (row.at > lastAt) lastAt = row.at }
                insert.run(sessionId, chunk[0]!.seq, chunk.at(-1)!.seq, firstAt, lastAt, chunk.length, encodeTurnBlock(chunk))
              }
              moved += remove.run(sessionId, from, end).changes
              blocks++
            }
            from = end
          }
          if (stopped || blocks < limit) settled.add(sessionId)
        }
      })()
      return { blocks, rows: moved, complete: blocks < limit }
    },
    forget(sessionId: string) {
      settled.delete(sessionId)
      dropThawed(sessionId)
      for (const key of [...decoded.keys()]) if (key.startsWith(`${sessionId}\0`)) decoded.delete(key)
    },
  }
}
export type SealedTurns = ReturnType<typeof createSealedTurns>
