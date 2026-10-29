import type { Clock } from "@mendcode/kernel"
import type { GlobalEvent } from "@mendcode/protocol"

export type UsageTodayEvent = Extract<GlobalEvent, { type: "usage.today" }>
type Recorded = { at: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; costMicros?: number | undefined }
type Totals = { day: string; tokens: number; calls: number; costMicros: number }

export const USAGE_TODAY_MIN_INTERVAL_MS = 1_000

export function localDay(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * Today's running usage across all sessions, kept in memory (O(1) per event). It is seeded from the
 * store once, resets when the local day changes, and pushes at most one update per second — the newest
 * numbers are delivered when the window ends, so the last call of a burst is never lost.
 */
export function createUsageToday(input: { clock: Clock; seed: Omit<Totals, "day">; emit(event: UsageTodayEvent): void; dayOf?: (at: number) => string; minIntervalMs?: number }) {
  const dayOf = input.dayOf ?? localDay
  const interval = input.minIntervalMs ?? USAGE_TODAY_MIN_INTERVAL_MS
  let totals: Totals = { day: dayOf(input.clock.now()), ...input.seed }
  let lastEmit = Number.NEGATIVE_INFINITY
  let timer: { cancel(): void } | undefined

  function snapshot(): UsageTodayEvent {
    const today = dayOf(input.clock.now())
    const current = totals.day === today ? totals : { day: today, tokens: 0, calls: 0, costMicros: 0 }
    return { type: "usage.today", gseq: 0, at: input.clock.now(), day: current.day, tokens: current.tokens, calls: current.calls, ...(current.costMicros > 0 ? { costMicros: current.costMicros } : {}) }
  }

  function flush() {
    timer = undefined
    lastEmit = input.clock.now()
    input.emit(snapshot())
  }

  return {
    record(event: Recorded) {
      const day = dayOf(event.at)
      if (day !== totals.day) totals = { day, tokens: 0, calls: 0, costMicros: 0 }
      totals.tokens += event.input + event.output + event.reasoning + event.cacheRead + event.cacheWrite
      totals.calls += 1
      totals.costMicros += event.costMicros ?? 0
      const wait = interval - (input.clock.now() - lastEmit)
      if (wait <= 0) {
        timer?.cancel()
        flush()
      } else timer ??= input.clock.setTimer(wait, flush)
    },
    /** The current totals, zero when the day has rolled over since the last event. */
    snapshot,
    stop() {
      timer?.cancel()
      timer = undefined
    },
  }
}
