import { describe, expect, test } from "bun:test"
import { isRecentWorkingAssistant, isStaleBusySession, sessionStatusExpiryDelay, STALE_BUSY_SESSION_WINDOW_MS } from "@/cli/cmd/tui/util/session-working"

describe("isRecentWorkingAssistant", () => {
  test("rejects stale unfinished assistant history", () => {
    expect(
      isRecentWorkingAssistant({
        now: 100_000,
        assistantCreated: 1_000,
        sessionUpdated: 2_000,
      }),
    ).toBe(false)
  })

  test("rejects fresh session metadata without fresh assistant activity", () => {
    expect(
      isRecentWorkingAssistant({
        now: 100_000,
        assistantCreated: 1_000,
        sessionUpdated: 95_000,
      }),
    ).toBe(false)
  })

  test("accepts fresh assistant activity", () => {
    expect(
      isRecentWorkingAssistant({
        now: 100_000,
        assistantCreated: 95_000,
        sessionUpdated: 1_000,
      }),
    ).toBe(true)
  })
})

describe("isStaleBusySession", () => {
  test("rejects non-busy and explicit future busy deadline", () => {
    expect(isStaleBusySession({ statusType: "idle", now: 100_000, assistantCreated: 1_000 })).toBe(false)
    expect(
      isStaleBusySession({
        statusType: "busy",
        now: 100_000,
        assistantCreated: 1_000,
        statusUntil: 101_000,
      }),
    ).toBe(false)
  })

  test("uses the same stale busy window as live TUI pruning", () => {
    expect(
      isStaleBusySession({
        statusType: "busy",
        now: 100_000,
        assistantCreated: 100_000 - STALE_BUSY_SESSION_WINDOW_MS - 1,
        sessionUpdated: 99_999,
      }),
    ).toBe(true)
    expect(
      isStaleBusySession({
        statusType: "busy",
        now: 100_000,
        assistantCreated: 100_000 - STALE_BUSY_SESSION_WINDOW_MS + 1,
      }),
    ).toBe(false)
  })

  test("returns live session-status pruning delays", () => {
    expect(sessionStatusExpiryDelay({ type: "busy" }, 100_000)).toBe(STALE_BUSY_SESSION_WINDOW_MS + 1)
    expect(sessionStatusExpiryDelay({ type: "busy", until: 101_000 }, 100_000)).toBe(1_001)
    expect(sessionStatusExpiryDelay({ type: "retry", attempt: 1, message: "wait", next: 101_000 }, 100_000)).toBe(1_001)
    expect(sessionStatusExpiryDelay({ type: "idle" }, 100_000)).toBeUndefined()
  })
})
