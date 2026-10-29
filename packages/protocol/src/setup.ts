import { z } from "zod"
import { lazySchema } from "./lazy"

const usd = z.number().finite().nonnegative()
/** Local API tariffs, USD per million tokens. No catalog price is guessed. */
export const BudgetPrice = lazySchema(() => z.strictObject({ input: usd, output: usd, cacheRead: usd.optional(), cacheWrite: usd.optional(), expensive: z.boolean().optional() }))
export const BudgetPolicy = lazySchema(() => z.strictObject({
  mode: z.enum(["subscription", "api-usage"]).default("subscription"),
  warnUsd: usd.nullable().default(null),
  stopUsd: usd.nullable().default(null),
  expensiveModelRequiresConfirm: z.boolean().default(false),
  prices: z.record(z.string().min(1).max(200), BudgetPrice).default({}),
  /** Additional known spend, excluding the calls recorded by this daemon. */
  suppliedUsd: usd.nullable().default(null),
}).refine((policy) => policy.warnUsd === null || policy.stopUsd === null || policy.stopUsd >= policy.warnUsd, { message: "stopUsd must be greater than or equal to warnUsd" }))
export type BudgetPolicy = z.infer<typeof BudgetPolicy>
export type BudgetPrice = z.infer<typeof BudgetPrice>
export type BudgetReport = {
  policy: BudgetPolicy
  enforcement: { state: "not-enforced" | "ok" | "warn" | "stop"; enforced: boolean; pricingKnown: boolean; model: string; currentKnownUsd: number; warnings: string[]; blockers: string[] }
  telemetry: { knownCalls: number; unknownCalls: number; recordedUsd: number; suppliedUsd: number | null }
}
export type SetupReport = {
  engine: string
  aiReady: boolean
  helper: { ready: boolean; model: string; reason?: string }
  preset: "default" | "minimal" | "full" | "custom"
  prompt: { mode: string; focusID: string }
  roles: Array<{ role: string; model: string; ready: boolean; reason?: string }>
  budget: BudgetReport
  blockers: string[]
  warnings: string[]
}
export const SetupPreset = z.enum(["default", "minimal", "full", "custom"])
export type SetupPreset = z.infer<typeof SetupPreset>
