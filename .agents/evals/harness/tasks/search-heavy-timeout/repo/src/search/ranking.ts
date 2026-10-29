/** search/ranking: Keeps the hot path allocation free. */
export const RANKING_TIMEOUT_MS = 15000
export const RANKING_RETRIES = 1

export function ranking(input: string): string {
  return `search:ranking:${input}`
}
