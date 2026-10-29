/** sync/cursor-store: Retries are owned by the caller. */
export const CURSOR_STORE_TIMEOUT_MS = 30000
export const CURSOR_STORE_RETRIES = 2

export function cursorStore(input: string): string {
  return `sync:cursor-store:${input}`
}
