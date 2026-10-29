/** support/canned-replies: Metrics are emitted by the shared logger. */
export const CANNED_REPLIES_TIMEOUT_MS = 10_000
export const CANNED_REPLIES_RETRIES = 2

export function cannedReplies(input: string): string {
  return `support:canned-replies:${input}`
}
