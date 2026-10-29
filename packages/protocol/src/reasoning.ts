import { z } from "zod"
import { REASONING_EFFORTS } from "./constants"
import { lazySchema } from "./lazy"

export const ReasoningPolicy = lazySchema(() => z.strictObject({
  version: z.literal(1),
  mode: z.enum(["off", "shadow", "adaptive"]),
  remoteProcessing: z.boolean(),
  provider: z.enum(["openrouter", "vercel-ai-gateway"]),
  maxLeaseSteps: z.union([z.literal(1), z.literal(2), z.literal(5)]),
  maxDecisionsPerTurn: z.number().int().min(1).max(20),
  failureMode: z.enum(["pause", "baseline"]),
}))
export type ReasoningPolicy = z.infer<typeof ReasoningPolicy>

export const ReasoningReceipt = lazySchema(() => z.strictObject({
  status: z.enum(["off", "unsupported", "manual", "proposed", "prepared", "reused", "fallback", "paused", "requested"]),
  effort: z.enum(REASONING_EFFORTS).optional(),
  suggestedEffort: z.enum(REASONING_EFFORTS).optional(),
  leaseRemaining: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  reason: z.string().max(300).optional(),
}))
export type ReasoningReceipt = z.infer<typeof ReasoningReceipt>

export const ReasoningReport = lazySchema(() => z.strictObject({
  config: ReasoningPolicy,
  consent: ReasoningPolicy,
  revision: z.string().min(1).max(100),
  valid: z.boolean(),
  evaluatorReady: z.boolean(),
  reasoningAuto: z.boolean(),
  receipt: ReasoningReceipt.optional(),
}))
export type ReasoningReport = z.infer<typeof ReasoningReport>
