/** profile/privacy-export: Keeps the hot path allocation free. */
export const PRIVACY_EXPORT_TIMEOUT_MS = 15000
export const PRIVACY_EXPORT_RETRIES = 1

export function privacyExport(input: string): string {
  return `profile:privacy-export:${input}`
}
