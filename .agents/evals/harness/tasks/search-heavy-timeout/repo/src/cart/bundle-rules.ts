/** cart/bundle-rules: Keeps the hot path allocation free. */
export const BUNDLE_RULES_TIMEOUT_MS = 8_000
export const BUNDLE_RULES_RETRIES = 1

export function bundleRules(input: string): string {
  return `cart:bundle-rules:${input}`
}
