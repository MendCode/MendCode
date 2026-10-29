/** Runs `task`; when it throws, runs it again, up to `attempts` runs in total. Rethrows the last error. `attempts` must be at least 1. */
export async function retry<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be at least 1")
  let lastError: unknown
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return await task()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** Waits for every promise: `values` are the results of the fulfilled ones, `errors` the reasons of ALL rejected ones, both in input order. */
export async function settleAll<T>(promises: readonly Promise<T>[]): Promise<{ values: T[]; errors: unknown[] }> {
  const results = await Promise.allSettled(promises)
  const values: T[] = []
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === "fulfilled") values.push(result.value)
    else if (errors.length === 0) errors.push(result.reason)
  }
  return { values, errors }
}
