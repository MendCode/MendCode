import { afterEach, describe, expect, test } from "bun:test"
import { validatePlan } from "../src"
import { b78Agent, b78Plan, b78Service, flushB78 } from "./b78-harness"

const harnesses: ReturnType<typeof b78Service>[] = []
const harness = () => { const current = b78Service(); harnesses.push(current); return current }
afterEach(() => { for (const current of harnesses.splice(0)) current.service.dispose() })
const plan = (extra: Record<string, unknown> = {}) => b78Plan({ tasks: [b78Agent("first")], ...extra })

describe("B78 overlap policies", () => {
  test("disabled by default; skip returns the live run without allocating sessions", () => {
    const current = harness(), first = current.create(plan())
    const sessions = current.sessions.length
    expect(current.create(plan({ overlapPolicy: "skip" })).workflowId).toBe(first.workflowId)
    expect(current.sessions).toHaveLength(sessions)
    expect(current.create(plan()).workflowId).not.toBe(first.workflowId)
    expect(current.create(plan({ overlapPolicy: "skip" }), "/other/project").workflowId).not.toBe(first.workflowId)
    expect(current.create(plan({ overlapPolicy: "skip", overlapKey: "other" })).workflowId).not.toBe(first.workflowId)
  })

  test("queue is durable FIFO, excludes waiting time and does not submit early", async () => {
    const current = harness(), first = current.create(plan())
    const second = current.create(plan({ overlapPolicy: "queue", budget: { maxRuntimeMs: 20 } }))
    const third = current.create(plan({ overlapPolicy: "queue" }))
    expect(second).toMatchObject({ state: "queued", queuedBehind: first.workflowId })
    expect(third).toMatchObject({ state: "queued", queuedBehind: second.workflowId })
    expect(current.submitted).toHaveLength(1)
    current.clock.advance(1000)
    expect(current.state(second).state).toBe("queued")
    await current.finish(first, "first")
    expect(current.state(second)).toMatchObject({ state: "running", startedAt: current.clock.now() })
    expect(current.state(third).state).toBe("queued")
    await current.finish(second, "first")
    expect(current.state(third).state).toBe("running")
    await current.finish(third, "first")
    expect(current.clock.pending()).toBe(0)
  })

  test("pause/resume/accept cannot bypass predecessors; stopped queue entries do not strand successors", async () => {
    const current = harness(), first = current.create(plan())
    const second = current.create(plan({ overlapPolicy: "queue" }))
    const third = current.create(plan({ overlapPolicy: "queue" }))
    expect(current.service.control(second.workflowId, "pause")).toHaveProperty("run")
    expect(current.service.control(second.workflowId, "accept", { reason: "skip" })).toMatchObject({ error: "queued workflow has not started" })
    current.service.control(second.workflowId, "resume")
    expect(current.state(second).state).toBe("queued")
    current.service.control(second.workflowId, "stop")
    current.service.control(second.workflowId, "delete")
    await flushB78()
    expect(current.state(third).state).toBe("queued")
    await current.finish(first, "first")
    expect(current.state(third).state).toBe("running")
  })

  test("queue waits for all prior legacy overlaps, not just one", async () => {
    const current = harness(), first = current.create(plan()), second = current.create(plan())
    const next = current.create(plan({ overlapPolicy: "queue" }))
    expect(next.queuedAfter).toHaveLength(2)
    await current.finish(second, "first")
    expect(current.state(next).state).toBe("queued")
    await current.finish(first, "first")
    expect(current.state(next).state).toBe("running")
  })

  test("restart retains FIFO even when storage order is reversed", async () => {
    const current = harness(), first = current.create(plan())
    const second = current.create(plan({ overlapPolicy: "queue" }))
    const third = current.create(plan({ overlapPolicy: "queue" }))
    current.service.dispose()
    const recovered = b78Service({ saved: new Map([...current.saved].reverse()), clock: current.clock })
    harnesses.push(recovered)
    recovered.service.start()
    const fourth = recovered.create(plan({ overlapPolicy: "queue" }))
    expect(fourth.queuedBehind).toBe(third.workflowId)
    expect(recovered.state(second).state).toBe("queued")
    await recovered.finish(first, "first")
    await recovered.finish(second, "first")
    await recovered.finish(third, "first")
    expect(recovered.state(fourth).state).toBe("running")
  })

  test("replace cancels started owned turns and ignores late results, leaving other projects intact", async () => {
    const current = harness(), work = plan({ tasks: [b78Agent("first", { mode: "work" })] })
    const old = current.create(work), unrelated = current.create(work, "/other")
    await flushB78()
    const oldSession = current.sessionOf(old, "first"), oldTurn = current.begin(oldSession)
    const next = current.create({ ...work, overlapPolicy: "replace" })
    expect(current.state(old).state).toBe("stopped")
    expect(current.state(unrelated).state).toBe("running")
    expect(current.cancelled).toEqual([{ sessionId: oldSession, turnId: oldTurn }])
    current.event(oldSession, { type: "turn.completed", turnId: oldTurn })
    expect(current.state(next).state).toBe("running")
  })

  test("replace before submit resolves cancels the abandoned turn when it starts", async () => {
    const current = harness(), work = plan({ tasks: [b78Agent("first", { mode: "work" })] })
    const old = current.create(work)
    const oldSession = current.sessionOf(old, "first")
    const next = current.create({ ...work, overlapPolicy: "replace" })
    await flushB78()
    const turnId = current.begin(oldSession)
    expect(current.cancelled).toContainEqual({ sessionId: oldSession, turnId })
    expect(current.state(next).state).toBe("running")
  })

  test("read-only replacement is rejected; overlap keys require explicit policies", () => {
    for (const input of [plan({ overlapPolicy: "replace" }), plan({ overlapPolicy: "replace", permissions: { mode: "report-only" } }), plan({ overlapKey: "explicit" })]) expect(validatePlan(input).ok).toBe(false)
  })

  test("queue is bounded before allocating a seventeenth live run", () => {
    const current = harness()
    for (let index = 0; index < 16; index++) current.create(plan({ overlapPolicy: "queue" }))
    const sessions = current.sessions.length
    expect(() => current.create(plan({ overlapPolicy: "queue" }))).toThrow("16 live runs")
    expect(current.sessions).toHaveLength(sessions)
  })
})
