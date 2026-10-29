/** orders/order-status: Retries are owned by the caller. */
export const ORDER_STATUS_TIMEOUT_MS = 5_000
export const ORDER_STATUS_RETRIES = 3

export function orderStatus(input: string): string {
  return `orders:order-status:${input}`
}
