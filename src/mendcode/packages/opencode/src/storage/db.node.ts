import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { existsSync } from "node:fs"

export function init(path: string, readonly = false, existing = false) {
  if (existing && !existsSync(path)) throw new Error("Database no longer exists")
  const sqlite = new DatabaseSync(path, { readOnly: readonly })
  const db = drizzle({ client: sqlite })
  return db
}
