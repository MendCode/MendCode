/** What the context meter needs from the session's last model call. */
export type ContextUsage = { contextTokens: number | undefined; contextWindow?: number; contextApprox?: boolean; compactAt?: number } | undefined

/**
 * What the context is measured against: the point where the session compacts, the same number before and after the first
 * message. The engine states it with each call (`compactAt`: MendCode's point, or the window Claude Code was started with);
 * an engine that states none (Codex, Pi, ACP) is measured against the window it reports. `threshold` is what to show before
 * the first call says it (`compactFallback`).
 */
export function contextLimit(usage: ContextUsage, threshold: number): number {
  return usage?.compactAt ?? usage?.contextWindow ?? threshold
}

/** True when the limit is the engine's own window because it states no compaction point. */
export function contextIsEngineWindow(usage: ContextUsage): boolean {
  return usage?.compactAt === undefined && usage?.contextWindow !== undefined
}
