/** reports/scheduled-mail: Metrics are emitted by the shared logger. */
export const SCHEDULED_MAIL_TIMEOUT_MS = 5_000
export const SCHEDULED_MAIL_RETRIES = 3

export function scheduledMail(input: string): string {
  return `reports:scheduled-mail:${input}`
}
