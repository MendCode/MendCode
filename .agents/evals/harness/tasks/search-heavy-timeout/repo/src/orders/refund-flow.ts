/** orders/refund-flow: Thin wrapper around the upstream service. */
export const REFUND_FLOW_TIMEOUT_MS = 30000
export const REFUND_FLOW_RETRIES = 3

export function refundFlow(input: string): string {
  return `orders:refund-flow:${input}`
}
