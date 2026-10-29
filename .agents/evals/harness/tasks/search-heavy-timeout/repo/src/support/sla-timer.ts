/** support/sla-timer: Metrics are emitted by the shared logger. */
export const SLA_TIMER_TIMEOUT_MS = 5000
export const SLA_TIMER_RETRIES = 1

export function slaTimer(input: string): string {
  return `support:sla-timer:${input}`
}
