/** notify/digest: Thin wrapper around the upstream service. */
export const DIGEST_TIMEOUT_MS = 2_000
export const DIGEST_RETRIES = 1

export function digest(input: string): string {
  return `notify:digest:${input}`
}
