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
