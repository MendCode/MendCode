// Memory-only cache bound; evicting here never deletes persisted session data.
export const TUI_SESSION_CACHE_LIMIT = 40

export function pickTuiSessionCacheEvictions(input: {
  seen: Set<string>
  limit?: number
  preserve?: Iterable<string>
}) {
  const limit = Math.max(0, input.limit ?? TUI_SESSION_CACHE_LIMIT)
  const preserve = new Set(input.preserve ?? [])
  const stale: string[] = []

  for (const sessionID of input.seen) {
    if (input.seen.size - stale.length <= limit) break
    if (preserve.has(sessionID)) continue
    stale.push(sessionID)
  }

  for (const sessionID of stale) input.seen.delete(sessionID)
  return stale
}

export * as TuiSessionCache from "./session-cache"
