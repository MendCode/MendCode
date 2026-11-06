import type { UsageAuxiliary } from "@mendcode/protocol"

/**
 * The calls MendCode made outside the user's turns (`usage.query`'s `auxiliary`: titles, summaries, memory, hooks...), shared by
 * the /usage Models tab and `mendcode usage`/`stats`. Rows are role and model; a role's rows stay together, the costliest role first.
 */

export type AuxiliaryTotals = { calls: number; input: number; output: number; tokens: number; costMicros: number; unpriced: number }

/** Roles whose turns the days and models already count (hidden sessions run turns): listed to say whose they are, never added to "outside turns". */
export const ATTRIBUTION_ROLES: readonly string[] = ["prReview"]

export function auxiliaryTotals(entries: readonly UsageAuxiliary[]): AuxiliaryTotals {
  const out: AuxiliaryTotals = { calls: 0, input: 0, output: 0, tokens: 0, costMicros: 0, unpriced: 0 }
  for (const entry of entries) {
    if (ATTRIBUTION_ROLES.includes(entry.role)) continue
    out.calls += entry.calls
    out.input += entry.input
    out.output += entry.output
    out.tokens += entry.input + entry.output
    out.costMicros += entry.costMicros
    out.unpriced += entry.costUnknownCalls
  }
  return out
}

/** Grouped by role (most tokens first, then most calls), each role's models by tokens. */
export function auxiliaryOrder(entries: readonly UsageAuxiliary[]): UsageAuxiliary[] {
  const weight = new Map<string, { tokens: number; calls: number }>()
  for (const entry of entries) {
    const role = weight.get(entry.role) ?? { tokens: 0, calls: 0 }
    weight.set(entry.role, { tokens: role.tokens + entry.input + entry.output, calls: role.calls + entry.calls })
  }
  const rank = (entry: UsageAuxiliary) => weight.get(entry.role)!
  return [...entries].sort((a, b) => rank(b).tokens - rank(a).tokens || rank(b).calls - rank(a).calls || a.role.localeCompare(b.role)
    || b.input + b.output - (a.input + a.output) || b.calls - a.calls || a.model.localeCompare(b.model))
}

export function callCount(calls: number, format: (value: number) => string) {
  return `${format(calls)} ${calls === 1 ? "call" : "calls"}`
}

/** "summary · gpt-6-luna": the role, then the model id without its provider (the CLI's JSON keeps both). */
export function auxiliaryLabel(entry: UsageAuxiliary) {
  return `${entry.role} · ${entry.model || entry.provider || "unknown model"}${ATTRIBUTION_ROLES.includes(entry.role) ? " (in the totals above)" : ""}`
}
