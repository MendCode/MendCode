import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type MemoryId } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-store-rev-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()

function seed(store: ReturnType<typeof openStore>, text: string, status: "saved" | "pending" = "saved") {
  const memoryId = ids("memory")
  store.memories.add({ memoryId, scope: "project", directory: "/repo", text, category: "commands", status, source: status === "saved" ? "user" : "agent" })
  return memoryId
}

describe("memories table migration", () => {
  test("a database created before revisions gains the columns and keeps its rows", () => {
    const dir = tempDir()
    const legacy = new Database(path.join(dir, "mendd.db"), { create: true, strict: true })
    legacy.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
    legacy.run(`CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, directory TEXT, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID`)
    legacy.run(`INSERT INTO memories VALUES ('memory_old', 'project', '/repo', 'Use pnpm', 'commands', 'saved', 'user', 1, 2)`)
    legacy.close()

    const store = openStore({ dir })
    const old = store.memories.get("memory_old" as MemoryId)
    expect(old).toEqual({ memoryId: "memory_old" as MemoryId, scope: "project", directory: "/repo", text: "Use pnpm", category: "commands", status: "saved", source: "user", createdAt: 1, updatedAt: 2 })
    const target = "memory_old" as MemoryId
    const proposal = ids("memory")
    store.memories.add({ memoryId: proposal, scope: "project", directory: "/repo", text: "Use pnpm 11", category: "commands", status: "pending", source: "agent", kind: "update", targetId: target, reason: "version bump" })
    expect(store.memories.get(proposal)).toMatchObject({ kind: "update", targetId: target, reason: "version bump", status: "pending" })
    store.close()
    // Reopening an already migrated database is a no-op.
    const again = openStore({ dir })
    expect(again.memories.list().map((m) => m.memoryId as string).sort()).toEqual(["memory_old", proposal as string].sort())
    again.close()
  })
  test("plain memories carry no kind, target or reason", () => {
    const store = openStore({ dir: tempDir() })
    const id = seed(store, "Tests run with bun test")
    expect(Object.keys(store.memories.get(id)!).sort()).toEqual(["category", "createdAt", "directory", "memoryId", "scope", "source", "status", "text", "updatedAt"])
    store.close()
  })
})

describe("resolveRevision", () => {
  function setup() {
    const store = openStore({ dir: tempDir() })
    const target = seed(store, "Package manager is npm")
    const other = seed(store, "Tests run with bun test")
    const propose = (kind: "update" | "archive", text: string, targetId: MemoryId = target) => {
      const memoryId = ids("memory")
      store.memories.add({ memoryId, scope: "project", directory: "/repo", text, category: "commands", status: "pending", source: "agent", kind, targetId, reason: "r" })
      return memoryId
    }
    return { store, target, other, propose }
  }

  test("nothing is applied while the proposal is pending", () => {
    const { store, target, propose } = setup()
    propose("update", "Package manager is pnpm")
    propose("archive", "Package manager is npm")
    expect(store.memories.get(target)).toMatchObject({ text: "Package manager is npm", status: "saved" })
    expect(store.memories.search({ query: "pnpm", directory: "/repo" })).toEqual([])
    expect(store.memories.list({ status: "saved" }).map((m) => m.memoryId)).not.toContain("x")
    store.close()
  })
  test("accepting an update rewrites the target, removes the proposal and reindexes search", () => {
    const { store, target, propose } = setup()
    const proposal = propose("update", "Package manager is pnpm")
    expect(store.memories.resolveRevision(proposal, true)).toEqual({ result: "applied", targetId: target, kind: "update" })
    expect(store.memories.get(target)).toMatchObject({ text: "Package manager is pnpm", status: "saved" })
    expect(store.memories.get(proposal)).toBeUndefined()
    expect(store.memories.search({ query: "pnpm", directory: "/repo" }).map((m) => m.memoryId)).toEqual([target])
    expect(store.memories.search({ query: "npm", directory: "/repo" })).toEqual([])
    store.close()
  })
  test("accepting an archive retires the target but keeps it, and restoring saves it again", () => {
    const { store, target, propose } = setup()
    const proposal = propose("archive", "Package manager is npm")
    expect(store.memories.resolveRevision(proposal, true)).toEqual({ result: "applied", targetId: target, kind: "archive" })
    expect(store.memories.get(target)).toMatchObject({ text: "Package manager is npm", status: "archived" })
    expect(store.memories.list({ status: "saved" }).some((m) => m.memoryId === target)).toBe(false)
    expect(store.memories.search({ query: "npm", directory: "/repo" })).toEqual([])
    store.memories.update(target, { status: "saved" })
    expect(store.memories.search({ query: "npm", directory: "/repo" }).map((m) => m.memoryId)).toEqual([target])
    store.close()
  })
  test("rejecting drops the proposal and leaves the target alone", () => {
    const { store, target, propose } = setup()
    const proposal = propose("update", "Package manager is pnpm")
    expect(store.memories.resolveRevision(proposal, false)).toEqual({ result: "rejected", targetId: target, kind: "update" })
    expect(store.memories.get(proposal)).toBeUndefined()
    expect(store.memories.get(target)).toMatchObject({ text: "Package manager is npm", status: "saved" })
    store.close()
  })
  test("a target that was archived, deleted or already changed makes the proposal stale and unapplied", () => {
    const { store, target, other, propose } = setup()
    store.memories.update(target, { status: "archived" })
    const first = propose("update", "Package manager is pnpm")
    expect(store.memories.resolveRevision(first, true)).toEqual({ result: "stale", targetId: target, kind: "update" })
    expect(store.memories.get(target)).toMatchObject({ text: "Package manager is npm", status: "archived" })
    expect(store.memories.get(first)).toBeUndefined()
    const second = propose("archive", "Tests run with bun test", other)
    store.memories.delete(other)
    expect(store.memories.resolveRevision(second, true)).toMatchObject({ result: "stale" })
    store.close()
  })
  test("ordinary memories, saved rows and unknown ids are not revisions", () => {
    const { store, target } = setup()
    const pending = seed(store, "A plain pending proposal", "pending")
    expect(store.memories.resolveRevision(target, true)).toEqual({ result: "not_a_revision" })
    expect(store.memories.resolveRevision(pending, true)).toEqual({ result: "not_a_revision" })
    expect(store.memories.resolveRevision("memory_missing" as MemoryId, true)).toEqual({ result: "not_a_revision" })
    expect(store.memories.get(pending)).toBeDefined()
    store.close()
  })
  test("resolving twice is safe", () => {
    const { store, propose } = setup()
    const proposal = propose("update", "Package manager is pnpm")
    store.memories.resolveRevision(proposal, true)
    expect(store.memories.resolveRevision(proposal, true)).toEqual({ result: "not_a_revision" })
    store.close()
  })
})
