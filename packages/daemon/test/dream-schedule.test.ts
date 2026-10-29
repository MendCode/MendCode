import { describe, expect, test } from "bun:test"
import { CHECK_EVERY_MS, checkWindow, dateKey, nextCheckIn, ON_TIME_MS, windows } from "../src/dream-schedule"

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime()

describe("Dream windows", () => {
  test("the latest window is today's when it has passed, yesterday's when it has not", () => {
    expect(windows(at(2026, 9, 28, 10), "03:00")).toEqual({ last: at(2026, 9, 28, 3), next: at(2026, 9, 29, 3) })
    expect(windows(at(2026, 9, 28, 2), "03:00")).toEqual({ last: at(2026, 9, 27, 3), next: at(2026, 9, 28, 3) })
    expect(dateKey(at(2026, 9, 8, 3))).toBe("2026-09-08")
  })

  test("a window that is newer than the last handled one runs once: on time is scheduled, late is recovered", () => {
    expect(checkWindow({ now: at(2026, 9, 28, 3, 0), at: "03:00", handled: "2026-09-27" })).toEqual({ action: "run", trigger: "scheduled", day: "2026-09-28" })
    expect(checkWindow({ now: at(2026, 9, 28, 3) + ON_TIME_MS, at: "03:00", handled: "2026-09-27" })).toMatchObject({ trigger: "scheduled" })
    expect(checkWindow({ now: at(2026, 9, 28, 3) + ON_TIME_MS + 1, at: "03:00", handled: "2026-09-27" })).toMatchObject({ trigger: "recovered" })
    // The machine slept through the window: the first check after waking recovers it.
    expect(checkWindow({ now: at(2026, 9, 28, 9), at: "03:00", handled: "2026-09-27" })).toEqual({ action: "run", trigger: "recovered", day: "2026-09-28" })
  })

  test("several missed days are one recovery, and a handled window never runs again", () => {
    const verdict = checkWindow({ now: at(2026, 9, 30, 8), at: "03:00", handled: "2026-09-25" })
    expect(verdict).toEqual({ action: "run", trigger: "recovered", day: "2026-09-30" })
    expect(checkWindow({ now: at(2026, 9, 30, 8), at: "03:00", handled: "2026-09-30" })).toEqual({ action: "wait" })
    expect(checkWindow({ now: at(2026, 9, 30, 2), at: "03:00", handled: "2026-09-29" })).toEqual({ action: "wait" })
  })

  test("checks are at most 15 minutes apart and never a busy loop", () => {
    expect(nextCheckIn(at(2026, 9, 28, 10), "03:00")).toBe(CHECK_EVERY_MS)
    expect(nextCheckIn(at(2026, 9, 28, 2, 50), "03:00")).toBe(10 * 60_000)
    expect(nextCheckIn(at(2026, 9, 28, 2, 59) + 59_900, "03:00")).toBe(1_000)
  })
})
