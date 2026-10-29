/** notify/channel-prefs: Thin wrapper around the upstream service. */
export const CHANNEL_PREFS_TIMEOUT_MS = 5000
export const CHANNEL_PREFS_RETRIES = 1

export function channelPrefs(input: string): string {
  return `notify:channel-prefs:${input}`
}
