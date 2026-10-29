import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-archive-store-"))
  dirs.push(dir)
  return dir
}
const open = (dir: string, now = () => 1_000) => {
  const store = openStore({ dir, now })
  stores.push(store)
  return store
}

test("archive persists across restart, filters before limit/offset and preserves attached state", () => {
  const dir = temp()
  let at = 1_000
  let store = open(dir, () => at)
  const root = ids("session")
  const child = ids("session")
  store.createSession({ id: root, title: "Archived root", directory: "/project" })
  store.createSession({ id: child, parentId: root, title: "Visible child", directory: "/project" })
  store.engineMessages.save(root, "native", [{ role: "user", content: "keep me" }])
  store.engineBindings.set(root, "codex", "external-thread")
  store.drafts.set(root, "unsent", [])
  const blob = store.putBlob(new TextEncoder().encode("attachment"), "text/plain")
  store.refBlob(blob, root)
  const before = store.readAfter(root, 0)
  expect(store.setSessionArchived(root, true)).toBe(true)
  at = 2_000
  expect(store.setSessionArchived(root, true)).toBe(true)
  expect(store.sessionSummary(root)?.archivedAt).toBe(1_000)
  expect(store.listSessions()).toEqual([])
  expect(store.listSessions({ roots: false, limit: 1 })[0]?.sessionId).toBe(child)
  expect(store.listSessions({ roots: false, offset: 1 })).toEqual([])
  expect(store.listSessions({ archived: true, search: "Archived", directory: "/project" })[0]?.sessionId).toBe(root)
  expect(store.sessionChildren(root)).toEqual([child])
  expect(store.readAfter(root, 0)).toEqual(before)
  store.close()
  stores.pop()
  store = open(dir, () => at)
  expect(store.sessionSummary(root)?.archivedAt).toBe(1_000)
  expect(store.engineMessages.load(root, "native")).toEqual([{ role: "user", content: "keep me" }])
  expect(store.engineBindings.get(root, "codex")).toBe("external-thread")
  expect(store.drafts.get(root)?.text).toBe("unsent")
  expect(Bun.file(store.blobPath(blob.sha256)).size).toBe(10)
  expect(store.setSessionArchived(root, false)).toBe(true)
  expect(store.sessionSummary(root)).not.toHaveProperty("archivedAt")
  expect(store.listSessions()[0]?.sessionId).toBe(root)
  expect(store.setSessionArchived(ids("session"), true)).toBe(false)
})

test("older databases gain a nullable archive column without hiding sessions; migration is idempotent", () => {
  const dir = temp()
  const db = new Database(path.join(dir, "mendd.db"))
  const id = ids("session")
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID")
  db.query("INSERT INTO sessions (id, directory, title, created_at) VALUES (?, ?, ?, ?)").run(id, "/project", "Before archive", 100)
  db.close()
  let store = open(dir)
  expect(store.listSessions()[0]).toMatchObject({ sessionId: id, title: "Before archive", updatedAt: 100 })
  expect(store.sessionSummary(id)).not.toHaveProperty("archivedAt")
  expect(store.setSessionArchived(id, true)).toBe(true)
  store.close()
  stores.pop()
  store = open(dir)
  expect(store.listSessions()).toEqual([])
  expect(store.listSessions({ archived: true })[0]?.archivedAt).toBe(1_000)
})
