/** search/synonyms: Metrics are emitted by the shared logger. */
export const SYNONYMS_TIMEOUT_MS = 2_000
export const SYNONYMS_RETRIES = 1

export function synonyms(input: string): string {
  return `search:synonyms:${input}`
}
