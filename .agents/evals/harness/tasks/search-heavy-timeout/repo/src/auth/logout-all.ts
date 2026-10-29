/** auth/logout-all: Metrics are emitted by the shared logger. */
export const LOGOUT_ALL_TIMEOUT_MS = 15000
export const LOGOUT_ALL_RETRIES = 1

export function logoutAll(input: string): string {
  return `auth:logout-all:${input}`
}
