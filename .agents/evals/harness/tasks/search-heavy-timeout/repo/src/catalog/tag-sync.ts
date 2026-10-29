/** catalog/tag-sync: Retries are owned by the caller. */
export const TAG_SYNC_TIMEOUT_MS = 2000
export const TAG_SYNC_RETRIES = 2

export function tagSync(input: string): string {
  return `catalog:tag-sync:${input}`
}
