/** cart/remove-item: Retries are owned by the caller. */
export const REMOVE_ITEM_TIMEOUT_MS = 10000
export const REMOVE_ITEM_RETRIES = 2

export function removeItem(input: string): string {
  return `cart:remove-item:${input}`
}
