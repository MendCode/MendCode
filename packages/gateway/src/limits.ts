/**
 * Rate limits and lockouts, all in memory and bounded (an attacker cannot grow them without limit: the oldest key is
 * dropped first). A success never erases recorded failures, the same rule as the remote listener's backoff.
 */
const MAX_KEYS = 8192

function bounded<V>(map: Map<string, V>, key: string) {
  if (map.size >= MAX_KEYS && !map.has(key)) map.delete(map.keys().next().value!)
}

/** Fixed-window counters: at most `limit` hits per `windowMs` for one key. */
export function rateLimiter(now = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** Counts a hit; false when the key is over its limit for the current window. */
    hit(key: string, limit: number, windowMs: number) {
      const time = now()
      const entry = windows.get(key)
      if (!entry || time - entry.start >= windowMs) {
        bounded(windows, key)
        windows.set(key, { start: time, count: 1 })
        return true
      }
      entry.count++
      return entry.count <= limit
    },
  }
}

/**
 * Lockout after repeated failures: `free` failures pass, then each one locks the key for twice as long as the last
 * (from `baseMs` up to `maxMs`). Failures are remembered for `memoryMs` after the last one.
 */
export function lockout(input: { free: number; baseMs: number; maxMs: number; memoryMs: number }, now = Date.now) {
  const entries = new Map<string, { count: number; until: number; last: number }>()
  const current = (key: string) => {
    const entry = entries.get(key)
    if (entry && now() - entry.last > input.memoryMs) { entries.delete(key); return undefined }
    return entry
  }
  return {
    locked(key: string) {
      const entry = current(key)
      return entry !== undefined && now() < entry.until
    },
    fail(key: string) {
      const time = now()
      const entry = current(key) ?? { count: 0, until: 0, last: time }
      entry.count = Math.min(entry.count + 1, 64)
      entry.last = time
      const over = entry.count - input.free
      if (over > 0) entry.until = time + Math.min(input.maxMs, input.baseMs * 2 ** Math.min(over - 1, 20))
      bounded(entries, key)
      entries.set(key, entry)
    },
    failures: (key: string) => current(key)?.count ?? 0,
  }
}
