export type TimerHandle = { cancel(): void; /** The timer no longer keeps the process alive; absent on clocks with no process to hold. */ unref?(): void }

/** All time in the kernel goes through a Clock so simulations can control interleavings (P3). */
export interface Clock {
  now(): number
  setTimer(ms: number, callback: () => void): TimerHandle
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, callback) {
    const handle = setTimeout(callback, Math.max(0, ms))
    return { cancel: () => clearTimeout(handle), unref: () => void handle.unref?.() }
  },
}

type VirtualTimer = { id: number; at: number; callback: () => void }

/** Deterministic clock: time only moves when the test calls `advance`/`runAll`. */
export function createVirtualClock(start = 0) {
  let current = start
  let nextId = 1
  const timers = new Map<number, VirtualTimer>()

  function due() {
    let best: VirtualTimer | undefined
    for (const timer of timers.values()) {
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer
    }
    return best
  }

  const clock = {
    now: () => current,
    setTimer(ms: number, callback: () => void): TimerHandle {
      const id = nextId++
      timers.set(id, { id, at: current + Math.max(0, ms), callback })
      return { cancel: () => void timers.delete(id) }
    },
    /** Fires every timer due up to `now + ms`, in order, then sets time to `now + ms`. */
    advance(ms: number) {
      const target = current + ms
      for (let timer = due(); timer && timer.at <= target; timer = due()) {
        timers.delete(timer.id)
        current = timer.at
        timer.callback()
      }
      current = target
    },
    pendingTimers: () => timers.size,
    nextTimerAt: () => due()?.at,
  }
  return clock
}
export type VirtualClock = ReturnType<typeof createVirtualClock>
