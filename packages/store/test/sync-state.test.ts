import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"
import { createSyncState } from "../src/sync-state"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ids = createIdFactory()

test("a change number is never used twice: dropping an applied change does not let the next one reuse its number", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-store-sync-"))
  dirs.push(dir)
  const store = openStore({ dir })
  const state = store.openSyncState(createSyncState, () => undefined)
  const memoryId = ids("memory")
  store.memories.add({ memoryId, scope: "user", text: "one", category: "commands", status: "saved", source: "user" })
  expect(state.changes("memory", 0, 10)).toEqual([expect.objectContaining({ id: memoryId, cseq: 1 })])
  // The device uploaded it (cursor 1), then applied the hub's newer copy and dropped its own record of it.
  state.forgetChange("memory", memoryId)
  expect(state.changes("memory", 0, 10)).toEqual([])
  store.memories.update(memoryId, { text: "two" })
  expect(state.changes("memory", 1, 10)).toEqual([expect.objectContaining({ id: memoryId, cseq: 2 })])
  const other = ids("memory")
  store.memories.add({ memoryId: other, scope: "user", text: "three", category: "commands", status: "saved", source: "user" })
  expect(state.changes("memory", 0, 10).map((change) => change.cseq)).toEqual([2, 3])
  store.close()
})

test("a database made with the old triggers gets the new ones on open, so a dropped change's number is not reused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-store-sync-"))
  dirs.push(dir)
  const store = openStore({ dir })
  let database: Database | undefined
  store.openSyncState((db, now) => { database = db; return createSyncState(db, now) }, () => undefined).enableHub()
  const db = database!
  // The schema as an earlier release made it: the allocator is max(cseq) + 1 and there is no trigger version.
  const old = (kind: string) => `(SELECT coalesce(max(cseq), 0) + 1 FROM sync_changes WHERE kind = '${kind}')`
  const body = (kind: string, id: string) => `BEGIN INSERT OR REPLACE INTO sync_changes(kind, id, cseq, deleted, at) VALUES ('${kind}', ${id}, ${old(kind)}, 0, 0); END`
  for (const name of ["sync_memory_insert", "sync_memory_update"]) db.run(`DROP TRIGGER ${name}`)
  db.run(`CREATE TRIGGER sync_memory_insert AFTER INSERT ON memories WHEN new.scope != 'session' ${body("memory", "new.id")}`)
  db.run(`CREATE TRIGGER sync_memory_update AFTER UPDATE ON memories WHEN new.scope != 'session' ${body("memory", "new.id")}`)
  db.run("DELETE FROM sync_meta WHERE key = 'trigger-version'")

  const state = createSyncState(db, () => 0)
  const memoryId = ids("memory")
  store.memories.add({ memoryId, scope: "user", text: "one", category: "commands", status: "saved", source: "user" })
  state.forgetChange("memory", memoryId)
  store.memories.update(memoryId, { text: "two" })
  expect(state.changes("memory", 1, 10)).toEqual([expect.objectContaining({ id: memoryId, cseq: 2 })])
  // A hub keeps its session triggers, and they are the new ones too.
  expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'sync_session_insert'").get()?.sql).toContain("cseq-session")
  store.close()
})
