import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

export function init(path: string, readOnly = false) {
  const sqlite = new DatabaseSync(path, { readOnly })
  const db = drizzle({ client: sqlite })
  return db
}
