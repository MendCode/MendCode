import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type Loop, type LoopId, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { createLoopService, evaluateRubric, reviewLoop, type CreateLoopInput } from "../src"
import { loopBudgetGate, carriedUsage } from "../src/budget"

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const checkpoint = (status = "complete", summary = "Tests passed", evidence: string[] = []) => `\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: ${summary}\nevidence: ${JSON.stringify(evidence)}\n\`\`\``

function harness() {
  const clock = createVirtualClock(1_800_000_000_000)
  const ids = createIdFactory({ now: clock.now })
  const saved = new Map<LoopId, Loop>()
  const sent: Array<{ sessionId: SessionId; text: string; queueId: ReturnType<typeof ids<"queue">> }> = []
  const cancelled: SessionId[] = []
  const service = createLoopService({ clock, ids,
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    createSession: () => ids("session"),
    submit: async (request) => { const queueId = ids("queue"); sent.push({ ...request, queueId }); return { queueId } },
    runCheck: async () => ({ exitCode: 0, output: "12 tests passed" }),
    cancelTurn: ({ sessionId }) => cancelled.push(sessionId),
  })
  let seq = 0
  const turn = () => {
    const request = sent.at(-1)!
    const turnId = ids("turn")
    const emit = (event: Record<string, unknown>) => { const built = { sessionId: request.sessionId, seq: ++seq, at: clock.now(), ...event } as SessionEvent; service.observe(built); return built }
    emit({ type: "turn.started", turnId, queueId: request.queueId })
    return {
      usage(costMicros?: number, tokens = 10) { return emit({ type: "usage.recorded", turnId, provider: "fake", model: "local", input: tokens, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 4, ...(costMicros !== undefined ? { costMicros } : {}) }) },
      fail() { emit({ type: "turn.failed", turnId, error: "fake failure" }) },
      finish(text: string, reads = 1, cancelled = false) {
        for (let i = 0; i < reads; i++) { const itemId = ids("item"); emit({ type: "item.started", turnId, itemId, kind: "tool_call" }); emit({ type: "item.completed", itemId, status: "ok", text: "source" }) }
        const itemId = ids("item")
        emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
        emit({ type: "item.completed", itemId, status: "ok", text })
        emit(cancelled ? { type: "turn.cancelled", turnId, by: "user" } : { type: "turn.completed", turnId })
      },
    }
  }
  const create = (extra: Partial<CreateLoopInput> = {}) => service.create({ name: "verify", directory: "/fake", objective: "verify tests", trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 4 }, audit: "none", ...extra })
  const current = (loop: Loop) => service.get(loop.loopId)!
  const review = (loop: Loop, action: "accept" | "waive" | "approve", extra = {}) => { const run = current(loop).history.at(-1)!; return service.review(loop.loopId, { action, run: run.run, checkpointHash: run.checkpointHash!, reviewer: "reviewer", reason: "checked the evidence", ...extra }) }
  return { clock, service, sent, cancelled, create, turn, current, review, saved }
}

describe("B44 budgets", () => {
  test("old loops without usage cannot pretend their prior consumption was zero", () => {
    const loop = { ...harness().create({ costBudget: { maxTokens: 1000 } }), runs: 3 }
    expect(loopBudgetGate(loop)).toMatchObject({ status: "fail", detail: expect.stringContaining("unavailable") })
    expect(carriedUsage({ ...loop, runs: 4 })).toMatchObject({ unknownCostCalls: 3, unreportedTurns: 3 })
  })
  test("total tokens include caches/reasoning, cap cancels and blocks even after a complete claim", async () => {
    const h = harness()
    const loop = h.create({ costBudget: { maxTokens: 20 } })
    h.service.runNow(loop.loopId); await flush()
    const run = h.turn(); run.usage(0); run.finish(checkpoint(), 0, true)
    expect(h.current(loop)).toMatchObject({ state: "blocked", usage: { tokens: 20, costMicros: 0, unknownCostCalls: 0 } })
    expect(h.cancelled).toHaveLength(1)
    expect(h.current(loop).history[0]?.usage?.tokens).toBe(20)
    expect(h.service.runNow(loop.loopId)).toBe(false)
    expect(h.service.accept(loop.loopId, "ignore cap")?.state).toBe("blocked")
  })

  test("usage events are counted once and a cap persists past the 20-run history window", async () => {
    const h = harness(); const loop = h.create({ budget: { mode: "monitor" }, costBudget: { maxTokens: 420 } })
    for (let i = 0; i < 21; i++) {
      expect(h.service.runNow(loop.loopId)).toBe(true); await flush()
      const run = h.turn(); const event = run.usage(1)
      h.service.observe(event)
      run.finish(checkpoint("continue")); await flush()
    }
    expect(h.current(loop)).toMatchObject({ state: "blocked", runs: 21, usage: { tokens: 420, costMicros: 21 } })
    expect(h.current(loop).history).toHaveLength(20)
    expect(h.service.runNow(loop.loopId)).toBe(false)
  }, 15_000)

  test("missing token reports block configured caps and cannot be bypassed by resume or fire", async () => {
    for (const cancelled of [false, true]) {
      const h = harness(); const loop = h.create({ costBudget: { maxTokens: 1000 }, trigger: { kind: "external" } })
      h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint(), 0, cancelled); await flush()
      expect(h.current(loop)).toMatchObject({ state: "blocked", usage: { unreportedTurns: 1 }, reason: expect.stringContaining("unavailable") })
      expect(h.service.resume(loop.loopId)?.state).toBe("blocked")
      expect(h.service.fire(loop.loopId)).toMatchObject({ ok: false })
    }
  })

  test("USD caps include audits; unknown prices fail closed and known zero is not unknown", async () => {
    for (const cost of [undefined, 0, 50]) {
      const h = harness(); const loop = h.create({ costBudget: { maxCost: 0.0001 }, audit: "independent" })
      h.service.runNow(loop.loopId); await flush()
      const run = h.turn(); run.usage(cost); run.finish(checkpoint()); await flush()
      if (cost === undefined) { expect(h.current(loop).state).toBe("blocked"); expect(h.sent).toHaveLength(1); continue }
      const audit = h.turn(); audit.usage(50); audit.finish("```AUDIT_VERDICT\nverdict: pass\nfindings: tests verified\n```"); await flush()
      expect(h.current(loop).state).toBe(cost === 0 ? "completed" : "blocked")
      expect(h.current(loop).usage?.unknownCostCalls).toBe(0)
      expect(h.current(loop).usage?.costMicros).toBe((cost ?? 0) + 50)
      expect(h.current(loop).history[0]?.usage).toEqual(h.current(loop).usage)
    }
  }, 15_000)

  test("explicit unknown-cost allow and removing caps preserve accumulated usage", async () => {
    const h = harness(); const loop = h.create({ budget: { mode: "monitor" }, costBudget: { maxCost: 1, unknownCost: "allow" } })
    h.service.runNow(loop.loopId); await flush(); const run = h.turn(); run.usage(); run.finish(checkpoint("continue")); await flush()
    expect(h.current(loop).state).toBe("active")
    h.service.update(loop.loopId, { costBudget: {} })
    expect(h.current(loop).usage?.unknownCostCalls).toBe(1)
    expect(h.saved.get(loop.loopId)?.usage).toEqual(h.current(loop).usage)
  })

  test("an auditor failure without usage remains unknown and prevents more spending", async () => {
    const h = harness(); const loop = h.create({ costBudget: { maxTokens: 1000, maxCost: 1 }, audit: "independent" })
    h.service.runNow(loop.loopId); await flush()
    const worker = h.turn(); worker.usage(10); worker.finish(checkpoint()); await flush()
    // The auditor fails each time it is asked (three attempts) before the loop blocks.
    for (let tries = 0; tries < 3; tries++) { h.turn().fail(); await flush() }
    expect(h.current(loop)).toMatchObject({ state: "blocked", usage: { tokens: 20, costMicros: 10, unknownCostCalls: 1, unreportedTurns: 1 } })
    expect(h.service.resume(loop.loopId)?.state).toBe("blocked")
    expect(h.service.runNow(loop.loopId)).toBe(false)
  })
})

describe("B44 runtime rubric and review", () => {
  test("weighted 0/5 scores, threshold, minScore and required evidence are computed by the host", () => {
    const h = harness(); const loop = h.create({ checks: ["bun test"], rubric: { passThreshold: 0.7, criteria: [{ id: "tests", description: "tests", weight: 3, minScore: 5, evidenceRequired: ["success checks", "validation output"] }, { id: "docs", description: "docs", weight: 1, evidenceRequired: ["README.md"] }] } })
    const result = evaluateRubric(loop, { status: "complete", summary: "I score myself 100%", evidence: [] }, [{ id: "bun test", status: "pass", detail: "12 tests pass" }])!
    expect(result).toMatchObject({ status: "fail", score: 0.75, threshold: 0.7 })
    expect(result.criteria[0]).toMatchObject({ passed: true, score: 5 })
    expect(result.criteria[1]).toMatchObject({ passed: false, score: 0 })
  })

  test("checks supply real output and the rubric persists a passing evaluation", async () => {
    const h = harness(); const loop = h.create({ checks: ["bun test"], rubric: { name: "Acceptance", criteria: [{ id: "tests", description: "all tests pass", evidenceRequired: ["success checks", "validation output"] }] } })
    h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint()); await flush()
    expect(h.current(loop)).toMatchObject({ state: "completed", history: [{ gates: [{ id: "bun test", status: "pass", detail: "exit 0\n12 tests passed" }, { id: "rubric", status: "pass", detail: "100% / 85%" }], rubricResult: { status: "pass", score: 1 } }] })
  })

  test("mandatory blockers cannot be waived or accepted and stale review evidence is rejected", async () => {
    const h = harness(); const loop = h.create({ rubric: { criteria: [{ id: "proof", description: "proof" }], mandatoryBlockers: ["self assertion"] } })
    h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint()); await flush()
    expect(h.current(loop).state).toBe("blocked")
    expect(h.review(loop, "waive", { gateId: "rubric" })).toMatchObject({ ok: false, message: expect.stringContaining("protected") })
    expect(h.review(loop, "accept")).toMatchObject({ ok: false })
    const run = h.current(loop).history.at(-1)!
    expect(reviewLoop(h.current(loop), { action: "waive", gateId: "rubric", run: run.run, checkpointHash: "0".repeat(64), reviewer: "user", reason: "reviewed" }, h.clock.now())).toMatchObject({ ok: false, message: expect.stringContaining("stale") })
  })

  test("a quality gate waiver records actor, reason, hash and time; acceptance keeps that evidence", async () => {
    const h = harness(); const loop = h.create({ rubric: { criteria: [{ id: "docs", description: "docs", evidenceRequired: ["README.md"] }] } })
    h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint()); await flush()
    const waived = h.review(loop, "waive", { gateId: "rubric" })
    expect(waived).toMatchObject({ ok: true, loop: { state: "blocked", history: [{ gates: [{ id: "rubric", status: "pass", waiver: { action: "waive", actor: "reviewer", reason: "checked the evidence", at: h.clock.now() } }] }] } })
    expect(h.review(loop, "accept")).toMatchObject({ ok: true, loop: { state: "completed" } })
    expect(h.current(loop).history[0]?.gates?.[0]?.waiver?.checkpointHash).toBe(h.current(loop).history[0]?.checkpointHash)
  })

  test("approval is separate from waiver and an approved checkpoint is verified before completing", async () => {
    const h = harness(); const loop = h.create({ approvalPolicy: { requireApprovalFor: ["deploy"] }, checks: ["bun test"] })
    h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint("complete", "Deployed the release")); await flush()
    expect(h.current(loop).state).toBe("blocked")
    expect(h.review(loop, "accept")).toMatchObject({ ok: false, message: expect.stringContaining("protected") })
    expect(h.review(loop, "approve", { approvalAction: "deploy" })).toMatchObject({ ok: true })
    await flush()
    expect(h.current(loop).state).toBe("completed")
    expect(h.current(loop).history[0]?.approvals?.[0]).toMatchObject({ action: "deploy", evidence: { action: "approve", actor: "reviewer" } })
  })

  test("editing policy or mandatory blockers cannot accept gates evaluated with the old settings", async () => {
    const edits: Partial<CreateLoopInput>[] = [{ approvalPolicy: { requireApprovalFor: ["deploy"] } }, { rubric: { criteria: [{ id: "docs", description: "docs", evidenceRequired: ["README.md"] }], mandatoryBlockers: ["self assertion"] } }]
    for (const edit of edits) {
      const h = harness(); const loop = h.create({ rubric: { criteria: [{ id: "docs", description: "docs", evidenceRequired: ["README.md"] }] } })
      h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint("complete", "Deployed the release")); await flush()
      expect(h.review(loop, "waive", { gateId: "rubric" }).ok).toBe(true)
      const history = h.current(loop).history
      h.service.update(loop.loopId, edit)
      expect(h.current(loop).reviewInvalidatedAt).toBe(h.clock.now())
      expect(h.current(loop).history).toEqual(history)
      expect(h.review(loop, "accept")).toMatchObject({ ok: false, message: expect.stringContaining("settings changed") })
      h.service.update(loop.loopId, { costBudget: {}, rubric: { criteria: [] }, approvalPolicy: { requireApprovalFor: [] } })
      expect(h.service.accept(loop.loopId, "legacy bypass")?.state).not.toBe("completed")
      expect(h.service.runNow(loop.loopId)).toBe(true); await flush()
      expect(h.current(loop).reviewInvalidatedAt).toBeUndefined()
      h.turn().finish(checkpoint()); await flush()
      expect(h.current(loop).state).toBe("completed")
      expect(h.current(loop).history[0]).toEqual(history[0])
    }
  }, 15_000)

  test("a no-op edit or display name change does not invalidate the current review", async () => {
    const h = harness(); const loop = h.create({ rubric: { criteria: [{ id: "docs", description: "docs" }] }, approvalPolicy: { requireApprovalFor: ["push", "deploy"] } })
    h.service.runNow(loop.loopId); await flush(); h.turn().finish(checkpoint()); await flush()
    h.service.update(loop.loopId, { name: "renamed", costBudget: {}, rubric: { name: "Evidence", passThreshold: 0.85, criteria: [{ id: "docs", description: "docs", weight: 1, minScore: 0, evidenceRequired: [] }] }, approvalPolicy: { requireApprovalFor: ["deploy", "push"] } })
    expect(h.current(loop).reviewInvalidatedAt).toBeUndefined()
    expect(h.review(loop, "waive", { gateId: "rubric" })).toMatchObject({ ok: true })
  })

  test("changing the objective during work or verification cannot auto-accept the old claim", async () => {
    for (const stage of ["worker", "audit"]) {
      const h = harness(); const loop = h.create({ rubric: { criteria: [{ id: "proof", description: "proof" }] }, audit: "independent" })
      h.service.runNow(loop.loopId); await flush()
      const worker = h.turn()
      if (stage === "audit") { worker.finish(checkpoint("complete", "Tests passed", ["README.md"])); await flush(); expect(h.current(loop).state).toBe("verifying") }
      h.service.update(loop.loopId, { objective: "verify the new requirement", rubric: { criteria: [] }, audit: "none" })
      if (stage === "worker") worker.finish(checkpoint())
      else h.turn().finish("```AUDIT_VERDICT\nverdict: pass\nfindings: tests verified\n```")
      await flush()
      expect(h.current(loop)).toMatchObject({ state: "blocked", reviewInvalidatedAt: h.clock.now() })
      expect(h.current(loop).history.at(-1)?.gates).toContainEqual(expect.objectContaining({ id: "review-settings", status: "fail", failureClass: "integrity" }))
    }
  }, 15_000)
})
