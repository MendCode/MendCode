import { describe, expect, test } from "bun:test"
import {
  isAssistantWorking,
  displayConnectionStatus,
  knownAgentActivityConnectionLabel,
  retryStatusMessage,
  isBusyStatusSupersededByTerminalAssistant,
  terminalAssistantSettlesActivity,
  isRecentWorkingAssistant,
  isStaleBusySession,
  isSubagentStatusActive,
  isToolActivityActive,
  sessionStatusExpiryDelay,
  shouldKeepCompactedSubagent,
  shouldShowAgentStateUnknown,
  STALE_BUSY_SESSION_WINDOW_MS,
} from "@/cli/cmd/tui/util/session-working"

describe("displayConnectionStatus", () => {
  test("labels a connected transport that is still recovering", () => {
    expect(displayConnectionStatus({ status: "connected", recoveringSince: 123 })).toBe("reconnecting")
    expect(displayConnectionStatus({ status: "connected" })).toBe("connected")
    expect(displayConnectionStatus({ status: "failed", recoveringSince: 123 })).toBe("failed")
  })
})

describe("retryStatusMessage", () => {
  test("identifies provider network retries in the activity line", () => {
    expect(retryStatusMessage("Network connection lost")).toBe("retrying AI backend: Network connection lost")
    expect(retryStatusMessage("TypeError: Failed to fetch")).toBe("retrying AI backend: TypeError: Failed to fetch")
    expect(retryStatusMessage("Provider is overloaded")).toBe("Provider is overloaded")
    expect(retryStatusMessage()).toBe("retrying AI backend")
  })
})

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

  test("distinguishes snapshot staleness from live busy activity", () => {
    expect(sessionStatusExpiryDelay({ type: "busy" }, 100_000)).toBe(STALE_BUSY_SESSION_WINDOW_MS + 1)
    expect(sessionStatusExpiryDelay({ type: "busy" }, 100_000, "live")).toBeUndefined()
    expect(sessionStatusExpiryDelay({ type: "busy", until: 101_000 }, 100_000)).toBe(1_001)
    expect(sessionStatusExpiryDelay({ type: "busy", until: 101_000 }, 100_000, "live")).toBe(1_001)
    expect(sessionStatusExpiryDelay({ type: "retry", attempt: 1, message: "wait", next: 101_000 }, 100_000)).toBe(1_001)
    expect(
      sessionStatusExpiryDelay(
        { type: "retry", attempt: 1, message: "wait", next: 99_000, heartbeatAt: 99_999 },
        100_000,
        "live",
      ),
    ).toBe(STALE_BUSY_SESSION_WINDOW_MS)
    expect(sessionStatusExpiryDelay({ type: "idle" }, 100_000)).toBeUndefined()
  })
})

describe("isToolActivityActive", () => {
  test("keeps long-running tools active while the live session remains busy", () => {
    expect(isToolActivityActive({ toolStatus: "running", sessionStatusType: "busy" })).toBe(true)
    expect(isToolActivityActive({ toolStatus: "pending", sessionStatusType: "retry" })).toBe(true)
  })

  test("stops tool animation after an idle status or local interrupt", () => {
    expect(isToolActivityActive({ toolStatus: "running", sessionStatusType: "idle" })).toBe(false)
    expect(isToolActivityActive({ toolStatus: "running", sessionStatusType: "busy", interrupted: true })).toBe(false)
    expect(isToolActivityActive({ toolStatus: "completed", sessionStatusType: "busy" })).toBe(false)
  })

  test("allows active detached children to animate a completed parent task", () => {
    expect(
      isToolActivityActive({
        toolStatus: "completed",
        sessionStatusType: "idle",
        activityOverride: true,
      }),
    ).toBe(true)
  })
})

describe("isAssistantWorking", () => {
  test("does not revive an old unfinished assistant after reconnect", () => {
    expect(
      isAssistantWorking({
        now: 100_000,
        assistantCreated: 1_000,
      }),
    ).toBe(false)
  })

  test("trusts a fresh busy status while allowing stale status to expire", () => {
    expect(isAssistantWorking({ statusType: "busy", now: 100_000, assistantCreated: 1_000 })).toBe(false)
    expect(
      isAssistantWorking({ statusType: "busy", now: 100_000, assistantCreated: 1_000, statusUntil: 101_000 }),
    ).toBe(true)
  })

  test("keeps long reasoning visible when the runtime heartbeat is fresh", () => {
    expect(
      isAssistantWorking({
        statusType: "busy",
        now: 100_000,
        assistantCreated: 1_000,
        statusHeartbeatAt: 99_999,
      }),
    ).toBe(true)
  })

  test("keeps retry activity visible after its scheduled attempt while heartbeat is fresh", () => {
    expect(
      isAssistantWorking({
        statusType: "retry",
        statusNext: 90_000,
        statusHeartbeatAt: 99_999,
        now: 100_000,
      }),
    ).toBe(true)
  })

  test("keeps a stale-aged busy assistant visible while its tool is still active", () => {
    expect(
      isAssistantWorking({
        statusType: "busy",
        now: 100_000,
        assistantCreated: 1_000,
        hasActiveTool: true,
      }),
    ).toBe(true)
    expect(
      isAssistantWorking({
        statusType: "idle",
        now: 100_000,
        assistantCreated: 1_000,
        hasActiveTool: true,
      }),
    ).toBe(false)
  })

  test("keeps compaction visibly active even after the normal busy window", () => {
    expect(
      isAssistantWorking({
        statusType: "busy",
        statusKind: "compaction",
        now: 100_000,
        assistantCreated: 1_000,
      }),
    ).toBe(true)
  })
})

describe("terminal busy reconciliation", () => {
  const terminal = { role: "assistant", finish: "stop", time: { created: 200, completed: 300 } }

  test("suppresses only a busy status that predates the terminal assistant", () => {
    expect(
      isBusyStatusSupersededByTerminalAssistant({
        statusType: "busy",
        statusStartedAt: 100,
        latestMessage: terminal,
      }),
    ).toBe(true)
    expect(
      isBusyStatusSupersededByTerminalAssistant({
        statusType: "busy",
        statusStartedAt: 400,
        latestMessage: terminal,
      }),
    ).toBe(false)
  })

  test("preserves active continuations and compaction", () => {
    expect(
      isBusyStatusSupersededByTerminalAssistant({
        statusType: "busy",
        statusStartedAt: 100,
        latestMessage: { ...terminal, finish: "tool-calls" },
      }),
    ).toBe(false)
    expect(
      isBusyStatusSupersededByTerminalAssistant({
        statusType: "busy",
        statusKind: "compaction",
        statusStartedAt: 100,
        latestMessage: terminal,
      }),
    ).toBe(false)
  })

  test("clears a stale busy flag when a terminal response has no startedAt", () => {
    expect(
      isBusyStatusSupersededByTerminalAssistant({
        statusType: "busy",
        latestMessage: terminal,
      }),
    ).toBe(true)
  })

  test("clears stale retry/reconnect activity after a terminal final response", () => {
    expect(
      terminalAssistantSettlesActivity({
        statusType: "retry",
        latestMessage: terminal,
        hasActiveTool: false,
      }),
    ).toBe(true)
  })

  test("treats a completed assistant without finish metadata as terminal", () => {
    expect(
      terminalAssistantSettlesActivity({
        statusType: "busy",
        latestMessage: { role: "assistant", time: { created: 200, completed: 300 } },
        hasActiveTool: false,
      }),
    ).toBe(true)
  })

  test("clears a stale busy flag even when its recovery startedAt is older than the final response", () => {
    expect(
      terminalAssistantSettlesActivity({
        statusType: "busy",
        statusStartedAt: 1,
        latestMessage: terminal,
        hasActiveTool: false,
      }),
    ).toBe(true)
  })

  test("keeps the activity indicator when the terminal-looking response still owns a running tool", () => {
    expect(
      terminalAssistantSettlesActivity({
        statusType: "busy",
        statusStartedAt: 100,
        latestMessage: terminal,
        hasActiveTool: true,
      }),
    ).toBe(false)
  })
})

describe("compacted subagents", () => {
  test("keeps an earlier compacted task visible while its child is active", () => {
    expect(isSubagentStatusActive("working")).toBe(true)
    expect(shouldKeepCompactedSubagent({ compacted: true, status: "working" })).toBe(true)
    expect(shouldKeepCompactedSubagent({ compacted: true, status: "retry #2" })).toBe(true)
  })

  test("hides completed compacted tasks without hiding current history", () => {
    expect(shouldKeepCompactedSubagent({ compacted: true, status: "responded" })).toBe(false)
    expect(shouldKeepCompactedSubagent({ compacted: false, status: "responded" })).toBe(true)
  })
})

describe("shouldShowAgentStateUnknown", () => {
  test("hides an orphaned assistant warning after reconnect", () => {
    expect(shouldShowAgentStateUnknown({ connectionStatus: "connected", hasUncertainAgentState: true })).toBe(false)
    expect(shouldShowAgentStateUnknown({ connectionStatus: "disconnected", hasUncertainAgentState: true })).toBe(true)
  })

  test("keeps known live activity visible while the transport reconciles", () => {
    expect(
      shouldShowAgentStateUnknown({
        connectionStatus: "reconnecting",
        hasUncertainAgentState: true,
        hasKnownAgentActivity: true,
      }),
    ).toBe(false)
    expect(
      knownAgentActivityConnectionLabel({
        connectionStatus: "reconnecting",
        hasKnownAgentActivity: true,
        attempt: 2,
      }),
    ).toBe("syncing connection #2...")
  })

  test("does not claim known activity after a hard disconnect", () => {
    expect(
      shouldShowAgentStateUnknown({
        connectionStatus: "disconnected",
        hasUncertainAgentState: true,
        hasKnownAgentActivity: true,
      }),
    ).toBe(true)
    expect(
      knownAgentActivityConnectionLabel({
        connectionStatus: "disconnected",
        hasKnownAgentActivity: true,
      }),
    ).toBeUndefined()
  })
})
