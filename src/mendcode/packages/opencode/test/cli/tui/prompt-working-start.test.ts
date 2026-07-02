import { describe, expect, test } from "bun:test"
import {
  promptCursorEndOffset,
  promptCursorOffsetAfterArrow,
  resolveWorkingStartedAt,
  shouldClearWorkingStartedAt,
  shouldEnableSessionInterrupt,
  shouldHandlePromptCursorArrow,
  shouldInterruptImmediately,
} from "@/cli/cmd/tui/component/prompt"
import {
  latestFullSessionHistoryStartID,
  sessionHasLocalQueuedTurn,
  shouldUseSimpleSessionHistory,
} from "@/cli/cmd/tui/routes/session"
import { loopWorkflowListCacheKey } from "@/cli/cmd/tui/routes/loops"

describe("resolveWorkingStartedAt", () => {
  test("keeps the original assistant start when a follower already stored a local start", () => {
    expect(
      resolveWorkingStartedAt({
        stored: 1_000,
        activeAssistantCreated: 100,
        fallback: 2_000,
      }),
    ).toBe(100)
  })

  test("falls back to stored or local start when active assistant history is not loaded yet", () => {
    expect(resolveWorkingStartedAt({ stored: 1_000, fallback: 2_000 })).toBe(1_000)
    expect(resolveWorkingStartedAt({ sessionUpdated: 1_500, fallback: 2_000 })).toBe(1_500)
    expect(resolveWorkingStartedAt({ fallback: 2_000 })).toBe(2_000)
  })

  test("does not clear the working start during transient idle snapshots", () => {
    expect(shouldClearWorkingStartedAt({ statusType: "idle" })).toBe(true)
    expect(shouldClearWorkingStartedAt({ statusType: "idle", hasActiveWorkingAssistant: true })).toBe(false)
    expect(shouldClearWorkingStartedAt({ statusType: "idle", permissionPending: true })).toBe(false)
    expect(shouldClearWorkingStartedAt({ statusType: "busy" })).toBe(false)
  })

  test("keeps interrupt enabled for orphaned unfinished assistant messages", () => {
    expect(shouldEnableSessionInterrupt({ statusType: "busy" })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "busy", autocompleteVisible: true })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "retry" })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "idle" })).toBe(false)
    expect(shouldEnableSessionInterrupt({ statusType: "idle", hasActiveWorkingAssistant: true })).toBe(true)
    expect(
      shouldEnableSessionInterrupt({
        statusType: "idle",
        hasActiveWorkingAssistant: true,
        autocompleteVisible: true,
      }),
    ).toBe(false)
  })

  test("interrupts immediately only while the session is actively busy", () => {
    expect(shouldInterruptImmediately({ statusType: "busy" })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "retry" })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "idle" })).toBe(false)
  })

  test("keeps plain left and right arrows available for prompt cursor movement", () => {
    expect(shouldHandlePromptCursorArrow({ name: "left", ctrl: false, meta: false, shift: false, super: false })).toBe(true)
    expect(shouldHandlePromptCursorArrow({ name: "right", ctrl: false, meta: false, shift: false, super: false })).toBe(true)
    expect(shouldHandlePromptCursorArrow({ name: "left", ctrl: true, meta: false, shift: false, super: false })).toBe(false)
    expect(shouldHandlePromptCursorArrow({ name: "up", ctrl: false, meta: false, shift: false, super: false })).toBe(false)

    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 0, direction: "left" })).toBe(0)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 1, direction: "left" })).toBe(0)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 1, direction: "right" })).toBe(2)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 3, direction: "right" })).toBe(3)
    expect(promptCursorEndOffset("好a")).toBe(3)
    expect(promptCursorOffsetAfterArrow({ text: "好a", cursorOffset: 2, direction: "right" })).toBe(3)
  })

  test("keeps follow sync alive when a queued user turn trails an unfinished assistant", () => {
    expect(
      sessionHasLocalQueuedTurn({
        pendingAssistantID: "msg_002",
        messages: [{ id: "msg_001" }, { id: "msg_002" }, { id: "msg_003" }],
      }),
    ).toBe(true)
    expect(
      sessionHasLocalQueuedTurn({
        pendingAssistantID: "msg_002",
        messages: [{ id: "msg_001" }, { id: "msg_002" }],
      }),
    ).toBe(false)
  })

  test("does not simplify normal history just because a newer user turn exists", () => {
    const messages = [
      { id: "msg_001", role: "user" as const, time: { completed: 1 } },
      { id: "msg_002", role: "assistant" as const, time: { completed: 2 } },
      { id: "msg_003", role: "user" as const, time: { completed: 3 } },
      { id: "msg_004", role: "assistant" as const, time: { completed: 4 } },
    ]
    const fullStartID = latestFullSessionHistoryStartID(messages)

    expect(fullStartID).toBeUndefined()
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_002", fullStartID })).toBe(false)
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_003", fullStartID })).toBe(false)
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_004", fullStartID })).toBe(false)
  })

  test("simplifies only history before the latest compaction summary", () => {
    const messages = [
      { id: "msg_001", role: "user" as const, time: { completed: 1 } },
      { id: "msg_002", role: "assistant" as const, parentID: "msg_001", time: { completed: 2 } },
      { id: "msg_003", role: "user" as const, time: { completed: 3 } },
      { id: "msg_004", role: "assistant" as const, parentID: "msg_003", summary: true, time: { completed: 4 } },
      { id: "msg_005", role: "user" as const, time: { completed: 5 } },
    ]
    const fullStartID = latestFullSessionHistoryStartID(messages)

    expect(fullStartID).toBe("msg_004")
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_002", fullStartID })).toBe(true)
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_003", fullStartID })).toBe(true)
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_004", fullStartID })).toBe(false)
    expect(shouldUseSimpleSessionHistory({ messageID: "msg_005", fullStartID })).toBe(false)
  })

  test("keeps unfinished assistant tools visible even when a newer queued user exists", () => {
    const messages = [
      { id: "msg_001", role: "user" as const, time: { completed: 1 } },
      { id: "msg_002", role: "assistant" as const, time: { completed: 2 } },
      { id: "msg_003", role: "user" as const, time: { completed: 3 } },
      { id: "msg_004", role: "assistant" as const, time: { completed: undefined } },
      { id: "msg_005", role: "user" as const, time: { completed: 5 } },
    ]

    expect(latestFullSessionHistoryStartID(messages)).toBeUndefined()
  })

  test("separates loop list cache entries by project directory and worktree", () => {
    expect(loopWorkflowListCacheKey({})).toBeUndefined()
    expect(loopWorkflowListCacheKey({ directory: "/repo", worktree: "/repo/.wt/a" })).not.toBe(
      loopWorkflowListCacheKey({ directory: "/repo", worktree: "/repo/.wt/b" }),
    )
    expect(loopWorkflowListCacheKey({ directory: "/repo" })).not.toBe(
      loopWorkflowListCacheKey({ worktree: "/repo/.wt/a" }),
    )
  })

})
