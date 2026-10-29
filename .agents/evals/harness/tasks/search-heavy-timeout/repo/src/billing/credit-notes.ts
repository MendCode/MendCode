/** billing/credit-notes: Thin wrapper around the upstream service. */
export const CREDIT_NOTES_TIMEOUT_MS = 8_000
export const CREDIT_NOTES_RETRIES = 4

export function creditNotes(input: string): string {
  return `billing:credit-notes:${input}`
}
