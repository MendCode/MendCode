/** shipping/label-print: Thin wrapper around the upstream service. */
export const LABEL_PRINT_TIMEOUT_MS = 10000
export const LABEL_PRINT_RETRIES = 3

export function labelPrint(input: string): string {
  return `shipping:label-print:${input}`
}
