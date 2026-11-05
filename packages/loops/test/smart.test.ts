import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type Loop, type LoopId, type LoopRun, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { createLoopService, runNotice } from "../src"

const START = new Date(2026, 10, 3, 10, 0, 0).getTime()
const flush = () => new Promise((r) => setImmediate(r))
const creator = "ses_01CREATORCREATORCREATOR" as SessionId

function harness(options: { approvalTimeoutMs?: number } = {}) {
  const clock = createVirtualClock(START)
  const ids = createIdFactory({ now: () => clock.now() })
  const saved = new Map<LoopId, Loop>()
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: ReturnType<typeof ids> }> = []
  const created: Array<{ permission?: string; readOnly?: boolean }> = []
  const notices: Array<{ loop: Loop; run: LoopRun }> = []
  const cancelled: Array<{ sessionId: SessionId; turnId: TurnId }> = []
  const service = createLoopService({
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    clock,
    ids,
    createSession: (input) => {
      created.push({ ...(input.permission ? { permission: input.permission } : {}), ...(input.readOnly ? { readOnly: true } : {}) })
      return ids("session")
    },
    submit: async ({ sessionId, text }) => {
      const queueId = ids("queue")
      submitted.push({ sessionId, text, queueId })
      return { queueId }
    },
    cancelTurn: (target) => void cancelled.push(target),
    notify: (notice) => void notices.push(notice),
    ...options,
  })
  let seq = 0
  const turnId = "trn_01" as TurnId
  const ev = (sessionId: SessionId, e: Record<string, unknown>) => service.observe({ sessionId, seq: ++seq, at: clock.now(), ...e } as SessionEvent)
  const start = () => {
    const last = submitted.at(-1)!
    ev(last.sessionId, { type: "turn.started", turnId, queueId: last.queueId })
    return last.sessionId
  }
  const finish = (sessionId: SessionId, answer: string, terminal: "turn.completed" | "turn.cancelled" = "turn.completed") => {
    const itemId = ids("item")
    ev(sessionId, { type: "item.started", turnId, itemId, kind: "agent_message" })
    ev(sessionId, { type: "item.completed", itemId, status: "ok", text: answer })
    ev(sessionId, terminal === "turn.cancelled" ? { type: terminal, turnId, by: "user" } : { type: terminal, turnId })
  }
  return { clock, service, saved, submitted, created, notices, cancelled, start, finish, ev, turnId }
}

const report = (summary: string) => `Report.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: continue\nsummary: ${summary}\n\`\`\``
const base = { name: "watch", directory: "/repo", objective: "report on the other repo", trigger: { kind: "manual" as const }, budget: { mode: "monitor" as const } }

describe("a loop waiting on an approval (AI)", () => {
  test("records the request it waits on and clears it when answered", async () => {
    const h = harness()
    const loop = h.service.create({ ...base, runNow: true })
    h.service.runNow(loop.loopId)
    await flush()
    const session = h.start()
    h.ev(session, { type: "server.request", turnId: h.turnId, requestId: "req_9", kind: "approval", title: "external directory access", detail: "external_directory: /elsewhere/*\n\nread /elsewhere/a.txt", tool: "read" })
    expect(h.service.get(loop.loopId)).toMatchObject({ state: "needs_input", waiting: { sessionId: session, requestId: "req_9", kind: "approval", title: "external directory access", tool: "read" } })
    h.ev(session, { type: "server.request.resolved", requestId: "req_9", resolution: "approved" })
    expect(h.service.get(loop.loopId)!.state).toBe("running")
    expect(h.service.get(loop.loopId)!.waiting).toBeUndefined()
  })

  test("an approval nobody gives ends the run with a clear message instead of leaving it running", async () => {
    const h = harness({ approvalTimeoutMs: 120_000 })
    const loop = h.service.create({ ...base, trigger: { kind: "interval", everyMs: 600_000 }, creatorSessionId: creator })
    h.clock.advance(600_000)
    await flush()
    const session = h.start()
    h.ev(session, { type: "server.request", turnId: h.turnId, requestId: "req_9", kind: "approval", title: "external directory access", detail: "" })
    h.clock.advance(119_000)
    expect(h.cancelled).toHaveLength(0)
    h.clock.advance(2_000)
    expect(h.cancelled).toEqual([{ sessionId: session, turnId: h.turnId }])
    // The engine abandons the request and the turn ends cancelled: the run failed (not "cancelled by you") and the next one is scheduled.
    h.finish(session, "", "turn.cancelled")
    const after = h.service.get(loop.loopId)!
    expect(after).toMatchObject({ state: "active", history: [{ outcome: "failed" }] })
    expect(after.reason).toContain("no answer to \"external directory access\" in 2m")
    expect(after.waiting).toBeUndefined()
    expect(after.nextWakeAt).toBeGreaterThan(h.clock.now())
    expect(h.notices.at(-1)?.run.outcome).toBe("failed")
    h.service.dispose()
  })

  test("an answer in time cancels the timer", async () => {
    const h = harness({ approvalTimeoutMs: 120_000 })
    const loop = h.service.create({ ...base, runNow: true })
    h.service.runNow(loop.loopId)
    await flush()
    const session = h.start()
    h.ev(session, { type: "server.request", turnId: h.turnId, requestId: "req_9", kind: "approval", title: "x", detail: "" })
    h.clock.advance(60_000)
    h.ev(session, { type: "server.request.resolved", requestId: "req_9", resolution: "approved" })
    h.clock.advance(600_000)
    expect(h.cancelled).toHaveLength(0)
    h.service.dispose()
  })
})

describe("report-only runs (AJ)", () => {
  test("the run note says to write the report as the answer and does not mention a plan to submit", async () => {
    const h = harness()
    const loop = h.service.create({ ...base, reportOnly: true, runNow: true })
    h.service.runNow(loop.loopId)
    await flush()
    const text = h.submitted.at(-1)!.text
    expect(text).toContain("Report-only: write the report as your answer")
    expect(text).toContain("do not call plan_review, plan_exit or plan_submit")
    expect(h.service.reportOnlySession(loop.sessionId)).toBe(true)
    expect(h.service.forSession(loop.sessionId)?.loopId).toBe(loop.loopId)
  })
})

describe("a notice per run (AK)", () => {
  test("a loop with a creator leaves one short notice per ended run; the notice names the loop session", async () => {
    const h = harness()
    const loop = h.service.create({ ...base, creatorSessionId: creator, runNow: true })
    expect(loop).toMatchObject({ creatorSessionId: creator, notify: "creator" })
    h.service.runNow(loop.loopId)
    await flush()
    expect(h.notices).toHaveLength(0)
    h.finish(h.start(), report("the other repo has 3 new commits"))
    expect(h.notices).toHaveLength(1)
    const text = runNotice(h.notices[0]!.loop, h.notices[0]!.run)
    expect(text.startsWith('[loop "watch" · run 1 continue] the other repo has 3 new commits (')).toBe(true)
    expect(text).toContain(`session ${loop.sessionId}`)
    expect(text).toContain(`/loop open ${loop.loopId}`)
    expect(text.includes("\n")).toBe(false)
    h.service.runNow(loop.loopId)
    await flush()
    h.finish(h.start(), report("nothing new"))
    expect(h.notices).toHaveLength(2)
  })

  test("notify none, and a loop without a creator, leave nothing", async () => {
    const h = harness()
    const quiet = h.service.create({ ...base, creatorSessionId: creator, notify: "none", runNow: true })
    h.service.runNow(quiet.loopId)
    await flush()
    h.finish(h.start(), report("a"))
    const alone = h.service.create({ ...base, name: "alone", runNow: true })
    h.service.runNow(alone.loopId)
    await flush()
    h.finish(h.start(), report("b"))
    expect(h.notices).toHaveLength(0)
  })

  test("the notice is bounded however long the summary is", () => {
    const loop = { loopId: "lop_1", name: "n".repeat(300), sessionId: "ses_1", state: "paused" } as unknown as Loop
    const text = runNotice(loop, { run: 7, startedAt: 0, endedAt: 1, outcome: "completed", checkpoint: { status: "continue", summary: "x".repeat(5_000) } })
    expect(text.length).toBeLessThan(600)
  })
})

describe("the permission mode a loop starts with (full, edits, ask)", () => {
  test("the loop's sessions start in the mode it was created with; report-only runs are read-only whatever it says", async () => {
    const h = harness()
    const full = h.service.create({ ...base, name: "f", permission: "full", creatorSessionId: creator })
    expect(full.permission).toBe("full")
    expect(h.created.at(-1)).toEqual({ permission: "full" })
    const report = h.service.create({ ...base, name: "r", permission: "full", reportOnly: true, creatorSessionId: creator })
    expect(report.permission).toBe("full")
    expect(h.created.at(-1)).toEqual({ permission: "full", readOnly: true })
    const none = h.service.create({ ...base, name: "d" })
    expect(none.permission).toBeUndefined()
    expect(h.created.at(-1)).toEqual({})
  })
})
