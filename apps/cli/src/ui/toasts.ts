import { TOAST_MS, type Toast } from "../view/toast"

type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

/**
 * One toast at a time (v1: a new one replaces the current and restarts the timer). The only timer is the single
 * timeout of the toast on screen, so an app with no toast has none (P6); an error has none at all and stays until it is
 * dismissed (the next prompt or command, a newer notice, F4). `ms` overrides TOAST_MS for the other kinds. `onChange` repaints.
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
    show(toast: Toast, ms?: number) {
      if (handle !== undefined) timers.clear(handle)
      handle = undefined
      current = toast
      const stay = toast.variant === "error" ? undefined : ms ?? TOAST_MS[toast.variant]
      if (stay !== undefined) {
        handle = timers.set(() => {
          handle = undefined
          current = undefined
          onChange()
        }, stay)
      }
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
