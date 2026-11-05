import type { ModelChoice, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { BudgetUsage } from "./budgets"

/**
 * Who asked for a model call that is not part of a turn (docs/usage.md, "Auxiliary calls"). Each one is recorded in
 * `usage_auxiliary_daily`: bookkeeping only, no request and no token of its own. `/btw` is not here: its side session runs turns,
 * which `usage.recorded` already counts. `prReview` is the exception that attributes: the PR reviewer's child sessions are hidden
 * sessions whose turns `usage.recorded` already counted in the days and models (and whose per-call rows go with the session), so
 * this row says how much of those totals the reviewer spent; reports leave it out of "outside turns" sums.
 */
export const AUXILIARY_ROLES = ["title", "summary", "recap", "memoryExtractor", "memoryAssistant", "memoryConsolidator", "dream", "permissionReviewer", "hook", "agentGenerate", "setup", "loopInterpret", "prReview", "whatsNew"] as const
export type AuxiliaryRole = (typeof AUXILIARY_ROLES)[number]
export type AuxiliaryCall = { role: AuxiliaryRole; sessionId?: SessionId | undefined; directory?: string | undefined }
/** The daemon's budgeted completion for calls outside a turn: `auxiliary` says whose call it is. */
export type AuxiliaryComplete = (input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice; onText?(text: string): void; auxiliary: AuxiliaryCall; onUsage?(usage: BudgetUsage | undefined): void }) => Promise<string>
export type AuxiliaryUsagePort = {
  /** One finished or failed call: `usage` as the provider reported it; none counts a call of `model` with unknown tokens and cost. */
  record(call: AuxiliaryCall, usage: BudgetUsage | undefined, model: string): void
}

export function createAuxiliaryUsage(input: { store: Store; now(): number; price(usage: BudgetUsage): number | undefined; log?(message: string): void }): AuxiliaryUsagePort {
  return {
    record(call, usage, model) {
      try {
        const directory = call.directory ?? (call.sessionId ? input.store.sessionDirectory(call.sessionId) : undefined)
        const used = usage ?? { provider: model.includes(":") ? model.split(":")[0]! : "", model, input: 0, output: 0 }
        input.store.usageAuxiliary.record({
          at: input.now(), role: call.role, provider: used.provider, model: used.model, directory,
          input: used.input, output: used.output, reasoning: used.reasoning, cacheRead: used.cacheRead, cacheWrite: used.cacheWrite,
          costMicros: usage ? input.price(usage) : undefined,
        })
      } catch (error) {
        // Bookkeeping never fails the call it counts.
        input.log?.(`[USAGE]: could not record a ${call.role} call: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
