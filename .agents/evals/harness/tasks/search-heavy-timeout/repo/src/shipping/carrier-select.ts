/** shipping/carrier-select: Keeps the hot path allocation free. */
export const CARRIER_SELECT_TIMEOUT_MS = 10_000
export const CARRIER_SELECT_RETRIES = 3

export function carrierSelect(input: string): string {
  return `shipping:carrier-select:${input}`
}
