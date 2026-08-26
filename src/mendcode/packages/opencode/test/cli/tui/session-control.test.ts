import { describe, expect, test } from "bun:test"
import {
  normalizeSessionCancelOutbox,
  sessionCancelRetryAllowed,
  sessionCancelRetryDelay,
  sessionControlAllowsPrompt,
  sessionCancelRequestIsDuplicate,
  sessionCancelResultNeedsHardAbort,
  resolveSessionControlRouting,
  SESSION_CANCEL_AUTO_RETRY_MAX_ATTEMPTS,
  SESSION_CANCEL_AUTO_RETRY_WINDOW_MS,
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

  test("classifies transient cancel delivery as unknown and stops after bounded retries", () => {
    const now = Date.now()
    expect(
      sessionCancelRetryAllowed({
        attempts: 1,
        requestedAt: now,
        now,
      }),
    ).toBe(true)
    expect(
      sessionCancelRetryAllowed({
        attempts: SESSION_CANCEL_AUTO_RETRY_MAX_ATTEMPTS,
        requestedAt: now,
        now,
      }),
    ).toBe(false)
    expect(
      sessionCancelRetryAllowed({
        attempts: 1,
        requestedAt: now - SESSION_CANCEL_AUTO_RETRY_WINDOW_MS - 1,
        now,
      }),
    ).toBe(false)
    expect(sessionCancelRetryDelay(1)).toBe(250)
    expect(sessionCancelRetryDelay(8)).toBe(2_000)
    expect(
      sessionControlAllowsPrompt({
        state: "stop_unknown",
        targetMessageID: "message-1",
        requestedAt: now,
        attempts: 1,
        error: "offline",
      }),
    ).toBe(false)
    expect(
      sessionControlAllowsPrompt({
        state: "stop_failed",
        targetMessageID: "message-1",
        requestedAt: now,
        attempts: SESSION_CANCEL_AUTO_RETRY_MAX_ATTEMPTS,
        error: "offline",
      }),
    ).toBe(false)
  })

  test("falls back to a session abort when the targeted stop cannot prove the active turn", () => {
    expect(sessionCancelResultNeedsHardAbort({ delivered: false })).toBe(true)
    expect(sessionCancelResultNeedsHardAbort({ delivered: true, result: "target_mismatch" })).toBe(true)
    expect(sessionCancelResultNeedsHardAbort({ delivered: true, result: "not_running" })).toBe(true)
    expect(sessionCancelResultNeedsHardAbort({ delivered: true, result: "cancelled" })).toBe(false)
    expect(sessionCancelResultNeedsHardAbort({ delivered: true, result: "already_terminal" })).toBe(false)
  })

  test("routes cancellation to the session owner instead of the currently selected folder", () => {
    expect(
      resolveSessionControlRouting({
        sessionDirectory: "/work/legacy-session",
        currentWorkspaceID: "workspace-selected-now",
        currentDirectory: "/work/current-folder",
      }),
    ).toEqual({ directory: "/work/legacy-session" })
    expect(
      resolveSessionControlRouting({
        sessionWorkspaceID: "workspace-session-owner",
        sessionDirectory: "/work/ignored-when-warped",
        currentWorkspaceID: "workspace-selected-now",
        currentDirectory: "/work/current-folder",
      }),
    ).toEqual({ workspace: "workspace-session-owner" })
    expect(
      resolveSessionControlRouting({
        currentWorkspaceID: "workspace-selected-now",
        currentDirectory: "/work/current-folder",
      }),
    ).toEqual({ workspace: "workspace-selected-now" })
  })
})
