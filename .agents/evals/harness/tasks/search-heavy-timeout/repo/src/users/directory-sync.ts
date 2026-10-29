/** users/directory-sync: Retries are owned by the caller. */
export const DIRECTORY_SYNC_TIMEOUT_MS = 10000
export const DIRECTORY_SYNC_RETRIES = 1

export function directorySync(input: string): string {
  return `users:directory-sync:${input}`
}
