import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type Loop, type LoopId, type QueueId, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { createLoopService, describeTrigger, finishRun, nextWake, parseCheckpoint, parseTrigger } from "../src"

const START = new Date(2026, 8, 26, 10, 0, 0).getTime()

function harness() {
  const clock = createVirtualClock(START)
  const ids = createIdFactory({ now: () => clock.now() })
  const saved = new Map<LoopId, Loop>()
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const service = createLoopService({
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    clock,
    ids,
    createSession: () => ids("session"),
    submit: async ({ sessionId, text }) => {
      const queueId = ids("queue")
      submitted.push({ sessionId, text, queueId })
      return { queueId }
    },
  })
  let seq = 0
  /** Plays a whole turn of the loop session: start, an agent message with `answer`, and a terminal event. */
  const playTurn = (answer: string, terminal: "turn.completed" | "turn.failed" | "turn.cancelled" = "turn.completed") => {
    const last = submitted.at(-1)!
    const turnId = ids("turn") as TurnId
    const itemId = ids("item")
    const tool = ids("item")
    const ev = (e: Record<string, unknown>) => service.observe({ sessionId: last.sessionId, seq: ++seq, at: clock.now(), ...e } as SessionEvent)
    ev({ type: "turn.started", turnId, queueId: last.queueId })
    ev({ type: "item.started", turnId, itemId: tool, kind: "tool_call" })
    ev({ type: "item.completed", itemId: tool, status: "ok", text: "```LOOP_CHECKPOINT\nstatus: complete\n```" })
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text: answer })
    ev(terminal === "turn.failed" ? { type: terminal, turnId, error: { code: "x", message: "y" } } : terminal === "turn.cancelled" ? { type: terminal, turnId, by: "user" } : { type: terminal, turnId })
  }
  return { clock, service, saved, submitted, playTurn }
}

const checkpoint = (status: string, summary = "did things") => `Work done.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: ${summary}\nnext: more\n\`\`\``
const flush = () => new Promise((r) => setImmediate(r))

describe("loop scheduling", () => {
  test("triggers parse and describe; daily wakeups use the next local occurrence", () => {
    expect(parseTrigger("every 30m")).toEqual({ kind: "interval", everyMs: 1_800_000 })
    expect(parseTrigger("every 2h")).toEqual({ kind: "interval", everyMs: 7_200_000 })
    expect(parseTrigger("daily 09:00")).toEqual({ kind: "daily", at: "09:00" })
    expect(parseTrigger("every 10s")).toBeUndefined()
    expect(parseTrigger("sometimes")).toBeUndefined()
    expect(describeTrigger({ kind: "interval", everyMs: 86_400_000 })).toBe("every 1d")
    expect(new Date(nextWake({ kind: "daily", at: "09:00" }, START)!).getDate()).toBe(27)
    expect(new Date(nextWake({ kind: "daily", at: "11:30" }, START)!).getHours()).toBe(11)
    expect(nextWake({ kind: "manual" }, START)).toBeUndefined()
  })

  test("checkpoints are read from the last block and invalid statuses are ignored", () => {
    expect(parseCheckpoint(checkpoint("continue"))).toEqual({ status: "continue", summary: "did things", next: "more" })
    expect(parseCheckpoint(`${checkpoint("continue")}\n${checkpoint("complete", "all green")}`)?.status).toBe("complete")
    expect(parseCheckpoint("```LOOP_CHECKPOINT\nstatus: maybe\n```")).toBeUndefined()
    expect(parseCheckpoint("no block")).toBeUndefined()
  })
})

describe("loop service", () => {
  test("partial updates preserve omitted options, including a legacy goal's absent audit", () => {
    const { service, clock } = harness()
    const loop = service.create({ name: "watch", directory: "/repo", objective: "check", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
    const edited = service.update(loop.loopId, { name: "renamed" })!
    expect(edited).toEqual({ ...loop, name: "renamed", updatedAt: loop.updatedAt + 1, journal: edited.journal })
    expect(edited.journal?.at(-1)).toMatchObject({ type: "updated", title: "renamed: active" })
    const legacy: Loop = { ...loop, budget: { mode: "goal" } }
    const restored = createLoopService({ store: { all: () => [legacy], save() {}, remove() {} }, clock, ids: createIdFactory(), createSession: () => loop.sessionId, submit: async () => ({ error: "unused" }) })
    const updated = restored.update(loop.loopId, { objective: "new objective" })!
    expect(updated.audit).toBeUndefined()
    expect(updated.history).toEqual(legacy.history)
    restored.dispose()
    service.dispose()
  })

  test("an unchanged adaptive trigger keeps its pace; a changed trigger resets it", async () => {
    const { service, clock, playTurn } = harness()
    const trigger = { kind: "adaptive" as const, everyMs: 60_000 }
    const loop = service.create({ name: "watch", directory: "/repo", objective: "check", trigger, budget: { mode: "monitor" } })
    clock.advance(60_000)
    await flush()
    playTurn("```LOOP_CHECKPOINT\nstatus: continue\nactivity: idle\n```")
    expect(service.get(loop.loopId)!.adaptiveMs).toBe(120_000)
    expect(service.update(loop.loopId, { name: "renamed", trigger })).toMatchObject({ adaptiveMs: 120_000, nextWakeAt: clock.now() + 120_000 })
    const changed = service.update(loop.loopId, { trigger: { kind: "adaptive", everyMs: 180_000 } })!
    expect(changed.adaptiveMs).toBeUndefined()
    expect(changed.nextWakeAt).toBe(clock.now() + 180_000)
    service.dispose()
  })

  test("updating the schedule cancels the old timer, fires at the new time and keeps run history", async () => {
    const { clock, service, submitted, playTurn, saved } = harness()
    const loop = service.create({ name: "watch", directory: "/repo", objective: "check", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" } })
    clock.advance(60_000)
    await flush()
    playTurn(checkpoint("continue"))
    const before = service.get(loop.loopId)!
    clock.advance(1_000)
    const updated = service.update(loop.loopId, { trigger: { kind: "interval", everyMs: 120_000 }, objective: "check again" })!
    expect(updated).toMatchObject({ loopId: loop.loopId, sessionId: loop.sessionId, history: before.history, runs: 1, state: "active", createdAt: loop.createdAt, updatedAt: clock.now(), nextWakeAt: clock.now() + 120_000 })
    expect(saved.get(loop.loopId)).toEqual(updated)
    clock.advance(60_000)
    await flush()
    expect(submitted).toHaveLength(1)
    clock.advance(60_000)
    await flush()
    expect(submitted).toHaveLength(2)
    expect(submitted[1]!.text).toContain("check again")
    service.dispose()
  })

  test("an interval monitor wakes on time, runs in its session and schedules the next wakeup", async () => {
    const { clock, service, submitted, playTurn } = harness()
    const loop = service.create({ name: "deps", directory: "/repo", objective: "check outdated deps", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    expect(loop.nextWakeAt).toBe(START + 3_600_000)
    clock.advance(3_599_000)
    expect(submitted).toHaveLength(0)
    clock.advance(1_000)
    await flush()
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.text).toContain("check outdated deps")
    expect(submitted[0]!.text).toContain("LOOP_CHECKPOINT")
    expect(service.get(loop.loopId)!.state).toBe("running")
    playTurn(checkpoint("continue"))
    const after = service.get(loop.loopId)!
    expect(after.state).toBe("active")
    expect(after.nextWakeAt).toBe(clock.now() + 3_600_000)
    expect(after.history.at(-1)).toMatchObject({ run: 1, outcome: "completed", checkpoint: { status: "continue" } })
  })

  test("a goal loop completes only on an explicit complete checkpoint; tool output never counts", async () => {
    const { service, playTurn } = harness()
    const loop = service.create({ name: "fix", directory: "/repo", objective: "make tests pass", trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 3 }, runNow: true, audit: "none" })
    await flush()
    service.runNow(loop.loopId)
    await flush()
    playTurn("no checkpoint in the answer")
    expect(service.get(loop.loopId)!.state).toBe("active")
    service.runNow(loop.loopId)
    await flush()
    playTurn(checkpoint("complete", "all tests pass"))
    expect(service.get(loop.loopId)).toMatchObject({ state: "completed", reason: "all tests pass" })
  })

  test("fixed loops finish after maxRuns; goal loops that hit the cap are blocked, not completed", () => {
    const base = { loopId: "lop_x", name: "n", directory: "/r", objective: "o", trigger: { kind: "manual" as const }, state: "running" as const, sessionId: "ses_x", history: [{ run: 2, startedAt: 0 }], createdAt: 0, updatedAt: 0 } as unknown as Loop
    expect(finishRun({ ...base, budget: { mode: "fixed", maxRuns: 2 }, runs: 2 }, { outcome: "completed", finalText: checkpoint("continue"), at: 5 }).state).toBe("completed")
    expect(finishRun({ ...base, budget: { mode: "goal", maxRuns: 2 }, runs: 2 }, { outcome: "completed", finalText: checkpoint("continue"), at: 5 }).state).toBe("blocked")
    expect(finishRun({ ...base, budget: { mode: "monitor" }, runs: 99 }, { outcome: "completed", finalText: checkpoint("blocked", "needs creds"), at: 5 })).toMatchObject({ state: "blocked", reason: "needs creds" })
    expect(finishRun({ ...base, budget: { mode: "monitor" }, runs: 1 }, { outcome: "cancelled", finalText: "", at: 5 }).state).toBe("paused")
  })

  test("a pending approval makes the loop needs_input until it is resolved", async () => {
    const { service, submitted } = harness()
    const loop = service.create({ name: "n", directory: "/r", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, runNow: true })
    service.runNow(loop.loopId)
    await flush()
    const last = submitted.at(-1)!
    const turnId = "trn_01" as TurnId
    service.observe({ sessionId: last.sessionId, seq: 1, at: 0, type: "turn.started", turnId, queueId: last.queueId } as SessionEvent)
    service.observe({ sessionId: last.sessionId, seq: 2, at: 0, type: "server.request", turnId, requestId: "req_1", kind: "approval", title: "Run command", detail: "rm" } as unknown as SessionEvent)
    expect(service.get(loop.loopId)).toMatchObject({ state: "needs_input", reason: "Run command" })
    service.observe({ sessionId: last.sessionId, seq: 3, at: 0, type: "server.request.resolved", requestId: "req_1", resolution: "approved" } as unknown as SessionEvent)
    expect(service.get(loop.loopId)!.state).toBe("running")
  })

  test("pause stops wakeups, resume re-arms, stop is final; a restart closes an in-flight run as interrupted", async () => {
    const h = harness()
    const loop = h.service.create({ name: "n", directory: "/r", objective: "o", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" } })
    h.service.pause(loop.loopId)
    h.clock.advance(120_000)
    await flush()
    expect(h.submitted).toHaveLength(0)
    h.service.resume(loop.loopId)
    h.clock.advance(60_000)
    await flush()
    expect(h.submitted).toHaveLength(1)
    const restarted = createLoopService({
      store: { all: () => [...h.saved.values()], save: (l) => void h.saved.set(l.loopId, l), remove: () => {} },
      clock: h.clock,
      ids: createIdFactory(),
      createSession: () => "ses_x" as SessionId,
      submit: async () => ({ error: "unused" }),
    })
    restarted.start()
    expect(restarted.get(loop.loopId)).toMatchObject({ state: "active" })
    expect(restarted.get(loop.loopId)!.history.at(-1)).toMatchObject({ outcome: "interrupted" })
    restarted.stop(loop.loopId)
    expect(restarted.get(loop.loopId)!.state).toBe("stopped")
    expect(restarted.runNow(loop.loopId)).toBe(false)
  })
})
