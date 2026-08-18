import { describe, expect, test } from "bun:test"
import { STALE_SESSION_RECOVERY_MS, shouldRecoverStaleSession } from "../../src/session/recovery"

describe("stale foreground session recovery", () => {
  test("reclaims a busy session whose running tool outlived its client", () => {
    const now = 10_000_000
    expect(
      shouldRecoverStaleSession({
        statusType: "busy",
        statusUpdatedAt: now - STALE_SESSION_RECOVERY_MS - 1,
        latestTool: { tool: "bash", status: "running", updatedAt: now - STALE_SESSION_RECOVERY_MS - 1 },
        now,
      }),
    ).toBe(true)
  })

  test("does not reclaim fresh, terminal, or already retrying work", () => {
    const now = 10_000_000
    expect(shouldRecoverStaleSession({ statusType: "busy", statusUpdatedAt: now, latestTool: { status: "running", updatedAt: now }, now })).toBe(false)
    expect(shouldRecoverStaleSession({ statusType: "busy", statusUpdatedAt: now - 100_000, latestTool: { status: "completed", updatedAt: now - 100_000 }, now })).toBe(false)
    expect(shouldRecoverStaleSession({ statusType: "retry", statusUpdatedAt: now - 100_000, latestTool: { status: "running", updatedAt: now - 100_000 }, now })).toBe(false)
  })

  test("reclaims stale unfinished work even when the persisted status is missing or idle", () => {
    const now = 10_000_000
    expect(
      shouldRecoverStaleSession({
        statusType: "idle",
        latestAssistant: { updatedAt: now - STALE_SESSION_RECOVERY_MS - 1 },
        now,
      }),
    ).toBe(true)
    expect(
      shouldRecoverStaleSession({
        statusType: "idle",
        latestTool: { status: "running", updatedAt: now - STALE_SESSION_RECOVERY_MS + 1 },
        now,
      }),
    ).toBe(false)
  })

  test("reclaims an unfinished assistant after its runtime disappears without replaying it", () => {
    const now = 10_000_000
    expect(
      shouldRecoverStaleSession({
        statusType: "busy",
        statusUpdatedAt: now - STALE_SESSION_RECOVERY_MS - 1,
        latestAssistant: { updatedAt: now - STALE_SESSION_RECOVERY_MS - 1 },
        now,
      }),
    ).toBe(true)
    expect(
      shouldRecoverStaleSession({
        statusType: "busy",
        statusUpdatedAt: now - STALE_SESSION_RECOVERY_MS - 1,
        latestAssistant: { finish: "stop", completedAt: now - STALE_SESSION_RECOVERY_MS - 1, updatedAt: now - STALE_SESSION_RECOVERY_MS - 1 },
        now,
      }),
    ).toBe(false)
  })
})
