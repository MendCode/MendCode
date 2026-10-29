/**
 * Subsequence match with scoring for the prompt's popups (v1 uses fuzzysort): every query character must
 * appear in order; word starts, the first character and runs of adjacent characters score higher, gaps
 * cost a little. Case-insensitive. Undefined when the query is not a subsequence.
 */
const isWordStart = (chars: string[], index: number) => index === 0 || !/[\p{L}\p{N}]/u.test(chars[index - 1]!)

export function fuzzyScore(query: string, text: string): number | undefined {
  const needle = Array.from(query.toLowerCase().replace(/\s+/g, ""))
  const chars = Array.from(text)
  const lower = chars.map((c) => c.toLowerCase())
  if (needle.length === 0) return 0
  if (needle.length > chars.length) return undefined
  const n = needle.length
  const m = chars.length
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(Number.NEGATIVE_INFINITY))
  for (let i = 0; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (lower[j] !== needle[i]) continue
      const gain = 1 + (isWordStart(chars, j) ? 8 : 0) + (j === 0 ? 6 : 0)
      if (i === 0) {
        best[i]![j] = gain - j * 0.05
        continue
      }
      for (let k = i - 1; k < j; k++) {
        const previous = best[i - 1]![k]!
        if (previous === Number.NEGATIVE_INFINITY) continue
        const score = previous + gain + (k === j - 1 ? 5 : -(j - k - 1) * 0.1)
        if (score > best[i]![j]!) best[i]![j] = score
      }
    }
  }
  const top = Math.max(...best[n - 1]!)
  return top === Number.NEGATIVE_INFINITY ? undefined : top
}
