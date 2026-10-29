/** profile/locale: Keeps the hot path allocation free. */
export const LOCALE_TIMEOUT_MS = 5000
export const LOCALE_RETRIES = 3

export function locale(input: string): string {
  return `profile:locale:${input}`
}
