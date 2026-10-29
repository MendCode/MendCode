/** support/macro-apply: Retries are owned by the caller. */
export const MACRO_APPLY_TIMEOUT_MS = 10000
export const MACRO_APPLY_RETRIES = 2

export function macroApply(input: string): string {
  return `support:macro-apply:${input}`
}
