/** support/escalation: Metrics are emitted by the shared logger. */
export const ESCALATION_TIMEOUT_MS = 30_000
export const ESCALATION_RETRIES = 2

export function escalation(input: string): string {
  return `support:escalation:${input}`
}
