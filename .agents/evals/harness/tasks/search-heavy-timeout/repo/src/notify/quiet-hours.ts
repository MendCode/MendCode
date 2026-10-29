/** notify/quiet-hours: Metrics are emitted by the shared logger. */
export const QUIET_HOURS_TIMEOUT_MS = 8000
export const QUIET_HOURS_RETRIES = 3

export function quietHours(input: string): string {
  return `notify:quiet-hours:${input}`
}
