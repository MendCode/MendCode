import { expect, test } from "bun:test"
import { createAdaptiveController, type GenerationIdentity } from "../../src/mend/adaptive-reasoning/runtime"
import { defaultAdaptivePolicy, type AdaptivePolicyState } from "../../src/mend/adaptive-reasoning/policy"
import { type JevDecision } from "../../src/mend/adaptive-reasoning/jev"

function fixture(mode: "adaptive" | "shadow" = "adaptive") {
  const controller = createAdaptiveController()
  const identity: GenerationIdentity = {
    projectScope: "project", sessionID: "session", turnID: "turn", generationID: "g1",
    inputRevision: "input", policyRevision: "policy", baselineEffort: "medium",
    bindingFingerprint: "fixture-only", compactionEpoch: 0, failureEpoch: 0,
  }
  const policy: AdaptivePolicyState = {
    config: { ...defaultAdaptivePolicy, mode, remoteProcessing: true },
    revision: "policy", valid: true, reason: null,
  }
  const decision: JevDecision = {
    effort: "high", leaseSteps: 2, evaluatedModel: "typesafe/jev-1.13", usage: {}, latencyMs: 0, attempts: 1,
  }
  const calls: AbortSignal[] = []
  const input = {
    identity, policy, eligible: true, bindingVerified: true, signal: new AbortController().signal,
    evaluate: async (signal: AbortSignal) => { calls.push(signal); return decision },
  }
  return { controller, input, calls, decision }
}

test("leases include first dispatch; concurrent retries evaluate and consume once", async () => {
  const { controller, input, calls } = fixture()
  const [first, retry] = await Promise.all([controller.beforeGeneration(input), controller.beforeGeneration(input)])
  expect(first).toEqual(retry)
  expect(calls).toHaveLength(1)
  expect(controller.markDispatched(input.identity).leaseRemaining).toBe(1)
  expect(controller.markDispatched(input.identity).leaseRemaining).toBe(1)
  expect((await controller.beforeGeneration(input)).decisionID).toBe(first.decisionID)
  input.identity.generationID = "g2"
  expect((await controller.beforeGeneration(input)).status).toBe("reused")
  expect(controller.markDispatched(input.identity).leaseRemaining).toBe(0)
  input.identity.generationID = "g3"
  expect((await controller.beforeGeneration(input)).decisionID).not.toBe(first.decisionID)
  expect(calls).toHaveLength(2)
})

test("cannot advance a generation before dispatching its prepared predecessor", async () => {
  const { controller, input } = fixture()
  await controller.beforeGeneration(input)
  await expect(controller.beforeGeneration({ ...input, identity: { ...input.identity, generationID: "g2" } })).rejects.toMatchObject({ code: "stale" })
})

test("shadow proposes and reuses without overriding baseline", async () => {
  const { controller, input } = fixture("shadow")
  expect(await controller.beforeGeneration(input)).toMatchObject({ status: "proposed", effort: "medium", suggestedEffort: "high" })
  expect(controller.markDispatched(input.identity).effort).toBe("medium")
  input.identity.generationID = "g2"
  expect(await controller.beforeGeneration(input)).toMatchObject({ status: "reused", effort: "medium" })
})

test("off, invalid consent, excluded origins and unverified adaptive never evaluate", async () => {
  for (const condition of ["off", "consent", "invalid", "origin", "binding"] as const) {
    const { controller, input, calls } = fixture()
    if (condition === "off") input.policy.config.mode = "off"
    if (condition === "consent") input.policy.config.remoteProcessing = false
    if (condition === "invalid") input.policy.valid = false
    if (condition === "origin") input.eligible = false
    if (condition === "binding") input.bindingVerified = false
    expect(["off", "unsupported"]).toContain((await controller.beforeGeneration(input)).status)
    expect(calls).toHaveLength(0)
    expect(controller.size).toBe(0)
  }
})

test("manual effort suspends the turn and rejects old dispatch receipts", async () => {
  const { controller, input, calls } = fixture()
  await controller.beforeGeneration(input)
  const old = { ...input.identity }
  input.identity.baselineEffort = "max"
  expect(await controller.beforeGeneration(input)).toMatchObject({ status: "manual", effort: "max" })
  expect(() => controller.markDispatched(old)).toThrow()
  input.identity.baselineEffort = "medium"
  expect((await controller.beforeGeneration(input)).status).toBe("manual")
  expect(calls).toHaveLength(1)
  input.identity.turnID = "next-turn"
  expect((await controller.beforeGeneration(input)).status).toBe("prepared")
})

test("invalidation aborts in-flight work and rejects a late evaluator result", async () => {
  const { controller, input, decision } = fixture()
  const pending = Promise.withResolvers<JevDecision>()
  const started = Promise.withResolvers<AbortSignal>()
  input.evaluate = (signal) => { started.resolve(signal); return pending.promise }
  const result = controller.beforeGeneration(input)
  const signal = await started.promise
  controller.invalidate(input.identity)
  expect(signal.aborted).toBe(true)
  pending.resolve(decision)
  await expect(result).rejects.toMatchObject({ code: "stale" })
  expect(() => controller.markDispatched(input.identity)).toThrow()
})

test("off revokes pending work without accepting a late response", async () => {
  const { controller, input, decision } = fixture()
  const pending = Promise.withResolvers<JevDecision>()
  const started = Promise.withResolvers<void>()
  input.evaluate = async () => { started.resolve(); return pending.promise }
  const result = controller.beforeGeneration(input)
  await started.promise
  input.policy.config.mode = "off"
  expect((await controller.beforeGeneration(input)).status).toBe("off")
  pending.resolve(decision)
  await expect(result).rejects.toMatchObject({ code: "stale" })
  expect(controller.size).toBe(0)
})

test("cancellation blocks dispatch and pre-cancelled inputs perform no evaluation", async () => {
  const { controller, input, calls } = fixture()
  const abort = new AbortController()
  input.signal = abort.signal
  await controller.beforeGeneration(input)
  abort.abort()
  expect(() => controller.markDispatched(input.identity)).toThrow()
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "cancelled" })
  expect(calls).toHaveLength(1)
  expect(controller.size).toBe(0)
})

test("compaction, failures and input changes invalidate leases", async () => {
  for (const field of ["compactionEpoch", "failureEpoch", "inputRevision"] as const) {
    const { controller, input, calls } = fixture()
    await controller.beforeGeneration(input)
    controller.markDispatched(input.identity)
    if (field === "inputRevision") input.identity.inputRevision = "new-input"
    else input.identity[field]++
    input.identity.generationID = "g2"
    expect((await controller.beforeGeneration(input)).status).toBe("prepared")
    expect(calls).toHaveLength(2)
  }
})

test("synchronous evaluator errors do not leave a stuck pending promise", async () => {
  const { controller, input } = fixture("shadow")
  input.evaluate = () => { throw new Error("private failure details") }
  expect(await controller.beforeGeneration(input)).toMatchObject({ status: "fallback", effort: "medium" })
  expect(controller.markDispatched(input.identity).decisionID).toBeUndefined()
  input.identity.generationID = "g2"
  expect((await controller.beforeGeneration(input)).status).toBe("fallback")
  expect(controller.markDispatched(input.identity).decisionID).toBeUndefined()
})

test("adaptive pause rejects sanitized failures; explicit baseline permits fallback", async () => {
  const { controller, input } = fixture()
  input.evaluate = () => { throw new Error("private details") }
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "response", message: "Jev evaluation blocked: response" })
  input.policy.config.failureMode = "baseline"
  expect((await controller.beforeGeneration(input)).status).toBe("fallback")
})

test("failed reevaluation cannot resurrect the previous generation receipt", async () => {
  const { controller, input, decision } = fixture()
  decision.leaseSteps = 1
  await controller.beforeGeneration(input)
  controller.markDispatched(input.identity)
  input.identity.generationID = "g2"
  input.evaluate = async () => { throw new Error("failure") }
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "response" })
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "response" })
  expect(() => controller.markDispatched(input.identity)).toThrow()
})

test("manual override aborts pending decisions and remains authoritative", async () => {
  const { controller, input, decision } = fixture()
  const pending = Promise.withResolvers<JevDecision>()
  const started = Promise.withResolvers<AbortSignal>()
  input.evaluate = (signal) => { started.resolve(signal); return pending.promise }
  const result = controller.beforeGeneration(input)
  const signal = await started.promise
  input.identity.baselineEffort = "max"
  expect((await controller.beforeGeneration(input)).status).toBe("manual")
  expect(signal.aborted).toBe(true)
  pending.resolve(decision)
  await expect(result).rejects.toMatchObject({ code: "stale" })
  expect(() => controller.markDispatched(input.identity)).toThrow()
})

test("decision cap pauses after consumed lease, not during its reuse", async () => {
  const { controller, input, calls } = fixture()
  input.policy.config.maxDecisionsPerTurn = 1
  await controller.beforeGeneration(input)
  controller.markDispatched(input.identity)
  input.identity.generationID = "g2"
  expect((await controller.beforeGeneration(input)).status).toBe("reused")
  controller.markDispatched(input.identity)
  input.identity.generationID = "g3"
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "budget" })
  expect(calls).toHaveLength(1)
})

test("projects, sessions and turns cannot dispatch each other's receipts", async () => {
  const { controller, input, calls } = fixture()
  await controller.beforeGeneration(input)
  for (const field of ["projectScope", "sessionID", "turnID"] as const) {
    const identity = { ...input.identity, [field]: "other" }
    expect(() => controller.markDispatched(identity)).toThrow()
  }
  await controller.beforeGeneration({ ...input, identity: { ...input.identity, sessionID: "other" } })
  expect(calls).toHaveLength(2)
  expect(controller.size).toBe(2)
  controller.dispose()
  expect(controller.size).toBe(0)
  expect(() => controller.markDispatched(input.identity)).toThrow()
})

test("controller bounds owners and releases capacity explicitly", async () => {
  const { controller, input } = fixture()
  for (let index = 0; index < 64; index++) {
    await controller.beforeGeneration({ ...input, identity: { ...input.identity, sessionID: String(index) } })
  }
  await expect(controller.beforeGeneration(input)).rejects.toMatchObject({ code: "capability" })
  controller.release({ ...input.identity, sessionID: "0" })
  expect((await controller.beforeGeneration(input)).status).toBe("prepared")
  controller.dispose()
})
