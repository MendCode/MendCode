import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { init } from "#db"

/** Refuse newer channel schemas before opening a writer; preserve legacy migration handling. */
export function assertRecordedSchema(file: string, entries: Array<{ name: string; timestamp: number; sql: string }>) {
  if (file === ":memory:" || !existsSync(file)) return
  const db = init(file, true)
  try {
    if (!db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='__mendcode_schema_identity'").length) return
    const known = new Map(entries.map(entry => [entry.name, entry]))
    for (const row of db.all<{ name: string; timestamp: number; hash: string }>("SELECT name, timestamp, hash FROM __mendcode_schema_identity")) {
      const expected = known.get(row.name)
      if (!expected || expected.timestamp !== row.timestamp || createHash("sha256").update(expected.sql).digest("hex") !== row.hash) {
        throw new Error("This session database was written by an incompatible release. Continue using that release channel; no database changes were made.")
      }
    }
  } finally { db.$client.close() }
}
