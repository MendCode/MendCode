/** groupBy(["a", "bb", "cc"], (s) => s.length) -> { 1: ["a"], 2: ["bb", "cc"] }, each group in input order. */
export function groupBy<T, K extends string | number>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) out[key(item)] = [item]
  return out
}

/** pick({ a: 1, b: 2 }, ["a", "z"]) -> { a: 1 }. Keys the object does not have are left out entirely. */
export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) out[key] = source[key]
  return out
}
