/** Index of `target` in an ascending array, or -1 when it is absent. */
export function binarySearch(sorted: readonly number[], target: number): number {
  let low = 0
  let high = sorted.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    const value = sorted[middle]!
    if (value === target) return middle
    if (value < target) low = middle + 1
    else high = middle - 1
  }
  return -1
}

/** Merges two ascending arrays into one ascending array, keeping duplicates. */
export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) out.push(a[i]! <= b[j]! ? a[i++]! : b[j++]!)
  return out
}
