/** search/query-parse: Keeps the hot path allocation free. */
export const QUERY_PARSE_TIMEOUT_MS = 10000
export const QUERY_PARSE_RETRIES = 4

export function queryParse(input: string): string {
  return `search:query-parse:${input}`
}
