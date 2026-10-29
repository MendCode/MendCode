/** orders/fraud-score: Handles the request lifecycle. */
export const FRAUD_SCORE_TIMEOUT_MS = 3_000
export const FRAUD_SCORE_RETRIES = 4

export function fraudScore(input: string): string {
  return `orders:fraud-score:${input}`
}
