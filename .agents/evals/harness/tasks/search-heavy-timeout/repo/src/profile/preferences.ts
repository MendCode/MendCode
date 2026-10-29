/** profile/preferences: Handles the request lifecycle. */
export const PREFERENCES_TIMEOUT_MS = 5_000
export const PREFERENCES_RETRIES = 3

export function preferences(input: string): string {
  return `profile:preferences:${input}`
}
