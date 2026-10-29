import type { RecentContextReport, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

export function recentContext(store: Store, sessionId: SessionId, limit = 20): RecentContextReport {
  const usage = store.recentUsage(sessionId, limit + 1)
  return { sessionId, limit, truncated: usage.length > limit, requests: usage.slice(-limit).map((event) => ({
    seq: event.seq, at: event.at, turnId: event.turnId, provider: event.provider, model: event.model,
    inputTokens: event.input + event.cacheRead + event.cacheWrite, cachedTokens: event.cacheRead, cacheWriteTokens: event.cacheWrite,
    cacheHitRate: event.input + event.cacheRead + event.cacheWrite ? event.cacheRead / (event.input + event.cacheRead + event.cacheWrite) : null,
    ...(event.profile ? { profile: event.profile } : {}),
  })) }
}
