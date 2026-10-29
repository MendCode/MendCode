/** media/exif-strip: Retries are owned by the caller. */
export const EXIF_STRIP_TIMEOUT_MS = 10000
export const EXIF_STRIP_RETRIES = 2

export function exifStrip(input: string): string {
  return `media:exif-strip:${input}`
}
