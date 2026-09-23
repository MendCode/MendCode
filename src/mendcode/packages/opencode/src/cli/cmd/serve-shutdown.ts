// Keep this shorter than the client's bounded wait for the previous process.
export const SHARED_SERVER_SHUTDOWN_TIMEOUT_MS = 10_000

/** Own the whole shutdown, not just instance disposal. A closed listener must
 * never leave a live process retaining the database writer lease indefinitely. */
export function createShutdown(input: {
  stopListener: () => Promise<void>
  disposeInstances: () => Promise<void>
  closeDatabase: () => void | Promise<void>
  clearState: () => Promise<void>
  exit: (code: number) => void
  report?: (stage: string, error: unknown) => void
  shutdownTimeoutMs?: number
}) {
  let shutdown: Promise<void> | undefined
  return () => (shutdown ??= run())

  async function run() {
    let stage = "listener"
    let expired = false
    let exitCode = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      // This timer deliberately stays referenced: cleanup is not complete
      // until the process exits and the OS releases its remaining resources.
      timer = setTimeout(() => {
        expired = true
        reject(new Error(`Shared server shutdown timed out during ${stage}`))
      }, input.shutdownTimeoutMs ?? SHARED_SERVER_SHUTDOWN_TIMEOUT_MS)
    })
    const cleanup = async () => {
      await input.stopListener()
      if (expired) return
      stage = "instances"
      await input.disposeInstances()
      if (expired) return
      stage = "database"
      await input.closeDatabase()
      if (expired) return
      // Only relinquish discovery after all writers have actually closed.
      // On failure retain the receipt for dead-process recovery by the client.
      stage = "state"
      await input.clearState()
    }
    try {
      await Promise.race([cleanup(), deadline])
    } catch (error) {
      exitCode = 1
      input.report?.(stage, error)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      input.exit(exitCode)
    }
  }
}
