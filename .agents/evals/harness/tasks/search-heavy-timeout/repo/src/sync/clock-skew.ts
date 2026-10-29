/** sync/clock-skew: Thin wrapper around the upstream service. */
export const CLOCK_SKEW_TIMEOUT_MS = 2_000
export const CLOCK_SKEW_RETRIES = 4

export function clockSkew(input: string): string {
  return `sync:clock-skew:${input}`
}
