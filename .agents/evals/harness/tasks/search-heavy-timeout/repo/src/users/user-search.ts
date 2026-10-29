/** users/user-search: Thin wrapper around the upstream service. */
export const USER_SEARCH_TIMEOUT_MS = 30000
export const USER_SEARCH_RETRIES = 1

export function userSearch(input: string): string {
  return `users:user-search:${input}`
}
