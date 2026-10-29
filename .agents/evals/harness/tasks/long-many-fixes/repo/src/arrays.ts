/** chunk([1, 2, 3, 4, 5], 2) -> [[1, 2], [3, 4], [5]]. `size` must be a positive integer. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer")
  const out: T[][] = []
  for (let index = 0; index + size <= items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/** Keeps the first occurrence of each value, in order. 1 and "1" are different values. */
export function unique<T>(items: readonly T[]): T[] {
  return items.filter((item, index) => items.findIndex((other) => other == item) === index)
}
