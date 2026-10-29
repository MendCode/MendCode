import type { Database } from "bun:sqlite"
import { SessionEvent, TIMELINE_PREVIEW_CHARS, type ChangesReport, type SessionId } from "@mendcode/protocol"
import { createCodec, DEDUP_MIN_BYTES, type Codec } from "./compress"
import { createEngineHistory, type EngineHistory } from "./engine-history"

/** The `\0MZ1` header of a wrapped value, and of a content-addressed reference, as SQL blob literals. */
const MAGIC_SQL = "X'004D5A31'"
const REF_SQL = "X'004D5A3146'"

export type TurnStatus = "running" | "completed" | "cancelled" | "failed" | "interrupted"

/** One turn as the `turns` projection holds it (see schema.ts). `history` is undefined for turns recorded before marks existed. */
export type TurnRecord = {
  turnId: string
  seq: number
  at: number
  /** The user message that started the turn; undefined for a compaction turn. */
  itemId?: string
  preview: string
  status: TurnStatus
  reverted: boolean
  /** The user's own `!command`. */
  shell: boolean
  /** A system notice (a background task finished), not typed by the user. */
  notice: boolean
  compacted: boolean
  /** The turn ran a shell tool: what it changed is not tracked. */
  shellTool: boolean
  /**
   * How many model messages each engine held when the turn started. An engine missing from the map held none; `null`
   * means the engine's history was rewritten since (compaction) and the count is gone. Undefined for a turn recorded
   * before marks existed.
   */
  history?: Record<string, number | null>
}

/** Where `engine`'s model history stood when the turn started; undefined when that is no longer (or was never) known. */
export function historyMark(turn: Pick<TurnRecord, "history">, engine: string): number | undefined {
  if (!turn.history) return undefined
  const mark = turn.history[engine]
  return mark === undefined ? 0 : (mark ?? undefined)
}

type TurnRow = {
  turn_id: string
  seq: number
  at: number
  item_id: string | null
  preview: string
  status: string
  reverted: number
  shell: number
  notice: number
  compacted: number
  shell_tool: number
  history: string | null
}

function parseHistory(text: string | null): Record<string, number | null> | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const out: Record<string, number | null> = {}
    for (const [engine, count] of Object.entries(parsed)) out[engine] = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null
    return out
  } catch {
    return undefined
  }
}

function toRecord(row: TurnRow): TurnRecord {
  const history = parseHistory(row.history)
  return {
    turnId: row.turn_id,
    seq: row.seq,
    at: row.at,
    ...(row.item_id ? { itemId: row.item_id } : {}),
    preview: row.preview,
    status: (["completed", "cancelled", "failed", "interrupted"] as const).find((status) => status === row.status) ?? "running",
    reverted: row.reverted === 1,
    shell: row.shell === 1,
    notice: row.notice === 1,
    compacted: row.compacted === 1,
    shellTool: row.shell_tool === 1,
    ...(history ? { history } : {}),
  }
}

/** The first characters of a user message on one line, for timeline entries. */
export function previewOf(text: string) {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, TIMELINE_PREVIEW_CHARS).join("")
}

const isShellTool = (tool: unknown) => typeof tool === "string" && /^shell(?::|$)/.test(tool)

const END_STATUS = { "turn.completed": "completed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted", "turn.failed": "failed" } as const

/** Turns whose file snapshots are kept per session; older ones can no longer be undone with their files. */
export const SNAPSHOT_TURNS_KEPT = 20

/** What a file looked like at one moment. `skipped`: no content was kept (binary, over the turn's byte budget, unreadable). */
export type FileState = { state: "content"; content: Uint8Array; mode?: number } | { state: "absent" } | { state: "skipped"; reason: "binary" | "too_large" | "unreadable" }
export type FileSnapshot = { path: string; before: FileState; after?: FileState }
export type SnapshotRecord = { root: string; scope: "tools" | "worktree" | "off"; complete: boolean; sealed: boolean; paths?: string[]; summary?: ChangesReport }

/** A part-level revert waiting for redo: the turn, the part it started at and the files it put back. */
export type PartialRevert = { turnId: string; itemId: string; paths: string[] }
export type CallFileSnapshot = { itemId: string; path: string; before: FileState }
type CallRow = { item_id: string; path: string; before_state: string; before_content: Uint8Array | null; before_mode: number | null; skip_reason: string | null }

type FileRow = { path: string; before_state: string; before_content: Uint8Array | null; before_mode: number | null; skip_reason: string | null; after_state: string | null; after_content: Uint8Array | null; after_mode: number | null; after_skip_reason: string | null }

type ContentReader = (value: Uint8Array | null) => Uint8Array | undefined

function stateOf(state: string | null, content: Uint8Array | null, mode: number | null, reason: string | null, read: ContentReader): FileState | undefined {
  if (state === "content") {
    const bytes = read(content)
    // A content-addressed object that is gone (it should never be) reads as an unreadable file, not as an empty one.
    if (!bytes) return { state: "skipped", reason: "unreadable" }
    return { state, content: bytes, ...(mode !== null ? { mode } : {}) }
  }
  if (state === "absent") return { state }
  if (state === "skipped") return { state, reason: reason === "binary" || reason === "too_large" ? reason : "unreadable" }
  return undefined
}

/**
 * The per-turn projection, the turn file snapshots and the undo stack's model-message stash. Every method is a plain
 * query; the store calls `record` inside the transaction that appends the event, so these rows never lag the log.
 */
export function createTurns(input: { db: Database; codec?: Codec; history?: EngineHistory; writeTurn?: (sessionId: string, turnId: string) => void }) {
  const { db } = input
  const history = input.history ?? createEngineHistory(db)
  const codec = input.codec ?? createCodec()
  const readObject = db.query<{ z: number; data: Uint8Array }, [string]>("SELECT z, data FROM snap_objects WHERE sha256 = ?")
  const putObject = db.query("INSERT OR IGNORE INTO snap_objects(sha256, bytes, z, data) VALUES (?, ?, ?, ?)")
  /** File content as the snapshot rows keep it: compressed and shared between rows (and turns) that hold the same bytes. */
  const packContent = (content: Uint8Array | null) => (content === null ? null : codec.packContent(content, (object) => void putObject.run(object.sha256, object.bytes, object.z ? 1 : 0, object.data)))
  const readContent: ContentReader = (value) =>
    codec.unpackContent(value, (sha256) => {
      const row = readObject.get(sha256)
      return row ? { z: row.z === 1, data: row.data } : undefined
    })
  /** Removes content-addressed objects no snapshot row references any more; returns how many. */
  function sweepObjects(): number {
    const referenced = [["turn_files", "before_content"], ["turn_files", "after_content"], ["turn_call_files", "before_content"]]
      .map(([table, column]) => `SELECT lower(hex(substr(${column}, 10, 32))) FROM ${table} WHERE substr(${column}, 1, 5) = ${REF_SQL}`)
      .join(" UNION ")
    return db.query(`DELETE FROM snap_objects WHERE sha256 NOT IN (${referenced})`).run().changes
  }
  /** Snapshot rows pruned since the last sweep: the objects they pointed at go once enough rows have, not on every turn. */
  let prunedSinceSweep = 0
  const SWEEP_AFTER_ROWS = 300
  const sumContent = (rows: Array<{ content: Uint8Array | null }>) => rows.reduce((total, row) => total + codec.contentBytes(row.content), 0)
  const q = {
    insert: db.query("INSERT OR IGNORE INTO turns(session_id, turn_id, seq, at, history) VALUES (?, ?, ?, ?, ?)"),
    // A notice read inside a turn (a background task ended while it worked) never replaces the message the turn already answers:
    // the turn stays the user's, with its item, for history, undo and edits.
    userItem: db.query("UPDATE turns SET item_id = ?3, shell = ?4, notice = ?5 WHERE session_id = ?1 AND turn_id = ?2 AND (?5 = 0 OR item_id IS NULL)"),
    flag: {
      compacted: db.query("UPDATE turns SET compacted = 1 WHERE session_id = ? AND turn_id = ?"),
      shellTool: db.query("UPDATE turns SET shell_tool = 1 WHERE session_id = ? AND turn_id = ?"),
    },
    preview: db.query("UPDATE turns SET preview = ? WHERE session_id = ? AND item_id = ? AND preview = ''"),
    revisedPreview: db.query("UPDATE turns SET preview = ? WHERE session_id = ? AND item_id = ?"),
    status: db.query("UPDATE turns SET status = ? WHERE session_id = ? AND turn_id = ?"),
    reverted: db.query("UPDATE turns SET reverted = ? WHERE session_id = ? AND turn_id = ?"),
    list: db.query<TurnRow, [string]>("SELECT turn_id, seq, at, item_id, preview, status, reverted, shell, notice, compacted, shell_tool, history FROM turns_read WHERE session_id = ? ORDER BY seq"),
    covering: db.query<{ seq: number; reverted: number }, [string, number, number]>("SELECT seq, reverted FROM turns_read WHERE session_id = ?1 AND seq <= ?3 AND seq >= COALESCE((SELECT MAX(seq) FROM turns_read WHERE session_id = ?1 AND seq <= ?2), 0) ORDER BY seq"),
    one: db.query<TurnRow, [string, string]>("SELECT turn_id, seq, at, item_id, preview, status, reverted, shell, notice, compacted, shell_tool, history FROM turns_read WHERE session_id = ? AND turn_id = ?"),
    byItem: db.query<TurnRow, [string, string]>("SELECT turn_id, seq, at, item_id, preview, status, reverted, shell, notice, compacted, shell_tool, history FROM turns_read WHERE session_id = ? AND item_id = ?"),
    setHistory: db.query("UPDATE turns SET history = ? WHERE session_id = ? AND turn_id = ?"),
    dropMarks: db.query("UPDATE turns SET history = json_set(history, ?, NULL) WHERE session_id = ? AND history IS NOT NULL"),
    clearStack: db.query("DELETE FROM undo_stack WHERE session_id = ?"),
    clearStash: db.query("DELETE FROM undone_messages WHERE session_id = ?"),
    pruneFiles: db.query(
      "DELETE FROM turn_files WHERE session_id = ?1 AND (turn_id IN (SELECT turn_id FROM turns_read WHERE session_id = ?1 AND reverted = 1) OR turn_id NOT IN (SELECT turn_id FROM turns_read WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2))",
    ),
    pruneCalls: db.query(
      "DELETE FROM turn_call_files WHERE session_id = ?1 AND (turn_id IN (SELECT turn_id FROM turns_read WHERE session_id = ?1 AND reverted = 1) OR turn_id NOT IN (SELECT turn_id FROM turns_read WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2))",
    ),
    callInsert: db.query("INSERT OR IGNORE INTO turn_call_files(session_id, turn_id, item_id, path, before_state, before_content, before_mode, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    callList: db.query<CallRow, [string, string]>("SELECT item_id, path, before_state, before_content, before_mode, skip_reason FROM turn_call_files WHERE session_id = ? AND turn_id = ?"),
    callBytes: db.query<{ content: Uint8Array | null }, [string, string]>("SELECT before_content AS content FROM turn_call_files WHERE session_id = ? AND turn_id = ?"),
    fileInsert: db.query("INSERT OR IGNORE INTO turn_files(session_id, turn_id, path, before_state, before_content, before_mode, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    fileSeal: db.query("UPDATE turn_files SET after_state = ?, after_content = ?, after_mode = ?, after_skip_reason = ? WHERE session_id = ? AND turn_id = ? AND path = ? AND after_state IS NULL"),
    fileList: db.query<FileRow, [string, string]>("SELECT path, before_state, before_content, before_mode, skip_reason, after_state, after_content, after_mode, after_skip_reason FROM turn_files WHERE session_id = ? AND turn_id = ? ORDER BY path"),
    fileHas: db.query<{ one: number }, [string, string, string]>("SELECT 1 AS one FROM turn_files WHERE session_id = ? AND turn_id = ? AND path = ?"),
    fileBytes: db.query<{ content: Uint8Array | null }, [string, string]>("SELECT before_content AS content FROM turn_files WHERE session_id = ? AND turn_id = ?"),
    fileDrop: db.query("DELETE FROM turn_files WHERE session_id = ? AND turn_id = ? AND path = ?"),
    snapshotGet: db.query<{ payload: string }, [string, string]>("SELECT payload FROM turn_snapshots WHERE session_id = ? AND turn_id = ?"),
    snapshotPut: db.query("INSERT OR REPLACE INTO turn_snapshots(session_id, turn_id, payload) VALUES (?, ?, ?)"),
    stackNext: db.query<{ n: number | null }, [string]>("SELECT MAX(n) AS n FROM undo_stack WHERE session_id = ?"),
    stackPush: db.query("INSERT INTO undo_stack(session_id, n, turn_ids, partial) VALUES (?, ?, ?, ?)"),
    stackTop: db.query<{ n: number; turn_ids: string; partial: string | null }, [string]>("SELECT n, turn_ids, partial FROM undo_stack WHERE session_id = ? ORDER BY n DESC LIMIT 1"),
    stackCount: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM undo_stack WHERE session_id = ?"),
    stackDrop: db.query("DELETE FROM undo_stack WHERE session_id = ? AND n = ?"),
    stash: db.query("INSERT INTO undone_messages(session_id, n, engine, idx, payload) VALUES (?, ?, ?, ?, ?)"),
    stashed: db.query<{ engine: string; idx: number; payload: string }, [string, number]>("SELECT engine, idx, payload FROM undone_messages WHERE session_id = ? AND n = ? ORDER BY engine, idx"),
    stashDrop: db.query("DELETE FROM undone_messages WHERE session_id = ? AND n = ?"),
  }

  /** How many model messages each engine holds for the session right now (a fork's shared prefix counts). */
  function messageCounts(sessionId: SessionId): Record<string, number> {
    return Object.fromEntries(history.engines(sessionId).map((engine) => [engine, history.count(sessionId, engine)]))
  }

  function startTurn(sessionId: string, turnId: string, seq: number, at: number, history: string | null) {
    q.insert.run(sessionId, turnId, seq, at, history)
  }

  /** The projection update for one appended event. */
  function record(event: SessionEvent) {
    const turnId = "turnId" in event ? event.turnId : "itemId" in event
      ? db.query<{ turn_id: string }, [string, string]>("SELECT turn_id FROM turns_read WHERE session_id = ? AND item_id = ?").get(event.sessionId, event.itemId)?.turn_id
      : undefined
    if (turnId && event.type !== "turn.started") input.writeTurn?.(event.sessionId, turnId)
    switch (event.type) {
      case "turn.started":
        startTurn(event.sessionId, event.turnId, event.seq, event.at, JSON.stringify(messageCounts(event.sessionId as SessionId)))
        // Something new happened: nothing can be redone any more, and the snapshots of undone turns are dead weight.
        q.clearStack.run(event.sessionId)
        q.clearStash.run(event.sessionId)
        prunedSinceSweep += q.pruneFiles.run(event.sessionId, SNAPSHOT_TURNS_KEPT).changes + q.pruneCalls.run(event.sessionId, SNAPSHOT_TURNS_KEPT).changes
        if (prunedSinceSweep >= SWEEP_AFTER_ROWS) {
          prunedSinceSweep = 0
          sweepObjects()
        }
        return
      case "item.started":
        if (event.kind === "user_message") q.userItem.run(event.sessionId, event.turnId, event.itemId, event.meta?.shell === true ? 1 : 0, event.meta?.notice === true ? 1 : 0)
        else if (event.kind === "compaction") q.flag.compacted.run(event.sessionId, event.turnId)
        else if (event.kind === "tool_call" && isShellTool(event.meta?.tool)) q.flag.shellTool.run(event.sessionId, event.turnId)
        return
      case "item.completed":
        if (event.text !== undefined) q.preview.run(previewOf(event.text), event.sessionId, event.itemId)
        return
      case "message.revised":
        q.revisedPreview.run(previewOf(event.deleted ? "" : event.snapshot.text ?? ""), event.sessionId, event.itemId)
        return
      case "turn.completed":
      case "turn.cancelled":
      case "turn.interrupted":
      case "turn.failed":
        q.status.run(END_STATUS[event.type], event.sessionId, event.turnId)
        return
      case "turn.reverted":
        q.reverted.run(1, event.sessionId, event.turnId)
        return
      case "turn.restored":
        q.reverted.run(0, event.sessionId, event.turnId)
        return
    }
  }

  /**
   * Builds the projection for the log written before it existed, once (the caller guards it with a meta key). Live
   * appends are not running yet, so the rows come only from here. A user message's text is the event right after its
   * `item.started` (the actor emits them together).
   */
  function backfill() {
    const rows = db.query<{ session_id: string; seq: number; type: string; at: number; payload: string }, []>(`
      SELECT session_id, seq, type, at, payload FROM events
      WHERE type IN ('turn.started', 'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.failed', 'turn.reverted', 'turn.restored')
         OR (type = 'item.started' AND (payload LIKE '%"kind":"user_message"%' OR payload LIKE '%"kind":"compaction"%' OR payload LIKE '%"tool":"shell%'))
      ORDER BY session_id, seq`)
    const next = db.query<{ payload: string }, [string, number]>("SELECT payload FROM events WHERE session_id = ? AND seq = ? AND type = 'item.completed'")
    for (const row of rows.iterate()) {
      let event: SessionEvent
      try {
        event = JSON.parse(row.payload) as SessionEvent
      } catch {
        continue
      }
      if (event.type === "turn.started") {
        startTurn(row.session_id, event.turnId, row.seq, row.at, null)
        continue
      }
      record(event)
      if (event.type === "item.started" && event.kind === "user_message") {
        const completed = next.get(row.session_id, row.seq + 1)
        if (completed) {
          const done = JSON.parse(completed.payload) as SessionEvent
          if (done.type === "item.completed" && done.itemId === event.itemId && done.text !== undefined) q.preview.run(previewOf(done.text), row.session_id, event.itemId)
        }
      }
    }
  }

  return {
    record,
    backfill,
    messageCounts,
    list(sessionId: SessionId): TurnRecord[] {
      return q.list.all(sessionId).map(toRecord)
    },
    /** The turns covering events `fromSeq` to `toSeq` (the one started last at or before `fromSeq`, then every later one up to `toSeq`), oldest first: seq and whether undone. */
    covering(sessionId: SessionId, fromSeq: number, toSeq: number): Array<{ seq: number; reverted: boolean }> {
      return q.covering.all(sessionId, fromSeq, toSeq).map((row) => ({ seq: row.seq, reverted: row.reverted === 1 }))
    },
    get(sessionId: SessionId, turnId: string): TurnRecord | undefined {
      const row = q.one.get(sessionId, turnId)
      return row ? toRecord(row) : undefined
    },
    byItem(sessionId: SessionId, itemId: string): TurnRecord | undefined {
      const row = q.byItem.get(sessionId, itemId)
      return row ? toRecord(row) : undefined
    },
    /** Stores marks worked out for a turn that had none (older sessions). */
    setHistory(sessionId: SessionId, turnId: string, history: Record<string, number>) {
      input.writeTurn?.(sessionId, turnId)
      q.setHistory.run(JSON.stringify(history), sessionId, turnId)
    },
    /** The engine's history was rewritten (compaction): the counts older turns recorded for it no longer point anywhere. */
    dropMarks(sessionId: SessionId, engine: string) {
      for (const turn of q.list.all(sessionId)) input.writeTurn?.(sessionId, turn.turn_id)
      q.dropMarks.run(`$."${engine.replaceAll('"', "")}"`, sessionId)
    },
    files: {
      drop(sessionId: SessionId, turnId: string, path: string) {
        q.fileDrop.run(sessionId, turnId, path)
      },
      /** Bytes of content this turn's snapshot already holds (its budget use). */
      usedBytes(sessionId: SessionId, turnId: string): number {
        return sumContent(q.fileBytes.all(sessionId, turnId))
      },
      has(sessionId: SessionId, turnId: string, path: string): boolean {
        return q.fileHas.get(sessionId, turnId, path) !== null
      },
      /** Keeps the file's state before the turn's first change; a path already held stays as it was. False when it was held. */
      captureBefore(sessionId: SessionId, turnId: string, path: string, before: FileState): boolean {
        const content = before.state === "content" ? packContent(before.content) : null
        const mode = before.state === "content" ? (before.mode ?? null) : null
        const reason = before.state === "skipped" ? before.reason : null
        return q.fileInsert.run(sessionId, turnId, path, before.state, content, mode, reason).changes === 1
      },
      /** Records the file's state when the turn ended; only the first seal of a path counts. */
      seal(sessionId: SessionId, turnId: string, path: string, after: FileState) {
        q.fileSeal.run(after.state, after.state === "content" ? packContent(after.content) : null, after.state === "content" ? after.mode ?? null : null, after.state === "skipped" ? after.reason : null, sessionId, turnId, path)
      },
      list(sessionId: SessionId, turnId: string): FileSnapshot[] {
        return q.fileList.all(sessionId, turnId).flatMap((row) => {
          const before = stateOf(row.before_state, row.before_content, row.before_mode, row.skip_reason, readContent)
          if (!before) return []
          const after = stateOf(row.after_state, row.after_content, row.after_mode, row.after_skip_reason, readContent)
          return [{ path: row.path, before, ...(after ? { after } : {}) }]
        })
      },
    },
    calls: {
      /** Bytes of content the turn's per-call snapshots hold. */
      usedBytes(sessionId: SessionId, turnId: string): number {
        return sumContent(q.callBytes.all(sessionId, turnId))
      },
      /** Keeps the file's state before one tool call changed it; a (call, path) already held stays as it was. */
      capture(sessionId: SessionId, turnId: string, itemId: string, path: string, before: FileState) {
        const content = before.state === "content" ? packContent(before.content) : null
        const mode = before.state === "content" ? (before.mode ?? null) : null
        const reason = before.state === "skipped" ? before.reason : null
        q.callInsert.run(sessionId, turnId, itemId, path, before.state, content, mode, reason)
      },
      list(sessionId: SessionId, turnId: string): CallFileSnapshot[] {
        return q.callList.all(sessionId, turnId).flatMap((row) => {
          const before = stateOf(row.before_state, row.before_content, row.before_mode, row.skip_reason, readContent)
          return before ? [{ itemId: row.item_id, path: row.path, before }] : []
        })
      },
    },
    /** Disk upkeep of the snapshot content: old raw rows move to the compressed, shared form; objects nothing points at go. */
    storage: {
      /** Rewrites up to `limit` rows (per column) that still hold raw file content; returns how many it changed. */
      compact(limit: number): number {
        if (!codec.enabled) return 0
        let changed = 0
        const targets = [
          { table: "turn_files", keys: ["session_id", "turn_id", "path"], column: "before_content" },
          { table: "turn_files", keys: ["session_id", "turn_id", "path"], column: "after_content" },
          { table: "turn_call_files", keys: ["session_id", "turn_id", "item_id", "path"], column: "before_content" },
        ]
        for (const { table, keys, column } of targets) {
          const raw = `typeof(${column}) = 'blob' AND length(${column}) >= ${DEDUP_MIN_BYTES} AND substr(${column}, 1, 4) <> ${MAGIC_SQL}`
          const rows = db.query<Record<string, string | Uint8Array>, [number]>(`SELECT ${keys.join(", ")}, ${column} AS content FROM ${table} WHERE ${raw} LIMIT ?`).all(limit)
          const update = db.query(`UPDATE ${table} SET ${column} = ? WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`)
          for (const row of rows) {
            update.run(packContent(row.content as Uint8Array), ...keys.map((key) => row[key] as string))
            changed++
          }
        }
        return changed
      },
      sweep: sweepObjects,
      stats(): { objects: number; objectBytes: number; rawBytes: number } {
        const row = db.query<{ n: number; stored: number | null; raw: number | null }, []>("SELECT COUNT(*) AS n, SUM(length(data)) AS stored, SUM(bytes) AS raw FROM snap_objects").get()
        return { objects: row?.n ?? 0, objectBytes: row?.stored ?? 0, rawBytes: row?.raw ?? 0 }
      },
    },
    snapshots: {
      get(sessionId: SessionId, turnId: string): SnapshotRecord | undefined {
        const row = q.snapshotGet.get(sessionId, turnId)
        return row ? JSON.parse(row.payload) as SnapshotRecord : undefined
      },
      put(sessionId: SessionId, turnId: string, record: SnapshotRecord) {
        q.snapshotPut.run(sessionId, turnId, JSON.stringify(record))
      },
    },
    undo: {
      top(sessionId: SessionId): { n: number; turnIds: string[]; partial?: PartialRevert } | undefined {
        const row = q.stackTop.get(sessionId)
        return row ? { n: row.n, turnIds: JSON.parse(row.turn_ids) as string[], ...(row.partial ? { partial: JSON.parse(row.partial) as PartialRevert } : {}) } : undefined
      },
      /** How many undo groups wait for a redo. */
      depth(sessionId: SessionId): number {
        return q.stackCount.get(sessionId)?.n ?? 0
      },
      /** Takes the messages from `cuts[engine]` on out of every engine's history into the stash and records the undone turns. Returns how many messages left. */
      push(sessionId: SessionId, turnIds: string[], cuts: Record<string, number>, partial?: PartialRevert): number {
        const n = Number(q.stackNext.get(sessionId)?.n ?? 0) + 1
        let removed = 0
        for (const [engine, cut] of Object.entries(cuts)) {
          for (const row of history.rows(sessionId, engine, cut)) {
            q.stash.run(sessionId, n, engine, row.idx, row.payload)
            removed++
          }
          history.cut(sessionId, engine, cut)
        }
        q.stackPush.run(sessionId, n, JSON.stringify(turnIds), partial ? JSON.stringify(partial) : null)
        return removed
      },
      /** The messages the top entry took out, by engine. */
      stashed(sessionId: SessionId, n: number) {
        return q.stashed.all(sessionId, n)
      },
      /**
       * Puts the top entry's messages back and drops it. Throws a RangeError when an engine's history is no longer the
       * exact prefix the messages were cut from (nothing else should have written it).
       */
      pop(sessionId: SessionId, n: number): number {
        const rows = q.stashed.all(sessionId, n)
        const first = new Map<string, number>()
        for (const row of rows) if (!first.has(row.engine)) first.set(row.engine, row.idx)
        for (const [engine, idx] of first) if (history.count(sessionId, engine) !== idx) throw new RangeError(`[STORE]: the ${engine} history changed after the undo`)
        for (const row of rows) history.insert(sessionId, row.engine, row.idx, row.payload)
        q.stashDrop.run(sessionId, n)
        q.stackDrop.run(sessionId, n)
        return rows.length
      },
    },
  }
}
export type TurnsStore = ReturnType<typeof createTurns>
