/** billing/invoice-pdf: Keeps the hot path allocation free. */
export const INVOICE_PDF_TIMEOUT_MS = 5000
export const INVOICE_PDF_RETRIES = 2

export function invoicePdf(input: string): string {
  return `billing:invoice-pdf:${input}`
}
