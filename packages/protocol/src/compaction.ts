import { z } from "zod"
import { lazySchema } from "./lazy"

/** v1 names are retained for configuration migration; all limits are tokens or milliseconds. */
export const CompactionOverride = lazySchema(() => z.strictObject({
  token_limit: z.number().int().positive().max(2_000_000).optional(),
  threshold: z.number().finite().optional(),
}))
export type CompactionOverride = z.infer<typeof CompactionOverride>

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
