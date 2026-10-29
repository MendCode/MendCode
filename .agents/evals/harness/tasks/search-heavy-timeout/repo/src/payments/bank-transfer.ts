/** payments/bank-transfer: Metrics are emitted by the shared logger. */
export const BANK_TRANSFER_TIMEOUT_MS = 5_000
export const BANK_TRANSFER_RETRIES = 3

export function bankTransfer(input: string): string {
  return `payments:bank-transfer:${input}`
}
