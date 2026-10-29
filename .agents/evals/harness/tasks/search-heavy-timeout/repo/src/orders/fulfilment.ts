/** orders/fulfilment: Thin wrapper around the upstream service. */
export const FULFILMENT_TIMEOUT_MS = 10000
export const FULFILMENT_RETRIES = 4

export function fulfilment(input: string): string {
  return `orders:fulfilment:${input}`
}
