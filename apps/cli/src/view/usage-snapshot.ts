import type { QuotaReading, SessionStats, UsageSnapshot } from "@mendcode/extension-api"
import { quotaReadings, type QuotaSnapshotLike } from "@mendcode/protocol/wire"

/** What `api.usage()` and the slot context's `usage` answer before the app has any state (tests, a headless load): nothing is known. */
export const NO_USAGE: UsageSnapshot = { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, quota: [] }

/** The readings the extension API hands out: the protocol's, without the engine-internal fields. */
function publicReading({ windowId: _id, windowMinutes: _minutes, source: _source, ...reading }: ReturnType<typeof quotaReadings>[number]): QuotaReading {
  return reading
}

/**
 * Usage as an extension or a footer sees it: the session stats' context and token totals plus every quota window the daemon has
 * observed. Pure: the quota snapshots are the ones the terminal already holds (the daemon's `quota.snapshot` events), so nothing
 * is asked of anyone and no other program's files are read.
 */
export function usageSnapshot({ stats, quotas, now }: { stats: SessionStats; quotas: Iterable<QuotaSnapshotLike>; now: number }): UsageSnapshot {
  const context = stats.contextTokens !== undefined && stats.contextLimit !== undefined && stats.contextPercent !== undefined
    ? { usedPercent: stats.contextPercent, tokens: stats.contextTokens, limit: stats.contextLimit }
    : undefined
  return {
    ...(context ? { context } : {}),
    tokens: { input: stats.input, output: stats.output, reasoning: stats.reasoning, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite },
    ...(stats.costMicros !== undefined ? { costMicros: stats.costMicros } : {}),
    quota: quotaReadings([...quotas], now).map(publicReading),
  }
}
