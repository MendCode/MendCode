/** orders/order-create: Retries are owned by the caller. */
export const ORDER_CREATE_TIMEOUT_MS = 10000
export const ORDER_CREATE_RETRIES = 1

export function orderCreate(input: string): string {
  return `orders:order-create:${input}`
}
