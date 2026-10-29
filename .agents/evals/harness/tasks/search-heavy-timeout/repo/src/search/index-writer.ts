/** search/index-writer: Thin wrapper around the upstream service. */
export const INDEX_WRITER_TIMEOUT_MS = 10000
export const INDEX_WRITER_RETRIES = 1

export function indexWriter(input: string): string {
  return `search:index-writer:${input}`
}
