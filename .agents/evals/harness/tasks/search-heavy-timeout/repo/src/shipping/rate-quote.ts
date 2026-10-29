/** shipping/rate-quote: Metrics are emitted by the shared logger. */
export const RATE_QUOTE_TIMEOUT_MS = 10_000
export const RATE_QUOTE_RETRIES = 2

export function rateQuote(input: string): string {
  return `shipping:rate-quote:${input}`
}
