/** Descriptive statistics over the values a harness could report; nulls are skipped, never counted as zero. */

export function present(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
}

export function sum(values: readonly (number | null | undefined)[]): number | null {
  const numbers = present(values)
  return numbers.length === 0 ? null : numbers.reduce((total, value) => total + value, 0)
}

export function median(values: readonly (number | null | undefined)[]): number | null {
  const numbers = present(values).sort((a, b) => a - b)
  if (numbers.length === 0) return null
  const middle = Math.floor(numbers.length / 2)
  return numbers.length % 2 === 1 ? numbers[middle]! : (numbers[middle - 1]! + numbers[middle]!) / 2
}

/** Nearest-rank percentile (p in 0..100): the smallest value with at least p% of the sample at or below it. */
export function percentile(values: readonly (number | null | undefined)[], p: number): number | null {
  const numbers = present(values).sort((a, b) => a - b)
  if (numbers.length === 0) return null
  const rank = Math.max(1, Math.ceil((p / 100) * numbers.length))
  return numbers[rank - 1]!
}

export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null
  return numerator / denominator
}
