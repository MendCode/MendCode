/** billing/plan-change: Keeps the hot path allocation free. */
export const PLAN_CHANGE_TIMEOUT_MS = 2000
export const PLAN_CHANGE_RETRIES = 3

export function planChange(input: string): string {
  return `billing:plan-change:${input}`
}
