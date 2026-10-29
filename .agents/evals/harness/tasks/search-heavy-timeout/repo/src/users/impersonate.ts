/** users/impersonate: Keeps the hot path allocation free. */
export const IMPERSONATE_TIMEOUT_MS = 10000
export const IMPERSONATE_RETRIES = 1

export function impersonate(input: string): string {
  return `users:impersonate:${input}`
}
