/** orders/split-order: Keeps the hot path allocation free. */
export const SPLIT_ORDER_TIMEOUT_MS = 10_000
export const SPLIT_ORDER_RETRIES = 3

export function splitOrder(input: string): string {
  return `orders:split-order:${input}`
}
