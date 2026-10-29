import type { Clock } from "@mendcode/kernel"
import { CACHE_TTL_PROVIDER_TYPES, nextWaitCache, type CacheTtl, type WaitCacheState } from "@mendcode/protocol/wire"
import type { ModelRole, SessionId, Settings } from "@mendcode/protocol"

/**
 * The cache lifetime a native call asks Anthropic for (docs/prompt-cache.md, "Cache lifetime").
 *
 * `promptCacheTtl: "1h"` asks for an hour on every call. Otherwise, with the `wait_cache` feature on, a session asks for an
 * hour once its calls were twice 5 to 60 minutes apart (`nextWaitCache`): the engine cannot know that the answer to a call
 * will start a long command, only that this session has waited that long before. Providers that take no `ttl` get none.
 *
 * The gaps live in this process only: a restarted daemon starts every session at 5 minutes again.
 */
export type CacheTtlPorts = {
  clock: Clock
  settings(): Pick<Settings, "promptCacheTtl">
  /** The `wait_cache` feature under the tier, the user's override and safe mode. */
  learns(): boolean
  /** The wire format of a configured provider, by the id a model call names. */
  provider(id: string): { type?: string | undefined } | undefined
}

/** Tracks kept; the one called longest ago goes first. */
const MAX_TRACKS = 512

export function createCacheTtl(ports: CacheTtlPorts) {
  /** One per prefix a session keeps warm: its own calls, and the sub-agent calls made inside it. */
  const tracks = new Map<string, WaitCacheState>()

  return {
    /** Asked once per request, just before it is sent: the call counts as made now. */
    ttlFor(input: { sessionId: SessionId; role: ModelRole; provider: string }): CacheTtl | undefined {
      const type = ports.provider(input.provider)?.type
      if (type === undefined || !CACHE_TTL_PROVIDER_TYPES.includes(type)) return undefined
      if (ports.settings().promptCacheTtl === "1h") return "1h"
      if (!ports.learns()) return undefined
      const key = `${input.sessionId}\n${input.role === "subagent" ? "subagent" : "main"}\n${input.provider}`
      const next = nextWaitCache(tracks.get(key), ports.clock.now())
      tracks.delete(key)
      tracks.set(key, next)
      if (tracks.size > MAX_TRACKS) tracks.delete(tracks.keys().next().value!)
      return next.ttl
    },
    /** Tracks held, for tests. */
    size: () => tracks.size,
  }
}
export type CacheTtlPolicy = ReturnType<typeof createCacheTtl>
