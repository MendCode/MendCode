import { Database } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync } from "node:fs"
import path from "node:path"
import { acquireWriterLock } from "@mendcode/store"

const clean = (value: string, label: string) => {
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value
  if (!path.isAbsolute(trimmed) || trimmed === "/") throw new Error(`[STORE]: ${label} must be an absolute folder other than /`)
  return trimmed
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
