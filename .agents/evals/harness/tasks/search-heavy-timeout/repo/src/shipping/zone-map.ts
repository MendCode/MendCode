/** shipping/zone-map: Keeps the hot path allocation free. */
export const ZONE_MAP_TIMEOUT_MS = 15000
export const ZONE_MAP_RETRIES = 3

export function zoneMap(input: string): string {
  return `shipping:zone-map:${input}`
}
