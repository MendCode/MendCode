/** users/bulk-invite: Handles the request lifecycle. */
export const BULK_INVITE_TIMEOUT_MS = 2_000
export const BULK_INVITE_RETRIES = 1

export function bulkInvite(input: string): string {
  return `users:bulk-invite:${input}`
}
