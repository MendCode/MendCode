import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { compactOfflineStorage } from "../src/storage-compact"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-offline-"))
  dirs.push(dir)
  return dir
}

// Real offline boundary: the writer exits, rather than leaving SQLite statements alive in this process.
function seed(dir: string) {
  const storeModule = path.resolve(import.meta.dir, "../../store/src/index.ts")
  const script = `import {openStore} from ${JSON.stringify(storeModule)}
const store = openStore({dir: ${JSON.stringify(dir)}, pageSize: 4096})
const id = ${JSON.stringify(createIdFactory()("session"))}
store.createSession({id, directory: "/repo", title: "preserve"})
const history = [{role: "tool", content: "lossless 日本語 🚀\\n".repeat(1000), metadata: [1, true, null]}]
store.engineMessages.save(id, "native", history)
console.log(JSON.stringify({id, history, events: store.readAfter(id, 0)}))
store.close()`
  const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}

test("offline page conversion preserves events, history and original backup; preview changes no database bytes", () => {
  const dir = temp()
  const { id, history, events } = seed(dir)
  const file = path.join(dir, "mendd.db")
  const original = readFileSync(file)
  expect(compactOfflineStorage({ dir, dryRun: true })).toMatchObject({ dryRun: true, pageSize: 4096, targetPageSize: 16384 })
  expect(readFileSync(file)).toEqual(original)
  const result = compactOfflineStorage({ dir })
  expect(result.pageSize).toBe(4096)
  expect(result.backup).toBeDefined()
  const backup = new Database(result.backup!, { readonly: true })
  expect(backup.query("PRAGMA page_size").all()).toEqual([{ page_size: 4096 }])
  expect(backup.query("SELECT title FROM sessions").all()).toEqual([{ title: "preserve" }])
  backup.close()
  const db = new Database(file, { readonly: true })
  expect(db.query("PRAGMA page_size").get()).toEqual({ page_size: 16384 })
  db.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.readAfter(id, 0)).toEqual(events)
    expect(reopened.engineMessages.load(id, "native")).toEqual(history)
  } finally { reopened.close() }
})

test("the storage_compact switch refuses offline writes and previews without changing database bytes", () => {
  const dir = temp()
  seed(dir)
  const store = openStore({ dir })
  store.settings.set({ features: { storage_compact: false } })
  store.close()
  const file = path.join(dir, "mendd.db")
  const original = readFileSync(file)
  expect(() => compactOfflineStorage({ dir })).toThrow("storage compaction is disabled")
  expect(() => compactOfflineStorage({ dir, dryRun: true })).toThrow("storage compaction is disabled")
  expect(readFileSync(file)).toEqual(original)
})

test("offline compact refuses a running writer and missing data; it never creates a store", () => {
  const dir = temp()
  expect(() => compactOfflineStorage({ dir })).toThrow("regular mendd.db")
  expect(existsSync(path.join(dir, "mendd.db"))).toBe(false)
  const store = openStore({ dir })
  try {
    expect(() => compactOfflineStorage({ dir })).toThrow("owned by running process")
    expect(() => compactOfflineStorage({ dir, dryRun: true })).toThrow("owned by running process")
  } finally { store.close() }
})

test("the CLI executes offline compaction without launching a daemon, and refuses remote attachment", () => {
  const dir = temp()
  seed(dir)
  const cli = path.resolve(import.meta.dir, "../../../apps/cli/src/entry.ts")
  const args = [process.execPath, cli, "storage", "--dir", dir, "--compact", "--offline", "--dry-run", "--json"]
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ dryRun: true, pageSize: 4096 })
  expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
  const executed = Bun.spawnSync(args.filter(arg => arg !== "--dry-run"), { stdout: "pipe", stderr: "pipe" })
  expect(executed.stderr.toString()).toBe("")
  expect(executed.exitCode).toBe(0)
  const converted = JSON.parse(executed.stdout.toString())
  expect(converted).toMatchObject({ dryRun: false, pageSize: 4096, targetPageSize: 16384 })
  expect(existsSync(converted.backup)).toBe(true)
  expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
  const remote = Bun.spawnSync([...args, "--socket", path.join(dir, "peer.sock")], { stdout: "pipe", stderr: "pipe" })
  expect(remote.exitCode).toBe(64)
  expect(remote.stderr.toString()).toContain("local-only")
  const invalid = Bun.spawnSync([process.execPath, cli, "storage", "--dir", dir, "--offline"], { stdout: "pipe", stderr: "pipe" })
  expect(invalid.exitCode).toBe(64)
})
