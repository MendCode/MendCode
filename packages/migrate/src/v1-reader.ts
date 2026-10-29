import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { MigrateError } from "./errors"
import { V1_DB_FILE } from "./settings"

export type JsonRecord = Record<string, unknown>

export type V1Session = {
  id: string
  parentId: string | null
  directory: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
}
export type V1Message = { id: string; createdAt: number | null; data: JsonRecord }
export type V1Part = { id: string; createdAt: number | null; data: JsonRecord }

type SessionRow = {
  id: string
  parent_id: string | null
  directory: string
  worktree: string | null
  title: string
  time_created: number
  time_updated: number
  time_archived: number | null
}

/** True for a plain JSON object. */
export const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)

function parseRecord(text: string, what: string): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new SyntaxError(`${what}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(value)) throw new TypeError(`${what}: not a JSON object`)
  return value
}

const fileBytes = (file: string) => (existsSync(file) ? statSync(file).size : 0)

type OpenedV1 = { db: Database; release: () => void }
export type OpenV1Options = {
  /** False skips the `file:` URI open, as an SQLite built without URI filename support behaves (Bun's own build on Linux). */
  immutableUri?: boolean
}

/**
 * A private copy of a v1 database that has no live log, in a temp directory of its own. A read-only connection to a
 * write-ahead-log database cannot be opened without its log files, so the copy (never a link: the v1 file must stay
 * untouched) is opened read-write and then made `query_only`; SQLite creates its `-shm`/`-wal` beside the copy.
 */
function snapshot(file: string): OpenedV1 {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-v1-"))
  const release = () => rmSync(dir, { recursive: true, force: true })
  try {
    const copy = path.join(dir, path.basename(file))
    copyFileSync(file, copy)
    return { db: new Database(copy), release }
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Opens the v1 database without ever writing to its directory. With a live write-ahead log the connection is a
 * plain read-only one (the log must be read; its files already exist). Without one the file is complete and is
 * opened `immutable`, so SQLite creates no `-shm`/`-wal` files next to it (a plain read-only open of a WAL database
 * would try to, and fails when it cannot). The `immutable` flag needs a `file:` URI; where the SQLite build does not
 * take URI filenames (the open fails), the complete file is opened from a private snapshot instead.
 */
function openReadonly(file: string, { immutableUri = true }: OpenV1Options): OpenedV1 {
  if (fileBytes(`${file}-wal`) > 0) {
    const db = new Database(file, { readonly: true })
    db.run("PRAGMA query_only = ON")
    return { db, release: () => {} }
  }
  let uriError: string | undefined
  if (immutableUri) {
    let db: Database | undefined
    try {
      db = new Database(`${pathToFileURL(file).href}?immutable=1`, { readonly: true })
      db.query("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      db.run("PRAGMA query_only = ON")
      return { db, release: () => {} }
    } catch (error) {
      uriError = error instanceof Error ? error.message : String(error)
      db?.close()
    }
  }
  try {
    const opened = snapshot(file)
    opened.db.run("PRAGMA query_only = ON")
    return opened
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(uriError === undefined ? reason : `${reason} (immutable open: ${uriError})`)
  }
}

/** Read-only access to the parts of the v1 database the import needs. One session's rows are read at a time. */
export function openV1(fromDir: string, options: OpenV1Options = {}) {
  const file = path.join(fromDir, V1_DB_FILE)
  let db: Database
  let release = () => {}
  try {
    const opened = openReadonly(file, options)
    db = opened.db
    release = opened.release
    db.query("SELECT 1 FROM session LIMIT 1").get()
  } catch (error) {
    release()
    throw new MigrateError("v1-open", `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const sessionSql = `SELECT s.id AS id, s.parent_id AS parent_id, s.directory AS directory, p.worktree AS worktree, s.title AS title,
      s.time_created AS time_created, s.time_updated AS time_updated, s.time_archived AS time_archived
    FROM session s LEFT JOIN project p ON p.id = s.project_id`
  const toSession = (row: SessionRow): V1Session => ({
    id: row.id,
    parentId: row.parent_id,
    directory: row.directory || row.worktree || "/",
    title: row.title,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    archived: row.time_archived !== null && row.time_archived !== undefined,
  })
  const listSessions = db.query<SessionRow, [number | null]>(`${sessionSql} WHERE (?1 IS NULL OR s.time_updated >= ?1) ORDER BY s.time_created, s.id`)
  const countSessions = db.query<{ n: number }, [number | null]>("SELECT COUNT(*) AS n FROM session WHERE (?1 IS NULL OR time_updated >= ?1)")
  const oneSession = db.query<SessionRow, [string]>(`${sessionSql} WHERE s.id = ?`)
  const hasMessages = db.query<{ found: number }, [string]>("SELECT EXISTS(SELECT 1 FROM message WHERE session_id = ?) AS found")
  const listMessages = db.query<{ id: string; time_created: number | null; data: string }, [string]>("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
  const listParts = db.query<{ id: string; time_created: number | null; data: string }, [string]>("SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY id")

  return {
    sessionCount: (since: number | undefined) => countSessions.get(since ?? null)?.n ?? 0,
    /** Sessions ordered by creation (parents normally come first). Rows are light: no message or part is read here. */
    *sessions(since: number | undefined) {
      for (const row of listSessions.iterate(since ?? null)) yield toSession(row)
    },
    session(id: string): V1Session | undefined {
      const row = oneSession.get(id)
      return row ? toSession(row) : undefined
    },
    hasMessages: (sessionId: string) => hasMessages.get(sessionId)?.found === 1,
    /** All messages of one session in order; throws on a message that is not valid JSON. */
    messages(sessionId: string): V1Message[] {
      return listMessages.all(sessionId).map((row) => ({ id: row.id, createdAt: row.time_created, data: parseRecord(row.data, `message ${row.id}`) }))
    },
    /** The parts of one message in order; throws on a part that is not valid JSON. */
    parts(messageId: string): V1Part[] {
      return listParts.all(messageId).map((row) => ({ id: row.id, createdAt: row.time_created, data: parseRecord(row.data, `part ${row.id}`) }))
    },
    close() {
      db.close()
      release()
    },
  }
}
export type V1Reader = ReturnType<typeof openV1>
