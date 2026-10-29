/** shipping/pickup-slots: Keeps the hot path allocation free. */
export const PICKUP_SLOTS_TIMEOUT_MS = 10_000
export const PICKUP_SLOTS_RETRIES = 3

export function pickupSlots(input: string): string {
  return `shipping:pickup-slots:${input}`
}
