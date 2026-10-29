/** users/seat-count: Retries are owned by the caller. */
export const SEAT_COUNT_TIMEOUT_MS = 10_000
export const SEAT_COUNT_RETRIES = 4

export function seatCount(input: string): string {
  return `users:seat-count:${input}`
}
