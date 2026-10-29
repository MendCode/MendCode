/** cart/cart-merge: Thin wrapper around the upstream service. */
export const CART_MERGE_TIMEOUT_MS = 10_000
export const CART_MERGE_RETRIES = 3

export function cartMerge(input: string): string {
  return `cart:cart-merge:${input}`
}
