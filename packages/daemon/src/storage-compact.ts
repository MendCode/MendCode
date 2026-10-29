import { Database } from "bun:sqlite"
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, renameSync } from "node:fs"
import path from "node:path"
import { acquireWriterLock } from "@mendcode/store"
import { featureOn } from "@mendcode/protocol/wire"

/** Explicit offline maintenance only. The lock excludes every daemon/store writer, including during the swap. */
export function compactOfflineStorage(input: { dir: string; dryRun?: boolean }) {
  const dir = path.resolve(input.dir)
  const file = path.join(dir, "mendd.db")
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error("[STORE]: --dir must contain a regular mendd.db")
  const lock = acquireWriterLock(path.join(dir, "mendd.lock"))
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: input.dryRun === true, strict: true })
    const row = db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()
    if (!featureOn(row ? JSON.parse(row.payload) : {}, "storage_compact")) throw new Error("[STORE]: storage compaction is disabled; enable /tier storage_compact on")
    const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").all()[0]!.page_size
    const beforeBytes = lstatSync(file).size
    if (input.dryRun) return { dryRun: true, pageSize, targetPageSize: 16384, beforeBytes, afterBytes: beforeBytes }
    // DELETE mode checkpoints and removes WAL sidecars before replacing the main file.
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").all()[0]
    if (mode?.journal_mode !== "delete") throw new Error("[STORE]: cannot leave WAL mode; close all database readers")
    const staging = mkdtempSync(path.join(dir, ".compact-"))
    chmodSync(staging, 0o700)
    const target = path.join(staging, "packed.db")
    const backup = path.join(staging, "original.db")
    db.run("PRAGMA page_size = 16384")
    db.run("VACUUM INTO ?", [target])
    chmodSync(target, lstatSync(file).mode & 0o777)
    const check = new Database(target, { readonly: true, strict: true })
    try {
      const integrity = check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all()
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || check.query("PRAGMA foreign_key_check").all().length) throw new Error("[STORE]: compacted database failed integrity checks")
      if (check.query<{ page_size: number }, []>("PRAGMA page_size").all()[0]?.page_size !== 16384) throw new Error("[STORE]: compacted database has the wrong page size")
    } finally { check.close() }
    db.close()
    db = undefined
    const fd = openSync(target, "r")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // A hard link preserves the original without a missing-file window. Rename on the same filesystem is atomic.
    linkSync(file, backup)
    const backupDirectory = openSync(staging, "r")
    try { fsyncSync(backupDirectory) } finally { closeSync(backupDirectory) }
    renameSync(target, file)
    const directory = openSync(dir, "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
    return { dryRun: false, pageSize, targetPageSize: 16384, beforeBytes, afterBytes: lstatSync(file).size, backup }
  } finally {
    db?.close()
    lock.release()
  }
}
