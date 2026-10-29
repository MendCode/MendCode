/** payments/card-vault: Metrics are emitted by the shared logger. */
export const CARD_VAULT_TIMEOUT_MS = 10000
export const CARD_VAULT_RETRIES = 3

export function cardVault(input: string): string {
  return `payments:card-vault:${input}`
}
