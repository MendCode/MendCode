import { randomUUID } from "node:crypto"
import { type AdaptivePolicyState } from "./policy"
import { JevError, type JevDecision } from "./jev"

export type GenerationIdentity = {
  projectScope: string
  sessionID: string
  turnID: string
  generationID: string
  inputRevision: string
  policyRevision: string
  baselineEffort: string
  bindingFingerprint: string
  compactionEpoch: number
  failureEpoch: number
}
export type AdaptiveReceipt = {
  status: "off" | "unsupported" | "manual" | "proposed" | "prepared" | "reused" | "fallback"
  effort: string
  suggestedEffort?: string
  decisionID?: string
  leaseRemaining: number
  reason?: string
}
type Entry = {
  turnID: string
  baseline: string
  fingerprint: string
  count: number
  suspended: boolean
  failed: boolean
  decision?: JevDecision
  decisionID?: string
  remaining: number
  generationID?: string
  receipt?: AdaptiveReceipt
  dispatched: boolean
  pending?: Promise<AdaptiveReceipt>
  abort?: AbortController
  signal?: AbortSignal
}

function key(identity: Pick<GenerationIdentity, "projectScope" | "sessionID">) {
  return JSON.stringify([identity.projectScope, identity.sessionID])
}
function fingerprint(identity: GenerationIdentity) {
  return JSON.stringify([identity.inputRevision, identity.policyRevision, identity.bindingFingerprint, identity.compactionEpoch, identity.failureEpoch])
}

/** Isolated state machine. The host owns lifecycle, consent, budget and transport readiness.
 * Construct one per runtime instance; this module never enables or calls a provider itself.
 */
export function createAdaptiveController() {
  const entries = new Map<string, Entry>()
  const release = (identity: Pick<GenerationIdentity, "projectScope" | "sessionID">) => {
    const entry = entries.get(key(identity))
    entry?.abort?.abort()
    entries.delete(key(identity))
  }
  const invalidate = (identity: Pick<GenerationIdentity, "projectScope" | "sessionID">) => {
    const entry = entries.get(key(identity))
    if (!entry) return
    entry.abort?.abort()
    entry.fingerprint = "invalidated"
    entry.decision = undefined
    entry.receipt = undefined
    entry.remaining = 0
  }
  const baseline = (identity: GenerationIdentity, status: AdaptiveReceipt["status"], reason?: string): AdaptiveReceipt => ({
    status, effort: identity.baselineEffort, leaseRemaining: 0, ...(reason ? { reason } : {}),
  })
  const beforeGeneration = async (input: {
    identity: GenerationIdentity
    policy: AdaptivePolicyState
    eligible: boolean
    bindingVerified: boolean
    signal: AbortSignal
    evaluate: (signal: AbortSignal) => Promise<JevDecision>
  }): Promise<AdaptiveReceipt> => {
    const id = { ...input.identity }
    const policy = { ...input.policy.config }
    if (input.signal.aborted) { release(id); throw new JevError("cancelled") }
    if (!input.policy.valid || input.policy.config.mode === "off" || !input.policy.config.remoteProcessing) {
      release(id)
      return baseline(id, "off")
    }
    if (id.policyRevision !== input.policy.revision) throw new JevError("stale")
    if (!input.eligible || (input.policy.config.mode === "adaptive" && !input.bindingVerified)) {
      release(id)
      return baseline(id, "unsupported", "Unverified binding or unsupported execution origin")
    }
    const previous = entries.get(key(id))
    if (previous && previous.turnID !== id.turnID) release(id)
    if (!entries.has(key(id))) {
      // Never evict active owners to admit another session.
      if (entries.size >= 64) throw new JevError("capability")
      entries.set(key(id), {
        turnID: id.turnID, baseline: id.baselineEffort, fingerprint: fingerprint(id),
        count: 0, suspended: false, failed: false, remaining: 0, dispatched: false,
      })
    }
    const entry = entries.get(key(id))!
    if (entry.baseline !== id.baselineEffort) {
      entry.abort?.abort()
      entry.suspended = true
      entry.baseline = id.baselineEffort
    }
    if (entry.suspended) return baseline(id, "manual", "Manual effort change suspends adaptation for this turn")
    if (entry.fingerprint !== fingerprint(id)) {
      entry.abort?.abort()
      entry.fingerprint = fingerprint(id)
      entry.remaining = 0
      entry.decision = undefined
      entry.receipt = undefined
      entry.generationID = undefined
      entry.pending = undefined
    }
    if (entry.generationID === id.generationID) {
      if (entry.pending) return entry.pending
      if (entry.receipt) return { ...entry.receipt }
    }
    if (entry.pending || entry.receipt && !entry.dispatched) throw new JevError("stale")
    if (entry.failed || entry.count >= policy.maxDecisionsPerTurn && !entry.remaining) {
      if (policy.mode === "adaptive" && policy.failureMode === "pause") throw new JevError(entry.failed ? "response" : "budget")
      entry.generationID = id.generationID
      entry.signal = input.signal
      entry.dispatched = false
      entry.receipt = baseline(id, "fallback", "Evaluation is suspended until the next turn")
      return { ...entry.receipt }
    }
    entry.generationID = id.generationID
    entry.dispatched = false
    entry.signal = input.signal
    const receipt = (status: AdaptiveReceipt["status"]): AdaptiveReceipt => ({
      status, effort: policy.mode === "shadow" ? id.baselineEffort : entry.decision!.effort,
      suggestedEffort: entry.decision!.effort, decisionID: entry.decisionID, leaseRemaining: entry.remaining,
    })
    if (entry.remaining && entry.decision) {
      entry.receipt = receipt("reused")
      return { ...entry.receipt }
    }
    entry.receipt = undefined
    entry.decision = undefined
    entry.decisionID = undefined
    const controller = new AbortController()
    entry.abort = controller
    const signal = AbortSignal.any([input.signal, controller.signal])
    const revision = entry.fingerprint
    entry.count++
    const pending = (async () => {
      try {
        const decision = await Promise.resolve().then(() => {
          if (signal.aborted) throw new JevError("cancelled")
          return input.evaluate(signal)
        })
        if (signal.aborted || entries.get(key(id)) !== entry || entry.fingerprint !== revision || entry.generationID !== id.generationID) throw new JevError("stale")
        if (![1, 2, 5].includes(decision.leaseSteps) || decision.leaseSteps > policy.maxLeaseSteps) throw new JevError("response")
        entry.decision = { ...decision, usage: { ...decision.usage } }
        entry.decisionID = randomUUID()
        entry.remaining = decision.leaseSteps
        entry.receipt = receipt(policy.mode === "shadow" ? "proposed" : "prepared")
        return { ...entry.receipt }
      } catch (error) {
        if (signal.aborted || entry.fingerprint !== revision || entries.get(key(id)) !== entry) throw new JevError(input.signal.aborted ? "cancelled" : "stale")
        entry.failed = true
        if (policy.mode === "adaptive" && policy.failureMode === "pause") throw error instanceof JevError ? error : new JevError("response")
        entry.receipt = baseline(id, "fallback", "Evaluator failed; using the selected baseline for this turn")
        return { ...entry.receipt }
      } finally {
        if (entry.abort === controller) { entry.pending = undefined; entry.abort = undefined }
      }
    })()
    entry.pending = pending
    return pending
  }
  return {
    beforeGeneration,
    invalidate,
    release,
    markDispatched(identity: GenerationIdentity) {
      const entry = entries.get(key(identity))
      if (!entry?.receipt || entry.suspended || entry.turnID !== identity.turnID || entry.baseline !== identity.baselineEffort || entry.generationID !== identity.generationID || entry.fingerprint !== fingerprint(identity) || entry.signal?.aborted) throw new JevError("stale")
      if (!entry.dispatched) { entry.remaining = Math.max(0, entry.remaining - 1); entry.dispatched = true }
      return { status: "dispatched" as const, decisionID: entry.receipt.decisionID, effort: entry.receipt.effort, leaseRemaining: entry.remaining }
    },
    dispose() {
      for (const entry of entries.values()) entry.abort?.abort()
      entries.clear()
    },
    get size() { return entries.size },
  }
}
