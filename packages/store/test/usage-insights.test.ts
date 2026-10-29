import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"
import { streaks } from "../src/usage-insights"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-insights-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 8, 20, 12)
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

function harness(dir = tempDir()) {
  let clock = T0
  const store = openStore({ dir, now: () => clock, dayOf })
  return {
    dir,
    store,
    at(ms: number) {
      clock = ms
    },
    session(title = "t", directory = "/repo") {
      const id = ids("session")
      store.createSession({ id, directory, title })
      return id
    },
  }
}

function usage(sessionId: SessionId, turnId: ReturnType<typeof ids<"turn">>, input: number, output: number) {
  return { type: "usage.recorded" as const, sessionId, turnId, provider: "openai", model: "gpt-6-luna", input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

describe("streaks", () => {
  test("longest run and the run ending today or yesterday", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-10", "2026-09-28", "2026-09-29"]
    expect(streaks(days, "2026-09-29")).toEqual({ current: 2, longest: 3 })
    expect(streaks(days, "2026-09-30")).toEqual({ current: 2, longest: 3 })
    expect(streaks(days, "2026-10-01")).toEqual({ current: 0, longest: 3 })
    expect(streaks([], "2026-09-29")).toEqual({ current: 0, longest: 0 })
    expect(streaks(["2026-02-28", "2026-03-01"], "2026-03-01")).toEqual({ current: 2, longest: 2 })
  })
})

describe("usage insights", () => {
  test("turns count per session effort, and turn time adds up per session", () => {
    const h = harness()
    const a = h.session("alpha")
    h.store.setSessionModel(a, { model: "gpt-6-luna", effort: "high" })
    const b = h.session("beta")
    for (const [sessionId, startAt, endAt] of [[a, T0, T0 + 2 * HOUR], [a, T0 + 3 * HOUR, T0 + 4 * HOUR], [b, T0, T0 + 10 * 60_000]] as const) {
      const turnId = ids("turn")
      h.at(startAt)
      h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      h.store.sessionSink.append(usage(sessionId, turnId, 1_000, 100))
      h.at(endAt)
      h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    }
    const insights = h.store.usageInsights({ from: "2026-09-01", to: "2026-09-30", today: "2026-09-20" })
    expect(insights.efforts).toEqual([
      { effort: "high", turns: 2 },
      { effort: "default", turns: 1 },
    ])
    expect(insights.longestSession).toMatchObject({ sessionId: a, title: "alpha", ms: 3 * HOUR, turns: 2, tokens: 2_200 })
    expect(insights.topSessions.map((s) => s.sessionId)).toEqual([a, b])
    expect(insights.lifetime).toEqual({ tokens: 3_300, since: "2026-09-20" })
    expect(insights.peakDay).toEqual({ day: "2026-09-20", tokens: 3_300 })
    expect(insights.streak).toEqual({ current: 1, longest: 1 })
    h.store.close()
  })

  test("skill loads count by name from tool items titled 'skill: <name>'", () => {
    const h = harness()
    const s = h.session()
    const turnId = ids("turn")
    h.store.sessionSink.append({ type: "turn.started", sessionId: s, turnId, queueId: ids("queue") })
    for (const tool of ["skill: build", "skill: build", "skill: fix", "read: a.ts"]) h.store.sessionSink.append({ type: "item.started", sessionId: s, turnId, itemId: ids("item"), kind: "tool_call", meta: { tool } })
    expect(h.store.usageInsights({ from: "2026-09-20", to: "2026-09-20", today: "2026-09-20" }).skills).toEqual([
      { skill: "build", runs: 2 },
      { skill: "fix", runs: 1 },
    ])
    h.store.close()
  })

  test("range figures only count what happened in the range; all-time figures ignore it", () => {
    const h = harness()
    const s = h.session()
    for (const [offset, input] of [[0, 500], [DAY, 5_000], [5 * DAY, 50]] as const) {
      const turnId = ids("turn")
      h.at(T0 + offset)
      h.store.sessionSink.append({ type: "turn.started", sessionId: s, turnId, queueId: ids("queue") })
      h.store.sessionSink.append(usage(s, turnId, input, 0))
    }
    const early = h.store.usageInsights({ from: "2026-09-01", to: "2026-09-19", today: "2026-09-25" })
    expect(early.efforts).toEqual([])
    expect(early.topSessions).toEqual([])
    expect(early.lifetime).toEqual({ tokens: 5_550, since: "2026-09-20" })
    expect(early.peakDay).toEqual({ day: "2026-09-21", tokens: 5_000 })
    expect(early.streak).toEqual({ current: 1, longest: 2 })
    h.store.close()
  })

  test("an empty store reports no lifetime, no peak and zero streaks", () => {
    const h = harness()
    expect(h.store.usageInsights({ from: "2026-09-01", to: "2026-09-30", today: "2026-09-20" })).toEqual({ streak: { current: 0, longest: 0 }, efforts: [], skills: [], topSessions: [] })
    h.store.close()
  })

  test("a store reopened keeps its figures and backfills only once", () => {
    const h = harness()
    const s = h.session()
    const turnId = ids("turn")
    h.store.sessionSink.append({ type: "turn.started", sessionId: s, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: s, turnId, itemId: ids("item"), kind: "tool_call", meta: { tool: "skill: build" } })
    h.store.sessionSink.append(usage(s, turnId, 10, 5))
    h.store.close()
    const again = openStore({ dir: h.dir, now: () => T0, dayOf })
    const insights = again.usageInsights({ from: "2026-09-20", to: "2026-09-20", today: "2026-09-20" })
    expect(insights.skills).toEqual([{ skill: "build", runs: 1 }])
    expect(insights.topSessions[0]).toMatchObject({ sessionId: s, turns: 1, tokens: 15 })
    again.close()
  })
})
