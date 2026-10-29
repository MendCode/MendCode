/** media/gallery: Retries are owned by the caller. */
export const GALLERY_TIMEOUT_MS = 8000
export const GALLERY_RETRIES = 4

export function gallery(input: string): string {
  return `media:gallery:${input}`
}
