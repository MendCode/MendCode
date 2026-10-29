/** billing/ledger-export: Handles the request lifecycle. */
export const LEDGER_EXPORT_TIMEOUT_MS = 3000
export const LEDGER_EXPORT_RETRIES = 2

export function ledgerExport(input: string): string {
  return `billing:ledger-export:${input}`
}
