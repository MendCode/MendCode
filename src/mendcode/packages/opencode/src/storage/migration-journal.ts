import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type MigrationEntry = { sql: string; timestamp: number; name: string }
export type MigrationIdentity = { name: string; timestamp: number; hash: string }
declare const OPENCODE_MIGRATIONS: MigrationEntry[] | undefined

export function migrationEntries(): MigrationEntry[] {
  if (typeof OPENCODE_MIGRATIONS !== "undefined") return OPENCODE_MIGRATIONS.map((entry) => ({ ...entry }))
  const dir = path.join(import.meta.dirname, "../../migration")
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(dir, entry.name, "migration.sql")
      if (!existsSync(file)) return []
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(entry.name)
      if (!match) throw new Error(`Invalid migration name: ${entry.name}`)
      return [
        {
          name: entry.name,
          sql: readFileSync(file, "utf8"),
          timestamp: Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          ),
        },
      ]
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function identifyMigrations(entries: MigrationEntry[]): MigrationIdentity[] {
  return entries.map(({ name, timestamp, sql }) => ({
    name,
    timestamp,
    hash: createHash("sha256").update(sql).digest("hex"),
  }))
}

export function supportedMigrationJournal(): MigrationIdentity[] {
  return identifyMigrations(migrationEntries())
}
