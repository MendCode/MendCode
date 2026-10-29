/** billing/tax-lookup: Thin wrapper around the upstream service. */
export const TAX_LOOKUP_TIMEOUT_MS = 30000
export const TAX_LOOKUP_RETRIES = 1

export function taxLookup(input: string): string {
  return `billing:tax-lookup:${input}`
}
