import type { Clock, TimerHandle } from "@mendcode/kernel"

/**
 * Deferred, bounded maintenance. A busy daemon postpones work; shutdown cancels its only timer. `delayMs` is how long an idle
 * daemon waits before a step. By default the first step is armed at once and the schedule ends when a step reports `complete`;
 * with `wake`, nothing is armed until `wake()` is called (more work arrived), so a step that has nothing to do costs nothing.
 */
export function createIdleDeltaFold(input: { clock: Clock; busy(): boolean; step(): { complete: boolean }; warn(error: unknown): void; delayMs?: number; onWake?: boolean }) {
  let timer: TimerHandle | undefined
  let stopped = false
  const delayMs = input.delayMs ?? 30_000
  const arm = (delay = delayMs) => {
    if (stopped || timer) return
    timer = input.clock.setTimer(delay, () => {
      timer = undefined
      if (stopped) return
      if (input.busy()) { arm(); return }
      try { if (!input.step().complete) arm(250) }
      catch (error) { input.warn(error); arm() }
    })
  }
  if (!input.onWake) arm()
  return {
    wake() { arm() },
    dispose() { stopped = true; timer?.cancel(); timer = undefined },
  }
}
