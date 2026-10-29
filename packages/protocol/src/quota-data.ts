/** Quota readings are observations, not live balances. Shared without loading schemas. */
export const QUOTA_MAX_AGE_MS = 15 * 60_000
export function quotaFresh(fetchedAt: number, now: number) {
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt <= QUOTA_MAX_AGE_MS
}

/** What a quota snapshot must carry to be read (the shape of the `quota.snapshot` event, without loading its schema). */
export type QuotaSnapshotLike = Readonly<{
  provider: string
  windows: ReadonlyArray<Readonly<{ id: string; label: string; usedPercent: number; resetsAt?: number | undefined; windowMinutes?: number | undefined }>>
  fetchedAt: number
  source: string
}>

/**
 * One provider window as MendCode last observed it. Percentages are whole and clamped to 0..100. A window the provider never reported is
 * not listed at all, so a missing entry means unknown, never 0 or 100. `stale` is true when the observation is older than
 * `QUOTA_MAX_AGE_MS` or the window it belongs to has already reset: the numbers then describe the past and `ageMs` says how far.
 */
export type QuotaReading = Readonly<{
  provider: string
  /** The window's label as the provider names its length: `5h`, `7d`. */
  window: string
  windowId: string
  windowMinutes?: number
  usedPercent: number
  leftPercent: number
  /** Epoch ms the window resets, when the provider said. */
  resetsAt?: number
  /** Epoch ms of the response or event that carried the numbers. */
  observedAt: number
  ageMs: number
  stale: boolean
  source: string
}>

/** The readings of every window of every snapshot, in the order given. */
export function quotaReadings(snapshots: readonly QuotaSnapshotLike[], now: number): QuotaReading[] {
  return snapshots.flatMap((snapshot) => snapshot.windows.map((window): QuotaReading => {
    const used = Math.round(Math.min(100, Math.max(0, window.usedPercent)))
    const ended = window.resetsAt !== undefined && window.resetsAt <= now
    return {
      provider: snapshot.provider,
      window: window.label,
      windowId: window.id,
      ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
      usedPercent: used,
      leftPercent: 100 - used,
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      observedAt: snapshot.fetchedAt,
      ageMs: Math.max(0, now - snapshot.fetchedAt),
      stale: ended || !quotaFresh(snapshot.fetchedAt, now),
      source: snapshot.source,
    }
  }))
}

/** A span of time in its two largest units, as short as it reads: `5d11h`, `3h20m`, `45m`, `<1m`. */
export function shortSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return "<1m"
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60
  if (days) return `${days}d${hours ? `${hours}h` : ""}`
  if (hours) return `${hours}h${rest ? `${rest}m` : ""}`
  return `${rest}m`
}
