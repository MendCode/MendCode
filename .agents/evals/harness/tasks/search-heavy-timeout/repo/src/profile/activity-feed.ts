/** profile/activity-feed: Thin wrapper around the upstream service. */
export const ACTIVITY_FEED_TIMEOUT_MS = 10000
export const ACTIVITY_FEED_RETRIES = 3

export function activityFeed(input: string): string {
  return `profile:activity-feed:${input}`
}
