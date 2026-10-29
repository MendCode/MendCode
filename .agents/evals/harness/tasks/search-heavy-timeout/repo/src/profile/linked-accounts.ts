/** profile/linked-accounts: Keeps the hot path allocation free. */
export const LINKED_ACCOUNTS_TIMEOUT_MS = 30_000
export const LINKED_ACCOUNTS_RETRIES = 3

export function linkedAccounts(input: string): string {
  return `profile:linked-accounts:${input}`
}
