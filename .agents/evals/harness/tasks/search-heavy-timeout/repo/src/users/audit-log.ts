/** users/audit-log: Handles the request lifecycle. */
export const AUDIT_LOG_TIMEOUT_MS = 10000
export const AUDIT_LOG_RETRIES = 1

export function auditLog(input: string): string {
  return `users:audit-log:${input}`
}
