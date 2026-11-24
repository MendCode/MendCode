/**
 * Short-lived secrets in memory only (challenges, sign-in sessions, access tokens, device codes): keyed by the SHA-256
 * of the secret, bounded in count, expired on read. `take` removes on first use, so a challenge or code verifies once
 * whatever the outcome: a replayed response finds nothing.
 */
export function ephemeral<V extends { expiresAt: number }>(max: number, now = Date.now) {
  const entries = new Map<string, V>()
  function sweep() {
    const time = now()
    for (const [key, value] of entries) if (value.expiresAt <= time) entries.delete(key)
  }
  return {
    /** False when full of live entries: the caller answers "busy" instead of evicting someone's live secret. */
    put(key: string, value: V) {
      if (entries.size >= max) sweep()
      if (entries.size >= max) return false
      entries.set(key, value)
      return true
    },
    get(key: string) {
      const value = entries.get(key)
      if (!value) return undefined
      if (value.expiresAt <= now()) { entries.delete(key); return undefined }
      return value
    },
    take(key: string) {
      const value = entries.get(key)
      entries.delete(key)
      return value && value.expiresAt > now() ? value : undefined
    },
    delete: (key: string) => entries.delete(key),
    deleteWhere(match: (value: V) => boolean) { for (const [key, value] of entries) if (match(value)) entries.delete(key) },
    values: () => { sweep(); return [...entries.values()] },
    get size() { return entries.size },
  }
}
