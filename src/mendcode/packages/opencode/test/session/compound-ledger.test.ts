import { describe, expect, test } from "bun:test"

import {
  aggregateLedger,
  createCompoundLedger,
  estimateCostUsd,
  finishRequest,
  ledgerForUnknownDispatch,
  reserveRequest,
  startRequest,
  type CompoundRequestKey,
} from "../../src/session/compound-ledger"

const limits = {
  maxModelRequests: 3,
  maxTotalTokens: 100,
  maxRuntimeMs: 60_000,
  maxCostUsd: 1,
  unknownCost: "block" as const,
}

const key = (legID: string, requestID = `request-${legID}`): CompoundRequestKey => ({
  runID: "run-1",
  taskAttemptID: "attempt-1",
  legID,
  requestID,
})

const pricing = {
  inputUsdPer1M: 1,
  outputUsdPer1M: 2,
  cacheReadUsdPer1M: null,
  cacheWriteUsdPer1M: null,
  source: "fixture",
}

describe("compound request ledger", () => {
  test("counts a request once and makes terminal events idempotent", () => {
    const first = reserveRequest({
      ledger: createCompoundLedger(limits),
      key: key("primary"),
      role: "primary",
      providerID: "provider-a",
      modelID: "model-a",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 20,
      estimatedCostUsd: 0.1,
      pricing,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const started = startRequest(first.ledger, key("primary"))
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const finished = finishRequest({
      ledger: started.ledger,
      key: key("primary"),
      status: "completed",
      usage: { inputTokens: 12, outputTokens: 18, costUsd: 0.08, costSource: "provider-reported" },
      coverage: { inputTokens: "reported", outputTokens: "reported", cost: "reported" },
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    expect(aggregateLedger(finished.ledger)).toMatchObject({
      requests: { used: 1, reserved: 0, remaining: 2 },
      tokens: { used: 30, reserved: 0, remaining: 70 },
      cost: { usedUsd: 0.08, unknownRequests: 0 },
    })
    const duplicate = finishRequest({ ledger: finished.ledger, key: key("primary"), status: "failed" })
    expect(duplicate).toMatchObject({ ok: false, reason: "already_terminal" })
    expect(aggregateLedger(duplicate.ledger)).toEqual(aggregateLedger(finished.ledger))
  })

  test("admits known cost and blocks an unknown priced request", () => {
    const ledger = createCompoundLedger(limits)
    const admitted = reserveRequest({
      ledger,
      key: key("priced"),
      role: "primary",
      providerID: "provider-a",
      modelID: "model-a",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      estimatedCostUsd: 0.2,
    })
    expect(admitted.ok).toBe(true)
    const blocked = reserveRequest({
      ledger: admitted.ledger,
      key: key("unknown"),
      role: "critic",
      providerID: "provider-b",
      modelID: "model-b",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      estimatedCostUsd: null,
    })
    expect(blocked).toMatchObject({ ok: false, reason: "unknown_cost" })
  })

  test("uses the token cap when unknown dollar cost is explicitly allowed", () => {
    const ledger = createCompoundLedger({ ...limits, unknownCost: "allow-with-token-cap" })
    const admitted = reserveRequest({
      ledger,
      key: key("unknown"),
      role: "primary",
      providerID: "provider-b",
      modelID: "model-b",
      estimatedInputTokens: 40,
      estimatedOutputTokens: 40,
      estimatedCostUsd: null,
    })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    expect(aggregateLedger(admitted.ledger).cost.unknownRequests).toBe(1)
    const overToken = reserveRequest({
      ledger: admitted.ledger,
      key: key("over-token"),
      role: "revision",
      providerID: "provider-b",
      modelID: "model-b",
      estimatedInputTokens: 20,
      estimatedOutputTokens: 41,
    })
    expect(overToken).toMatchObject({ ok: false, reason: "token_limit" })
  })

  test("marks an ambiguous dispatch unknown and refuses replay after restart", () => {
    const reserved = reserveRequest({
      ledger: createCompoundLedger({ ...limits, maxModelRequests: 1 }),
      key: key("compaction"),
      role: "compaction",
      providerID: "provider-a",
      modelID: "model-a",
      estimatedInputTokens: 20,
      estimatedOutputTokens: 20,
      estimatedCostUsd: 0.2,
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    const unknown = ledgerForUnknownDispatch({ ledger: reserved.ledger, key: key("compaction") })
    expect(unknown.ok).toBe(true)
    if (!unknown.ok) return
    expect(unknown.receipt.status).toBe("unknown")
    const replay = reserveRequest({
      ledger: JSON.parse(JSON.stringify(unknown.ledger)),
      key: key("compaction"),
      role: "compaction",
      providerID: "provider-a",
      modelID: "model-a",
      estimatedInputTokens: 20,
      estimatedOutputTokens: 20,
      estimatedCostUsd: 0.2,
    })
    expect(replay).toMatchObject({ ok: false, reason: "already_terminal" })
    expect(aggregateLedger(unknown.ledger)).toMatchObject({ requests: { used: 1, remaining: 0 }, cost: { unknownRequests: 1 } })
  })

  test("calculates a catalog estimate only when every component is priced", () => {
    expect(estimateCostUsd({ usage: { inputTokens: 1_000_000, outputTokens: 500_000 }, pricing })).toBe(2)
    expect(estimateCostUsd({ usage: { inputTokens: 1 }, pricing: { ...pricing, outputUsdPer1M: null } })).toBeUndefined()
  })
})
