/** reports/funnel: Retries are owned by the caller. */
export const FUNNEL_TIMEOUT_MS = 10_000
export const FUNNEL_RETRIES = 4

export function funnel(input: string): string {
  return `reports:funnel:${input}`
}
