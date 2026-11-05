import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ids = createIdFactory()
const T0 = new Date(2026, 9, 10, 9, 0).getTime()
const DAY = "2026-10-10"

test("every model call and finished compaction becomes a row in session order, scoped by directory, and the backfill runs once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-calls-"))
  dirs.push(dir)
  let clock = T0
  let store = openStore({ dir, now: () => clock })
  const here = ids("session")
  const there = ids("session")
  store.createSession({ id: here, directory: "/repo", title: "here" })
  store.createSession({ id: there, directory: "/other", title: "there" })
  const turnId = ids("turn")
  const append = (at: number, draft: Parameters<typeof store.sessionSink.append>[0]) => { clock = at; store.sessionSink.append(draft) }
  append(T0, { type: "usage.recorded", sessionId: here, turnId, provider: "anthropic", model: "claude-opus-5-5", input: 100, output: 20, reasoning: 5, cacheRead: 30_000, cacheWrite: 400, costMicros: 12, cacheTtl: "1h", compactAt: 200_000, profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 300, durationMs: 900, toolCount: 0, imageCount: 0 } } as never)
  append(T0 + 1_000, { type: "usage.recorded", sessionId: there, turnId, provider: "claude", model: "claude-opus-5-5", input: 1, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 4, context: 99 })
  append(T0 + 2_000, { type: "compaction.updated", sessionId: here, turnId, reason: "auto", state: "writing", followUp: "" })
  append(T0 + 9_000, { type: "compaction.updated", sessionId: here, turnId, reason: "auto", idle: true, state: "packed", followUp: "" })

  const all = store.usageCalls.calls({ from: DAY, to: DAY })
  expect(all.map((row) => [row.sessionId, row.input, row.cacheRead, row.costMicros, row.context, row.compactAt, row.ttl, row.durationMs])).toEqual([
    [here, 100, 30_000, 12, null, 200_000, "1h", 900],
    [there, 1, 3, null, 99, null, null, null],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  expect(store.usageCalls.calls({ from: DAY, to: DAY, directories: ["/repo"] }).map((row) => row.sessionId)).toEqual([here])
  expect(store.usageCalls.compactions({ from: DAY, to: DAY })).toEqual([{ sessionId: here, seq: expect.any(Number), at: T0 + 9_000, reason: "idle", state: "packed", waitMs: 7_000 }])
  expect(store.usageCalls.sessions([here]).map((row) => row.title)).toEqual(["here"])
  store.close()

  // A database from before the table existed: the rows are built from the log on the next open, once.
  const db = new Database(path.join(dir, "mendd.db"))
  db.run("DELETE FROM usage_calls; DELETE FROM usage_compactions; DELETE FROM meta WHERE key = 'usage_calls_backfill'")
  db.close()
  store = openStore({ dir, now: () => clock })
  expect(store.usageCalls.calls({ from: DAY, to: DAY })).toHaveLength(2)
  expect(store.usageCalls.compactions({ from: DAY, to: DAY })).toHaveLength(1)
  store.close()
})

test("cache samples pair consecutive main calls of a provider, skipping a compaction between them and short prompts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-usage-samples-"))
  dirs.push(dir)
  let clock = T0
  const store = openStore({ dir, now: () => clock })
  const session = ids("session")
  store.createSession({ id: session, directory: "/repo", title: "samples" })
  const turnId = ids("turn")
  const call = (at: number, cacheRead: number, extra: Record<string, unknown> = {}) => {
    clock = at
    store.sessionSink.append({ type: "usage.recorded", sessionId: session, turnId, provider: "chatgpt", model: "gpt-6", input: 6_000, output: 10, reasoning: 0, cacheRead, cacheWrite: 0, compactAt: 200_000, ...extra } as never)
  }
  call(T0, 0)
  call(T0 + 4 * 60_000, 6_000)
  call(T0 + 20 * 60_000, 0)
  clock = T0 + 21 * 60_000
  store.sessionSink.append({ type: "compaction.updated", sessionId: session, turnId, reason: "auto", state: "writing", followUp: "" })
  clock = T0 + 22 * 60_000
  store.sessionSink.append({ type: "compaction.updated", sessionId: session, turnId, reason: "auto", state: "packed", followUp: "" })
  call(T0 + 30 * 60_000, 6_000)
  call(T0 + 31 * 60_000, 3_000, { input: 100 })
  const query = { provider: "chatgpt", ttl: null, since: T0 - 86_400_000, minPrompt: 4_096, limit: 50 }
  expect(store.usageCalls.cacheSamples(query).map((row) => [row.gapMs, row.hit]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[4 * 60_000, true], [16 * 60_000, false]])
  expect(store.usageCalls.cacheSamples({ ...query, provider: "anthropic" })).toEqual([])
  store.close()
})
