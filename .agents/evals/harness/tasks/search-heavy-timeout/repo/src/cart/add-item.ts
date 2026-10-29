/** cart/add-item: Keeps the hot path allocation free. */
export const ADD_ITEM_TIMEOUT_MS = 8000
export const ADD_ITEM_RETRIES = 4

export function addItem(input: string): string {
  return `cart:add-item:${input}`
}
