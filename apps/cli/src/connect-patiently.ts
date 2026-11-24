/**
 * A daemon too busy to answer the handshake in time (the machine short on memory, a heavy build) is waited for: the client is built
 * again and asked again, instead of the terminal closing with a stack trace. Anything else (an older build, a refused secret) fails at once.
 */
export const CONNECT_ATTEMPTS = 8

const TRANSIENT = /no reply to hello within|connection timeout|connection closed|ECONNREFUSED|ECONNRESET/

export function isTransientConnectError(error: unknown) {
  return TRANSIENT.test(error instanceof Error ? error.message : String(error))
}

export async function connectPatiently<C extends { connect(): Promise<void>; close(): void }>(input: {
  build: () => C
  onWait?: (attempt: number, error: unknown) => void
  attempts?: number
  delayMs?: (attempt: number) => number
}): Promise<C> {
  const { build, onWait, attempts = CONNECT_ATTEMPTS, delayMs = (attempt) => Math.min(5_000, 500 * 2 ** attempt) } = input
  for (let attempt = 1; ; attempt++) {
    const client = build()
    try {
      await client.connect()
      return client
    } catch (error) {
      client.close()
      if (attempt >= attempts || !isTransientConnectError(error)) throw error
      onWait?.(attempt, error)
      await Bun.sleep(delayMs(attempt))
    }
  }
}

const SLOW_START = /did not start within/

/** A daemon that is still coming up (a loaded machine, a first start) is waited for again instead of ending the terminal at the first deadline. */
export async function startPatiently<T>(input: { start: () => Promise<T>; onWait?: (attempt: number) => void; attempts?: number }): Promise<T> {
  const { start, onWait, attempts = 3 } = input
  for (let attempt = 1; ; attempt++) {
    try {
      return await start()
    } catch (error) {
      if (attempt >= attempts || !SLOW_START.test(error instanceof Error ? error.message : String(error))) throw error
      onWait?.(attempt)
    }
  }
}

/** What the terminal prints when its daemon cannot be reached at start: a readable line, never the error's source frame. */
export function startFailureMessage(error: unknown, dir: string) {
  const text = (error instanceof Error ? error.message : String(error)).replace(/^(\[(CLI|CLIENT)\]: )+/, "")
  return `error: ${text}\n${SLOW_START.test(text) ? `The daemon's own output is in ${dir}/logs (mendcode daemon logs); run mendcode again to retry.\n` : ""}`
}
