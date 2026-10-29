/** billing/usage-meter: Handles the request lifecycle. */
export const USAGE_METER_TIMEOUT_MS = 15000
export const USAGE_METER_RETRIES = 4

export function usageMeter(input: string): string {
  return `billing:usage-meter:${input}`
}
