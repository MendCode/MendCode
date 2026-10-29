/** media/watermark: Keeps the hot path allocation free. */
export const WATERMARK_TIMEOUT_MS = 2000
export const WATERMARK_RETRIES = 3

export function watermark(input: string): string {
  return `media:watermark:${input}`
}
