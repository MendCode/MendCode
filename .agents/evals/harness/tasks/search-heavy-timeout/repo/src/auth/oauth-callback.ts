/** auth/oauth-callback: Keeps the hot path allocation free. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 3_000
export const OAUTH_CALLBACK_RETRIES = 3

export function oauthCallback(input: string): string {
  return `auth:oauth-callback:${input}`
}
