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
 * OpenAI API (Responses, api.openai.com): without `prompt_cache_retention`, which the adapter does not send, a cached prefix
 * stays for 5 to 10 minutes of inactivity (OpenAI's prompt-caching guide). The lower bound, so the compaction is never late. Not measured here.
 */
export const OPENAI_CACHE_LIFETIME_MS = 5 * 60_000
/** ChatGPT subscription backend: an ASSUMPTION, nobody states it; one sample found the cache alive at 4 min 30 s (docs/prompt-cache.md). */
export const CHATGPT_CACHE_LIFETIME_MS = 5 * 60_000

export const CACHE_LIFETIME_MINUTES_RANGE = { min: 1, max: 1_440 } as const

export type CacheLifetimeSource = "setting" | "documented" | "assumed"
export type CacheLifetime = { ms: number; source: CacheLifetimeSource }

/**
 * How long `provider` keeps a prompt prefix after the last call that read or wrote it. The user's `cacheLifetimeMinutes`
 * entry wins. Undefined when nobody states it: the idle compaction then stays off for that provider, never at a guessed time.
 */
export function cacheLifetime(input: { provider: string; type?: string | undefined; baseUrl?: string | undefined; overrides?: Readonly<Record<string, number>> | undefined; /** The lifetime the session's last call asked for (`cacheTtl` of its `usage.recorded`). */ ttl?: CacheTtl | undefined }): CacheLifetime | undefined {
  const minutes = input.overrides?.[input.provider]
  if (typeof minutes === "number" && minutes >= CACHE_LIFETIME_MINUTES_RANGE.min && minutes <= CACHE_LIFETIME_MINUTES_RANGE.max) return { ms: minutes * 60_000, source: "setting" }
  if (input.provider === "chatgpt") return { ms: CHATGPT_CACHE_LIFETIME_MS, source: "assumed" }
  // A call that was answered with `ttl: "1h"` in its request: an hour wherever that field is taken, Vertex included.
  if (input.ttl === "1h" && input.type !== undefined && CACHE_TTL_PROVIDER_TYPES.includes(input.type)) return { ms: ANTHROPIC_CACHE_LIFETIME_1H_MS, source: "documented" }
  if (input.type === "anthropic") return { ms: ANTHROPIC_CACHE_LIFETIME_MS, source: "documented" }
  if (input.type === "openai" && /^https:\/\/api\.openai\.com(\/|$)/i.test(input.baseUrl ?? "")) return { ms: OPENAI_CACHE_LIFETIME_MS, source: "documented" }
  return undefined
}

/** Why no idle compaction is scheduled for a session. */
export const IDLE_COMPACT_OFF_REASONS = ["feature-off", "auto-off", "native-strategy", "engine-managed", "child-session", "no-call", "below-threshold", "unknown-lifetime", "already-compacted", "busy", "cache-expired"] as const
export type IdleCompactOffReason = (typeof IDLE_COMPACT_OFF_REASONS)[number]

/** The line a compaction that ran while idle leaves in the transcript. */
export const IDLE_COMPACT_NOTE = "Compacted while idle, before the prompt cache expired"
