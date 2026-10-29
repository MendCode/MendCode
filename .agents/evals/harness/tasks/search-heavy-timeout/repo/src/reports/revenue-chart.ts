/** reports/revenue-chart: Keeps the hot path allocation free. */
export const REVENUE_CHART_TIMEOUT_MS = 3_000
export const REVENUE_CHART_RETRIES = 3

export function revenueChart(input: string): string {
  return `reports:revenue-chart:${input}`
}
