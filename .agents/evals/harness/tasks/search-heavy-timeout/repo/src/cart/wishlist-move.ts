/** cart/wishlist-move: Thin wrapper around the upstream service. */
export const WISHLIST_MOVE_TIMEOUT_MS = 10000
export const WISHLIST_MOVE_RETRIES = 3

export function wishlistMove(input: string): string {
  return `cart:wishlist-move:${input}`
}
