import type { LoopGate } from "@mendcode/protocol"

/** Numeric acceptance on top of loop checks/receipts; no scheduler, process or checkout mutation. */
export function acceptExperiment(input: { baseline: number; candidate: number; direction: "min" | "max"; gates: readonly LoopGate[]; iteration: number; maxIterations: number; costMicros?: number | undefined; maxCostMicros: number; tokens: number; maxTokens: number }): { accepted: boolean; reason: string } {
  if (![input.baseline, input.candidate, input.maxCostMicros, input.tokens, input.maxTokens].every(Number.isFinite)) return { accepted: false, reason: "Invalid metric or budget" }
  if (!Number.isInteger(input.iteration) || !Number.isInteger(input.maxIterations) || input.iteration < 1 || input.iteration > input.maxIterations) return { accepted: false, reason: "Iteration limit reached" }
  if (input.maxCostMicros < 0 || input.tokens < 0 || input.maxTokens < 0 || input.tokens > input.maxTokens) return { accepted: false, reason: "Token budget exceeded" }
  if (input.costMicros === undefined || !Number.isFinite(input.costMicros) || input.costMicros < 0 || input.costMicros > input.maxCostMicros) return { accepted: false, reason: "Cost unknown or budget exceeded" }
  if (!input.gates.length || input.gates.some((gate) => gate.status !== "pass" || gate.waiver)) return { accepted: false, reason: "Correctness not verified" }
  const improved = input.direction === "min" ? input.candidate < input.baseline : input.candidate > input.baseline
  return { accepted: improved, reason: improved ? "Metric improved and correctness passed" : "Metric did not improve" }
}
