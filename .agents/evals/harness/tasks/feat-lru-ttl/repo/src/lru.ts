export type LruOptions = { max: number }

/** Least-recently-used cache: reading or writing a key makes it the newest; the oldest key is evicted past `max`. */
export class LruCache<K, V> {
  readonly #max: number
  readonly #entries = new Map<K, V>()

  constructor({ max }: LruOptions) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer")
    this.#max = max
  }

  get size(): number {
    return this.#entries.size
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined
    const value = this.#entries.get(key) as V
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
    return this
  }

  delete(key: K): boolean {
    return this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  /** Keys from oldest to newest. */
  keys(): K[] {
    return [...this.#entries.keys()]
  }
}
