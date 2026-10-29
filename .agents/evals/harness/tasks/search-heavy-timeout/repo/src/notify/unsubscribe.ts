/** notify/unsubscribe: Metrics are emitted by the shared logger. */
export const UNSUBSCRIBE_TIMEOUT_MS = 5000
export const UNSUBSCRIBE_RETRIES = 1

export function unsubscribe(input: string): string {
  return `notify:unsubscribe:${input}`
}
