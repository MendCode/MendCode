/** orders/reorder: Metrics are emitted by the shared logger. */
export const REORDER_TIMEOUT_MS = 5_000
export const REORDER_RETRIES = 2

export function reorder(input: string): string {
  return `orders:reorder:${input}`
}
