import { Database, type Statement } from "bun:sqlite"
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { atomicPrivateWrite, cleanPrivateTemp, createSealedFiles, isSealedFile, privateTempTarget } from "./sealed-file"

/** Plain SQLite by default; opt-in authenticated snapshots execute only in memory, never a decrypted temp file. */
export function openPrivateDatabase(dir: string, file: string) {
  const existing = existsSync(file)
  const hasEncryptedFiles = (root: string): boolean => {
    if (!existsSync(root)) return false
    const info = lstatSync(root)
    if (info.isSymbolicLink()) return false
    if (info.isDirectory()) return readdirSync(root).some((name) => hasEncryptedFiles(path.join(root, name)))
    if (!info.isFile() || !isSealedFile(root)) return false
    const name = path.basename(root)
    if (/^[a-f0-9]{64}$/.test(name) && root === path.join(dir, "blobs", name.slice(0, 2), name)) {
      return new Bun.CryptoHasher("sha256").update(readFileSync(root)).digest("hex") !== name
    }
    return true
  }
  const sealed = createSealedFiles(dir, "chats", () => [file, ...["blobs", "session-transcripts", "tool-output", "goals"].map((name) => path.join(dir, name))].some(hasEncryptedFiles))
  let enabled = existsSync(file) && isSealedFile(file)
  let live = enabled ? Database.deserialize(sealed.openFile(file, "database")) : new Database(file, { create: true, strict: true })
  let generation = 0
  let depth = 0
  let ready = false
  let failed: unknown
  const configure = () => live.run("PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY")
  configure()
  if (existing) for (const name of readdirSync(dir)) {
    if (privateTempTarget(name) === path.basename(file)) cleanPrivateTemp(path.join(dir, name), () => { live.query("PRAGMA schema_version").get() })
  }
  // What the snapshot on disk holds: rows changed on this connection (triggers included), the schema, the user version and
  // the page layout (vacuum, auto_vacuum). A statement that changed none of them (`INSERT OR IGNORE` of a present row,
  // `CREATE TABLE IF NOT EXISTS`) leaves the snapshot as it is instead of sealing the whole database again.
  let persisted: string | undefined
  const contentMark = () => {
    const row = live.query<Record<string, number>, []>(`SELECT total_changes() AS c, (SELECT schema_version FROM pragma_schema_version) AS s,
      (SELECT user_version FROM pragma_user_version) AS u, (SELECT page_count FROM pragma_page_count) AS p,
      (SELECT freelist_count FROM pragma_freelist_count) AS f, (SELECT auto_vacuum FROM pragma_auto_vacuum) AS v`).get()!
    return `${generation}:${row.c}:${row.s}:${row.u}:${row.p}:${row.f}:${row.v}`
  }
  // A snapshot just opened is what the file holds.
  if (enabled) persisted = contentMark()
  function persist() {
    if (!enabled || !ready || depth || live.inTransaction) return
    const mark = contentMark()
    if (mark === persisted) return
    try { sealed.sealToFile(file, live.serialize(), "database"); failed = undefined; persisted = mark }
    catch (error) { failed = error; throw error }
  }
  const check = () => { if (failed) throw failed }
  function statement(sql: string, params?: unknown) {
    let version = generation
    // Store modules declare their queries at open, but only the ones actually used need a native statement.
    // Keep it after first use (Bun's query cache also shares identical SQL); a privacy switch replaces the connection.
    let stmt: Statement | undefined
    return new Proxy({}, {
      get(_target, property) {
        if (!stmt || version !== generation) {
          stmt = params === undefined || version !== generation ? live.query(sql) : live.prepare(sql, params as never)
          version = generation
        }
        const value = Reflect.get(stmt, property, stmt)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          check()
          const result = value.apply(stmt, args)
          if (property === "run" || !/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql) && ["get", "all", "values"].includes(String(property))) persist()
          return result
        }
      },
    })
  }
  const db = new Proxy(live, {
    get(_target, property) {
      if (property === "query" || property === "prepare") return statement
      if (property === "transaction") return (fn: (...args: any[]) => any) => {
        const wrap = (mode: "deferred" | "immediate" | "exclusive") => (...args: any[]) => {
          check()
          depth++
          let ok = false
          try { const result = live.transaction(fn)[mode](...args); ok = true; return result }
          finally { depth--; if (ok) persist() }
        }
        return Object.assign(wrap("deferred"), { deferred: wrap("deferred"), immediate: wrap("immediate"), exclusive: wrap("exclusive") })
      }
      if (property === "run" || property === "exec") return (...args: any[]) => { check(); const result = (live.run as any)(...args); persist(); return result }
      if (property === "close") return () => { if (!failed) persist(); live.close() }
      const value = Reflect.get(live, property, live)
      return typeof value === "function" ? value.bind(live) : value
    },
  }) as Database
  return {
    db, sealed,
    start() { ready = true; persist() },
    enabled: () => enabled,
    set(next: boolean) {
      check()
      if (next === enabled) return
      if (live.inTransaction) throw new Error("[PRIVACY]: finish the current transaction first")
      if (next) {
        // Checkpoint before serialization, then detach all prepared statements from the disk database.
        live.run("PRAGMA wal_checkpoint(TRUNCATE)")
        const bytes = live.serialize()
        // A serialized WAL database still advertises WAL in its header; an in-memory connection has no sidecar.
        bytes[18] = 1
        bytes[19] = 1
        const replacement = Database.deserialize(bytes)
        replacement.run("PRAGMA journal_mode = MEMORY; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY")
        try { sealed.sealToFile(file, bytes, "database") }
        catch (error) {
          if (isSealedFile(file)) {
            live.close(); live = replacement; generation++; enabled = true; failed = error
          } else replacement.close()
          throw error
        }
        live.close()
        live = replacement
        generation++
        enabled = true
        persisted = contentMark()
        for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true })
      } else {
        const bytes = live.serialize()
        try {
          atomicPrivateWrite(file, bytes)
          const replacement = new Database(file, { strict: true })
          replacement.run("PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA journal_mode = WAL")
          live.close()
          live = replacement
          enabled = false
          generation++
        } catch (error) { failed = error; throw error }
      }
    },
  }
}
