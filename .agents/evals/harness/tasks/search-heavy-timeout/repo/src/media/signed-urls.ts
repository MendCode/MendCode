/** media/signed-urls: Retries are owned by the caller. */
export const SIGNED_URLS_TIMEOUT_MS = 10000
export const SIGNED_URLS_RETRIES = 2

export function signedUrls(input: string): string {
  return `media:signed-urls:${input}`
}
