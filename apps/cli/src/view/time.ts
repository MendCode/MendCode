/** Time formatting for the transcript, following v1's `Locale` helpers (util/locale.ts). Pure: `now` is passed in. */

/** 820ms / 12.3s / 1m 5s / 2h 3m. */
export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  const hours = Math.floor(totalSeconds / 3600)
  return `${hours}h ${Math.floor((totalSeconds % 3600) / 60)}m`
}

/** Whole seconds for a running clock: 12s / 1m 5s / 2h 3m. */
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** Whole seconds with padded remainders: 42s / 3m 05s / 1h 02m. */
export function formatPaddedElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
const DATE = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric" })

/** Today → `3:45 PM`; another day → `3:45 PM · 9/27/2026`. An unknown time (0) is empty. */
export function todayTimeOrDateTime(at: number, now: number) {
  if (!(at > 0)) return ""
  const date = new Date(at)
  const time = TIME.format(date).replace(/[  ]/g, " ")
  return date.toDateString() === new Date(now).toDateString() ? time : `${time} · ${DATE.format(date)}`
}
