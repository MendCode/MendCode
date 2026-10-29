/** reports/cohort: Metrics are emitted by the shared logger. */
export const COHORT_TIMEOUT_MS = 10_000
export const COHORT_RETRIES = 4

export function cohort(input: string): string {
  return `reports:cohort:${input}`
}
