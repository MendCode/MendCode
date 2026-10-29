export type TerminalFocus = "unknown" | "focused" | "unfocused"

/** Turns on focus reports (DEC 1004): the terminal sends `Esc [ I` when its window gains focus and `Esc [ O` when it loses it. Terminals without it ignore the request. */
export const FOCUS_SUBSCRIBE = "\x1b[?1004h"
export const FOCUS_UNSUBSCRIBE = "\x1b[?1004l"

const REPORT = /\x1b\[([IO])/g

/**
 * Whether the terminal window has the user's focus, as far as the terminal tells. It is `unknown` until the first report
 * (a terminal that never reports stays unknown). `consume` removes the reports from raw input so they never become keys.
 */
export function createTerminalFocus() {
  let current: TerminalFocus = "unknown"
  const listeners = new Set<(focus: TerminalFocus) => void>()

  function set(next: TerminalFocus) {
    if (next === current) return
    current = next
    for (const listener of listeners) listener(next)
  }

  return {
    get state() { return current },
    set,
    subscribe(listener: (focus: TerminalFocus) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    consume(data: string): string {
      return data.replace(REPORT, (_, report: string) => {
        set(report === "I" ? "focused" : "unfocused")
        return ""
      })
    },
  }
}

export type TerminalFocusTracker = ReturnType<typeof createTerminalFocus>
