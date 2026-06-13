import { describe, expect, test } from "bun:test"
import {
  formatAgentViewSessionTime,
  isAgentViewSessionFallbackVisible,
  isAgentViewSessionVisible,
  isTemporaryAgentViewDirectory,
  type AgentViewBackgroundSession,
} from "../../../src/cli/cmd/tui/util/agent-view"

const now = 1_800_000_000_000

describe("Agent View visibility", () => {
  test("formats welcome timestamps with date context", () => {
    const current = Date.UTC(2026, 5, 13, 18, 0, 0)
    const today = Date.UTC(2026, 5, 13, 15, 30, 0)
    const previousMonth = Date.UTC(2026, 4, 10, 15, 30, 0)
    const previousYear = Date.UTC(2025, 5, 13, 15, 30, 0)

    expect(formatAgentViewSessionTime(today, current)).toBe(new Date(today).toLocaleTimeString(undefined, { timeStyle: "short" }))
    expect(formatAgentViewSessionTime(previousMonth, current)).toBe(
      `${new Date(previousMonth).toLocaleTimeString(undefined, { timeStyle: "short" })} · ${new Date(
        previousMonth,
      ).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`,
    )
    expect(formatAgentViewSessionTime(previousYear, current)).toBe(
      `${new Date(previousYear).toLocaleTimeString(undefined, { timeStyle: "short" })} · ${new Date(
        previousYear,
      ).toLocaleDateString(undefined, { day: "numeric", month: "numeric", year: "numeric" })}`,
    )
  })

  test("detects temp and test directories", () => {
    expect(isTemporaryAgentViewDirectory("/private/var/folders/wk/opencode-test-123")).toBe(true)
    expect(isTemporaryAgentViewDirectory("/tmp/mendcode-test-123")).toBe(true)
    expect(isTemporaryAgentViewDirectory("/Users/obed/Code/MendCode")).toBe(false)
  })

  test("hides temp sessions before active state classification", () => {
    const completed = item({
      state: "completed",
      directory: "/private/var/folders/wk/opencode-test-123",
    })
    expect(isAgentViewSessionVisible({ item: completed, now })).toBe(false)
    expect(isAgentViewSessionVisible({ item: item({ ...completed.background, state: "working" }), now })).toBe(false)
    expect(isAgentViewSessionVisible({ item: item({ ...completed.background, pinned: true }), now })).toBe(true)
  })

  test("keeps recent real completed sessions and hides orphan completed rows", () => {
    expect(
      isAgentViewSessionVisible({
        item: item({ state: "completed", directory: "/Users/obed/Code/MendCode", updated: now - 1_000 }),
        now,
      }),
    ).toBe(true)
    expect(isAgentViewSessionVisible({ item: item({ state: "completed", session: null }), now })).toBe(false)
  })

  test("allows old real sessions only as the empty-recent fallback", () => {
    const oldSession = item({
      state: "completed",
      directory: "/Users/obed/Code/TerraPredict",
      updated: now - 25 * 60 * 60 * 1_000,
    })
    const tempSession = item({
      state: "completed",
      directory: "/private/var/folders/wk/opencode-test-123",
      updated: now - 25 * 60 * 60 * 1_000,
    })

    expect(isAgentViewSessionVisible({ item: oldSession, now })).toBe(false)
    expect(isAgentViewSessionFallbackVisible(oldSession)).toBe(true)
    expect(isAgentViewSessionFallbackVisible(tempSession)).toBe(false)
    expect(isAgentViewSessionFallbackVisible(item({ state: "completed", session: null }))).toBe(false)
  })
})

function item(
  input: Partial<AgentViewBackgroundSession> & {
    directory?: string
    updated?: number
  },
) {
  const background: AgentViewBackgroundSession = {
    sessionID: input.sessionID ?? "ses_test",
    state: input.state ?? "completed",
    summary: input.summary,
    error: input.error,
    pinned: input.pinned,
    time: {
      created: input.time?.created ?? now - 2_000,
      updated: input.updated ?? input.time?.updated ?? now - 1_000,
    },
    session:
      input.session === null
        ? null
        : {
            id: input.session?.id ?? "ses_test",
            title: input.session?.title ?? "test session",
            directory: input.directory ?? input.session?.directory ?? "/Users/obed/Code/MendCode",
            path: input.session?.path,
            agent: input.session?.agent,
            time: input.session?.time ?? { created: now - 2_000, updated: now - 1_000 },
          },
  }
  return { background }
}
