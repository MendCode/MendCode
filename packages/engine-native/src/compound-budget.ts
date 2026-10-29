import { estimateTokens } from "@mendcode/protocol/wire"
import type { CompoundLedger, CompoundLimits, CompoundPricing, CompoundRequestReceipt, ModelChoice } from "@mendcode/protocol"
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage } from "./provider"

export type CompoundCall = { budget: CompoundBudget; role: string; choice: ModelChoice; critic?: boolean }
export type CompoundBudget = ReturnType<typeof createCompoundBudget>
const tokens = (usage: ModelUsage) => usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
const cost = (usage: ModelUsage, pricing?: CompoundPricing) => pricing ? (usage.input * pricing.inputUsdPer1M + (usage.output + usage.reasoning) * pricing.outputUsdPer1M + usage.cacheRead * pricing.cacheReadUsdPer1M + usage.cacheWrite * pricing.cacheWriteUsdPer1M) / 1_000_000 : undefined

/** One ledger across every leg and every tool-loop request. Reservations survive unknown dispatches. */
export function createCompoundBudget(input: { limits: CompoundLimits; pricing: Record<string, CompoundPricing>; now?: () => number; changed?(ledger: CompoundLedger): void }) {
  const now = input.now ?? Date.now
  const ledger: CompoundLedger = { limits: structuredClone(input.limits), requests: [], tokens: 0, costUsd: 0, unknownCosts: 0, startedAt: now() }
  const controller = new AbortController()
  const timer = setTimeout(() => { ledger.blocked = "runtime_limit"; controller.abort(); input.changed?.(ledger) }, input.limits.maxRuntimeMs)
  const changed = () => {
    ledger.tokens = ledger.requests.reduce((sum, request) => sum + Math.max(request.reservedTokens, (request.inputTokens ?? 0) + (request.outputTokens ?? 0)), 0)
    ledger.costUsd = ledger.requests.reduce((sum, request) => sum + Math.max(request.reservedCostUsd ?? 0, request.costUsd ?? 0), 0)
    ledger.unknownCosts = ledger.requests.filter((request) => request.costSource === "unknown").length
    if (ledger.tokens > ledger.limits.maxTotalTokens) ledger.blocked = "token_limit"
    if (ledger.limits.maxCostUsd !== undefined && ledger.costUsd > ledger.limits.maxCostUsd) ledger.blocked = "cost_limit"
    input.changed?.(ledger)
  }
  function block(reason: string): never {
    ledger.blocked = reason
    changed()
    throw new Error(`Compound request blocked: ${reason}`)
  }
  return {
    ledger,
    signal: controller.signal,
    remainingMs: () => Math.max(0, ledger.startedAt + ledger.limits.maxRuntimeMs - now()),
    stop: () => { clearTimeout(timer); controller.abort() },
    async *stream(provider: ModelProvider, request: ModelRequest, leg: CompoundCall): AsyncIterable<ModelEvent> {
      if (ledger.blocked) block(ledger.blocked)
      if (controller.signal.aborted || now() - ledger.startedAt >= ledger.limits.maxRuntimeMs) block("runtime_limit")
      if (request.signal.aborted) block("cancelled")
      if (ledger.requests.some((entry) => entry.state === "running" || entry.state === "reserved")) block("in_flight")
      if (ledger.requests.length >= ledger.limits.maxModelRequests) block("request_limit")
      const estimate = Math.max(1, estimateTokens(request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length))
      const output = Math.min(request.maxOutputTokens ?? 4_096, 4_096, ledger.limits.maxTotalTokens - ledger.tokens - estimate)
      if (output < 1) block("token_limit")
      const pricing = input.pricing[leg.choice.model]
      const estimatedCost = pricing ? (estimate * Math.max(pricing.inputUsdPer1M, pricing.cacheReadUsdPer1M, pricing.cacheWriteUsdPer1M) + output * pricing.outputUsdPer1M) / 1_000_000 : undefined
      if (estimatedCost === undefined && ledger.limits.unknownCost === "block") block("unknown_cost")
      if (ledger.limits.maxCostUsd !== undefined && estimatedCost !== undefined && ledger.costUsd + estimatedCost > ledger.limits.maxCostUsd) block("cost_limit")
      const receipt: CompoundRequestReceipt = { requestId: crypto.randomUUID(), leg: leg.role, model: leg.choice.model, provider: provider.idFor?.(leg.choice.model) ?? provider.id, state: "reserved", reservedTokens: estimate + output, reservedCostUsd: estimatedCost ?? null, costSource: pricing ? "catalog" : "unknown", startedAt: now() }
      ledger.requests.push(receipt)
      changed()
      receipt.state = "running"
      changed()
      const signal = AbortSignal.any([request.signal, controller.signal])
      let finished = false
      let usage: ModelUsage | undefined
      let iterator: AsyncIterator<ModelEvent> | undefined
      let aborted: (() => void) | undefined
      const cancellation = new Promise<never>((_, reject) => {
        aborted = () => reject(new Error("Compound request cancelled or timed out"))
        if (signal.aborted) aborted()
        else signal.addEventListener("abort", aborted, { once: true })
      })
      try {
        iterator = provider.stream({ ...request, model: leg.choice.model, effort: leg.choice.effort, parameters: leg.choice.parameters, maxOutputTokens: output, signal })[Symbol.asyncIterator]()
        for (;;) {
          const next = await Promise.race([iterator.next(), cancellation])
          if (next.done) break
          const event = next.value
          if (leg.critic && (event.type === "tool_call" || event.type === "hosted_tool")) throw new Error("Critic requested tools")
          if (event.type === "usage") {
            if ([event.usage.input, event.usage.output, event.usage.reasoning, event.usage.cacheRead, event.usage.cacheWrite, event.usage.costMicros ?? 0].some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid provider usage")
            usage = event.usage
          }
          if (event.type === "finish") finished = true
          yield event
        }
        if (!finished) throw new Error("Provider stream ended without a finish receipt")
        receipt.state = "completed"
      } catch (error) {
        receipt.state = signal.aborted ? "cancelled" : "unknown"
        ledger.blocked ??= signal.aborted ? "runtime_or_cancelled" : "unknown_dispatch"
        // Never replay a dispatched compound request on a provider retry.
        throw new Error(error instanceof Error ? error.message : String(error))
      } finally {
        if (aborted) signal.removeEventListener("abort", aborted)
        if (!finished) void iterator?.return?.().catch(() => {})
        if (usage) {
          receipt.inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
          receipt.outputTokens = usage.output + usage.reasoning
          const known = usage.costMicros !== undefined ? usage.costMicros / 1_000_000 : cost(usage, pricing)
          if (known !== undefined) { receipt.costUsd = known; receipt.costSource = usage.costMicros !== undefined ? "provider" : "catalog" }
          if (tokens(usage) > ledger.limits.maxTotalTokens - (ledger.tokens - receipt.reservedTokens)) ledger.blocked = "token_limit"
        }
        receipt.endedAt = now()
        changed()
      }
    },
  }
}
