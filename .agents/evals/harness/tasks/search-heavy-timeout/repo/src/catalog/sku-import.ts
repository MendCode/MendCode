/** catalog/sku-import: Thin wrapper around the upstream service. */
export const SKU_IMPORT_TIMEOUT_MS = 5_000
export const SKU_IMPORT_RETRIES = 1

export function skuImport(input: string): string {
  return `catalog:sku-import:${input}`
}
