/** shipping/tracking-poll: Retries are owned by the caller. */
export const TRACKING_POLL_TIMEOUT_MS = 10_000
export const TRACKING_POLL_RETRIES = 3

export function trackingPoll(input: string): string {
  return `shipping:tracking-poll:${input}`
}
