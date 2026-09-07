import type { Pricing } from "@/mend/config/compound-models"
import type { Limits } from "@/config/ai"

export type CompoundRequestKey = {
  readonly runID: string
  readonly taskAttemptID: string
  readonly legID: string
  readonly requestID: string
}

export type CompoundRequestStatus = "reserved" | "running" | "completed" | "failed" | "cancelled" | "unknown"

export type CompoundUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly costUsd?: number
  readonly costSource?: "provider-reported" | "catalog-estimate" | "unknown"
}

export type CompoundUsageCoverage = {
  readonly inputTokens: "reported" | "estimated" | "missing"
  readonly outputTokens: "reported" | "estimated" | "missing"
  readonly cost: "reported" | "estimated" | "unknown"
}

export type CompoundRequestReceipt = {
  readonly key: CompoundRequestKey
  readonly role: string
  readonly providerID: string
  readonly modelID: string
  readonly authMode: string | null
  readonly status: CompoundRequestStatus
  readonly reserved: {
    readonly requests: 1
    readonly tokens: number
    readonly costUsd: number | null
  }
  readonly pricing?: Pricing
  readonly usage?: CompoundUsage
  readonly coverage: CompoundUsageCoverage
  readonly createdAt: number
  readonly startedAt?: number
  readonly completedAt?: number
  readonly error?: string
}

export type CompoundLedgerSnapshot = {
  readonly version: 1
  readonly limits: Limits
  readonly records: readonly CompoundRequestReceipt[]
}

export type CompoundLedgerAggregate = {
  readonly requests: {
    readonly used: number
    readonly reserved: number
    readonly remaining: number
  }
  readonly tokens: {
    readonly used: number
    readonly reserved: number
    readonly remaining: number
  }
  readonly cost: {
    readonly usedUsd: number
    readonly reservedUsd: number
    readonly remainingUsd: number | null
    readonly unknownRequests: number
  }
}

export type LedgerTransition =
  | {
      readonly ok: true
      readonly ledger: CompoundLedgerSnapshot
      readonly receipt: CompoundRequestReceipt
    }
  | {
      readonly ok: false
      readonly ledger: CompoundLedgerSnapshot
      readonly reason:
        | "already_terminal"
        | "in_flight"
        | "request_limit"
        | "token_limit"
        | "cost_limit"
        | "unknown_cost"
        | "missing_request"
    }

export type RequestAdmissionInput = {
  readonly ledger: CompoundLedgerSnapshot
  readonly key: CompoundRequestKey
  readonly role: string
  readonly providerID: string
  readonly modelID: string
  readonly authMode?: string | null
  readonly estimatedInputTokens?: number
  readonly estimatedOutputTokens?: number
  readonly estimatedCostUsd?: number | null
  readonly pricing?: Pricing
  readonly now?: number
}

export type RequestFinishInput = {
  readonly ledger: CompoundLedgerSnapshot
  readonly key: CompoundRequestKey
  readonly status: Exclude<CompoundRequestStatus, "reserved" | "running">
  readonly usage?: CompoundUsage
  readonly coverage?: Partial<CompoundUsageCoverage>
  readonly error?: string
  readonly now?: number
}

const finiteNonNegative = (value: number | undefined | null) =>
  value !== undefined && value !== null && Number.isFinite(value) && value >= 0 ? value : undefined

const tokenEstimate = (input: Pick<RequestAdmissionInput, "estimatedInputTokens" | "estimatedOutputTokens">) =>
  Math.max(0, Math.floor(finiteNonNegative(input.estimatedInputTokens) ?? 0)) +
  Math.max(0, Math.floor(finiteNonNegative(input.estimatedOutputTokens) ?? 0))

const usageTokens = (usage: CompoundUsage | undefined) => {
  if (!usage) return
  const input = finiteNonNegative(usage.inputTokens)
  const output = finiteNonNegative(usage.outputTokens)
  if (input === undefined && output === undefined) return
  return Math.floor((input ?? 0) + (output ?? 0))
}

const keyString = (key: CompoundRequestKey) => `${key.runID}\u0000${key.taskAttemptID}\u0000${key.legID}\u0000${key.requestID}`

const terminal = (status: CompoundRequestStatus) =>
  status === "completed" || status === "failed" || status === "cancelled" || status === "unknown"

const normalizedCoverage = (input?: Partial<CompoundUsageCoverage>): CompoundUsageCoverage => ({
  inputTokens: input?.inputTokens ?? "missing",
  outputTokens: input?.outputTokens ?? "missing",
  cost: input?.cost ?? "unknown",
})

const price = (tokens: number | undefined, perMillion: number | null | undefined) =>
  tokens === undefined || (tokens > 0 && (perMillion === null || perMillion === undefined || !Number.isFinite(perMillion)))
    ? undefined
    : tokens === 0
      ? 0
      : (tokens / 1_000_000) * perMillion!

export function estimateCostUsd(input: {
  readonly usage: Pick<CompoundUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">
  readonly pricing?: Pricing
}) {
  const inputTokens = finiteNonNegative(input.usage.inputTokens)
  const outputTokens = finiteNonNegative(input.usage.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return
  const values = [
    price(inputTokens, input.pricing?.inputUsdPer1M),
    price(outputTokens, input.pricing?.outputUsdPer1M),
    price(finiteNonNegative(input.usage.cacheReadTokens) ?? 0, input.pricing?.cacheReadUsdPer1M),
    price(finiteNonNegative(input.usage.cacheWriteTokens) ?? 0, input.pricing?.cacheWriteUsdPer1M),
  ]
  if (values.some((value) => value === undefined)) return
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

export function createCompoundLedger(limits: Limits): CompoundLedgerSnapshot {
  return { version: 1, limits, records: [] }
}

export function aggregateLedger(ledger: CompoundLedgerSnapshot): CompoundLedgerAggregate {
  const usedRecords = ledger.records.filter((record) => terminal(record.status))
  const openRecords = ledger.records.filter((record) => !terminal(record.status))
  const usedTokens = usedRecords.reduce(
    (total, record) => total + Math.max(record.reserved.tokens, usageTokens(record.usage) ?? 0),
    0,
  )
  const reservedTokens = openRecords.reduce((total, record) => total + record.reserved.tokens, 0)
  const usedUsd = usedRecords.reduce(
    (total, record) => total + (finiteNonNegative(record.usage?.costUsd) ?? record.reserved.costUsd ?? 0),
    0,
  )
  const reservedUsd = openRecords.reduce((total, record) => total + (record.reserved.costUsd ?? 0), 0)
  const maxCost = ledger.limits.maxCostUsd
  return {
    requests: {
      used: usedRecords.length,
      reserved: openRecords.length,
      remaining: Math.max(0, ledger.limits.maxModelRequests - ledger.records.length),
    },
    tokens: {
      used: usedTokens,
      reserved: reservedTokens,
      remaining: Math.max(0, ledger.limits.maxTotalTokens - usedTokens - reservedTokens),
    },
    cost: {
      usedUsd,
      reservedUsd,
      remainingUsd: maxCost === undefined ? null : Math.max(0, maxCost - usedUsd - reservedUsd),
      unknownRequests: ledger.records.filter((record) => record.coverage.cost === "unknown").length,
    },
  }
}

export function reserveRequest(input: RequestAdmissionInput): LedgerTransition {
  const existing = input.ledger.records.find((record) => keyString(record.key) === keyString(input.key))
  if (existing) {
    return {
      ok: false,
      ledger: input.ledger,
      reason: terminal(existing.status) ? "already_terminal" : "in_flight",
    }
  }

  const tokens = tokenEstimate(input)
  const estimatedCost = finiteNonNegative(input.estimatedCostUsd)
  const aggregate = aggregateLedger(input.ledger)
  if (input.ledger.records.length >= input.ledger.limits.maxModelRequests) {
    return { ok: false, ledger: input.ledger, reason: "request_limit" }
  }
  if (aggregate.tokens.used + aggregate.tokens.reserved + tokens > input.ledger.limits.maxTotalTokens) {
    return { ok: false, ledger: input.ledger, reason: "token_limit" }
  }
  if (input.ledger.limits.maxCostUsd !== undefined && estimatedCost === undefined && input.ledger.limits.unknownCost === "block") {
    return { ok: false, ledger: input.ledger, reason: "unknown_cost" }
  }
  if (
    input.ledger.limits.maxCostUsd !== undefined &&
    estimatedCost !== undefined &&
    aggregate.cost.usedUsd + aggregate.cost.reservedUsd + estimatedCost > input.ledger.limits.maxCostUsd
  ) {
    return { ok: false, ledger: input.ledger, reason: "cost_limit" }
  }

  const receipt: CompoundRequestReceipt = {
    key: input.key,
    role: input.role,
    providerID: input.providerID,
    modelID: input.modelID,
    authMode: input.authMode ?? null,
    status: "reserved",
    reserved: { requests: 1, tokens, costUsd: estimatedCost ?? null },
    ...(input.pricing ? { pricing: input.pricing } : {}),
    coverage: normalizedCoverage({
      inputTokens: input.estimatedInputTokens === undefined ? "missing" : "estimated",
      outputTokens: input.estimatedOutputTokens === undefined ? "missing" : "estimated",
      cost: estimatedCost === undefined ? "unknown" : "estimated",
    }),
    createdAt: input.now ?? Date.now(),
  }
  return { ok: true, ledger: { ...input.ledger, records: [...input.ledger.records, receipt] }, receipt }
}

export function startRequest(ledger: CompoundLedgerSnapshot, key: CompoundRequestKey, now = Date.now()): LedgerTransition {
  const index = ledger.records.findIndex((record) => keyString(record.key) === keyString(key))
  if (index < 0) return { ok: false, ledger, reason: "missing_request" }
  const record = ledger.records[index]!
  if (terminal(record.status)) return { ok: false, ledger, reason: "already_terminal" }
  if (record.status === "running") return { ok: false, ledger, reason: "in_flight" }
  const started = { ...record, status: "running" as const, startedAt: record.startedAt ?? now }
  const records = [...ledger.records]
  records[index] = started
  return { ok: true, ledger: { ...ledger, records }, receipt: started }
}

export function finishRequest(input: RequestFinishInput): LedgerTransition {
  const index = input.ledger.records.findIndex((record) => keyString(record.key) === keyString(input.key))
  if (index < 0) return { ok: false, ledger: input.ledger, reason: "missing_request" }
  const record = input.ledger.records[index]!
  if (terminal(record.status)) return { ok: false, ledger: input.ledger, reason: "already_terminal" }
  const cost = finiteNonNegative(input.usage?.costUsd)
  const finished: CompoundRequestReceipt = {
    ...record,
    status: input.status,
    ...(input.usage ? { usage: input.usage } : {}),
    coverage: normalizedCoverage({ ...record.coverage, ...input.coverage, ...(cost !== undefined ? { cost: input.usage?.costSource === "provider-reported" ? "reported" : "estimated" } : {}) }),
    completedAt: input.now ?? Date.now(),
    ...(input.error ? { error: input.error } : {}),
  }
  const records = [...input.ledger.records]
  records[index] = finished
  return { ok: true, ledger: { ...input.ledger, records }, receipt: finished }
}

export function ledgerForUnknownDispatch(input: {
  readonly ledger: CompoundLedgerSnapshot
  readonly key: CompoundRequestKey
  readonly error?: string
  readonly now?: number
}) {
  return finishRequest({
    ledger: input.ledger,
    key: input.key,
    status: "unknown",
    coverage: { cost: "unknown" },
    error: input.error ?? "Request ended without a terminal provider receipt; it must not be replayed automatically.",
    now: input.now,
  })
}

export function keyFromParts(input: CompoundRequestKey) {
  return keyString(input)
}

export * as CompoundLedger from "./compound-ledger"
