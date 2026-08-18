import { describe, expect, test } from "bun:test"
import {
  normalizeSessionCancelOutbox,
  sessionControlAllowsPrompt,
  sessionCancelRequestIsDuplicate,
  type SessionCancelOutboxEntry,
} from "@tui/context/session-control"

describe("session control outbox", () => {
  test("drops invalid and expired controls while retaining recent entries", () => {
    const now = Date.now()
    const recent = {
      id: "recent",
      sessionID: "session-1",
      targetMessageID: "message-1",
      requestedAt: now - 1_000,
      attempts: 0,
    } satisfies SessionCancelOutboxEntry
    const expired = {
      ...recent,
      id: "expired",
      requestedAt: now - 8 * 24 * 60 * 60 * 1_000,
    }

    expect(normalizeSessionCancelOutbox([recent, expired, { id: "invalid" }], now)).toEqual([recent])
  })

  test("deduplicates stable IDs and caps the outbox", () => {
    const now = Date.now()
    const entries = Array.from({ length: 70 }, (_, index) => ({
      id: `control-${index}`,
      sessionID: "session-1",
      targetMessageID: `message-${index}`,
      requestedAt: now - 70 + index,
      attempts: 0,
    }))
    entries.push({ ...entries[69], attempts: 2 })

    const normalized = normalizeSessionCancelOutbox(entries, now)
    expect(normalized).toHaveLength(64)
    expect(normalized[0]?.id).toBe("control-6")
    expect(normalized.at(-1)?.attempts).toBe(2)
  })

  test("retains an undelivered control after a persisted JSON round trip", () => {
    const now = Date.now()
    const entry = {
      id: "/tmp/project\u0000session-1\u0000message-1",
      directory: "/tmp/project",
      sessionID: "session-1",
      targetMessageID: "message-1",
      requestedAt: now,
      attempts: 1,
      lastAttemptAt: now,
      lastError: "Control request failed",
    } satisfies SessionCancelOutboxEntry

    expect(normalizeSessionCancelOutbox(JSON.parse(JSON.stringify([entry])), now)).toEqual([entry])
  })

  test("does not send the same cancel-turn twice after confirmation", () => {
    expect(
      sessionCancelRequestIsDuplicate({
        entries: [],
        confirmedTargetMessageID: "message-1",
        sessionID: "session-1",
        targetMessageID: "message-1",
      }),
    ).toBe(true)
    expect(
      sessionCancelRequestIsDuplicate({
        entries: [],
        confirmedTargetMessageID: "message-1",
        sessionID: "session-1",
        targetMessageID: "message-2",
      }),
    ).toBe(false)
    expect(
      sessionCancelRequestIsDuplicate({
        entries: [{ sessionID: "session-1", targetMessageID: "message-1" }],
        sessionID: "session-1",
        targetMessageID: "message-1",
      }),
    ).toBe(true)
  })

  test("holds prompt acceptance until cancellation is confirmed", () => {
    expect(sessionControlAllowsPrompt({ state: "idle" })).toBe(true)
    expect(
      sessionControlAllowsPrompt({ state: "stop_requested", targetMessageID: "message-1", requestedAt: Date.now() }),
    ).toBe(false)
    expect(
      sessionControlAllowsPrompt({
        state: "stop_confirmed",
        targetMessageID: "message-1",
        confirmedAt: Date.now(),
        result: "cancelled",
      }),
    ).toBe(true)
    expect(
      sessionControlAllowsPrompt({
        state: "stop_confirmed",
        targetMessageID: "message-1",
        confirmedAt: Date.now(),
        result: "target_mismatch",
      }),
    ).toBe(false)
  })
})
