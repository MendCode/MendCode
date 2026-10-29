/** cart/stock-hold: Handles the request lifecycle. */
export const STOCK_HOLD_TIMEOUT_MS = 30000
export const STOCK_HOLD_RETRIES = 2

export function stockHold(input: string): string {
  return `cart:stock-hold:${input}`
}
