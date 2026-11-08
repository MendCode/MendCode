/**
 * Compaction while idle, before the provider's prompt cache expires (docs/compaction.md, "Compaction while idle").
 * Data and pure functions only, no imports, so the daemon, the thin terminal client and tests share one declaration.
 */

/** A session whose context is below this is not compacted while idle, when the `idleCompactAtTokens` setting is unset. */
export const DEFAULT_IDLE_COMPACT_AT_TOKENS = 100_000

/**
 * How long before the cache expires the compaction starts. It covers the compaction's own start-up (hooks, loading the
 * history, building the request) and the provider counting the lifetime from when it received the last request.
 */
export const IDLE_COMPACT_MARGIN_MS = 60_000

/**
 * Anthropic Messages: `cache_control: { type: "ephemeral" }` without `ttl`, which is what the adapter sends by default, lasts 5 minutes
 * and is refreshed by every read (Anthropic's prompt-caching documentation). Not measured here.
 */
export const ANTHROPIC_CACHE_LIFETIME_MS = 5 * 60_000
/** Anthropic Messages with `cache_control: { type: "ephemeral", ttl: "1h" }` (the `promptCacheTtl` setting, or the `wait_cache` feature): one hour, as documented. Not measured here. */
export const ANTHROPIC_CACHE_LIFETIME_1H_MS = 60 * 60_000
/** The two cache lifetimes Anthropic sells (`promptCacheTtl`, docs/prompt-cache.md): `5m` sends no `ttl`, `1h` sends `ttl: "1h"`. */
export const CACHE_TTLS = ["5m", "1h"] as const
export type CacheTtl = (typeof CACHE_TTLS)[number]
/** Provider types whose requests take `ttl` in `cache_control`: the Anthropic API and Claude on Vertex (the Messages wire format). */
export const CACHE_TTL_PROVIDER_TYPES: readonly string[] = ["anthropic", "google-vertex-anthropic"]

/**
 * `wait_cache` (docs/prompt-cache.md, "A longer lifetime after long waits"): a session whose calls were twice more than the
 * 5-minute lifetime apart, and less than an hour, writes its cache at `1h` from the second such call on.
 */
export const WAIT_CACHE_AFTER = 2
export type WaitCacheState = { ttl: CacheTtl; lastAt?: number | undefined; longWaits: number }

/**
 * The state after a call that starts at `now`. The lifetime only changes on a call whose cache has already expired (the gap
 * was longer than the lifetime in force), so a switch never rewrites a prefix that could still have been read: Anthropic does
 * not say whether a `5m` and a `1h` entry of one prefix are the same entry.
 */
export function nextWaitCache(state: WaitCacheState | undefined, now: number): WaitCacheState {
  if (!state || state.lastAt === undefined) return { ttl: state?.ttl ?? "5m", lastAt: now, longWaits: state?.longWaits ?? 0 }
  const gap = now - state.lastAt
  // Past an hour neither lifetime kept the cache: back to 5 minutes, and the pattern has to show again.
  if (gap > ANTHROPIC_CACHE_LIFETIME_1H_MS) return { ttl: "5m", lastAt: now, longWaits: 0 }
  if (state.ttl === "1h" || gap <= ANTHROPIC_CACHE_LIFETIME_MS) return { ttl: state.ttl, lastAt: now, longWaits: state.longWaits }
  const longWaits = state.longWaits + 1
  return { ttl: longWaits >= WAIT_CACHE_AFTER ? "1h" : "5m", lastAt: now, longWaits }
}
/**
 * OpenAI API (Responses, api.openai.com): in-memory retention is typically 5 to 10 minutes of inactivity and up to an hour, and the
 * extended `24h` retention is the default for some models and organizations (OpenAI's prompt-caching guide). The adapter does not
 * send `prompt_cache_retention`, so which one applies depends on the account: the lower bound is the fallback, and the lifetime
 * observed from the cached tokens of each response (`observedCacheLifetime`) replaces it once it is longer.
 */
export const OPENAI_CACHE_LIFETIME_MS = 5 * 60_000
/** ChatGPT subscription backend: an ASSUMPTION, nobody states it; one sample found the cache alive at 4 min 30 s (docs/prompt-cache.md). */
export const CHATGPT_CACHE_LIFETIME_MS = 5 * 60_000

/**
 * Observed lifetime. Every call that follows an earlier call of the same provider leaves a sample: the gap since that call
 * and whether the response read the conversation's prefix from the cache (`CACHE_HIT_SHARE` of the previous prompt). The gaps are bucketed; a bucket with
 * enough samples is alive when at least `CACHE_HIT_RATE` of them hit. The lifetime is the longest hit gap below the first
 * dead bucket, so it is never beyond what was seen to work.
 */
export const CACHE_GAP_EDGES_MINUTES: readonly number[] = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1_440]
/** A response read the conversation's cache when its cached tokens are at least this share of the previous call's prompt: the instructions and tool list alone are cached across sessions and say nothing about it. */
export const CACHE_HIT_SHARE = 0.5
export const CACHE_BUCKET_MIN_SAMPLES = 3
/** A compaction that finds the cache gone pays the full price, so a gap only counts as alive when the cache is reliably there. */
export const CACHE_HIT_RATE = 0.8
/** A call whose prompt was shorter than this cannot tell a miss from a prefix too short to cache (OpenAI caches from 1,024 tokens). */
export const CACHE_SAMPLE_MIN_PROMPT_TOKENS = 4_096
/** Samples kept per provider and cache lifetime request; the oldest go first. */
export const CACHE_SAMPLES_MAX = 400
/** Gaps shorter than this are not kept: a cache that reads after seconds says nothing about its end, and they would crowd out the long ones. */
export const CACHE_SAMPLE_MIN_GAP_MS = 2 * 60_000
/** How far back the stored calls are read for samples when a provider's first call is seen: the provider changes its retention now and then. */
export const CACHE_SAMPLE_WINDOW_MS = 14 * 86_400_000
export type CacheSample = { gapMs: number; hit: boolean }
export type ObservedCacheLifetime = { ms: number; /** A bucket longer than `ms` was seen failing, so the lifetime is an upper bound. */ closed: boolean }

export function observedCacheLifetime(samples: readonly CacheSample[]): ObservedCacheLifetime | undefined {
  const buckets = CACHE_GAP_EDGES_MINUTES.map(() => ({ total: 0, hits: 0, longestHitMs: 0 }))
  for (const sample of samples) {
    if (!(sample.gapMs > 0)) continue
    const index = CACHE_GAP_EDGES_MINUTES.findIndex((edge) => sample.gapMs <= edge * 60_000)
    const bucket = buckets[index < 0 ? buckets.length - 1 : index]
    if (!bucket) continue
    bucket.total += 1
    if (sample.hit) {
      bucket.hits += 1
      bucket.longestHitMs = Math.max(bucket.longestHitMs, sample.gapMs)
    }
  }
  let ms = 0
  for (const bucket of buckets) {
    if (bucket.total < CACHE_BUCKET_MIN_SAMPLES) continue
    if (bucket.hits / bucket.total < CACHE_HIT_RATE) return ms > 0 ? { ms, closed: true } : undefined
    ms = Math.max(ms, bucket.longestHitMs)
  }
  return ms > 0 ? { ms, closed: false } : undefined
}

export const CACHE_LIFETIME_MINUTES_RANGE = { min: 1, max: 1_440 } as const

export type CacheLifetimeSource = "setting" | "observed" | "documented" | "assumed"
export type CacheLifetime = { ms: number; source: CacheLifetimeSource }

/**
 * How long `provider` keeps a prompt prefix after the last call that read or wrote it. The user's `cacheLifetimeMinutes`
 * entry wins. Undefined when nobody states it: the idle compaction then stays off for that provider, never at a guessed time.
 */
export function cacheLifetime(input: { provider: string; type?: string | undefined; baseUrl?: string | undefined; overrides?: Readonly<Record<string, number>> | undefined; /** The lifetime the session's last call asked for (`cacheTtl` of its `usage.recorded`). */ ttl?: CacheTtl | undefined; /** What the provider's own responses showed (`observedCacheLifetime`). */ observed?: ObservedCacheLifetime | undefined }): CacheLifetime | undefined {
  const minutes = input.overrides?.[input.provider]
  if (typeof minutes === "number" && minutes >= CACHE_LIFETIME_MINUTES_RANGE.min && minutes <= CACHE_LIFETIME_MINUTES_RANGE.max) return { ms: minutes * 60_000, source: "setting" }
  const fallback = fallbackCacheLifetime(input)
  const observed = input.observed
  if (!observed) return fallback
  const seen: CacheLifetime = { ms: observed.ms, source: "observed" }
  if (!fallback) return observed.closed ? seen : undefined
  // A documented lifetime is only replaced by a longer one; an assumed one by anything seen (a closed bucket means it is a measured bound).
  if (fallback.source === "assumed") return observed.closed || observed.ms > fallback.ms ? seen : fallback
  return observed.ms > fallback.ms ? seen : fallback
}

function fallbackCacheLifetime(input: { provider: string; type?: string | undefined; baseUrl?: string | undefined; ttl?: CacheTtl | undefined }): CacheLifetime | undefined {
  if (input.provider === "chatgpt") return { ms: CHATGPT_CACHE_LIFETIME_MS, source: "assumed" }
  // A call that was answered with `ttl: "1h"` in its request: an hour wherever that field is taken, Vertex included.
  // Claude Code (`claude`) reports `1h` when its calls wrote the one-hour cache (`ephemeral_1h_input_tokens`), as it does on a subscription.
  if (input.ttl === "1h" && (input.provider === "claude" || (input.type !== undefined && CACHE_TTL_PROVIDER_TYPES.includes(input.type)))) return { ms: ANTHROPIC_CACHE_LIFETIME_1H_MS, source: "documented" }
  if (input.type === "anthropic") return { ms: ANTHROPIC_CACHE_LIFETIME_MS, source: "documented" }
  if (input.type === "openai" && /^https:\/\/api\.openai\.com(\/|$)/i.test(input.baseUrl ?? "")) return { ms: OPENAI_CACHE_LIFETIME_MS, source: "documented" }
  return undefined
}

/** Why no idle compaction is scheduled for a session. */
export const IDLE_COMPACT_OFF_REASONS = ["feature-off", "auto-off", "native-strategy", "engine-managed", "child-session", "no-call", "below-threshold", "unknown-lifetime", "already-compacted", "busy", "cache-expired"] as const
export type IdleCompactOffReason = (typeof IDLE_COMPACT_OFF_REASONS)[number]

/** The line a compaction that ran while idle leaves in the transcript. */
export const IDLE_COMPACT_NOTE = "Compacted while idle, before the prompt cache expired"
