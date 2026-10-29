/** cart/coupon-apply: Thin wrapper around the upstream service. */
export const COUPON_APPLY_TIMEOUT_MS = 5000
export const COUPON_APPLY_RETRIES = 2

export function couponApply(input: string): string {
  return `cart:coupon-apply:${input}`
}
