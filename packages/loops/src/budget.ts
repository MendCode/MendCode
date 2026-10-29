import type { Loop, LoopCostBudget, LoopGate, LoopUsage, SessionEvent } from "@mendcode/protocol"

export const EMPTY_USAGE: LoopUsage = { tokens: 0, costMicros: 0, unknownCostCalls: 0 }
export type UsageEvent = Extract<SessionEvent, { type: "usage.recorded" }>

export function addUsage(usage: LoopUsage | undefined, event: UsageEvent): LoopUsage {
  const previous = usage ?? EMPTY_USAGE
  return {
    tokens: previous.tokens + event.input + event.output + event.reasoning + event.cacheRead + event.cacheWrite,
    costMicros: previous.costMicros + (event.costMicros ?? 0),
    unknownCostCalls: previous.unknownCostCalls + (event.costMicros === undefined ? 1 : 0),
    ...(previous.unreportedTurns !== undefined ? { unreportedTurns: previous.unreportedTurns } : {}),
  }
}

/** Stops at the cap so the next run cannot spend more. A running call can exceed it before usage arrives. */
export function costBudgetGate(budget: LoopCostBudget | undefined, usage: LoopUsage = EMPTY_USAGE): LoopGate | undefined {
  if (!budget || budget.maxTokens === undefined && budget.maxCost === undefined) return undefined
  const failure = budget.maxTokens !== undefined && (usage.unreportedTurns ?? 0) > 0
    ? `Token usage unavailable for ${usage.unreportedTurns} turn(s); budget cannot be verified.`
    : budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens
    ? `Token cap reached (${usage.tokens}/${budget.maxTokens}).`
    : budget.maxCost !== undefined && usage.costMicros >= Math.round(budget.maxCost * 1_000_000)
      ? `USD cap reached ($${(usage.costMicros / 1_000_000).toFixed(6)}/$${budget.maxCost}).`
      : budget.maxCost !== undefined && usage.unknownCostCalls > 0 && budget.unknownCost !== "allow"
        ? `USD cost unknown for ${usage.unknownCostCalls} call(s); budget cannot be verified.`
        : undefined
  return { id: "cost-budget", status: failure ? "fail" : "pass", ...(failure ? { failureClass: "budget", detail: failure } : {}) }
}

export function loopBudgetGate(loop: Loop) {
  return costBudgetGate(loop.costBudget, loop.usage ?? (loop.runs ? { ...EMPTY_USAGE, unknownCostCalls: loop.runs, unreportedTurns: loop.runs } : EMPTY_USAGE))
}

/** Older loops have no totals. Keep prior runs unknown when the first new run reports usage. */
export function carriedUsage(loop: Loop): LoopUsage {
  if (loop.usage) return loop.usage
  const unreportedTurns = Math.max(0, loop.runs - 1)
  return { ...EMPTY_USAGE, unknownCostCalls: unreportedTurns, ...(unreportedTurns ? { unreportedTurns } : {}) }
}
