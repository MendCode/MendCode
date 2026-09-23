import { existsSync } from "node:fs"
import path from "node:path"
import { EOL } from "node:os"
import { Global } from "@mendcode/core/global"

// Clients and maintenance commands must not migrate data before the backend or
// updater has established ownership and checked compatibility.
export function commandOwnsStartupMigration(command: string | undefined) {
  return command !== undefined && !new Set([
    "upgrade", "attach", "uninstall", "models", "providers", "console", "completion", "stats", "run",
  ]).has(command)
}

export async function migrateLegacyStorage() {
  const marker = path.join(Global.Path.data, ".mendcode-json-storage-migration-v0.done")
  if (existsSync(marker)) return
  const [{ JsonMigration }, { Database }] = await Promise.all([
    import("./json-migration"), import("./db"),
  ])
  process.stderr.write("Performing one time database migration..." + EOL)
  let last = -1
  try {
    const stats = await JsonMigration.run(Database.Client(), {
      progress: (event) => {
        const percent = event.total ? Math.floor(event.current / event.total * 100) : 100
        if (percent === last) return
        last = percent
        process.stderr.write(`sqlite-migration:${percent}${EOL}`)
      },
    })
    if (!JsonMigration.jsonStorageMigrationSucceeded(stats)) {
      throw new Error(`Database migration incomplete (${stats.errors.length} errors): ${stats.errors.slice(0, 10).join("; ")}`)
    }
    await JsonMigration.writeJsonStorageMigrationDoneMarker()
    process.stderr.write("Database migration complete." + EOL)
  } finally {
    // The importer changes PRAGMAs; normal runtime access must start fresh.
    Database.close()
    process.stderr.write(`sqlite-migration:done${EOL}`)
  }
}
