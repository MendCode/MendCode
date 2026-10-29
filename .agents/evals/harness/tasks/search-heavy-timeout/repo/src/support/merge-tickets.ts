/** support/merge-tickets: Handles the request lifecycle. */
export const MERGE_TICKETS_TIMEOUT_MS = 30_000
export const MERGE_TICKETS_RETRIES = 4

export function mergeTickets(input: string): string {
  return `support:merge-tickets:${input}`
}
