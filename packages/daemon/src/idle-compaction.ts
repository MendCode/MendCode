import type { Clock, TimerHandle } from "@mendcode/kernel"
import { DEFAULT_IDLE_COMPACT_AT_TOKENS, IDLE_COMPACT_MARGIN_MS, cacheLifetime, usageContext, type CacheLifetime, type CacheTtl, type IdleCompactOffReason } from "@mendcode/protocol/wire"
import type { ContextLimits, SessionEvent, SessionId, Settings } from "@mendcode/protocol"

/**
 * Compaction while idle, before the provider's prompt cache expires (docs/compaction.md, "Compaction while idle").
 *
 * A provider keeps a prompt prefix for a few minutes after the last call. A large session left idle past that pays the full input
 * price for its whole context on the next message. One compaction just before the cache expires reads the context at the cached
 * price one last time and leaves a small one, so the expiry stops mattering. Nothing is pinged to keep a cache warm.
 *
 * One timer per session, set at the session's last main model call (`usage.recorded` with `compactAt`) and living only in this
 * process: a restarted daemon schedules nothing until the session's next call. Every condition is checked again when the timer fires.
 */
export type IdleCompactionStatus = NonNullable<ContextLimits["idleCompaction"]>

export type IdleCompactionPorts = {
  clock: Clock
  /** The `idle_compact` feature under the tier, the user's override and safe mode. */
  enabled(): boolean
  settings(): Pick<Settings, "compaction" | "idleCompactAtTokens" | "cacheLifetimeMinutes">
  /** The wire format and host of a configured provider, by the id a `usage.recorded` names. */
  provider(id: string): { type?: string | undefined; baseUrl?: string | undefined } | undefined
  /** MendCode packs this session's history itself: the native engine, not Claude Code, Codex, pi or an ACP agent. */
  packs(sessionId: SessionId): boolean
  /** A sub-agent's or a workflow's own session: it is not resumed by a person. */
  child(sessionId: SessionId): boolean
  /** No running turn, nothing queued, no pending approval or question, no background task whose notice is expected. */
  idle(sessionId: SessionId): boolean
  /** Starts the compaction when the session is still free; false when something else got there first. */
  compact(sessionId: SessionId): Promise<boolean>
}

type Entry = {
  provider: string
  /** The lifetime that call asked for and got (`promptCacheTtl`, `wait_cache`): an hour instead of the provider's default. */
  ttl?: CacheTtl | undefined
  tokens: number
  /** When the provider received the session's last main call: its lifetime counts from here. */
  callAt: number
  state: "armed" | "fired" | "packed" | "expired"
  timer?: TimerHandle | undefined
  fireAt?: number | undefined
}

/** Entries without a timer are only kept to answer `status`; the oldest go first. */
const MAX_ENTRIES = 512
const TURN_ENDS = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"])

/** When the compaction starts: the margin before the expiry, or half the lifetime when the lifetime is shorter than two margins. */
export const idleCompactFireAt = (callAt: number, lifetimeMs: number) => callAt + Math.max(lifetimeMs - IDLE_COMPACT_MARGIN_MS, Math.floor(lifetimeMs / 2))

export function createIdleCompaction(ports: IdleCompactionPorts) {
  const { clock } = ports
  const entries = new Map<SessionId, Entry>()
  /** Sessions with a compaction in progress: its own model calls are not the session's "last call". */
  const compacting = new Set<SessionId>()

  const atTokens = () => ports.settings().idleCompactAtTokens ?? DEFAULT_IDLE_COMPACT_AT_TOKENS
  const lifetimeOf = (entry: Pick<Entry, "provider" | "ttl">): CacheLifetime | undefined => cacheLifetime({ provider: entry.provider, ...ports.provider(entry.provider), overrides: ports.settings().cacheLifetimeMinutes, ttl: entry.ttl })

  function disarm(entry: Entry | undefined) {
    entry?.timer?.cancel()
    if (entry) { entry.timer = undefined; entry.fireAt = undefined }
  }

  /** Why the session may not be compacted while idle right now; undefined when everything holds. */
  function blocked(sessionId: SessionId, entry: Entry | undefined): IdleCompactOffReason | undefined {
    if (!ports.enabled()) return "feature-off"
    const { compaction } = ports.settings()
    if (compaction?.auto === false) return "auto-off"
    if (compaction?.strategy === "native") return "native-strategy"
    if (!ports.packs(sessionId)) return "engine-managed"
    if (ports.child(sessionId)) return "child-session"
    if (!entry) return "no-call"
    if (entry.state === "packed" || entry.state === "fired") return "already-compacted"
    if (entry.state === "expired") return "cache-expired"
    if (entry.tokens < atTokens()) return "below-threshold"
    const lifetime = lifetimeOf(entry)
    if (!lifetime) return "unknown-lifetime"
    if (clock.now() >= entry.callAt + lifetime.ms) return "cache-expired"
    if (compacting.has(sessionId) || !ports.idle(sessionId)) return "busy"
    return undefined
  }

  function arm(sessionId: SessionId, entry: Entry) {
    disarm(entry)
    const lifetime = lifetimeOf(entry)
    // An unknown lifetime never becomes a guessed time: no timer at all.
    if (!lifetime) return
    const fireAt = idleCompactFireAt(entry.callAt, lifetime.ms)
    entry.fireAt = fireAt
    entry.timer = clock.setTimer(Math.max(0, fireAt - clock.now()), () => fire(sessionId, entry))
    // Never the reason the process stays alive.
    entry.timer.unref?.()
  }

  function fire(sessionId: SessionId, entry: Entry) {
    entry.timer = undefined
    entry.fireAt = undefined
    if (entries.get(sessionId) !== entry || entry.state !== "armed") return
    // The lifetime was raised since the timer was set (`cacheLifetimeMinutes`): not yet.
    const lifetime = lifetimeOf(entry)
    if (lifetime && clock.now() < idleCompactFireAt(entry.callAt, lifetime.ms)) return arm(sessionId, entry)
    const reason = blocked(sessionId, entry)
    // The machine slept past the expiry (or the timer was late): the cache is gone, a compaction now would read at the full price.
    if (reason === "cache-expired") return void (entry.state = "expired")
    // Busy sessions get another chance when their turn ends (`observe`); every other reason stands until the next call.
    if (reason) return
    entry.state = "fired"
    void ports.compact(sessionId).then((started) => { if (!started && entry.state === "fired") entry.state = "armed" }, () => {})
  }

  function remember(sessionId: SessionId, entry: Entry) {
    entries.delete(sessionId)
    entries.set(sessionId, entry)
    if (entries.size <= MAX_ENTRIES) return
    for (const [id, old] of entries) {
      if (entries.size <= MAX_ENTRIES) break
      if (!old.timer) entries.delete(id)
    }
  }

  return {
    observe(event: SessionEvent) {
      const sessionId = event.sessionId
      if (event.type === "usage.recorded") {
        // A compaction's own calls are not a "last call".
        if (compacting.has(sessionId)) return
        // Only a main call of a history MendCode packs carries `compactAt`. Any other call in the session (plan mode, a sub-agent)
        // means the recorded call is no longer its latest request: nothing is scheduled from it until the next main call.
        if (event.compactAt === undefined) {
          const stale = entries.get(sessionId)
          if (stale?.state === "armed") { disarm(stale); entries.delete(sessionId) }
          return
        }
        disarm(entries.get(sessionId))
        const entry: Entry = { provider: event.provider, ...(event.cacheTtl ? { ttl: event.cacheTtl } : {}), tokens: usageContext(event) ?? 0, callAt: event.at - (event.profile?.durationMs ?? 0), state: "armed" }
        remember(sessionId, entry)
        return arm(sessionId, entry)
      }
      const entry = entries.get(sessionId)
      if (event.type === "compaction.updated") {
        if (event.state === "writing") { compacting.add(sessionId); return disarm(entry) }
        compacting.delete(sessionId)
        // Packed by any compaction: nothing is left to save until the session's next call.
        if (event.state === "packed" && entry) entry.state = "packed"
        return
      }
      // A message or a turn before it fires cancels it; the turn's own call sets the next one.
      if (event.type === "queue.added" || event.type === "turn.started") return disarm(entry)
      // A turn that made no model call (a `!command`, a cancel before the first call) left the cache as it was.
      if (TURN_ENDS.has(event.type) && entry?.state === "armed" && !entry.timer) queueMicrotask(() => { if (entries.get(sessionId) === entry && entry.state === "armed" && !entry.timer && !blocked(sessionId, entry)) arm(sessionId, entry) })
    },
    /** Whether a compaction while idle is scheduled for the session and when, or why not. */
    status(sessionId: SessionId): IdleCompactionStatus {
      const entry = entries.get(sessionId)
      const lifetime = entry ? lifetimeOf(entry) : undefined
      const facts = { atTokens: atTokens(), ...(entry ? { provider: entry.provider } : {}), ...(lifetime ? { lifetimeMinutes: lifetime.ms / 60_000, lifetimeSource: lifetime.source } : {}) }
      const reason = blocked(sessionId, entry)
      if (reason) return { scheduled: false, reason, ...facts }
      // The timer follows the settings in force: a lifetime stated or changed after the call moves it.
      if (entry && lifetime && entry.fireAt !== idleCompactFireAt(entry.callAt, lifetime.ms)) arm(sessionId, entry)
      if (entry?.fireAt === undefined) return { scheduled: false, reason: "no-call", ...facts }
      return { scheduled: true, at: entry.fireAt, ...facts }
    },
    /** Pending timers, for tests. */
    pending: () => [...entries.values()].filter((entry) => entry.timer).length,
    dispose() {
      for (const entry of entries.values()) disarm(entry)
      entries.clear()
      compacting.clear()
    },
  }
}
export type IdleCompaction = ReturnType<typeof createIdleCompaction>
