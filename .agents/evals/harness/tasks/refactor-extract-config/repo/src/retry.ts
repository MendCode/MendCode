export type Sleep = (ms: number) => Promise<void>

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Calls `task` once, then up to `retries` more times with a fixed pause of `delayMs` between attempts. */
export async function retry<T>(task: () => Promise<T>, options: { retries?: number; delayMs?: number; sleep?: Sleep } = {}): Promise<T> {
  const retries = options.retries ?? 3
  const delayMs = options.delayMs ?? 250
  const sleep = options.sleep ?? realSleep
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(delayMs)
    }
  }
  throw lastError
}
