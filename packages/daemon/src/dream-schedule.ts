import type { DreamTrigger } from "@mendcode/protocol"

/** How late a window may be and still count as on time (a run after it is a recovery). */
export const ON_TIME_MS = 5 * 60_000
/**
 * The longest the daemon waits between checks while Dream is scheduled. A timer that counts monotonic time stops while
 * the machine sleeps, so after a wake it could be hours late; checking this often bounds that to one interval.
 */
export const CHECK_EVERY_MS = 15 * 60_000

/** Local calendar day, `YYYY-MM-DD`. */
export function dateKey(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** The latest daily window at or before `now` and the first one after it, for a local time "HH:MM". */
export function windows(now: number, at: string): { last: number; next: number } {
  const [hours, minutes] = at.split(":").map(Number) as [number, number]
  const today = new Date(now)
  today.setHours(hours, minutes, 0, 0)
  const before = new Date(today)
  const after = new Date(today)
  if (today.getTime() <= now) after.setDate(after.getDate() + 1)
  else before.setDate(before.getDate() - 1)
  return { last: before.getTime(), next: after.getTime() }
}

/**
 * What to do at a check. `handled` is the day of the last window already run or recovered. A window that is newer runs once:
 * `scheduled` when it is on time, `recovered` when the daemon was down or the machine asleep and this is the first check after it.
 * Several missed days are one recovery, never one per day.
 */
export function checkWindow(input: { now: number; at: string; handled: string | undefined }): { action: "wait" } | { action: "run"; trigger: Extract<DreamTrigger, "scheduled" | "recovered">; day: string } {
  const { last } = windows(input.now, input.at)
  const day = dateKey(last)
  if (input.handled !== undefined && input.handled >= day) return { action: "wait" }
  return { action: "run", trigger: input.now - last <= ON_TIME_MS ? "scheduled" : "recovered", day }
}

/** Milliseconds until the next check: the next window, or sooner when it is far away (see CHECK_EVERY_MS). */
export function nextCheckIn(now: number, at: string) {
  return Math.max(1_000, Math.min(windows(now, at).next - now, CHECK_EVERY_MS))
}
