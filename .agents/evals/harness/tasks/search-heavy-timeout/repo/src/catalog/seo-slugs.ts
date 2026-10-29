/** catalog/seo-slugs: Thin wrapper around the upstream service. */
export const SEO_SLUGS_TIMEOUT_MS = 8_000
export const SEO_SLUGS_RETRIES = 2

export function seoSlugs(input: string): string {
  return `catalog:seo-slugs:${input}`
}
