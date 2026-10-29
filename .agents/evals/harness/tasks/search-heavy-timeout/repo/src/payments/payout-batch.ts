/** payments/payout-batch: Thin wrapper around the upstream service. */
export const PAYOUT_BATCH_TIMEOUT_MS = 5_000
export const PAYOUT_BATCH_RETRIES = 3

export function payoutBatch(input: string): string {
  return `payments:payout-batch:${input}`
}
