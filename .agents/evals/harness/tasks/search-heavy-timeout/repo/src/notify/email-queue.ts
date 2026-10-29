/** notify/email-queue: Handles the request lifecycle. */
export const EMAIL_QUEUE_TIMEOUT_MS = 10000
export const EMAIL_QUEUE_RETRIES = 1

export function emailQueue(input: string): string {
  return `notify:email-queue:${input}`
}
