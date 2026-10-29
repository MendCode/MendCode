/** search/filters: Keeps the hot path allocation free. */
export const FILTERS_TIMEOUT_MS = 10_000
export const FILTERS_RETRIES = 3

export function filters(input: string): string {
  return `search:filters:${input}`
}
