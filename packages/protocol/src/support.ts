import { z } from "zod"
import { lazySchema } from "./lazy"
import { IDLE_COMPACT_OFF_REASONS } from "./idle-compaction-data"

const tokens = z.number().int().nonnegative()
export const RequestProfile = lazySchema(() => z.strictObject({
  estimatedTokens: z.strictObject({ instructions: tokens, memory: tokens, history: tokens, toolResults: tokens, toolSchemas: tokens, media: tokens, total: tokens }),
  firstTokenMs: tokens.nullable(),
  durationMs: tokens,
  toolCount: tokens,
  imageCount: tokens,
}))
export type RequestProfile = z.infer<typeof RequestProfile>

/**
 * A session's limits as they stand now: the model, its window and who states it, where the history will be packed and what sets
 * that point, and how full the context is. Every `*Source` names where the number beside it comes from.
 */
export const ContextLimits = lazySchema(() => z.strictObject({
  model: z.string(),
  /** Absent when nobody states a window for the model. */
  contextWindow: z.number().int().positive().optional(),
  /** `session`: this session's `/context-window` override; `model-setting`: the model's `modelContext` window; `engine`: the engine reports it; `catalog`: the model list; `unknown`: nobody states one. */
  contextWindowSource: z.enum(["session", "model-setting", "engine", "catalog", "unknown"]),
  /** The largest window the provider is known to serve for the model; absent when unknown. */
  maxContextWindow: z.number().int().positive().optional(),
  /** A provider's input limit below the window: the threshold percentage and the cap apply to it. */
  inputLimit: z.number().int().positive().optional(),
  /** Where MendCode packs the history. Absent for an engine that compacts on its own. */
  compactAtTokens: z.number().int().positive().optional(),
  /**
   * What sets `compactAtTokens`. Absolute triggers, first one set wins: `model-override` and `provider-override` (a `compaction.token_limit`
   * in providers.json), `environment` (MENDCODE_COMPACT_AT_TOKENS of the daemon), `model-setting` (`compactAt` of the model's `modelContext`),
   * `compactAtTokens` (the setting), `compaction.token_limit`.
   * Otherwise `threshold` (a percentage of the window) or `no-window-default` (160k, no window known). `engine`: the engine's own number,
   * which the settings do not explain. `last-call`: what the engine said with the session's last model call. `engine-managed`: the engine compacts itself.
   */
  compactAtSource: z.enum(["model-override", "provider-override", "environment", "model-setting", "compactAtTokens", "compaction.token_limit", "threshold", "no-window-default", "engine", "last-call", "engine-managed"]),
  /** With `threshold`: the percentage and the setting that states it. */
  thresholdPercent: z.number().min(1).max(100).optional(),
  thresholdSource: z.enum(["model-override", "provider-override", "compaction.threshold", "default"]).optional(),
  /** An absolute trigger above the window (or input limit) was lowered to it. */
  capped: z.literal(true).optional(),
  /** False when `compaction.auto` is false: only `/compact` packs. */
  autoCompact: z.boolean(),
  /** Tokens the conversation occupies. `last-call`: the provider's count after the last model call; `estimate`: the current history's text, 4 characters per token. */
  contextTokens: tokens.optional(),
  contextTokensSource: z.enum(["last-call", "estimate"]).optional(),
  /**
   * How far the limit is: tokens left to the compaction point (`limit: "compaction"`) or to the window of an engine that compacts
   * on its own (`window`). `turns` and `perTurn` come from the growth of the session's last main turns and are present only with
   * at least three of them. `noticePercent` is the share at which the terminal says it (absent when the notice is off);
   * `noticeDue` is true once the context is at or past it. Absent when nothing is measured or no limit is known.
   */
  forecast: z.strictObject({
    limit: z.enum(["compaction", "window"]),
    auto: z.boolean(),
    tokensLeft: tokens,
    turns: tokens.optional(),
    perTurn: tokens.optional(),
    noticePercent: z.number().int().min(10).max(99).optional(),
    noticeDue: z.boolean(),
  }).optional(),
  /**
   * Compaction while idle, before the provider's prompt cache expires. `scheduled` with `at` (when it starts), or not scheduled with
   * `reason`. `atTokens` is the least context it applies to; `lifetimeMinutes` and `lifetimeSource` say how long the provider of the
   * last call keeps a prefix and who states that (`assumed`: nobody measured it).
   */
  idleCompaction: z.strictObject({
    scheduled: z.boolean(),
    at: tokens.optional(),
    reason: z.enum(IDLE_COMPACT_OFF_REASONS).optional(),
    atTokens: z.number().int().positive(),
    provider: z.string().optional(),
    lifetimeMinutes: z.number().positive().optional(),
    lifetimeSource: z.enum(["setting", "documented", "assumed"]).optional(),
  }).optional(),
}))
export type ContextLimits = z.infer<typeof ContextLimits>

export const RecentContextReport = lazySchema(() => z.strictObject({
  sessionId: z.string(),
  limit: z.number().int().min(1).max(100),
  /** Absent from older daemons. */
  limits: ContextLimits.optional(),
  requests: z.array(z.strictObject({
    seq: tokens, at: tokens, turnId: z.string(), provider: z.string(), model: z.string(),
    inputTokens: tokens, cachedTokens: tokens, cacheWriteTokens: tokens,
    cacheHitRate: z.number().min(0).max(1).nullable(),
    profile: RequestProfile.optional(),
  })).max(100),
  truncated: z.boolean(),
}))
export type RecentContextReport = z.infer<typeof RecentContextReport>

export const SystemReport = lazySchema(() => z.strictObject({
  operation: z.string(),
  ok: z.boolean(),
  checks: z.array(z.strictObject({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  failures: z.array(z.string()),
  facts: z.record(z.string(), z.unknown()),
}))
export type SystemReport = z.infer<typeof SystemReport>
