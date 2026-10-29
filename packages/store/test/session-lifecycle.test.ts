import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
test("an existing database receives additive lifecycle columns without losing sessions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-lifecycle-migrate-"))
  dirs.push(dir)
  const id = createIdFactory()("session")
  const store = openStore({ dir })
  store.createSession({ id, directory: dir, title: "Existing" })
  store.close()
  const db = new Database(path.join(dir, "mendd.db"))
  for (const column of ["pinned_at", "lifecycle", "fanout"]) db.run(`ALTER TABLE sessions DROP COLUMN ${column}`)
  db.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.sessionInfo(id)?.title).toBe("Existing")
    expect(reopened.sessionData.get(id, "lifecycle")).toBeUndefined()
    expect(reopened.setSessionPinned(id, true)).toBe(true)
  } finally { reopened.close() }
})
test("lifecycle, pin and long fan-out records survive reopening without metadata truncation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-lifecycle-store-"))
  dirs.push(dir)
  const id = createIdFactory()("session")
  const store = openStore({ dir })
  store.createSession({ id, directory: dir, title: "Lifecycle" })
  store.setSessionPinned(id, true)
  const pinned = store.sessionPinnedAt(id)
  const lifecycle = JSON.stringify({ pr: { number: 7, title: "a".repeat(600) }, rules: { inactiveDays: 7 } })
  const fanout = JSON.stringify({ branches: Array.from({ length: 8 }, (_, n) => ({ directory: `${dir}/${n}/${"x".repeat(300)}` })) })
  store.sessionData.set(id, "lifecycle", lifecycle)
  store.sessionData.set(id, "fanout", fanout)
  expect(() => store.sessionData.set(id, "fanout", "x".repeat(32001))).toThrow()
  store.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.sessionPinnedAt(id)).toBe(pinned)
    expect(reopened.sessionData.get(id, "lifecycle")).toBe(lifecycle)
    expect(reopened.sessionData.get(id, "fanout")).toBe(fanout)
    reopened.setSessionPinned(id, false)
    expect(reopened.sessionPinnedAt(id)).toBeUndefined()
  } finally { reopened.close() }
})
