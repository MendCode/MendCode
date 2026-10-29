import { DEFAULT_TOAST_MS, type Toast } from "../view/toast"

type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

/**
 * One toast at a time (v1: a new one replaces the current and restarts the timer). The only timer is the single
 * timeout of the toast on screen, so an app with no toast has none (P6). `onChange` repaints.
 */
export function createToasts(onChange: () => void, timers: Timers = realTimers) {
  let current: Toast | undefined
  let handle: unknown
  function clear() {
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
    current = undefined
  }
  return {
    get current() {
      return current
    },
    show(toast: Toast, ms = DEFAULT_TOAST_MS) {
      if (handle !== undefined) timers.clear(handle)
      current = toast
      handle = timers.set(() => {
        handle = undefined
        current = undefined
        onChange()
      }, ms)
      onChange()
    },
    dismiss() {
      if (!current) return
      clear()
      onChange()
    },
    /** Whether a timer is alive (tests, P6). */
    get pending() {
      return handle !== undefined
    },
  }
}
export type Toasts = ReturnType<typeof createToasts>
