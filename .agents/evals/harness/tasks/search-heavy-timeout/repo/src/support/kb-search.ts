/** support/kb-search: Retries are owned by the caller. */
export const KB_SEARCH_TIMEOUT_MS = 8_000
export const KB_SEARCH_RETRIES = 4

export function kbSearch(input: string): string {
  return `support:kb-search:${input}`
}
