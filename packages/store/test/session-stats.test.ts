import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ids = createIdFactory()
const MINUTE = 60_000
/** 10:30 local time: the hour keys are local, so the test builds its times in local time too. */
const T0 = new Date(2026, 8, 20, 10, 30).getTime()

function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-session-stats-"))
  dirs.push(dir)
  let clock = T0
  const store = openStore({ dir, now: () => clock })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/repo", title: "research" })
  const append = (at: number, draft: Parameters<typeof store.sessionSink.append>[0]) => { clock = at; store.sessionSink.append(draft) }
  return { store, sessionId, append }
}

const usage = (sessionId: SessionId, turnId: string, output: number, extra: Record<string, unknown> = {}) =>
  ({ type: "usage.recorded" as const, sessionId, turnId: turnId as never, provider: "claude", model: "claude-opus-5-5", input: 10, output, reasoning: 0, cacheRead: 1_000, cacheWrite: 0, ...extra })

describe("session stats", () => {
  test("turn time and usage are split over the hours a turn ran; unknown usage is counted, never guessed", () => {
    const { store, sessionId, append } = harness()
    // 10:30 → 12:00, 600 output tokens: 30 min (200) in the 10:00 hour, 60 min (400) in the 11:00 hour.
    const long = ids("turn")
    append(T0, { type: "turn.started", sessionId, turnId: long, queueId: ids("queue") })
    append(T0 + 90 * MINUTE, usage(sessionId, long, 600))
    append(T0 + 90 * MINUTE, { type: "turn.completed", sessionId, turnId: long })
    // Cancelled with only the calls' sums.
    const cut = ids("turn")
    append(T0 + 100 * MINUTE, { type: "turn.started", sessionId, turnId: cut, queueId: ids("queue") })
    append(T0 + 110 * MINUTE, usage(sessionId, cut, 50, { partial: true }))
    append(T0 + 110 * MINUTE, { type: "turn.cancelled", sessionId, turnId: cut, by: "user" })
    // Failed with nothing recorded, after waiting 5 minutes on an approval.
    const lost = ids("turn")
    const requestId = ids("request")
    append(T0 + 120 * MINUTE, { type: "turn.started", sessionId, turnId: lost, queueId: ids("queue") })
    append(T0 + 121 * MINUTE, { type: "server.request", sessionId, turnId: lost, requestId, kind: "approval", title: "Run command", detail: "rm -rf build" } as never)
    append(T0 + 126 * MINUTE, { type: "server.request.resolved", sessionId, requestId, resolution: "approved" } as never)
    append(T0 + 130 * MINUTE, { type: "turn.failed", sessionId, turnId: lost, error: { code: "x", message: "x" } } as never)

    const stats = store.sessionStats.get(sessionId, T0 + 200 * MINUTE)!
    expect(stats.turns).toMatchObject({ total: 3, completed: 1, cancelled: 1, failed: 1, running: 0, activeMs: 110 * MINUTE, withoutUsage: 1, partialUsage: 1 })
    expect(stats.turns.longest[0]).toMatchObject({ turnId: long, ms: 90 * MINUTE, status: "completed", usage: { output: 600 } })
    expect(stats.usage.total.output).toBe(650)
    expect(stats.usage.byModel).toEqual([{ provider: "claude", model: "claude-opus-5-5", records: 2, input: 20, output: 650, reasoning: 0, cacheRead: 2_000, cacheWrite: 0, costMicros: 0 }])
    const hour = (key: number) => stats.hours.find((entry) => entry.key.endsWith(`${String(key).padStart(2, "0")}:00`))!
    expect(hour(10)).toMatchObject({ activeMs: 30 * MINUTE, turns: 1, usage: { output: 200 } })
    expect(hour(11)).toMatchObject({ activeMs: 60 * MINUTE, usage: { output: 400 } })
    expect(hour(12)).toMatchObject({ activeMs: 20 * MINUTE, turns: 2, usage: { output: 50 } })
    expect(stats.days).toHaveLength(1)
    expect(stats.days[0]).toMatchObject({ activeMs: 110 * MINUTE, turns: 3, usage: { output: 650 } })
    expect(stats.approvals).toEqual({ asked: 1, waitMs: 5 * MINUTE })
    store.close()
  })

  test("tools count by name with their errors; sub-agents' calls and totals are kept apart", () => {
    const { store, sessionId, append } = harness()
    const turnId = ids("turn")
    append(T0, { type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    const agent = ids("item")
    for (const [tool, status, parent] of [["shell: ls", "ok"], ["shell: false", "error"], ["read: a.ts", "ok"], ["Agent: research", "ok"], ["shell: grep x", "ok", agent]] as const) {
      const itemId = tool.startsWith("Agent") ? agent : ids("item")
      append(T0, { type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool, ...(parent ? { agentParent: parent } : {}) } })
      append(T0, { type: "item.completed", sessionId, itemId, status, ...(tool.startsWith("Agent") ? { meta: { agentParent: agent, agentEnd: true, toolCalls: 12, tokens: 40_000, durationMs: 9 * MINUTE } } : {}) } as never)
    }
    append(T0 + MINUTE, { type: "turn.completed", sessionId, turnId })
    const stats = store.sessionStats.get(sessionId, T0 + MINUTE)!
    expect(stats.tools).toEqual({ calls: 4, errors: 1, byTool: [{ tool: "shell", calls: 2, errors: 1 }, { tool: "read", calls: 1, errors: 0 }, { tool: "Agent", calls: 1, errors: 0 }], bySubAgents: 1 })
    expect(stats.subAgents).toEqual({ runs: 1, toolCalls: 12, tokens: 40_000, ms: 9 * MINUTE })
    expect(stats.turns.withoutUsage).toBe(1)
    store.close()
  })

  test("a running turn counts up to now, and an unknown session has no stats", () => {
    const { store, sessionId, append } = harness()
    append(T0, { type: "turn.started", sessionId, turnId: ids("turn"), queueId: ids("queue") })
    expect(store.sessionStats.get(sessionId, T0 + 7 * MINUTE)!.turns).toMatchObject({ running: 1, activeMs: 7 * MINUTE, withoutUsage: 0 })
    expect(store.sessionStats.get("session_missing", T0)).toBeUndefined()
    store.close()
  })
})
