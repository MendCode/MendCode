/** What the context meter needs from the session's last model call. */
export type ContextUsage = { contextTokens: number | undefined; contextWindow?: number; contextApprox?: boolean; compactAt?: number } | undefined

/**
 * What the context is measured against. An engine that compacts on its own (Claude Code, Codex) states its model's
 * window and MendCode's compaction threshold means nothing to it; every other engine is measured against the point where
 * MendCode packs the history, which the engine says with each call (`compactAt`: the user's `compactAtTokens`, or the
 * threshold percentage of the model's window). `threshold` is only what to show before the first call says it.
 */
export function contextLimit(usage: ContextUsage, threshold: number): number {
  return usage?.contextWindow ?? usage?.compactAt ?? threshold
}

/** True when the limit is the engine's own window rather than MendCode's compaction threshold. */
export function contextIsEngineWindow(usage: ContextUsage): boolean {
  return usage?.contextWindow !== undefined
}
