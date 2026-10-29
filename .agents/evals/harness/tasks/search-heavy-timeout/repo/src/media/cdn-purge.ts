/** media/cdn-purge: Retries are owned by the caller. */
export const CDN_PURGE_TIMEOUT_MS = 10_000
export const CDN_PURGE_RETRIES = 4

export function cdnPurge(input: string): string {
  return `media:cdn-purge:${input}`
}
