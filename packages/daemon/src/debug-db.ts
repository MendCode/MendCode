import type { Database } from "bun:sqlite"
import path from "node:path"
import type { DatabaseReport } from "@mendcode/protocol"

/** Runs in an isolated worker so expensive SELECTs cannot block the daemon. */
function databaseWorker(Database: typeof import("bun:sqlite").Database) {
  self.onmessage = (event: MessageEvent<{ file: string; sql: string }>) => {
    let db: Database | undefined
    try {
      db = new Database(event.data.file, { readonly: true, strict: true, safeIntegers: true })
      const statement = db.query<Record<string, unknown>, []>(event.data.sql)
      const rows: Record<string, unknown>[] = []
      let bytes = 0, truncated = false
      for (const row of statement.iterate()) {
        const safe = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : String(value) : value instanceof Uint8Array ? { encoding: "base64", content: Buffer.from(value).toString("base64") } : value]))
        const size = Buffer.byteLength(JSON.stringify(safe))
        if (rows.length >= 1000 || bytes + size > 100_000) { truncated = true; break }
        rows.push(safe)
        bytes += size
      }
      self.postMessage({ path: event.data.file, columns: statement.columnNames, rows, truncated })
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
    finally { db?.close() }
  }
}

export function queryDatabase(dir: string, operation: "path" | "query", sql?: string): Promise<DatabaseReport> {
  const file = path.join(dir, "mendd.db")
  if (operation === "path") return Promise.resolve({ path: file })
  if (!sql) return Promise.reject(new Error("db query needs SQL"))
  // One read statement, with schema inspection PRAGMAs only. No ATTACH or writable shell.
  const shape = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "")
  if (shape.includes(";") || !/^(SELECT\b|WITH\b|EXPLAIN\b|PRAGMA\s+(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list|schema_version|user_version)\b)/i.test(shape) || /^PRAGMA/i.test(shape) && shape.includes("=")) return Promise.reject(new Error("Only one read-only SQL statement is allowed"))
  const url = URL.createObjectURL(new Blob([`import { Database } from "bun:sqlite"\n(${databaseWorker.toString()})(Database)`], { type: "text/javascript" }))
  return new Promise((resolve, reject) => {
    const worker = new Worker(url)
    const finish = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url) }
    const timer = setTimeout(() => { finish(); reject(new Error("SQL query timed out after 5 seconds")) }, 5000)
    worker.onmessage = (event: MessageEvent<DatabaseReport & { error?: string }>) => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data) }
    worker.onerror = (error) => { finish(); reject(new Error(error.message)) }
    worker.postMessage({ file, sql })
  })
}
