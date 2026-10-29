import type { Clock, GlobalEventDraft, TimerHandle } from "@mendcode/kernel"
import { redactSecrets } from "@mendcode/protocol"
import { quotaRefreshIntervalMs, type QuotaRefreshEntry, type QuotaRefreshProvider } from "@mendcode/protocol/wire"

/**
 * The quota refresh probe's schedule (docs/usage-limit.md, "Quota refresh"). A provider's windows are known only when a turn on it ran,
 * so on a session that uses another provider they age. For each provider the user listed in `quotaRefresh`, the daemon sends one
 * probe now and then, through the same engine path that already yields that provider's quota. This module decides only WHEN: it
 * never reads a credential and never sends anything itself; a probe is a function handed in. Off (no entries) it does nothing at all.
 */

/** Asks the provider for its windows; resolves once a quota snapshot was reported, rejects with why not. */
export type RefreshProbe = (input: { model?: string; signal: AbortSignal; report(snapshot: Extract<GlobalEventDraft, { type: "quota.snapshot" }>): void }) => Promise<void>

export type QuotaRefreshOptions = {
  clock: Clock
  /** What the user listed; empty when the setting is unset, the feature is off or safe mode is on. Read on every tick. */
  entries(): readonly QuotaRefreshEntry[]
  /** A terminal is attached or a turn is running: an idle daemon with nobody looking sends nothing. */
  active(): boolean
  /** The provider's latest reading from any source (a real turn or an earlier probe), when MendCode has one. */
  latest(provider: QuotaRefreshProvider): { fetchedAt: number } | undefined
  /** The provider is at a usage limit now: probing would only be refused, and the pause owns the wait. */
  limited(provider: QuotaRefreshProvider): boolean
  probes: Partial<Record<QuotaRefreshProvider, RefreshProbe>>
  /** Stores and broadcasts a snapshot a probe reported, like any quota the engines emit. */
  report(snapshot: Extract<GlobalEventDraft, { type: "quota.snapshot" }>): void
  /** One line for the user (a toast in every terminal). */
  notify(text: string): void
  /** 0..1, for jitter; Math.random when absent. */
  random?(): number
  /** How often the schedule looks; 30 s when absent. */
  tickMs?: number
  /** Consecutive failures that stop a provider; 3 when absent. */
  maxFailures?: number
}

export type RefreshStatus = {
  provider: QuotaRefreshProvider
  everyMinutes: number
  model?: string
  /** `on`: scheduled; `waiting`: nothing to do until a terminal is attached or the limit ends; `stopped`: failed too often. */
  state: "on" | "waiting" | "stopped"
  lastProbeAt?: number
  /** Probes sent since local midnight, counted apart from the session's own usage. */
  probesToday: number
  lastError?: string
}

type State = { signature: string; nextAt?: number; failures: number; stopped?: string; running?: AbortController; lastProbeAt?: number; day: string; today: number; lastError?: string }

/** A probe that gets no answer in this long is abandoned and counts as a failure. */
const PROBE_TIMEOUT_MS = 90_000
const BACKOFF_CAP_MS = 6 * 3_600_000
/** The next probe lands within ±10% of the interval, so several terminals' daemons do not ask on the same second. */
const JITTER = 0.1
const MESSAGE_CHARS = 160

/** A provider at its limit: a window that is spent, or reported as rejected, and has not reset yet. Probing it would only be refused. */
export function windowsSpent(snapshot: { status?: string | undefined; windows: readonly { usedPercent: number; resetsAt?: number | undefined }[] }, now: number): boolean {
  const open = (window: { resetsAt?: number | undefined }) => window.resetsAt === undefined || window.resetsAt > now
  return snapshot.windows.some((window) => open(window) && (window.usedPercent >= 100 || snapshot.status === "rejected"))
}

const dayOf = (now: number) => new Date(now).toDateString()
const cleaned = (error: unknown) => redactSecrets((error instanceof Error ? error.message : String(error)).replace(/^\[[A-Z]+\]:\s*/, "").replace(/\s+/g, " ")).text.slice(0, MESSAGE_CHARS)

export function createQuotaRefresh(options: QuotaRefreshOptions) {
  const { clock } = options
  const random = options.random ?? Math.random
  const maxFailures = options.maxFailures ?? 3
  const states = new Map<QuotaRefreshProvider, State>()
  let timer: TimerHandle | undefined
  let stopped = false

  const jittered = (ms: number) => Math.round(ms * (1 + (random() * 2 - 1) * JITTER))
  const stateOf = (entry: QuotaRefreshEntry): State => {
    const signature = `${quotaRefreshIntervalMs(entry)}:${entry.model ?? ""}`
    let state = states.get(entry.provider)
    // Editing the entry starts it afresh, including after it stopped.
    if (!state || state.signature !== signature) {
      state = { signature, failures: 0, day: dayOf(clock.now()), today: state?.today ?? 0, ...(state?.lastProbeAt !== undefined ? { lastProbeAt: state.lastProbeAt } : {}) }
      states.set(entry.provider, state)
    }
    return state
  }

  async function run(entry: QuotaRefreshEntry, state: State) {
    const probe = options.probes[entry.provider]
    const interval = quotaRefreshIntervalMs(entry)
    if (!probe) return
    const abort = new AbortController()
    state.running = abort
    const deadline = clock.setTimer(PROBE_TIMEOUT_MS, () => abort.abort())
    const sentAt = clock.now()
    try {
      await Promise.race([
        probe({ ...(entry.model ? { model: entry.model } : {}), signal: abort.signal, report: options.report }),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("the probe timed out")), { once: true })),
      ])
      const now = clock.now()
      if (state.day !== dayOf(now)) { state.day = dayOf(now); state.today = 0 }
      state.today += 1
      state.lastProbeAt = now
      state.failures = 0
      delete state.lastError
      state.nextAt = now + jittered(interval)
    } catch (error) {
      if (stopped) return
      state.failures += 1
      state.lastError = cleaned(error)
      const now = clock.now()
      // A failed probe may still have been sent: it counts, like a spent one.
      if (state.day !== dayOf(now)) { state.day = dayOf(now); state.today = 0 }
      state.today += 1
      state.lastProbeAt = sentAt
      if (state.failures >= maxFailures) {
        state.stopped = state.lastError
        options.notify(`quota refresh for ${entry.provider} stopped after ${state.failures} failed probes (${state.lastError}); edit quotaRefresh to start it again`)
      } else state.nextAt = now + jittered(Math.min(BACKOFF_CAP_MS, interval * 2 ** state.failures))
    } finally {
      deadline.cancel()
      delete state.running
    }
  }

  /** One look at every listed provider: sends at most one probe each, and none when nothing is due. */
  async function tick(): Promise<void> {
    const entries = options.entries()
    for (const provider of [...states.keys()]) if (!entries.some((entry) => entry.provider === provider)) states.delete(provider)
    if (entries.length === 0 || !options.active()) return
    await Promise.all(entries.map(async (entry) => {
      const state = stateOf(entry)
      if (state.stopped || state.running || options.limited(entry.provider)) return
      if (!options.probes[entry.provider]) {
        // Never a silent "on": an engine with no way to ask this provider says so once and stays stopped until the entry changes.
        state.stopped = `this daemon has no ${entry.provider} probe`
        options.notify(`quota refresh for ${entry.provider} cannot run: ${state.stopped}`)
        return
      }
      const now = clock.now()
      const interval = quotaRefreshIntervalMs(entry)
      // A reading from a real turn (or from the last probe) newer than the interval is as good as a probe: wait out its interval.
      const latest = options.latest(entry.provider)
      if (latest && now - latest.fetchedAt < interval) {
        state.nextAt = Math.max(state.nextAt ?? 0, latest.fetchedAt + jittered(interval))
        return
      }
      if (state.nextAt === undefined) state.nextAt = now + Math.round(random() * Math.min(30_000, interval / 4))
      if (now < state.nextAt) return
      await run(entry, state)
    }))
  }

  function arm() {
    if (stopped) return
    timer = clock.setTimer(options.tickMs ?? 30_000, () => {
      void tick().finally(arm)
    })
  }

  return {
    tick,
    /** Starts the schedule's own timer; the daemon calls it once. */
    start() {
      if (!timer && !stopped) arm()
    },
    stop() {
      stopped = true
      timer?.cancel()
      for (const state of states.values()) state.running?.abort()
    },
    /** What the `usage` card shows per listed provider: on or off, the interval, the last probe and the day's count. */
    status(): RefreshStatus[] {
      const now = clock.now()
      return options.entries().map((entry) => {
        const state = states.get(entry.provider)
        const today = state && state.day === dayOf(now) ? state.today : 0
        return {
          provider: entry.provider,
          everyMinutes: quotaRefreshIntervalMs(entry) / 60_000,
          ...(entry.model ? { model: entry.model } : {}),
          state: state?.stopped ? "stopped" : !options.active() || options.limited(entry.provider) ? "waiting" : "on",
          ...(state?.lastProbeAt !== undefined ? { lastProbeAt: state.lastProbeAt } : {}),
          probesToday: today,
          ...(state?.stopped ?? state?.lastError ? { lastError: state?.stopped ?? state?.lastError } : {}),
        } as RefreshStatus
      })
    },
  }
}
