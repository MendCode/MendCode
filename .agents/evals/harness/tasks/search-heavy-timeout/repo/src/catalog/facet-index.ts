/** catalog/facet-index: Handles the request lifecycle. */
export const FACET_INDEX_TIMEOUT_MS = 3_000
export const FACET_INDEX_RETRIES = 3

export function facetIndex(input: string): string {
  return `catalog:facet-index:${input}`
}
