import type { UsageDay, UsageHarness, UsageReport } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

/**
 * What `/usage` adds to a report when it opens (docs/usage.md, "Every harness"): the turns' usage by harness and the calls outside
 * turns per day. Read on demand from projections that already exist; loaded by the first `usage.query`, never at start-up.
 */

/** Auxiliary roles whose calls are turns of hidden sessions, already in `days`: they attribute, never add. */
export const ATTRIBUTION_ROLES: readonly string[] = ["prReview"]

type Range = { from: string; to: string; directories?: string[] }
type Sums = Omit<UsageHarness, "harness" | "subagents">

const FIELDS = ["calls", "input", "output", "reasoning", "cacheRead", "cacheWrite", "costMicros", "costUnknownCalls"] as const

function zero(harness: string): UsageHarness {
  return { harness, calls: 0, sessions: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0 }
}

function add(target: Sums, row: Partial<Record<(typeof FIELDS)[number], number>>) {
  for (const field of FIELDS) target[field] += row[field] ?? 0
}

/** Tokens of a row: reasoning is part of `output`, so it is not added again. */
export function rowTokens(row: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return row.input + row.output + row.cacheRead + row.cacheWrite
}

/**
 * `harnesses`: one row per harness, adding up to `days` (which carry recovered usage too). Calls of sessions deleted since stay in
 * the daily sums but have no session to name a harness by: they are the `unattributed` row, so the table still adds up.
 */
export function usageHarnesses(input: { store: Store; range: Range; days: readonly UsageDay[] }): UsageHarness[] {
  const { store, range } = input
  const byHarness = new Map<string, UsageHarness>()
  const row = (harness: string) => byHarness.get(harness) ?? byHarness.set(harness, zero(harness)).get(harness)!
  for (const entry of store.usageScopes.harnesses(range)) {
    const target = row(entry.harness)
    add(target, entry)
    target.sessions += entry.sessions
    if (entry.child) {
      const tokens = rowTokens(entry)
      const previous = target.subagents ?? { calls: 0, sessions: 0, tokens: 0 }
      target.subagents = { calls: previous.calls + entry.calls, sessions: previous.sessions + entry.sessions, tokens: previous.tokens + tokens }
    }
  }
  for (const recovered of store.usageRecovery.rows(range)) {
    if (!recovered.input && !recovered.output && !recovered.cacheRead && !recovered.cacheWrite) continue
    add(row(`imported:${recovered.engine}`), recovered)
  }
  const total = zero("total")
  for (const day of input.days) add(total, day)
  const counted = zero("counted")
  for (const entry of byHarness.values()) add(counted, entry)
  const rest = zero("unattributed")
  for (const field of FIELDS) rest[field] = Math.max(0, total[field] - counted[field])
  if (rowTokens(rest) > 0 || rest.calls > 0) byHarness.set(rest.harness, rest)
  return [...byHarness.values()].filter((entry) => rowTokens(entry) > 0 || entry.calls > 0).sort((a, b) => rowTokens(b) - rowTokens(a) || a.harness.localeCompare(b.harness))
}

/** The fields `usage.query` adds when these are known: absent ones stay absent, as older daemons send. */
export function usageBreakdown(input: { store: Store; range: Range; days: readonly UsageDay[] }): Pick<UsageReport, "harnesses" | "auxiliaryDays"> {
  const harnesses = usageHarnesses(input)
  const auxiliaryDays = input.store.usageAuxiliary.days(input.range, ATTRIBUTION_ROLES)
  return { ...(harnesses.length ? { harnesses } : {}), ...(auxiliaryDays.length ? { auxiliaryDays } : {}) }
}
