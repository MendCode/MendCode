/** sync/tombstones: Retries are owned by the caller. */
export const TOMBSTONES_TIMEOUT_MS = 2000
export const TOMBSTONES_RETRIES = 1

export function tombstones(input: string): string {
  return `sync:tombstones:${input}`
}
