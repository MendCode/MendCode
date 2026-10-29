import { z } from "zod"
import type { ModelChoice } from "./queries"
import { MODEL_ROLES } from "./constants"
import { SessionId } from "./ids"
import { lazySchema } from "./lazy"

export const CompoundLimits = lazySchema(() => z.strictObject({
  maxModelRequests: z.number().int().min(1).max(32),
  maxTotalTokens: z.number().int().positive().max(100_000_000),
  maxRuntimeMs: z.number().int().min(1_000).max(3_600_000),
  maxCostUsd: z.number().finite().positive().optional(),
  unknownCost: z.enum(["block", "allow-with-token-cap"]).default("block"),
}))
export type CompoundLimits = z.infer<typeof CompoundLimits>

export const CompoundModelRef = lazySchema(() => z.union([
  z.strictObject({ role: z.enum(MODEL_ROLES) }),
  z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(100), variant: z.string().min(1).max(100).optional() }),
]))
export const CompoundProfile = lazySchema(() => z.strictObject({
  strategy: z.enum(["single", "cascade", "critic"]),
  primary: CompoundModelRef,
  escalation: CompoundModelRef.optional(),
  critic: CompoundModelRef.optional(),
  limits: CompoundLimits,
}).superRefine((profile, ctx) => {
  const minimum = { single: 1, cascade: 2, critic: 3 }[profile.strategy]
  if (profile.limits.maxModelRequests < minimum) ctx.addIssue({ code: "custom", path: ["limits", "maxModelRequests"], message: `${profile.strategy} requires at least ${minimum} requests` })
  if (profile.strategy === "cascade" && !profile.escalation) ctx.addIssue({ code: "custom", path: ["escalation"], message: "cascade requires escalation" })
  if (profile.strategy === "critic" && !profile.critic) ctx.addIssue({ code: "custom", path: ["critic"], message: "critic requires a critic model" })
}))
export type CompoundProfile = z.infer<typeof CompoundProfile>
export const CompoundConfig = lazySchema(() => z.strictObject({
  version: z.literal(1),
  orchestration: z.strictObject({
    enabled: z.boolean().default(false),
    profiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), CompoundProfile).refine((value) => Object.keys(value).length <= 16, "at most 16 profiles"),
  }),
}))
export type CompoundConfig = z.infer<typeof CompoundConfig>

export const CompoundPricing = lazySchema(() => z.strictObject({
  inputUsdPer1M: z.number().finite().nonnegative(),
  outputUsdPer1M: z.number().finite().nonnegative(),
  cacheReadUsdPer1M: z.number().finite().nonnegative(),
  cacheWriteUsdPer1M: z.number().finite().nonnegative(),
  source: z.string().min(1).max(300),
}))
export type CompoundPricing = z.infer<typeof CompoundPricing>
export type ResolvedCompoundProfile = { name: string; strategy: CompoundProfile["strategy"]; primary: ModelChoice; escalation?: ModelChoice; critic?: ModelChoice; limits: CompoundLimits; configHash: string; pricing: Record<string, CompoundPricing> }

export const CompoundCheck = lazySchema(() => z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), command: z.string().min(1).max(300), timeoutMs: z.number().int().min(1).max(600_000).optional() }))
export const CompoundRunInput = lazySchema(() => z.strictObject({ directory: z.string().min(1).max(4096), profile: z.string().min(1).max(48), prompt: z.string().min(1).max(8_000), checks: z.array(CompoundCheck).min(1).max(5), permission: z.enum(["ask", "edits"]).default("ask"), originSessionId: SessionId.optional() }))
export type CompoundRunInput = z.infer<typeof CompoundRunInput>
export type CompoundRequestReceipt = {
  requestId: string; leg: string; model: string; provider: string
  state: "reserved" | "running" | "completed" | "unknown" | "cancelled"
  reservedTokens: number; reservedCostUsd: number | null
  inputTokens?: number; outputTokens?: number; costUsd?: number
  costSource: "catalog" | "provider" | "unknown"
  startedAt: number; endedAt?: number
}
export type CompoundLedger = { limits: CompoundLimits; requests: CompoundRequestReceipt[]; tokens: number; costUsd: number; unknownCosts: number; startedAt: number; blocked?: string }
export type CompoundFinding = { path: string; line?: number; message: string }
export type CompoundAssessment = { verdict: "accept" | "revise" | "uncertain"; findings: CompoundFinding[]; summary: string }
export type CompoundRun = {
  runId: string; directory: string; profile: ResolvedCompoundProfile; state: "running" | "accepted" | "unreviewed-revision" | "failed" | "blocked" | "cancelled"
  phase: string; startedAt: number; endedAt?: number; workspace?: string; base?: string; fingerprint?: string
  reason?: string; result?: string; review?: CompoundAssessment
  legs: Array<{ role: string; sessionId: z.infer<typeof SessionId>; model: string; state: string }>
  validation: Array<{ id: string; status: "pass" | "quality" | "environment"; detail: string }>
  ledger: CompoundLedger
}
export type CompoundReport = { config: CompoundConfig; configHash: string; profiles: ResolvedCompoundProfile[]; issues: string[]; runs: CompoundRun[]; activeRun?: CompoundRun }
