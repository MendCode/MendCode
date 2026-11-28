/**
 * Names what held the daemon's event loop. A timer that should fire every `intervalMs` notes how late it came; past `thresholdMs`
 * the daemon logs one line with the lag, the commands still in flight (oldest first, with how long each has run) and the ones that
 * started during the stall, so a frozen daemon says what it was doing once it answers again. One unref'd timer a second, a map
 * entry per command in flight: nothing else runs at rest.
 */
export type LoopWatch = {
  /** A command (or a background job) started; the returned function says it ended. */
  begin(label: string): () => void
  stop(): void
}

export const LOOP_WATCH_INTERVAL_MS = 1000
export const LOOP_WATCH_THRESHOLD_MS = 1000
/** Commands that started recently, kept to name the ones that ran during a stall. */
const RECENT_MAX = 32
/** The in-flight and recent labels a line lists at most. */
const LISTED_MAX = 8

export function createLoopWatch(options: {
  log: (message: string) => void
  now?: () => number
  intervalMs?: number
  thresholdMs?: number
  /** Extra facts for the line (resident memory); never throws into the timer. */
  facts?: () => string
  every?: (run: () => void, ms: number) => () => void
}): LoopWatch {
  const now = options.now ?? (() => performance.now())
  const intervalMs = options.intervalMs ?? LOOP_WATCH_INTERVAL_MS
  const thresholdMs = options.thresholdMs ?? LOOP_WATCH_THRESHOLD_MS
  const every = options.every ?? repeat
  const inFlight = new Map<number, { label: string; at: number }>()
  const recent: Array<{ label: string; at: number; ms?: number }> = []
  let next = 0
  let expected = now() + intervalMs

  const stop = every(() => {
    const at = now()
    const lag = at - expected
    expected = at + intervalMs
    if (lag < thresholdMs) return
    const since = at - lag - intervalMs
    const running = [...inFlight.values()].sort((a, b) => a.at - b.at).slice(0, LISTED_MAX).map((entry) => `${entry.label} ${Math.round(at - entry.at)}ms`)
    const during = recent.filter((entry) => entry.at >= since).slice(-LISTED_MAX).map((entry) => entry.ms === undefined ? entry.label : `${entry.label} ${Math.round(entry.ms)}ms`)
    let extra = ""
    try { extra = options.facts?.() ?? "" } catch {}
    options.log(`[DAEMON]: the event loop was blocked for ${Math.round(lag)} ms · in flight: ${running.join(", ") || "none"} · started during it: ${during.join(", ") || "none"}${extra ? ` · ${extra}` : ""}`)
  }, intervalMs)

  return {
    begin(label) {
      const id = next++
      const at = now()
      inFlight.set(id, { label, at })
      const entry: { label: string; at: number; ms?: number } = { label, at }
      recent.push(entry)
      if (recent.length > RECENT_MAX) recent.shift()
      return () => {
        inFlight.delete(id)
        entry.ms = now() - at
      }
    },
    stop,
  }
}

/** `MENDCODE_LOOP_WATCH_MS`: the lag in whole milliseconds (50 or more) that is logged; anything else keeps the default. */
export function loopWatchThreshold(env: Record<string, string | undefined>) {
  const value = env.MENDCODE_LOOP_WATCH_MS
  return value !== undefined && /^\d{2,6}$/.test(value) && Number(value) >= 50 ? Number(value) : LOOP_WATCH_THRESHOLD_MS
}

function repeat(run: () => void, ms: number) {
  const timer = setInterval(run, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}
