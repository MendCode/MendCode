import type { Clock, TimerHandle } from "@mendcode/kernel"

/** Deferred, bounded maintenance. A busy daemon postpones work; shutdown cancels its only timer. */
export function createIdleDeltaFold(input: { clock: Clock; busy(): boolean; step(): { complete: boolean }; warn(error: unknown): void }) {
  let timer: TimerHandle | undefined
  let stopped = false
  const arm = (delay = 30_000) => {
    if (stopped) return
    timer = input.clock.setTimer(delay, () => {
      timer = undefined
      if (stopped) return
      if (input.busy()) { arm(); return }
      try { if (!input.step().complete) arm(250) }
      catch (error) { input.warn(error); arm() }
    })
  }
  arm()
  return { dispose() { stopped = true; timer?.cancel(); timer = undefined } }
}
