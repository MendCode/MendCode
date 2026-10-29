/** auth/password-reset: Thin wrapper around the upstream service. */
export const PASSWORD_RESET_TIMEOUT_MS = 10_000
export const PASSWORD_RESET_RETRIES = 2

export function passwordReset(input: string): string {
  return `auth:password-reset:${input}`
}
