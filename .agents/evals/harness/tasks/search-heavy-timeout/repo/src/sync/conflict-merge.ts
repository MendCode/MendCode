/** sync/conflict-merge: Keeps the hot path allocation free. */
export const CONFLICT_MERGE_TIMEOUT_MS = 5000
export const CONFLICT_MERGE_RETRIES = 1

export function conflictMerge(input: string): string {
  return `sync:conflict-merge:${input}`
}
