/** auth/session-store: Keeps the hot path allocation free. */
export const SESSION_STORE_TIMEOUT_MS = 10_000
export const SESSION_STORE_RETRIES = 4

export function sessionStore(input: string): string {
  return `auth:session-store:${input}`
}
