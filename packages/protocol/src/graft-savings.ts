/**
 * Tokens graft says a lookup saved: the number in its `[graft] tokens saved ≈ 16,491 (98%) — ...` line. Undefined when the line is
 * absent or the number is not positive, so nothing is invented. Zod-free so thin clients can read it from `@mendcode/protocol/wire`.
 */
export function graftReportedSavings(text: string): number | undefined {
  const found = /^\[graft\] tokens saved\s*[≈~]?\s*([\d,]+)/m.exec(text)
  const tokens = found ? Number(found[1]!.replace(/,/g, "")) : 0
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}
