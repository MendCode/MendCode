import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SyncMemoryRow } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createSyncState } from "@mendcode/store/sync-state"
import { applyMemory } from "../src/sync/memories"
import type { ProjectIndex } from "../src/sync/projects"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ids = createIdFactory()
const projects = {} as ProjectIndex

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-sync-memories-"))
  dirs.push(dir)
  const store = openStore({ dir })
  return { store, state: store.openSyncState(createSyncState, () => undefined) }
}
const wire = (id: string, updatedAt: number): SyncMemoryRow => ({ id, updatedAt, scope: "user", text: "from the hub", category: "commands", status: "saved", source: "user", createdAt: updatedAt, kind: "new", reason: "", profile: "", pinned: false })

test("a memory deleted here and not yet sent is not brought back by the older copy the hub echoes; a newer edit there still wins", async () => {
  const { store, state } = setup()
  const memoryId = ids("memory")
  store.memories.add({ memoryId, scope: "user", text: "mine", category: "commands", status: "saved", source: "user" })
  store.memories.delete(memoryId)
  expect(state.changeOf("memory", memoryId)).toMatchObject({ deleted: true })
  // The hub's copy is the one this device uploaded before it deleted the memory: older than the delete.
  expect(await applyMemory(state, wire(memoryId, Date.now() - 60_000), projects, true)).toBe(false)
  expect(store.memories.get(memoryId)).toBeUndefined()
  expect(state.changeOf("memory", memoryId)).toMatchObject({ deleted: true })
  // An edit on the hub made after the delete is newer: it wins and the pending delete is dropped by the caller.
  expect(await applyMemory(state, wire(memoryId, Date.now() + 60_000), projects, true)).toBe(true)
  expect(store.memories.get(memoryId)?.text).toBe("from the hub")
  store.close()
})
