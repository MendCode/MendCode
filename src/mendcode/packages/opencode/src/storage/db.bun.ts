import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

export function init(path: string, readonly = false) {
  const sqlite = new Database(path, readonly ? { readonly: true } : { create: true })
  const db = drizzle({ client: sqlite })
  return db
}
