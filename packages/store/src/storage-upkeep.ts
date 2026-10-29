import type { Database } from "bun:sqlite"
import type { SessionEvent } from "@mendcode/protocol"
import { createCodec, unpackEvent, type Codec } from "./compress"
import type { EventObjects } from "./event-objects"
import type { TurnsStore } from "./turns"

const DAY_MS = 86_400_000
/** Rows rewritten per transaction while compacting: short write locks, the daemon keeps answering. */
const BATCH = 400
/** Rows one compaction call rewrites at most (per kind); `complete` is false when more remain, and the next call continues. */
const DEFAULT_ROW_LIMIT = 20_000
const COMPRESSIBLE_ROW = 1024

export type StorageUpkeep = ReturnType<typeof createStorageUpkeep>

export type EventTypeBytes = { type: string; count: number; bytes: number }
export type StorageExtras = {
  turns: number
  eventTypes: EventTypeBytes[]
  snapshotBytes: number
  snapshotObjects: number
  snapshotRefs: number
  compressedRows: number
  /** What compression and content sharing keep off the disk: original size of the packed values minus what is stored. */
  savedBytes: number
}
export type CompactResult = {
  dryRun: boolean
  engineRows: number
  eventRows: number
  snapshotRows: number
  deltaEvents: number
  snapshotObjectsSwept: number
  /** Dry run: bytes of the rows that would be rewritten or removed. */
  candidateBytes: number
  /** False when a row limit stopped the pass: run it again to continue. */
  complete: boolean
}

const MAGIC_SQL = "X'004D5A31'"
const REF_SQL = "X'004D5A3146'"

/**
 * Disk upkeep that is not retention: the report's breakdown of where bytes go and the pass that moves data written
 * before compression existed (or while it was off) into the compact forms, plus dropping the streaming deltas of
 * messages that already have their final text. Additive: nothing here changes a schema or a row's meaning.
 */
export function createStorageUpkeep(input: { db: Database; codec: Codec; turns: TurnsStore; now: () => number; objects: EventObjects }) {
  const { db, codec, turns, now } = input
  const get = <T>(sql: string, ...params: Array<string | number>) => db.query<T, Array<string | number>>(sql).get(...params)
  const num = (sql: string) => Number(get<{ n: number | null }>(sql)?.n ?? 0)

  function extras(): StorageExtras {
    const eventTypes = db
      .query<EventTypeBytes, []>("SELECT type, COUNT(*) AS count, SUM(octet_length(payload)) AS bytes FROM events GROUP BY type ORDER BY bytes DESC LIMIT 6")
      .all()
    const snap = turns.storage.stats()
    const inline = ["turn_files.before_content", "turn_files.after_content", "turn_call_files.before_content"].reduce((total, ref) => {
      const [table, column] = ref.split(".") as [string, string]
      return total + num(`SELECT SUM(octet_length(${column})) AS n FROM ${table} WHERE ${column} IS NOT NULL`)
    }, 0)
    let refs = 0
    let refLogical = 0
    for (const [table, column] of [["turn_files", "before_content"], ["turn_files", "after_content"], ["turn_call_files", "before_content"]] as const) {
      for (const row of db.query<{ head: Uint8Array }, []>(`SELECT substr(${column}, 1, 9) AS head FROM ${table} WHERE substr(${column}, 1, 5) = ${REF_SQL}`).iterate()) {
        refs++
        refLogical += codec.contentBytes(row.head)
      }
    }
    // Compressed model messages carry their original size in the header; nine bytes per row is all that is read.
    let engineRows = 0
    let engineSaved = 0
    for (const row of db.query<{ stored: number; head: Uint8Array }, []>("SELECT octet_length(payload) AS stored, substr(payload, 1, 9) AS head FROM engine_messages WHERE typeof(payload) = 'blob'").iterate()) {
      engineRows++
      engineSaved += codec.textBytes(row.head) - row.stored
    }
    const packedEvents = db
      .query<{ n: number; raw: number | null; stored: number | null }, []>(
        `SELECT COUNT(*) AS n, SUM(json_extract(payload, '$.z')) AS raw, SUM(length(json_extract(payload, '$.text'))) AS stored FROM events
         WHERE type IN ('item.completed', 'item.delta') AND payload LIKE '%,"z":%' AND payload NOT LIKE '%"zref":%' AND json_extract(payload, '$.z') IS NOT NULL`,
      )
      .get()
    const eventSaved = (packedEvents?.raw ?? 0) - (packedEvents?.stored ?? 0)
    const sharedEventBytes = num("SELECT SUM(json_extract(payload, '$.z')) AS n FROM events WHERE json_extract(payload, '$.zref') IS NOT NULL")
    const objects = input.objects.stats()
    const objectSaved = snap.rawBytes - snap.objectBytes
    // Sharing: what the references would have cost as one copy each, minus the one copy each object really takes.
    const sharedSaved = Math.max(0, refLogical - snap.rawBytes)
    return {
      turns: num("SELECT COUNT(*) AS n FROM turns"),
      eventTypes,
      snapshotBytes: inline + snap.objectBytes,
      snapshotObjects: snap.objects,
      snapshotRefs: refs,
      compressedRows: engineRows + (packedEvents?.n ?? 0) + snap.objects + objects.objects,
      savedBytes: Math.max(0, engineSaved + eventSaved + sharedEventBytes - objects.objectBytes) + Math.max(0, objectSaved) + sharedSaved,
    }
  }

  /** Streaming deltas of items that have their final text: replay needs only the completed event. */
  const deltaTarget = `type = 'item.delta' AND EXISTS (SELECT 1 FROM events c WHERE c.session_id = events.session_id
    AND c.type IN ('item.started', 'item.delta', 'item.completed') AND c.type = 'item.completed'
    AND json_extract(c.payload, '$.itemId') = json_extract(events.payload, '$.itemId')
    AND json_extract(c.payload, '$.text') IS NOT NULL AND json_extract(c.payload, '$.blob') IS NULL)`

  function compact(options: { dryRun?: boolean; deltaIdleDays?: number; protect?: ReadonlySet<string>; rowLimit?: number }): CompactResult {
    const dryRun = options.dryRun === true
    const limit = options.rowLimit ?? DEFAULT_ROW_LIMIT
    const result: CompactResult = { dryRun, engineRows: 0, eventRows: 0, snapshotRows: 0, deltaEvents: 0, snapshotObjectsSwept: 0, candidateBytes: 0, complete: true }
    if (codec.enabled) {
      // An explicit first pass of the new format revisits old compressed output too. Never on open or dry run.
      if (!dryRun && !get("SELECT value FROM meta WHERE key = 'shared_content_compacted'")) {
        db.transaction(() => {
          db.run("UPDATE storage_marks SET events_seq = 0")
          db.run("INSERT INTO meta(key, value) VALUES ('shared_content_compacted', '1')")
        })()
      }
      compactEngine(result, limit, dryRun)
      compactEvents(result, limit, dryRun)
      if (dryRun) {
        for (const [table, column] of [["turn_files", "before_content"], ["turn_files", "after_content"], ["turn_call_files", "before_content"]] as const) {
          const row = get<{ n: number; bytes: number | null }>(`SELECT COUNT(*) AS n, SUM(length(${column})) AS bytes FROM ${table} WHERE typeof(${column}) = 'blob' AND length(${column}) >= 256 AND substr(${column}, 1, 4) <> ${MAGIC_SQL}`)
          result.snapshotRows += row?.n ?? 0
          result.candidateBytes += row?.bytes ?? 0
        }
      } else {
        let changed: number
        do {
          changed = turns.storage.compact(BATCH)
          result.snapshotRows += changed
        } while (changed > 0 && result.snapshotRows < limit)
        if (changed > 0) result.complete = false
      }
    }
    if (options.deltaIdleDays !== undefined) dropDeltas(result, options.deltaIdleDays, options.protect ?? new Set(), dryRun)
    if (!dryRun) result.snapshotObjectsSwept = turns.storage.sweep()
    return result
  }

  function compactEngine(result: CompactResult, limit: number, dryRun: boolean) {
    const stored = get<{ value: string }>("SELECT value FROM meta WHERE key = 'shared_engine_cursor'")
    const migrated: [string, string, number] = stored ? JSON.parse(stored.value) : ["", "", -1]
    const packer = dryRun ? createCodec({ enabled: codec.enabled, objects: { put: input.objects.preview, load: input.objects.load } }) : codec
    const select = db.query<{ session_id: string; engine: string; idx: number; payload: string | Uint8Array }, [string, string, number, string, string, number, number]>(
      `SELECT session_id, engine, idx, payload FROM engine_messages WHERE ((typeof(payload) = 'text' AND length(payload) >= ${COMPRESSIBLE_ROW})
       OR (substr(payload, 1, 5) = X'004D5A315A' AND (session_id, engine, idx) > (?1, ?2, ?3)))
       AND (session_id, engine, idx) > (?4, ?5, ?6) ORDER BY session_id, engine, idx LIMIT ?7`,
    )
    const update = db.query("UPDATE engine_messages SET payload = ? WHERE session_id = ? AND engine = ? AND idx = ?")
    let cursor: [string, string, number] = ["", "", -1]
    let visited = 0
    for (;;) {
      const rows = select.all(...migrated, ...cursor, Math.min(BATCH, Math.max(1, limit - visited)))
      if (!rows.length) return
      const last = rows[rows.length - 1]!
      cursor = [last.session_id, last.engine, last.idx]
      const batch = () => {
        for (const row of rows) {
          const packed = packer.packText(codec.unpackText(row.payload))
          if (typeof packed === "string" || (row.payload instanceof Uint8Array && Buffer.compare(packed, row.payload) === 0)) continue
          result.engineRows++
          if (dryRun) result.candidateBytes += Buffer.byteLength(row.payload)
          else update.run(packed, row.session_id, row.engine, row.idx)
        }
        if (!dryRun) {
          db.run(`INSERT INTO meta(key, value) VALUES ('shared_engine_cursor', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value
            WHERE (?2, ?3, ?4) > (json_extract(meta.value, '$[0]'), json_extract(meta.value, '$[1]'), json_extract(meta.value, '$[2]'))`, [JSON.stringify(cursor), ...cursor])
        }
      }
      if (dryRun) batch()
      else db.transaction(batch)()
      visited += rows.length
      if (visited >= limit) {
        result.complete = false
        return
      }
    }
  }

  const pending = db.query<{ id: string; last_seq: number; done: number }, []>(
    `SELECT s.id, s.last_seq, COALESCE(m.events_seq, 0) AS done FROM sessions s LEFT JOIN storage_marks m ON m.session_id = s.id
     WHERE s.last_seq > COALESCE(m.events_seq, 0) ORDER BY s.id`,
  )
  const markEvents = db.query("INSERT INTO storage_marks(session_id, events_seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET events_seq = excluded.events_seq")
  const markDeltas = db.query("INSERT INTO storage_marks(session_id, deltas_seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET deltas_seq = excluded.deltas_seq")

  /** Visits each session's events once: a mark per session says how far an earlier pass looked, so a daily pass only reads what is new. */
  function compactEvents(result: CompactResult, limit: number, dryRun: boolean) {
    const previewCodec = createCodec({ enabled: codec.enabled, objects: { put: input.objects.preview, load: input.objects.load } })
    const select = db.query<{ seq: number; payload: string }, [string, number, number]>(
      `SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? AND type IN ('item.completed', 'item.delta') AND (length(payload) >= ${COMPRESSIBLE_ROW} OR payload LIKE '%,"z":%')
       AND payload NOT LIKE '%"zref":%' ORDER BY seq LIMIT ?`,
    )
    const update = db.query("UPDATE events SET payload = ? WHERE session_id = ? AND seq = ?")
    const started = db.query<{ payload: string }, [string, string]>("SELECT payload FROM events WHERE session_id = ? AND type = 'item.started' AND json_extract(payload, '$.itemId') = ? LIMIT 1")
    function isToolCall(event: SessionEvent) {
      if (event.type !== "item.completed" && event.type !== "item.delta") return false
      if (event.type === "item.completed" && event.toolInput !== undefined) return true
      const start = started.get(event.sessionId, event.itemId)
      return start !== null && (JSON.parse(start.payload) as { kind?: string }).kind === "tool_call"
    }
    for (const session of pending.all()) {
      let cursor = session.done
      for (;;) {
        const rows = select.all(session.id, cursor, BATCH)
        if (!rows.length) break
        const rewrites: Array<{ seq: number; payload: string }> = []
        for (const row of rows) {
          const event = unpackEvent(JSON.parse(row.payload) as Record<string, unknown>, input.objects.load) as unknown as SessionEvent
          const packed = (dryRun ? previewCodec : codec).packEvent(event, row.payload, isToolCall(event))
          if (packed === row.payload) continue
          rewrites.push({ seq: row.seq, payload: packed })
          result.eventRows++
          if (dryRun) result.candidateBytes += Buffer.byteLength(row.payload)
        }
        cursor = rows[rows.length - 1]!.seq
        if (!dryRun)
          db.transaction(() => {
            for (const row of rewrites) {
              const hash = JSON.parse(row.payload).zref as string | undefined
              if (hash) input.objects.refer(hash, session.id)
              if (hash) {
                for (const child of db.query<{ session_id: string }, [string, number]>("SELECT session_id FROM transcript_prefix WHERE parent_id = ? AND parent_seq = ?").all(session.id, row.seq)) input.objects.refer(hash, child.session_id)
              }
              update.run(row.payload, session.id, row.seq)
            }
            markEvents.run(session.id, cursor)
          })()
        if (result.eventRows >= limit) {
          result.complete = false
          return
        }
      }
      if (!dryRun) markEvents.run(session.id, session.last_seq)
    }
  }

  function dropDeltas(result: CompactResult, idleDays: number, protect: ReadonlySet<string>, dryRun: boolean) {
    const cutoff = now() - idleDays * DAY_MS
    const sessions = db
      .query<{ id: string; last_seq: number }, [number]>(
        `SELECT s.id, s.last_seq FROM sessions s LEFT JOIN storage_marks m ON m.session_id = s.id
         WHERE s.updated_at <= ? AND s.active_turn IS NULL AND s.last_seq > COALESCE(m.deltas_seq, 0)`,
      )
      .all(cutoff)
      .filter((row) => !protect.has(row.id))
    const count = db.query<{ n: number; bytes: number | null }, [string]>(`SELECT COUNT(*) AS n, SUM(octet_length(payload)) AS bytes FROM events WHERE session_id = ? AND ${deltaTarget}
      AND NOT EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.parent_id = events.session_id AND p.parent_seq = events.seq)`)
    const remove = db.query(`DELETE FROM events WHERE session_id = ? AND ${deltaTarget}
      AND NOT EXISTS (SELECT 1 FROM transcript_prefix p WHERE p.parent_id = events.session_id AND p.parent_seq = events.seq)`)
    for (const { id, last_seq } of sessions) {
      if (dryRun) {
        const row = count.get(id)
        result.deltaEvents += row?.n ?? 0
        result.candidateBytes += row?.bytes ?? 0
      } else {
        result.deltaEvents += remove.run(id).changes
        markDeltas.run(id, last_seq)
      }
    }
  }

  return { extras, compact }
}
