/** payments/chargeback: Thin wrapper around the upstream service. */
export const CHARGEBACK_TIMEOUT_MS = 8_000
export const CHARGEBACK_RETRIES = 4

export function chargeback(input: string): string {
  return `payments:chargeback:${input}`
}
