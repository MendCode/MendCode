import type { SessionStats } from "@mendcode/extension-api"
import { forecastTurns } from "./context-forecast"
import { cacheHitPercent, callSpeed, type CallStats, type ContextSample, type SessionUsage } from "./usage-notes"

/**
 * The one place the session's live figures are computed (docs/customize.md, "Session stats"). Pure data in, `SessionStats` out: the
 * footer, the activity status, the top bar, the sidebar's `stats` card and `api.stats()` all read this value, so no surface keeps a
 * second tally. It folds what the client already has (the usage totals and call timings the transcript keeps from `usage.recorded`);
 * it asks the daemon for nothing and owns no timer.
 */
export type SessionStatsInput = {
  usage: SessionUsage
  /** The last conversation call's own counts, for the per-call cache share. */
  last?: { input: number; cacheRead: number; cacheWrite: number }
  /** The last calls' timings, oldest first. */
  calls?: readonly CallStats[]
  /** Estimated spend in micro-USD. */
  costMicros?: number
  /** Context in use after the last call, and what it is measured against. */
  contextTokens?: number
  contextLimit?: number
  contextApprox?: boolean
  /** The context size at the end of recent turns (the forecast). */
  contexts?: readonly ContextSample[]
  /** A forecast the caller already has (the footer's, tier-gated); overrides the one computed from `contexts`. */
  forecastTurns?: number
  model?: string
  effort?: string
}

export const EMPTY_USAGE: SessionUsage = Object.freeze({ calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export function computeSessionStats(source: SessionStatsInput): SessionStats {
  const { usage } = source
  const cachePercent = cacheHitPercent(usage)
  const lastPrompt = source.last ? source.last.input + source.last.cacheRead + source.last.cacheWrite : 0
  const speed = source.calls?.map(callSpeed).findLast((value) => value !== undefined)
  const firstToken = source.calls?.findLast((call) => call.firstTokenMs !== null)?.firstTokenMs
  const limit = source.contextLimit !== undefined && source.contextLimit > 0 ? source.contextLimit : undefined
  const forecast = source.forecastTurns ?? (limit !== undefined && source.contexts ? forecastTurns(source.contexts, limit)?.turns : undefined)
  return Object.freeze({
    calls: usage.calls,
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    reasoning: usage.reasoning,
    ...(cachePercent !== undefined ? { cachePercent } : {}),
    ...(source.last && lastPrompt > 0 ? { lastPrompt, lastCacheRead: source.last.cacheRead, lastCachePercent: Math.round((source.last.cacheRead / lastPrompt) * 100) } : {}),
    ...(source.contextTokens !== undefined && limit !== undefined ? { contextTokens: source.contextTokens, contextLimit: limit, contextPercent: Math.round((source.contextTokens / limit) * 100) } : {}),
    ...(source.contextTokens !== undefined && limit !== undefined && source.contextApprox ? { contextApprox: true } : {}),
    ...(source.costMicros !== undefined ? { costMicros: source.costMicros } : {}),
    ...(speed !== undefined ? { tokensPerSecond: speed } : {}),
    ...(firstToken != null ? { firstTokenMs: firstToken } : {}),
    ...(forecast !== undefined ? { forecastTurns: forecast } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
  })
}

/** Figures of a made-up session for previews (the customize page, the docs' frames): a healthy cache, a third of the window used. */
export const SAMPLE_STATS: SessionStats = computeSessionStats({
  usage: { calls: 14, input: 3_200, output: 5_100, reasoning: 1_400, cacheRead: 212_000, cacheWrite: 9_800 },
  last: { input: 400, cacheRead: 21_600, cacheWrite: 0 },
  costMicros: 183_000,
  contextTokens: 22_000,
  contextLimit: 160_000,
  forecastTurns: 12,
  effort: "medium",
  calls: [{ at: 0, model: "sample", output: 600, reasoning: 100, firstTokenMs: 900, durationMs: 9_900, toolCount: 2 }],
})

/** Two snapshots carry the same figures (every field is a number, a boolean or a string). */
export function sameStats(a: SessionStats, b: SessionStats): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key as keyof SessionStats] !== b[key as keyof SessionStats]) return false
  return true
}

/**
 * The live holder of the current stats: `read()` recomputes from the source (cheap: a few sums) and keeps the previous object while
 * nothing moved, so surfaces and extensions can compare by identity. Subscribers are told about a change once, after the call that
 * noticed it returns (a microtask), never from inside a frame and never on a timer.
 */
export function createStatsHub(source: () => SessionStatsInput, options: { onListenerError?: (error: unknown) => void } = {}) {
  let current = computeSessionStats(source())
  const listeners = new Set<(stats: SessionStats) => void>()
  let scheduled = false
  const flush = () => {
    scheduled = false
    for (const listener of [...listeners]) {
      try { listener(current) } catch (error) { options.onListenerError?.(error) }
    }
  }
  return {
    read(): SessionStats {
      const next = computeSessionStats(source())
      if (sameStats(current, next)) return current
      current = next
      if (listeners.size > 0 && !scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
      return current
    },
    subscribe(listener: (stats: SessionStats) => void): () => void {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get listeners() {
      return listeners.size
    },
  }
}
export type StatsHub = ReturnType<typeof createStatsHub>
