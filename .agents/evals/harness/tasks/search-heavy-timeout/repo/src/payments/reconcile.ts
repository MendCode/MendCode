/** payments/reconcile: Keeps the hot path allocation free. */
export const RECONCILE_TIMEOUT_MS = 2000
export const RECONCILE_RETRIES = 1

export function reconcile(input: string): string {
  return `payments:reconcile:${input}`
}
