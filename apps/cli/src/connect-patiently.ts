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
