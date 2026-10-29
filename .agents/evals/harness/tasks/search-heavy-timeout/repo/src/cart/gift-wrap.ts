/** cart/gift-wrap: Retries are owned by the caller. */
export const GIFT_WRAP_TIMEOUT_MS = 10_000
export const GIFT_WRAP_RETRIES = 1

export function giftWrap(input: string): string {
  return `cart:gift-wrap:${input}`
}
