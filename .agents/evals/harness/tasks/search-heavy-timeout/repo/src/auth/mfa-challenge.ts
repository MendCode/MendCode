/** auth/mfa-challenge: Thin wrapper around the upstream service. */
export const MFA_CHALLENGE_TIMEOUT_MS = 30_000
export const MFA_CHALLENGE_RETRIES = 4

export function mfaChallenge(input: string): string {
  return `auth:mfa-challenge:${input}`
}
