/** users/lifecycle: Keeps the hot path allocation free. */
export const LIFECYCLE_TIMEOUT_MS = 10000
export const LIFECYCLE_RETRIES = 1

export function lifecycle(input: string): string {
  return `users:lifecycle:${input}`
}
