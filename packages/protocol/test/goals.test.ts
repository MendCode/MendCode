import { describe, expect, test } from "bun:test"
import { Command, GOAL_INLINE_OBJECTIVE_CHARS, GOAL_MAX_OBJECTIVE_CHARS, GOAL_STATUSES, GOAL_TERMINAL_STATUSES, Goal, SessionEvent, createIdFactory, decodeFrame, encodeFrame } from "../src"
import { FOOTER_SEGMENTS, PROTOCOL_VERSION } from "../src/constants"

let seed = 0
const id = createIdFactory({ now: () => 1_790_000_000_000, random: (n) => new Uint8Array(n).fill(seed++ % 32) })
const sessionId = id("session")
const clientId = id("client")
const base = () => ({ id: id("command"), clientId, sessionId })

const goal = { goalId: id("goal"), sessionId, objective: "ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }

describe("goal protocol", () => {
  test("goal ids carry their own prefix", () => {
    expect(id("goal").startsWith("gol_")).toBe(true)
    expect(Goal.safeParse({ ...goal, goalId: id("loop") }).success).toBe(false)
  })

  test("the statuses are the six of a session goal, two of them terminal", () => {
    expect([...GOAL_STATUSES]).toEqual(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"])
    expect([...GOAL_TERMINAL_STATUSES]).toEqual(["budget_limited", "complete"])
    expect(Goal.safeParse({ ...goal, status: "done" }).success).toBe(false)
    expect(Goal.safeParse({ ...goal, extra: 1 }).success).toBe(false)
  })

  test("goal.get, goal.set, goal.update and goal.clear parse; empty or oversized input does not", () => {
    expect(Command.safeParse({ ...base(), type: "goal.get" }).success).toBe(true)
    expect(Command.safeParse({ ...base(), type: "goal.get", history: true }).success).toBe(true)
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "  fix the build  ", tokenBudget: 50_000, replace: true })).toMatchObject({ success: true, data: { objective: "fix the build" } })
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "   " }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "x".repeat(GOAL_MAX_OBJECTIVE_CHARS + 1) }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "x".repeat(GOAL_INLINE_OBJECTIVE_CHARS + 1) }).success).toBe(true)
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "x", tokenBudget: 0 }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.set", objective: "x", tokenBudget: 1.5 }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.update", status: "paused" }).success).toBe(true)
    expect(Command.safeParse({ ...base(), type: "goal.update", status: "active", objective: "new" }).success).toBe(true)
    expect(Command.safeParse({ ...base(), type: "goal.update", tokenBudget: null }).success).toBe(true)
    // The user cannot complete or block a goal by command: those are the agent's calls.
    expect(Command.safeParse({ ...base(), type: "goal.update", status: "complete" }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.update" }).success).toBe(false)
    expect(Command.safeParse({ ...base(), type: "goal.clear" }).success).toBe(true)
    expect(Command.safeParse({ id: id("command"), clientId, type: "goal.clear" }).success).toBe(false)
  })

  test("goal.changed is a session event carrying the whole goal, and survives a frame round trip", () => {
    const event = { sessionId, seq: 4, at: 10, type: "goal.changed", change: "status", goal: { ...goal, status: "blocked", note: "needs a key" }, by: "agent", reason: "needs a key" }
    expect(SessionEvent.safeParse(event).success).toBe(true)
    expect(SessionEvent.safeParse({ ...event, change: "moved" }).success).toBe(false)
    expect(SessionEvent.safeParse({ ...event, by: "robot" }).success).toBe(false)
    const frame = encodeFrame({ v: PROTOCOL_VERSION, kind: "event", body: SessionEvent.parse(event) })
    expect(decodeFrame(frame.trim())).toMatchObject({ ok: true, frame: { body: { type: "goal.changed", goal: { status: "blocked" } } } })
  })

  test("a goal steering turn's item meta is accepted by the event schema", () => {
    const turnId = id("turn")
    const started = { sessionId, seq: 2, at: 1, type: "item.started", turnId, itemId: id("item"), kind: "user_message", meta: { notice: true, goal: "continuation" } }
    expect(SessionEvent.safeParse(started).success).toBe(true)
  })

  test("the footer can show the goal segment", () => {
    expect(FOOTER_SEGMENTS).toContain("goal")
  })

  test("the footer's opt-in status segments come after the original ten, so stored orders keep their meaning", () => {
    expect(FOOTER_SEGMENTS.slice(0, 10)).toEqual(["state", "permission", "context", "model", "quota", "today", "cost", "branch", "notice", "goal"])
    expect(FOOTER_SEGMENTS.slice(10)).toEqual(["cache", "tokens", "effort", "jobs", "sandbox", "vim", "update", "ttft", "tps", "spend", "forecast", "ctx", "hit", "think", "calls", "directory", "codegraph", "time", "warm"])
  })

  test("a usage event may say the call went without thinking, and only with true", () => {
    const usage = { sessionId, seq: 3, at: 1, type: "usage.recorded", turnId: id("turn"), provider: "p", model: "m", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    expect(SessionEvent.safeParse(usage).success).toBe(true)
    expect(SessionEvent.safeParse({ ...usage, thinkingDropped: true }).success).toBe(true)
    expect(SessionEvent.safeParse({ ...usage, thinkingDropped: false }).success).toBe(false)
  })
})
