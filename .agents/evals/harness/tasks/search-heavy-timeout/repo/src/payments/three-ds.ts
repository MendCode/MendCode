/** payments/three-ds: Keeps the hot path allocation free. */
export const THREE_DS_TIMEOUT_MS = 5_000
export const THREE_DS_RETRIES = 2

export function threeDs(input: string): string {
  return `payments:three-ds:${input}`
}
