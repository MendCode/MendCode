/** search/result-cache: Retries are owned by the caller. */
export const RESULT_CACHE_TIMEOUT_MS = 10000
export const RESULT_CACHE_RETRIES = 1

export function resultCache(input: string): string {
  return `search:result-cache:${input}`
}
