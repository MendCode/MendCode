/** billing/vat-validate: Metrics are emitted by the shared logger. */
export const VAT_VALIDATE_TIMEOUT_MS = 10_000
export const VAT_VALIDATE_RETRIES = 2

export function vatValidate(input: string): string {
  return `billing:vat-validate:${input}`
}
