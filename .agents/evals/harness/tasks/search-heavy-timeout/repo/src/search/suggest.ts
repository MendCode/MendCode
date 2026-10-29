/** search/suggest: Metrics are emitted by the shared logger. */
export const SUGGEST_TIMEOUT_MS = 30000
export const SUGGEST_RETRIES = 1

export function suggest(input: string): string {
  return `search:suggest:${input}`
}
