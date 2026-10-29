import { checkpointOf, latestUserRequestContext, localRescueSummary, portableHistory, preservedTailSnapshotContext, recentOperationalContext, SUMMARY_PREFIX, type ModelMessage } from "@mendcode/engine-native"
import { featureOn, redactSecrets, type GlobalEvent, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { quotaFresh } from "@mendcode/protocol/wire"

/** Portable side checkpoint of persisted work. Never replaces live history or spends quota. */
export function createLimitCheckpoint(store: Store, now: () => number, notify: (sessionId: SessionId) => void = () => {}, subscription: (sessionId: SessionId) => boolean = () => true, enabled: () => boolean = () => true) {
  const providers = new Map(store.limitCheckpoints.tracked().map((id) => [id, store.limitCheckpoints.state(id)!.provider]))
  function save(sessionId: SessionId, provider: string, quota: Extract<GlobalEvent, { type: "quota.snapshot" }>) {
    // A deleted session took its rows with it; writing its state again would break the foreign key, inside whichever turn delivered the snapshot.
    if (!store.hasSession(sessionId)) {
      providers.delete(sessionId)
      return
    }
    // Unknown adapters and API credit/budget windows never qualify.
    if (!subscription(sessionId) || !["codex", "claude"].includes(provider) || quota.credits || !quotaFresh(quota.fetchedAt, now())) return
    const state = store.limitCheckpoints.state(sessionId) ?? { provider, used: {}, saved: [] }
    const used: typeof state.used = {}
    const candidates: string[] = []
    for (const window of quota.windows) {
      if (window.resetsAt === undefined || window.resetsAt <= now()) continue
      const key = JSON.stringify([provider, window.id, window.resetsAt])
      const previous = state.used[key]
      const burn = previous && quotaFresh(previous.at, now()) ? quota.fetchedAt > previous.at ? Math.max(0, window.usedPercent - previous.percent) : previous.burn : 0
      used[key] = { percent: window.usedPercent, at: quota.fetchedAt, burn }
      if ((window.usedPercent >= 90 || window.usedPercent + burn >= 100) && !state.saved.includes(key)) candidates.push(key)
    }
    state.used = used
    state.saved = state.saved.filter((key) => Number(JSON.parse(key)[2]) > now()).slice(-64)
    store.limitCheckpoints.track(sessionId, state)
    if (!candidates.length || !featureOn(store.settings.get(), "limit_checkpoint") || !enabled() || store.sessionInfo(sessionId)?.parentId) return
    const windowKey = JSON.stringify(candidates)
    const first = store.engineMessages.first(sessionId, "native") as ModelMessage | undefined
    const tail = store.engineMessages.tail(sessionId, "native", 24) as ModelMessage[]
    const messages = first && JSON.stringify(first) !== JSON.stringify(tail[0]) ? [first, ...tail] : tail
    if (!messages.length) return
    const portable = portableHistory(messages)
    const existing = checkpointOf(messages)
    // A compaction's preserved tail is already checkpointed; a new user turn makes it stale.
    if (existing && store.engineMessages.count(sessionId, "native") === 1 + (existing.tailMessages ?? 0)) {
      state.saved.push(...candidates)
      store.limitCheckpoints.track(sessionId, state)
      return
    }
    const previous = portable[0]?.role === "user" && portable[0].content.startsWith(SUMMARY_PREFIX) ? portable[0].content.slice(SUMMARY_PREFIX.length) : undefined
    const summary = localRescueSummary({ reason: "subscription window nearly spent", ...(previous ? { previousSummary: previous } : {}), context: [
      ...latestUserRequestContext(portable), ...recentOperationalContext(portable), ...preservedTailSnapshotContext(portable),
    ] })
    state.saved.push(...candidates)
    store.limitCheckpoints.put(sessionId, { version: 1, provider, windowKey, at: now(), checkpoint: { version: 1, generation: (existing?.generation ?? 0) + 1, method: "incremental", tailTurns: 0 }, summary: redactSecrets(summary).text.slice(0, 16_000) }, state)
    notify(sessionId)
  }
  return {
    observe(event: SessionEvent) {
      if (event.type === "usage.recorded") {
        const provider = event.provider === "chatgpt" ? "codex" : event.provider
        if (!store.hasSession(event.sessionId) || !subscription(event.sessionId) || !["codex", "claude"].includes(provider)) return
        if (providers.size >= 512 && !providers.has(event.sessionId)) providers.delete(providers.keys().next().value!)
        providers.set(event.sessionId, provider)
        const prior = store.limitCheckpoints.state(event.sessionId)
        if (prior?.provider !== provider) store.limitCheckpoints.track(event.sessionId, { provider, used: {}, saved: prior?.saved ?? [] })
      }
      if (!["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.type)) return
      const provider = providers.get(event.sessionId)
      const quota = store.latestQuota().find((snapshot) => snapshot.provider === provider)
      if (provider && quota) save(event.sessionId, provider, quota)
    },
    quota(event: GlobalEvent) {
      if (event.type !== "quota.snapshot") return
      // Snapshot only persisted history; never replace or compact a running engine's context.
      for (const [sessionId, provider] of providers) if (provider === event.provider) save(sessionId, provider, event)
    },
  }
}
