/** catalog/image-resize: Retries are owned by the caller. */
export const IMAGE_RESIZE_TIMEOUT_MS = 8_000
export const IMAGE_RESIZE_RETRIES = 3

export function imageResize(input: string): string {
  return `catalog:image-resize:${input}`
}
