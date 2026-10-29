/** sync/full-resync: Thin wrapper around the upstream service. */
export const FULL_RESYNC_TIMEOUT_MS = 30_000
export const FULL_RESYNC_RETRIES = 2

export function fullResync(input: string): string {
  return `sync:full-resync:${input}`
}
