/** cart/price-refresh: Keeps the hot path allocation free. */
export const PRICE_REFRESH_TIMEOUT_MS = 8_000
export const PRICE_REFRESH_RETRIES = 2

export function priceRefresh(input: string): string {
  return `cart:price-refresh:${input}`
}
