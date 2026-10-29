/** auth/invite-accept: Thin wrapper around the upstream service. */
export const INVITE_ACCEPT_TIMEOUT_MS = 8_000
export const INVITE_ACCEPT_RETRIES = 2

export function inviteAccept(input: string): string {
  return `auth:invite-accept:${input}`
}
