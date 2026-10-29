/** catalog/price-rules: Handles the request lifecycle. */
export const PRICE_RULES_TIMEOUT_MS = 10_000
export const PRICE_RULES_RETRIES = 3

export function priceRules(input: string): string {
  return `catalog:price-rules:${input}`
}
