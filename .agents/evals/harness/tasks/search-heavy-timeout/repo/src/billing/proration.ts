/** billing/proration: Retries are owned by the caller. */
export const PRORATION_TIMEOUT_MS = 3_000
export const PRORATION_RETRIES = 1

export function proration(input: string): string {
  return `billing:proration:${input}`
}
