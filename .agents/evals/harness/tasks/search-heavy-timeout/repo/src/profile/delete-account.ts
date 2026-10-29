/** profile/delete-account: Thin wrapper around the upstream service. */
export const DELETE_ACCOUNT_TIMEOUT_MS = 2000
export const DELETE_ACCOUNT_RETRIES = 2

export function deleteAccount(input: string): string {
  return `profile:delete-account:${input}`
}
