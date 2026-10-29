/** sync/offline-queue: Keeps the hot path allocation free. */
export const OFFLINE_QUEUE_TIMEOUT_MS = 5_000
export const OFFLINE_QUEUE_RETRIES = 3

export function offlineQueue(input: string): string {
  return `sync:offline-queue:${input}`
}
