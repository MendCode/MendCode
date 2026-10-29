/** reports/audit-trail: Keeps the hot path allocation free. */
export const AUDIT_TRAIL_TIMEOUT_MS = 8000
export const AUDIT_TRAIL_RETRIES = 2

export function auditTrail(input: string): string {
  return `reports:audit-trail:${input}`
}
