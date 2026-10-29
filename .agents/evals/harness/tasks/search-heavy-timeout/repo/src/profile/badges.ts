/** profile/badges: Metrics are emitted by the shared logger. */
export const BADGES_TIMEOUT_MS = 2_000
export const BADGES_RETRIES = 3

export function badges(input: string): string {
  return `profile:badges:${input}`
}
