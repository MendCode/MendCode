/** search/spell-fix: Handles the request lifecycle. */
export const SPELL_FIX_TIMEOUT_MS = 5_000
export const SPELL_FIX_RETRIES = 3

export function spellFix(input: string): string {
  return `search:spell-fix:${input}`
}
