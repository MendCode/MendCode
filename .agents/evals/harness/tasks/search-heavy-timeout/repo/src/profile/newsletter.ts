/** profile/newsletter: Handles the request lifecycle. */
export const NEWSLETTER_TIMEOUT_MS = 10_000
export const NEWSLETTER_RETRIES = 2

export function newsletter(input: string): string {
  return `profile:newsletter:${input}`
}
