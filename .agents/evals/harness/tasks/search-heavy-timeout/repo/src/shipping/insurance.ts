/** shipping/insurance: Retries are owned by the caller. */
export const INSURANCE_TIMEOUT_MS = 10_000
export const INSURANCE_RETRIES = 2

export function insurance(input: string): string {
  return `shipping:insurance:${input}`
}
