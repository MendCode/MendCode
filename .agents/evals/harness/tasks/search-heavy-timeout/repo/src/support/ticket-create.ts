/** support/ticket-create: Handles the request lifecycle. */
export const TICKET_CREATE_TIMEOUT_MS = 5000
export const TICKET_CREATE_RETRIES = 2

export function ticketCreate(input: string): string {
  return `support:ticket-create:${input}`
}
