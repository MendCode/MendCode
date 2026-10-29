/** auth/token-refresh: Handles the request lifecycle. */
export const TOKEN_REFRESH_TIMEOUT_MS = 10000
export const TOKEN_REFRESH_RETRIES = 4

export function tokenRefresh(input: string): string {
  return `auth:token-refresh:${input}`
}
