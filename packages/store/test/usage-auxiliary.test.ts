import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ids = createIdFactory()
const T0 = new Date(2026, 9, 10, 9, 0).getTime()
const DAY = "2026-10-10"

test("auxiliary calls roll up per day, role and model, scope by directory, survive their session and never touch the turn sums", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-aux-"))
  dirs.push(dir)
  let store = openStore({ dir, now: () => T0 })
  const here = ids("session")
  store.createSession({ id: here, directory: "/repo", title: "here" })
  const call = { at: T0, provider: "chatgpt", model: "gpt-6-luna", input: 1_000, output: 20 }
  store.usageAuxiliary.record({ ...call, role: "summary", directory: "/repo", costMicros: 7 })
  store.usageAuxiliary.record({ ...call, role: "summary", directory: "/repo", reasoning: 5, cacheRead: 300 })
  store.usageAuxiliary.record({ ...call, role: "setup", directory: "/elsewhere", input: 50, output: 5, costMicros: 2 })
  // The next day is outside the range.
  store.usageAuxiliary.record({ ...call, at: T0 + 86_400_000, role: "title", directory: "/repo" })

  const summary = { role: "summary", provider: "chatgpt", model: "gpt-6-luna", input: 2_000, output: 40, reasoning: 5, cacheRead: 300, cacheWrite: 0, calls: 2, costMicros: 7, costUnknownCalls: 1 }
  const setup = { role: "setup", provider: "chatgpt", model: "gpt-6-luna", input: 50, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 1, costMicros: 2, costUnknownCalls: 0 }
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY })).toEqual([summary, setup])
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: ["/repo"] })).toEqual([summary])
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: [] })).toEqual([])
  expect(store.usageDaily({ from: DAY, to: DAY })).toEqual([])
  expect(store.usageByModel({ from: DAY, to: DAY })).toEqual([])

  // Rows outlive the session and a reopen.
  store.deleteSession(here)
  store.close()
  store = openStore({ dir, now: () => T0 })
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY })).toEqual([summary, setup])
  store.close()
})

test("rows of the earlier shape, one per session, fold into one per directory when the store opens, and the report stays the same", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-aux-"))
  dirs.push(dir)
  let store = openStore({ dir, now: () => T0 })
  store.close()
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const db = new Database(path.join(dir, "mendd.db"))
  db.run("DROP TABLE usage_auxiliary_daily")
  db.run(`CREATE TABLE usage_auxiliary_daily (
      day TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      cost_unknown_calls INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, role, provider, model, session_id)
    ) WITHOUT ROWID`)
  const insert = db.query("INSERT INTO usage_auxiliary_daily VALUES (?, 'title', 'chatgpt', 'gpt-6-luna', ?, ?, ?, 2, 0, 0, 0, ?, 0, 1)")
  insert.run(DAY, "ses_a", "/repo", 100, 3)
  insert.run(DAY, "ses_b", "/repo", 50, 4)
  insert.run(DAY, "ses_c", "/other", 10, 1)
  db.close()
  store = openStore({ dir, now: () => T0 })
  const title = (input: number, calls: number, costMicros: number) => ({ role: "title", provider: "chatgpt", model: "gpt-6-luna", input, output: 2 * calls, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls, costMicros, costUnknownCalls: 0 })
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: ["/repo"] })).toEqual([title(150, 2, 7)])
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY })).toEqual([title(160, 3, 8)])
  store.usageAuxiliary.record({ at: T0, role: "title", provider: "chatgpt", model: "gpt-6-luna", input: 1, output: 2, costMicros: 1, directory: "/repo" })
  expect(store.usageAuxiliary.report({ from: DAY, to: DAY, directories: ["/repo"] })).toEqual([title(151, 3, 8)])
  store.close()
  const after = new Database(path.join(dir, "mendd.db"), { readonly: true })
  expect(after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_auxiliary_daily").get()!.n).toBe(2)
  expect(after.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE 'usage_auxiliary%'").all().map((row) => row.name)).toEqual(["usage_auxiliary_daily"])
  after.close()
})
