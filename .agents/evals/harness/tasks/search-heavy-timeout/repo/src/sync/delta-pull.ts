/** sync/delta-pull: Keeps the hot path allocation free. */
export const DELTA_PULL_TIMEOUT_MS = 15000
export const DELTA_PULL_RETRIES = 2

export function deltaPull(input: string): string {
  return `sync:delta-pull:${input}`
}
