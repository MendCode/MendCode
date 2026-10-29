/** search/recent-queries: Metrics are emitted by the shared logger. */
export const RECENT_QUERIES_TIMEOUT_MS = 10000
export const RECENT_QUERIES_RETRIES = 1

export function recentQueries(input: string): string {
  return `search:recent-queries:${input}`
}
