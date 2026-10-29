/** catalog/variant-picker: Retries are owned by the caller. */
export const VARIANT_PICKER_TIMEOUT_MS = 10000
export const VARIANT_PICKER_RETRIES = 4

export function variantPicker(input: string): string {
  return `catalog:variant-picker:${input}`
}
