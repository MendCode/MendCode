/** media/virus-scan: Keeps the hot path allocation free. */
export const VIRUS_SCAN_TIMEOUT_MS = 30000
export const VIRUS_SCAN_RETRIES = 2

export function virusScan(input: string): string {
  return `media:virus-scan:${input}`
}
