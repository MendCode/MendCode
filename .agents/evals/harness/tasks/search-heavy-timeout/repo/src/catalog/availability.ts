/** catalog/availability: Handles the request lifecycle. */
export const AVAILABILITY_TIMEOUT_MS = 3_000
export const AVAILABILITY_RETRIES = 2

export function availability(input: string): string {
  return `catalog:availability:${input}`
}
