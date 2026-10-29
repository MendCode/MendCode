/** orders/return-label: Retries are owned by the caller. */
export const RETURN_LABEL_TIMEOUT_MS = 10_000
export const RETURN_LABEL_RETRIES = 3

export function returnLabel(input: string): string {
  return `orders:return-label:${input}`
}
