import { z } from "zod"
import { lazySchema } from "./lazy"

/** v1 names are retained for configuration migration; all limits are tokens or milliseconds. */
export const CompactionOverride = lazySchema(() => z.strictObject({
  token_limit: z.number().int().positive().max(2_000_000).optional(),
  threshold: z.number().finite().optional(),
}))
export type CompactionOverride = z.infer<typeof CompactionOverride>

/**
 * What a new `threshold` may be: a percent of the context window, above 0 and at most 100. Saved values stay readable as they were
 * (the engine reads a value at most 1 as a fraction), so only a write is held to it: `settings.set` and `providers.set`.
 */
export const THRESHOLD_RULE = "compaction.threshold is a percent of the context window, for example 80 for 80%: more than 0 and at most 100"
export const CompactionThresholdInput = lazySchema(() => z.number({ error: THRESHOLD_RULE }).finite({ error: THRESHOLD_RULE }).gt(0, { error: THRESHOLD_RULE }).max(100, { error: THRESHOLD_RULE }))
export const CompactionOverrideInput = lazySchema(() => CompactionOverride.extend({ threshold: CompactionThresholdInput.optional() }))
/** A `settings.set` patch's `compaction.threshold`, checked as a write; anything else in the patch is the Settings schema's. */
export const CompactionPatch = lazySchema(() => z.looseObject({ compaction: z.looseObject({ threshold: CompactionThresholdInput.optional() }).nullable().optional() }))

export const CompactionConfig = lazySchema(() => CompactionOverride.extend({
  auto: z.boolean().optional(),
  prune: z.boolean().optional(),
  tail_turns: z.number().int().min(0).max(1000).optional(),
  preserve_recent_tokens: z.number().int().min(0).max(2_000_000).optional(),
  reserved: z.number().int().min(0).max(2_000_000).optional(),
  strategy: z.enum(["portable", "auto", "native"]).optional(),
  portable_mode: z.enum(["legacy", "incremental"]).optional(),
  timeout_ms: z.number().int().min(1000).max(300_000).optional(),
  max_summary_tokens: z.number().int().min(512).max(8192).optional(),
  on_native_error: z.enum(["stop", "portable"]).optional(),
}))
export type CompactionConfig = z.infer<typeof CompactionConfig>
