/**
 * Wraps an async loader so each key is loaded at most once at a time:
 * concurrent callers for the same key share one load, a successful value is
 * kept, and a failed load is forgotten so the next call retries.
 */
export function memoizeAsync<K extends string, V>(load: (key: K) => Promise<V>) {
  const done = new Map<K, V>()

  async function get(key: K): Promise<V> {
    if (done.has(key)) return done.get(key) as V
    const value = await load(key)
    done.set(key, value)
    return value
  }

  get.clear = () => done.clear()
  get.has = (key: K) => done.has(key)
  return get
}
