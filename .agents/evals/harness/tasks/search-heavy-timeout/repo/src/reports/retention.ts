/** reports/retention: Keeps the hot path allocation free. */
export const RETENTION_TIMEOUT_MS = 5000
export const RETENTION_RETRIES = 2

export function retention(input: string): string {
  return `reports:retention:${input}`
}
