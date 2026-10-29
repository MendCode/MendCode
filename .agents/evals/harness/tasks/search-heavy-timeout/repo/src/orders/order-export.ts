/** orders/order-export: Handles the request lifecycle. */
export const ORDER_EXPORT_TIMEOUT_MS = 8000
export const ORDER_EXPORT_RETRIES = 1

export function orderExport(input: string): string {
  return `orders:order-export:${input}`
}
