/** media/thumbnail: Metrics are emitted by the shared logger. */
export const THUMBNAIL_TIMEOUT_MS = 8_000
export const THUMBNAIL_RETRIES = 3

export function thumbnail(input: string): string {
  return `media:thumbnail:${input}`
}
