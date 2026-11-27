import { Database } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync } from "node:fs"
import path from "node:path"
import { acquireWriterLock } from "@mendcode/store"

const clean = (value: string, label: string) => {
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value
  if (!path.isAbsolute(trimmed) || trimmed === "/") throw new Error(`[STORE]: ${label} must be an absolute folder other than /`)
  return trimmed
}

/** The folder fields (`directory`, `cwd`) of a stored JSON value that are `from` or inside it, moved under `to`; everything else is left as it is. */
function movePaths(value: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  const move = (text: string) => (text === from || text.startsWith(`${from}/`) ? `${to}${text.slice(from.length)}` : text)
  let changed = false
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => {
        if ((key === "directory" || key === "cwd") && typeof child === "string") {
          const moved = move(child)
          if (moved !== child) changed = true
          return [key, moved]
        }
        return [key, walk(child)]
      }))
    }
    return node
  }
  const result = walk(value)
  return { value: result, changed }
}

/**
 * Explicit offline maintenance: every stored folder at or under `from` moves under `to` (sessions, prompt history, workflows, project
 * memories: each table with a `directory` column). Whole path segments only (`/a/Code` never matches `/a/Codex`). The lock excludes
 * the daemon; a full copy of the database is written first and kept.
 */
export function moveStoredDirectories(input: { dir: string; from: string; to: string; dryRun?: boolean; now?: () => number }) {
  const from = clean(input.from, "the old folder")
  const to = clean(input.to, "the new folder")
  if (from === to) throw new Error("[STORE]: the old and the new folder are the same")
  const dir = path.resolve(input.dir)
  const file = path.join(dir, "mendd.db")
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error("[STORE]: --dir must contain a regular mendd.db")
  const lock = acquireWriterLock(path.join(dir, "mendd.lock"))
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: input.dryRun === true, strict: true })
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      .map((row) => row.name)
      .filter((name) => db!.query<{ name: string }, []>(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().some((column) => column.name === "directory"))
    const matches = `(directory = $from OR substr(directory, 1, length($from) + 1) = $from || '/')`
    const counts: Record<string, number> = {}
    for (const table of tables) {
      const count = db.query<{ n: number }, [{ from: string }]>(`SELECT count(*) AS n FROM "${table}" WHERE ${matches}`).get({ from })!.n
      if (count) counts[table] = count
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    if (input.dryRun || total === 0) return { dryRun: input.dryRun === true, from, to, moved: counts, total }
    const backup = path.join(dir, `mendd.db.before-move-${(input.now ?? Date.now)()}`)
    db.run("VACUUM INTO ?", [backup])
    chmodSync(backup, 0o600)
    db.run("BEGIN IMMEDIATE")
    try {
      for (const table of Object.keys(counts)) db.query(`UPDATE "${table}" SET directory = $to || substr(directory, length($from) + 1) WHERE ${matches}`).run({ from, to })
      // A workflow's folder and its tasks' folders live in its stored payload (the column is only an index of it), and the journal of a script run records them too.
      for (const [table, key] of [["workflows", "id"], ["workflow_journal", "workflow_id, key"]] as const) {
        if (!db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue
        const columns = key.split(", ")
        const update = db.query(`UPDATE "${table}" SET payload = $payload${table === "workflow_journal" ? ", bytes = $bytes" : ""} WHERE ${columns.map((column) => `${column} = $${column}`).join(" AND ")}`)
        for (const row of db.query<Record<string, string>, [string]>(`SELECT ${key}, payload FROM "${table}" WHERE instr(payload, ?) > 0`).all(from)) {
          let parsed: unknown
          try { parsed = JSON.parse(row.payload!) } catch { continue }
          const moved = movePaths(parsed, from, to)
          if (!moved.changed) continue
          const payload = JSON.stringify(moved.value)
          update.run({ payload, ...(table === "workflow_journal" ? { bytes: Buffer.byteLength(payload) } : {}), ...Object.fromEntries(columns.map((column) => [column, row[column]!])) })
        }
      }
      db.run("COMMIT")
    } catch (error) {
      db.run("ROLLBACK")
      throw error
    }
    return { dryRun: false, from, to, moved: counts, total, backup }
  } finally {
    db?.close()
    lock.release()
  }
}
