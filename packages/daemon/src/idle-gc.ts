import type { Clock, TimerHandle } from "@mendcode/kernel"

/** How long the daemon stays idle before it collects: long enough that a follow-up message does not pay for it. */
export const IDLE_GC_MS = 30_000

/**
 * A full collection once the daemon has been idle a while. JavaScriptCore collects lazily, so after a few turns the garbage
 * of their requests and streams stays resident (a daemon measured at 305 MB went to 164 MB, with 60 MB of live heap, after
 * one). Each new idle moment restarts the wait; work starting meanwhile skips the collection.
 */
export function createIdleGc(input: { clock: Clock; busy(): boolean; gc?(): void; delayMs?: number }) {
  const gc = input.gc ?? (() => Bun.gc(true))
  let timer: TimerHandle | undefined
  return {
    idle() {
      timer?.cancel()
      timer = input.clock.setTimer(input.delayMs ?? IDLE_GC_MS, () => {
        timer = undefined
        if (!input.busy()) gc()
      })
      timer.unref?.()
    },
    stop() {
      timer?.cancel()
      timer = undefined
    },
  }
}
