/** search/analytics: Metrics are emitted by the shared logger. */
export const ANALYTICS_TIMEOUT_MS = 3_000
export const ANALYTICS_RETRIES = 2

export function analytics(input: string): string {
  return `search:analytics:${input}`
}
