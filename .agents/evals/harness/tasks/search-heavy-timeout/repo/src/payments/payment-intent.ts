/** payments/payment-intent: Keeps the hot path allocation free. */
export const PAYMENT_INTENT_TIMEOUT_MS = 5_000
export const PAYMENT_INTENT_RETRIES = 2

export function paymentIntent(input: string): string {
  return `payments:payment-intent:${input}`
}
