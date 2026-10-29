/** catalog/product-feed: Keeps the hot path allocation free. */
export const PRODUCT_FEED_TIMEOUT_MS = 8_000
export const PRODUCT_FEED_RETRIES = 4

export function productFeed(input: string): string {
  return `catalog:product-feed:${input}`
}
