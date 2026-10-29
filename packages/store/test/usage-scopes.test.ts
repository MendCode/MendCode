import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ids = createIdFactory()
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-scopes-"))
  dirs.push(dir)
  let at = Date.UTC(2026, 8, 20, 12)
  const store = openStore({ dir, now: () => at, dayOf })
  const session = (directory: string, tokens: number, name: string) => {
    const sessionId = ids("session"), turnId = ids("turn"), queueId = ids("queue"), itemId = ids("item")
    store.createSession({ id: sessionId, directory, title: name })
    store.setSessionModel(sessionId, { model: name, effort: "high" })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId, text: "Review local changes", attachments: [] })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: `skill: ${name}` } })
    at += 200
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "error" })
    store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "local", model: name, input: tokens, output: 10, reasoning: 5, cacheRead: 20, cacheWrite: 2, costMicros: 100 })
    at += 300
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    return sessionId
  }
  return { store, dir, session, at: (value: number) => { at = value } }
}
const range = { from: "2026-09-20", to: "2026-09-20", directories: ["/repo/src"] }

test("session savings span days, isolate sessions and survive reopening", () => {
  const h = fixture()
  const sessionId = h.session("/repo/src", 10, "panel")
  const otherId = h.session("/repo/src", 10, "other")
  const saved = (id: typeof sessionId, source: string, tokens: number) => {
    const turnId = ids("turn"), itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId: id, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: id, turnId, itemId, kind: "tool_call", meta: { tool: "graph_map" } })
    h.store.sessionSink.append({ type: "item.completed", sessionId: id, itemId, status: "ok", meta: { savedTokens: tokens, filter: source } })
    h.store.sessionSink.append({ type: "turn.completed", sessionId: id, turnId })
  }
  saved(sessionId, "graft", 1000)
  saved(otherId, "graft", 99_000)
  h.at(Date.UTC(2026, 8, 21, 12))
  saved(sessionId, "graft", 2000)
  saved(sessionId, "git", 500)
  const expected = [{ source: "graft", calls: 2, tokens: 3000 }, { source: "git", calls: 1, tokens: 500 }]
  expect(h.store.usageScopes.sessionSavings(sessionId)).toEqual(expected)
  expect(h.store.usageScopes.sessionSavings(ids("session"))).toEqual([])
  h.store.close()
  const reopened = openStore({ dir: h.dir, dayOf })
  try { expect(reopened.usageScopes.sessionSavings(sessionId)).toEqual(expected) }
  finally { reopened.close() }
})

test("scoped projections isolate all metrics and range/lifetime insights; empty selection never becomes global", () => {
  const h = fixture()
  try {
    const selected = h.session("/repo/src", 100, "review")
    h.session("/repo/tests", 1000, "test")
    h.session("/repo-other", 10000, "build")
    h.at(Date.UTC(2026, 8, 21, 12))
    h.session("/repo/src", 50, "next")
    const s = h.store.usageScopes
    expect(s.daily(range)).toEqual([{ day: "2026-09-20", input: 100, output: 10, reasoning: 5, cacheRead: 20, cacheWrite: 2, costMicros: 100, costUnknownCalls: 0, calls: 1, sessions: 1 }])
    expect(s.sessions(range)).toBe(1)
    expect(s.models(range)).toMatchObject([{ provider: "local", model: "review", input: 100, calls: 1 }])
    expect(s.activity(range)).toMatchObject([{ day: "2026-09-20", prompts: 1, words: 3, aiMs: 0, toolMs: 200 }])
    expect(s.tools(range)).toEqual([{ tool: "skill", calls: 1, ms: 200, errors: 1 }])
    expect(s.insights({ ...range, today: "2026-09-21" })).toMatchObject({ lifetime: { tokens: 170, since: "2026-09-20" }, peakDay: { day: "2026-09-20", tokens: 110 },
      streak: { current: 2, longest: 2 }, efforts: [{ effort: "high", turns: 1 }], skills: [{ skill: "review", runs: 1 }], topSessions: [{ sessionId: selected, tokens: 110, ms: 500, turns: 1 }] })
    const empty = { ...range, directories: [] }
    expect(s.daily(empty)).toEqual([])
    expect(s.sessions(empty)).toBe(0)
    expect(s.insights({ ...empty, today: "2026-09-21" })).toEqual({ streak: { current: 0, longest: 0 }, efforts: [], skills: [], topSessions: [] })
    expect(h.store.usageDaily(range)[0]!.input).toBe(11100)
  } finally { h.store.close() }
})

test("scoped history backfills transactionally once and survives reopen without double counting", () => {
  const h = fixture()
  h.session("/repo/src", 100, "review")
  const expected = h.store.usageScopes.insights({ ...range, today: "2026-09-20" })
  h.store.close()
  const db = new Database(path.join(h.dir, "mendd.db"))
  for (const table of ["daily", "activity", "tools", "labels"]) db.run(`DELETE FROM usage_scope_${table}`)
  db.run("DELETE FROM meta WHERE key = 'usage_scopes_backfill'")
  db.close()
  for (let i = 0; i < 2; i++) {
    const store = openStore({ dir: h.dir, dayOf })
    try {
      expect(store.usageScopes.daily(range)[0]!.calls).toBe(1)
      expect(store.usageScopes.tools(range)[0]!.calls).toBe(1)
      expect(store.usageScopes.insights({ ...range, today: "2026-09-20" })).toEqual(expected)
    } finally { store.close() }
  }
})
