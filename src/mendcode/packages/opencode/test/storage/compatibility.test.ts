import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import {
  acquireDatabaseMaintenance,
  assertCompatibility,
  backupBeforeMigration,
  inspectCompatibility,
  recordSchemaIdentity,
} from "../../src/storage/compatibility"
import { identifyMigrations } from "../../src/storage/migration-journal"
import { init } from "../../src/storage/db.bun"
import { mendChannelDbPath } from "../../src/storage/resolve-default-sqlite-path"

const root = mkdtempSync(path.join(tmpdir(), "mendcode-compatibility-"))
afterAll(() => {
  const trash = path.join(homedir(), ".Trash")
  mkdirSync(trash, { recursive: true })
  renameSync(root, path.join(trash, path.basename(root)))
})
const entries = [{ name: "20260904000000_initial", timestamp: 1788480000000, sql: "CREATE TABLE item(value TEXT);" }]
const journal = identifyMigrations(entries)
function fixture(name: string) {
  const file = path.join(root, `${name}.db`)
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE __drizzle_migrations (name TEXT, created_at NUMERIC)")
  db.run("INSERT INTO __drizzle_migrations VALUES (?, ?)", [entries[0].name, entries[0].timestamp])
  return { file, db }
}

test("future journal is rejected without changing database bytes", () => {
  const { file, db } = fixture("future")
  db.run("INSERT INTO __drizzle_migrations VALUES ('future', 9999999999999)")
  db.close()
  const before = readFileSync(file)
  expect(() => assertCompatibility(file, journal)).toThrow("Unsupported database migration")
  expect(readFileSync(file)).toEqual(before)
})

test("known legacy schema is compatible; persisted SQL identity rejects drift", () => {
  const { file, db } = fixture("hash")
  db.close()
  expect(inspectCompatibility(file, journal)).toEqual({ compatible: true, pending: [], legacy: true })
  const writer = init(file)
  recordSchemaIdentity(writer, journal)
  writer.$client.close()
  expect(inspectCompatibility(file, journal).legacy).toBe(false)
  expect(inspectCompatibility(file, [{ ...journal[0], hash: "f".repeat(64) }]).compatible).toBe(false)
})

test("snapshot includes WAL commits only when migrations are pending", () => {
  const { file, db } = fixture("backup")
  db.run("PRAGMA journal_mode=WAL")
  db.run("CREATE TABLE item(value TEXT)")
  db.run("INSERT INTO item VALUES ('preserved')")
  expect(backupBeforeMigration(file, journal)).toBeUndefined()
  const next = [...journal, { name: "next", timestamp: entries[0].timestamp + 1, hash: "a".repeat(64) }]
  const backup = backupBeforeMigration(file, next)!
  const copy = new Database(backup, { readonly: true })
  expect(copy.query("SELECT value FROM item").get()).toEqual({ value: "preserved" })
  copy.close()
  db.close()
})

test("maintenance excludes another writer and releases cleanly", () => {
  const { file, db } = fixture("lock")
  const guard = acquireDatabaseMaintenance(file, journal)
  expect(() => db.run("CREATE TABLE blocked(id INTEGER)")).toThrow()
  guard.release()
  guard.release()
  db.run("CREATE TABLE allowed(id INTEGER)")
  db.close()
})

test("release channels share new-install database path", () => {
  expect(["stable", "beta", "nightly"].map((channel) => mendChannelDbPath(root, channel, false))).toEqual(
    Array(3).fill(path.join(root, "mendcode.db")),
  )
})
