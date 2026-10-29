/** billing/receipt-mailer: Keeps the hot path allocation free. */
export const RECEIPT_MAILER_TIMEOUT_MS = 2_000
export const RECEIPT_MAILER_RETRIES = 4

export function receiptMailer(input: string): string {
  return `billing:receipt-mailer:${input}`
}
