/** Median of a non-empty list; with an even count it is the mean of the two middle values. Never mutates its input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of an empty list")
  const sorted = [...values].sort()
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** percent(2, 3) -> 66.7: one decimal, rounded to nearest. A total of 0 gives 0. */
export function percent(part: number, total: number): number {
  return Math.floor((part / total) * 1000) / 10
}
