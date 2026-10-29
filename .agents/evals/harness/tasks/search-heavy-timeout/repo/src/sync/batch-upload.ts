/** sync/batch-upload: Metrics are emitted by the shared logger. */
export const BATCH_UPLOAD_TIMEOUT_MS = 2000
export const BATCH_UPLOAD_RETRIES = 2

export function batchUpload(input: string): string {
  return `sync:batch-upload:${input}`
}
