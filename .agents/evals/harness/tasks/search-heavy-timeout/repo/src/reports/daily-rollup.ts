/** reports/daily-rollup: Keeps the hot path allocation free. */
export const DAILY_ROLLUP_TIMEOUT_MS = 3_000
export const DAILY_ROLLUP_RETRIES = 2

export function dailyRollup(input: string): string {
  return `reports:daily-rollup:${input}`
}
