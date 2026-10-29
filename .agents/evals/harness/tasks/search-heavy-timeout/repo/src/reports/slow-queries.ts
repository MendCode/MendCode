/** reports/slow-queries: Metrics are emitted by the shared logger. */
export const SLOW_QUERIES_TIMEOUT_MS = 10000
export const SLOW_QUERIES_RETRIES = 1

export function slowQueries(input: string): string {
  return `reports:slow-queries:${input}`
}
