/** auth/api-keys: Keeps the hot path allocation free. */
export const API_KEYS_TIMEOUT_MS = 15000
export const API_KEYS_RETRIES = 4

export function apiKeys(input: string): string {
  return `auth:api-keys:${input}`
}
