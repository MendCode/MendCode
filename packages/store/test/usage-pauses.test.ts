import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createUsagePauses } from "../src/usage-pauses"
import { openStore } from "../src/store"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-pauses-"))
  dirs.push(dir)
  return dir
}

test("a pause keeps the model it was opened with, and a pause row without one reads back without it", () => {
  const dir = temp()
  const store = openStore({ dir })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/repo", title: "t" })
  store.usagePauses.put({ sessionId, state: "scheduled", provider: "claude", model: "claude-sonnet#fast", message: "limit", resetsAt: 5, createdAt: 1, updatedAt: 2 })
  expect(store.usagePauses.get(sessionId)).toMatchObject({ state: "scheduled", provider: "claude", model: "claude-sonnet#fast", resetsAt: 5 })
  store.usagePauses.put({ sessionId, state: "paused", message: "limit", createdAt: 1, updatedAt: 3 })
  expect(store.usagePauses.get(sessionId)?.model).toBeUndefined()
  expect(() => store.usagePauses.put({ sessionId, state: "resumed" as never, message: "resolved", createdAt: 1, updatedAt: 4 })).toThrow("resolved usage pause")
  expect(store.usagePauses.get(sessionId)?.state).toBe("paused")
  store.close()
})

test("a database from before the model column keeps its open pauses and gains the column", () => {
  const db = new Database(":memory:", { strict: true })
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
  db.run("INSERT INTO sessions (id) VALUES ('ses_old')")
  db.run(`CREATE TABLE usage_pauses (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT, state TEXT NOT NULL, provider TEXT, message TEXT NOT NULL, resets_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`)
  db.run("INSERT INTO usage_pauses (session_id, state, message, resets_at, created_at, updated_at) VALUES ('ses_old', 'scheduled', 'limit', 9, 1, 1)")
  const pauses = createUsagePauses(db)
  const old = "ses_old" as SessionId
  expect(pauses.get(old)).toMatchObject({ state: "scheduled", resetsAt: 9 })
  expect(pauses.get(old)?.model).toBeUndefined()
  pauses.put({ sessionId: old, state: "scheduled", model: "m", message: "limit", resetsAt: 9, createdAt: 1, updatedAt: 2 })
  expect(pauses.get(old)?.model).toBe("m")
  db.close()
})
