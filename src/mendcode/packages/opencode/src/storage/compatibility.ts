import { init } from "#db"
import { existsSync, mkdirSync, chmodSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { MigrationIdentity } from "./migration-journal"
import { acquireWriterLease } from "./writer-lease"
import { reportBackendPhase } from "../installation/backend-startup"

type Reader = Pick<ReturnType<typeof init>, "all" | "run">
export type Compatibility = { compatible: boolean; reason?: string; pending: string[]; legacy: boolean }

function inspect(db: Reader, supported: MigrationIdentity[]): Compatibility {
  const tables = new Set(
    db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name),
  )
  const known = new Map(supported.map((entry) => [entry.name, entry]))
  const rows = tables.has("__drizzle_migrations")
    ? db.all<{ name: string; created_at: number }>("SELECT name, created_at FROM __drizzle_migrations")
    : []
  const incompatible = rows.find(
    (row) => !known.has(row.name) || known.get(row.name)!.timestamp !== Number(row.created_at),
  )
  if (incompatible)
    return {
      compatible: false,
      reason: `Unsupported database migration: ${incompatible.name ?? "unnamed"}`,
      pending: [],
      legacy: true,
    }
  const identities = tables.has("__mendcode_schema_identity")
    ? db.all<{ name: string; timestamp: number; hash: string }>(
        "SELECT name, timestamp, hash FROM __mendcode_schema_identity",
      )
    : []
  const drift = identities.find(
    (row) => known.get(row.name)?.hash !== row.hash || known.get(row.name)?.timestamp !== Number(row.timestamp),
  )
  if (drift)
    return {
      compatible: false,
      reason: `Incompatible database schema identity: ${drift.name}`,
      pending: [],
      legacy: false,
    }
  const applied = new Set(rows.map((row) => row.name))
  return {
    compatible: true,
    pending: supported.filter((entry) => !applied.has(entry.name)).map((entry) => entry.name),
    legacy: !tables.has("__mendcode_schema_identity"),
  }
}

/** Opens an existing file read-only: no migration, writer PRAGMA or file creation. */
export function inspectCompatibility(file: string, supported: MigrationIdentity[]): Compatibility {
  if (file === ":memory:" || !existsSync(file))
    return { compatible: true, pending: supported.map((entry) => entry.name), legacy: true }
  const db = init(file, true)
  try {
    return inspect(db, supported)
  } catch (error) {
    return {
      compatible: false,
      reason: `Cannot verify database compatibility: ${error instanceof Error ? error.message : String(error)}`,
      pending: [],
      legacy: true,
    }
  } finally {
    db.$client.close()
  }
}

export function assertCompatibility(file: string, supported: MigrationIdentity[]) {
  const result = inspectCompatibility(file, supported)
  if (!result.compatible)
    throw new Error(`${result.reason}. Use a compatible MendCode version; this database was not migrated.`)
  return result
}

/** SQLite produces a consistent snapshot including committed WAL pages. */
export function backupBeforeMigration(file: string, supported: MigrationIdentity[]) {
  const state = assertCompatibility(file, supported)
  if (file === ":memory:" || !existsSync(file) || state.pending.length === 0) return
  const dir = `${file}.backups`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const destination = `${dir}/before-migration-${Date.now()}-${randomUUID()}.db`
  const db = init(file, true)
  try {
    reportBackendPhase("backup")
    db.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
    chmodSync(destination, 0o600)
    return destination
  } finally {
    db.$client.close()
  }
}

export function recordSchemaIdentity(db: Reader, supported: MigrationIdentity[]) {
  db.run("SAVEPOINT mendcode_schema_identity")
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS __mendcode_schema_identity (name TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, hash TEXT NOT NULL)",
    )
    for (const entry of supported) {
      db.run(
        `INSERT OR IGNORE INTO __mendcode_schema_identity VALUES ('${entry.name.replaceAll("'", "''")}', ${entry.timestamp}, '${entry.hash}')`,
      )
    }
    db.run("RELEASE SAVEPOINT mendcode_schema_identity")
  } catch (error) {
    db.run("ROLLBACK TO SAVEPOINT mendcode_schema_identity")
    db.run("RELEASE SAVEPOINT mendcode_schema_identity")
    throw error
  }
}

export function acquireDatabaseMaintenance(file: string, supported: MigrationIdentity[]) {
  const releaseLease = acquireWriterLease(file)
  let db: ReturnType<typeof init> | undefined
  try {
    assertCompatibility(file, supported)
    if (file === ":memory:" || !existsSync(file)) return { release: releaseLease }
    db = init(file, false, true)
    db.run("BEGIN IMMEDIATE")
    const state = inspect(db, supported)
    if (!state.compatible) throw new Error(state.reason)
  } catch (error) {
    try { db?.$client.close() } finally { releaseLease() }
    throw error
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        db!.run("ROLLBACK")
      } finally {
        try { db!.$client.close() } finally { releaseLease() }
      }
    },
  }
}
