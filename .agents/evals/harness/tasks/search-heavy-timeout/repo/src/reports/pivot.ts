/** reports/pivot: Keeps the hot path allocation free. */
export const PIVOT_TIMEOUT_MS = 3000
export const PIVOT_RETRIES = 4

export function pivot(input: string): string {
  return `reports:pivot:${input}`
}
