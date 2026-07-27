import { describe, expect, test } from "bun:test"
import {
  formatAgentViewDetailLabel,
  formatAgentViewCommandSummary,
  formatAgentViewPathLabel,
  formatAgentViewSessionTime,
  countAgentViewCommands,
  formatAgentViewOrchestrationSummary,
  agentViewCommandTouchesSession,
  agentViewLoopRootSessionIDs,
  filterAgentViewLoopSessions,
  isAgentViewCompletedLoop,
  isAgentViewLoopSession,
  isAgentViewCommandActionable,
  isAgentViewSessionFallbackVisible,
  isAgentViewSessionVisible,
  isTemporaryAgentViewDirectory,
  summarizeAgentViewOrchestration,
  type AgentViewCommand,
  type AgentViewBackgroundSession,
} from "../../../src/cli/cmd/tui/util/agent-view"

const now = 1_800_000_000_000

describe("Agent View visibility", () => {
  test("formats welcome timestamps with date context", () => {
    const current = Date.UTC(2026, 5, 13, 18, 0, 0)
    const today = Date.UTC(2026, 5, 13, 15, 30, 0)
    const previousMonth = Date.UTC(2026, 4, 10, 15, 30, 0)
    const previousYear = Date.UTC(2025, 5, 13, 15, 30, 0)

    expect(formatAgentViewSessionTime(today, current)).toBe(
      `Today · ${new Date(today).toLocaleTimeString(undefined, { timeStyle: "short" })}`,
    )
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

  test("compacts path-like details to parent folder and base name", () => {
    expect(formatAgentViewPathLabel("/Users/obed/Code/MendCode")).toBe("Code/MendCode")
    expect(formatAgentViewPathLabel("/Users/obed/Code/MendCode/")).toBe("Code/MendCode")
    expect(formatAgentViewPathLabel("/tmp/mendcode-test-123/session.log")).toBe("mendcode-test-123/session.log")
    expect(formatAgentViewPathLabel("C:\\Users\\obed\\Code\\MendCode")).toBe("Code/MendCode")
    expect(formatAgentViewDetailLabel("/Users/obed/Code/MendCode")).toBe("Code/MendCode")
    expect(formatAgentViewDetailLabel("Loop active: ready")).toBe("Loop active: ready")
  })

  test("keeps every workflow root classified as a loop, including paused and old manual roots", () => {
    const roots = agentViewLoopRootSessionIDs([
      { rootSessionID: "ses_paused_manual" },
      { rootSessionID: "ses_old_manual" },
      { rootSessionID: undefined },
    ])

    expect(isAgentViewLoopSession({ sessionID: "ses_paused_manual", title: "A normal-looking title", loopRootSessionIDs: roots })).toBe(true)
    expect(isAgentViewLoopSession({ sessionID: "ses_old_manual", title: "Another title", loopRootSessionIDs: roots })).toBe(true)
    expect(isAgentViewLoopSession({ sessionID: "ses_title_fallback", title: "Loop: legacy root", loopRootSessionIDs: roots })).toBe(true)
    expect(isAgentViewLoopSession({ sessionID: "ses_summary_fallback", title: "legacy root", summary: "Loop paused: paused", loopRootSessionIDs: roots })).toBe(true)
  })

  test("filters loop roots out of the regular session list", () => {
    const roots = agentViewLoopRootSessionIDs([{ rootSessionID: "ses_loop" }])
    const sessions = [
      { id: "ses_loop", title: "Manual loop" },
      { id: "ses_legacy", title: "Loop: old root" },
      { id: "ses_chat", title: "Normal chat" },
    ]

    expect(filterAgentViewLoopSessions(sessions, roots)).toEqual([{ id: "ses_chat", title: "Normal chat" }])
  })

  test("identifies completed loop rows without hiding failed or paused loops", () => {
    expect(isAgentViewCompletedLoop({ state: "completed" })).toBe(true)
    expect(isAgentViewCompletedLoop({ summary: "Loop completed: completed" })).toBe(true)
    expect(isAgentViewCompletedLoop({ state: "failed", summary: "Loop failed: terminal" })).toBe(false)
    expect(isAgentViewCompletedLoop({ state: "paused", summary: "Loop paused: paused" })).toBe(false)
  })

  test("hides completed temp sessions but keeps active or awaiting rows", () => {
    const completed = item({
      state: "completed",
      directory: "/private/var/folders/wk/opencode-test-123",
    })
    expect(isAgentViewSessionVisible({ item: completed, now })).toBe(false)
    expect(isAgentViewSessionVisible({ item: item({ ...completed.background, state: "working" }), now })).toBe(true)
    expect(isAgentViewSessionVisible({ item: item({ ...completed.background, state: "needs_input" }), now })).toBe(true)
    expect(isAgentViewSessionVisible({ item: completed, pendingInput: 1, now })).toBe(true)
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

  test("keeps old sessions visible while commands are still active or blocked", () => {
    const oldSession = item({
      state: "completed",
      directory: "/Users/obed/Code/TerraPredict",
      updated: now - 25 * 60 * 60 * 1_000,
    })

    expect(isAgentViewSessionVisible({ item: oldSession, now })).toBe(false)
    expect(isAgentViewSessionVisible({ item: oldSession, activeCommands: 1, now })).toBe(true)
    expect(isAgentViewSessionVisible({ item: oldSession, blockedCommands: 1, now })).toBe(true)
  })

  test("keeps pinned or active archived sessions visible while hiding archived completed rows", () => {
    expect(isAgentViewSessionVisible({ item: item({ state: "completed", metadata: { archived: true } }), now })).toBe(false)
    expect(
      isAgentViewSessionVisible({
        item: item({ state: "completed", metadata: { archived: true, pinned: true } }),
        now,
      }),
    ).toBe(true)
    expect(isAgentViewSessionVisible({ item: item({ state: "working", metadata: { archived: true } }), now })).toBe(true)
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

  test("summarizes and counts command inbox state for Agent View rows", () => {
    const pending = command({ id: "acmd_1", targetSessionID: "ses_worker", type: "rename", payload: { title: "Worker Alpha" } })
    const accepted = command({ id: "acmd_2", targetSessionID: "ses_worker", state: "accepted", type: "tag", payload: { tags: ["api"] } })
    const other = command({ id: "acmd_3", targetSessionID: "ses_other" })

    expect(isAgentViewCommandActionable(pending)).toBe(true)
    expect(isAgentViewCommandActionable(accepted)).toBe(false)
    expect(agentViewCommandTouchesSession({ command: pending, sessionID: "ses_worker" })).toBe(true)
    expect(agentViewCommandTouchesSession({ command: pending, sessionID: "ses_source" })).toBe(false)
    expect(agentViewCommandTouchesSession({ command: pending, sessionID: "ses_source", direction: "either" })).toBe(true)
    expect(agentViewCommandTouchesSession({ command: pending, sessionID: "ses_else", direction: "either" })).toBe(false)
    expect(countAgentViewCommands({ commands: [pending, accepted, other], sessionID: "ses_worker", states: ["pending"] })).toBe(1)
    expect(countAgentViewCommands({ commands: [pending, accepted, other], sessionID: "ses_worker" })).toBe(2)
    expect(countAgentViewCommands({ commands: [pending, accepted, other], sessionID: "ses_source", direction: "either" })).toBe(3)
    expect(formatAgentViewCommandSummary(pending)).toBe("pending · rename row · Worker Alpha")
    expect(formatAgentViewCommandSummary(accepted)).toBe("accepted · update tags · #api")
    expect(formatAgentViewCommandSummary(command({ type: "send_message", payload: { text: "Ship next safe step" } }))).toBe(
      "pending · send message · Ship next safe step",
    )
    expect(formatAgentViewCommandSummary(command({ type: "stop", payload: { reason: "handoff" } }))).toBe(
      "pending · stop worker · handoff",
    )
  })

  test("collapses multiline command instructions into one safe preview line", () => {
    expect(
      formatAgentViewCommandSummary(
        command({
          type: "request_summary",
          payload: { instructions: "Summarize latest run\n\nInclude failures\tand next steps" },
        }),
      ),
    ).toBe("pending · request summary · Summarize latest run Include failures and next steps")
  })

  test("summarizes orchestration command status board with explicit pending limits", () => {
    const summary = summarizeAgentViewOrchestration({
      sessionIDs: ["ses_worker", "ses_other"],
      pendingLimitPerTarget: 2,
      commands: [
        command({ id: "acmd_1", targetSessionID: "ses_worker" }),
        command({ id: "acmd_2", targetSessionID: "ses_worker" }),
        command({ id: "acmd_3", targetSessionID: "ses_worker" }),
        command({ id: "acmd_4", targetSessionID: "ses_worker", state: "running" }),
        command({ id: "acmd_5", targetSessionID: "ses_worker", state: "completed" }),
        command({ id: "acmd_6", targetSessionID: "ses_other", state: "failed" }),
        command({ id: "acmd_7", targetSessionID: "ses_hidden" }),
      ],
    })

    expect(summary).toEqual({
      pending: 3,
      active: 1,
      completed: 1,
      blocked: 1,
      pendingCapacity: 4,
      overLimitTargets: 1,
    })
    expect(formatAgentViewOrchestrationSummary(summary)).toBe(
      "Coordinator commands · 3/4 queued · 1 over limit · 1 running · 1 done · 1 blocked",
    )
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
    process: input.process,
    metadata: input.metadata,
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

function command(input: Partial<AgentViewCommand>): AgentViewCommand {
  return {
    id: input.id ?? "acmd_test",
    sourceSessionID: input.sourceSessionID ?? "ses_source",
    targetSessionID: input.targetSessionID ?? "ses_target",
    type: input.type ?? "request_summary",
    payload: input.payload ?? {},
    permissions: input.permissions ?? [],
    state: input.state ?? "pending",
    time: input.time ?? { created: now - 2_000, updated: now - 1_000 },
  }
}
