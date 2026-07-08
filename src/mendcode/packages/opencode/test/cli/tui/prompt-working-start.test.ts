import { describe, expect, test } from "bun:test"
import {
  promptCursorEndOffset,
  promptCursorOffsetAfterArrow,
  promptCursorOffsetFromMouse,
  mergeOptimisticUserParts,
  optimisticUserMessage,
  supplementalSlashPromptParts,
  optimisticUserParts,
  promptHistoryMatchesCurrent,
  resolveWorkingStartedAt,
  shouldAcceptPromptInterruptFocus,
  shouldAttemptPromptHistoryNavigation,
  shouldClearWorkingStartedAt,
  shouldEnableSessionInterrupt,
  shouldHandlePromptCursorArrow,
  shouldInterruptImmediately,
  shouldPreferMessagePromptHistory,
  shouldSnapPromptCursorToEnd,
  shouldUseStoredPromptHistoryFallback,
} from "@/cli/cmd/tui/component/prompt"
import {
  latestFullSessionHistoryStartID,
  sessionHasLocalQueuedTurn,
  sessionUserPromptHistory,
  submittedPromptViewportHoldRows,
  shouldReleaseSessionPagingBoundarySuppression,
  shouldRestoreSessionScrollAnchor,
  shouldUseSimpleSessionHistory,
} from "@/cli/cmd/tui/routes/session"
import { loopWorkflowListCacheKey } from "@/cli/cmd/tui/routes/loops"
import { statsCacheNeedsRefresh, statsDayTokenValue, statsDayVisualValue, statsGraphSeries, statsSelectedDayIndex } from "@/cli/cmd/tui/routes/stats"
import type { DailyUsage } from "@/cli/cmd/tui/util/usage-insights"

describe("optimistic user turn", () => {
  test("uses the submitted ids so backend sync reconciles instead of duplicating", () => {
    expect(
      optimisticUserMessage({
        sessionID: "ses_001",
        messageID: "msg_002",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        variant: "high",
        created: 123,
      }),
    ).toMatchObject({
      id: "msg_002",
      sessionID: "ses_001",
      role: "user",
      time: { created: 123 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test", variant: "high" },
    })

    expect(
      optimisticUserParts({
        sessionID: "ses_001",
        messageID: "msg_002",
        parts: [{ id: "prt_003", type: "text", text: "hello" }],
      }),
    ).toEqual([{ id: "prt_003", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "hello" }])
  })

  test("merges optimistic parts with early backend parts without duplicates", () => {
    expect(
      mergeOptimisticUserParts({
        current: [{ id: "prt_002", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "backend" }],
        optimistic: [
          { id: "prt_001", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "typed" },
          { id: "prt_002", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "optimistic duplicate" },
        ],
      }),
    ).toEqual([
      { id: "prt_001", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "typed" },
      { id: "prt_002", sessionID: "ses_001", messageID: "msg_002", type: "text", text: "backend" },
    ])
  })

  test("keeps synthetic pasted context on skill slash submission", () => {
    expect(
      supplementalSlashPromptParts([
        { id: "prt_001", type: "text", text: "/skill summarize this" },
        {
          id: "prt_002",
          type: "text",
          text: "full pasted body",
          synthetic: true,
          metadata: { kind: "pasted_content", chars: 16 },
        },
        { id: "prt_003", type: "file", mime: "text/plain", text: "attachment" },
      ]),
    ).toEqual([
      {
        id: "prt_002",
        type: "text",
        text: "full pasted body",
        synthetic: true,
        metadata: { kind: "pasted_content", chars: 16 },
      },
      { id: "prt_003", type: "file", mime: "text/plain", text: "attachment" },
    ])
  })
})

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

  test("interrupts immediately only while the session is actively busy without a local draft", () => {
    expect(shouldInterruptImmediately({ statusType: "busy" })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "retry" })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "busy", hasDraft: true })).toBe(false)
    expect(shouldInterruptImmediately({ statusType: "retry", hasDraft: true })).toBe(false)
    expect(shouldInterruptImmediately({ statusType: "idle" })).toBe(false)
  })

  test("accepts prompt interrupt only when the prompt textarea owns focus", () => {
    const promptInput = {}
    const arcadeInput = {}
    expect(shouldAcceptPromptInterruptFocus({ inputFocused: true, currentFocusedRenderable: promptInput, promptInput })).toBe(true)
    expect(shouldAcceptPromptInterruptFocus({ inputFocused: true, currentFocusedRenderable: arcadeInput, promptInput })).toBe(false)
    expect(shouldAcceptPromptInterruptFocus({ inputFocused: false, currentFocusedRenderable: promptInput, promptInput })).toBe(false)
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
    expect(promptCursorEndOffset("line 1\nline 2")).toBe("line 1\nline 2".length)
    expect(promptCursorEndOffset("好a")).toBe("好a".length)
    expect(promptCursorOffsetAfterArrow({ text: "好a", cursorOffset: 2, direction: "right" })).toBe(2)
  })

  test("syncs mouse-click prompt cursor offset to the visual cursor position", () => {
    expect(promptCursorOffsetFromMouse({ text: "abc", visualOffset: 1 })).toBe(1)
    expect(promptCursorOffsetFromMouse({ text: "abc", visualOffset: -5 })).toBe(0)
    expect(promptCursorOffsetFromMouse({ text: "abc", visualOffset: 99 })).toBe(3)
    expect(promptCursorOffsetFromMouse({ text: "好a", visualOffset: 2 })).toBe(2)
    expect(promptCursorOffsetFromMouse({ text: "好a", visualOffset: 9 })).toBe(2)
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

  test("uses stored history only when the route does not supply session-scoped history", () => {
    expect(shouldUseStoredPromptHistoryFallback({ historyItems: () => [], messageHistoryCount: 0 })).toBe(false)
    expect(shouldUseStoredPromptHistoryFallback({ historyItems: () => [{ input: "loaded", parts: [] }], messageHistoryCount: 1 })).toBe(false)
    expect(shouldUseStoredPromptHistoryFallback({})).toBe(true)
  })

  test("keeps ArrowDown in message history mode after ArrowUp recalls a prompt", () => {
    expect(
      shouldPreferMessagePromptHistory({
        direction: -1,
        currentPromptMatchesHistory: promptHistoryMatchesCurrent({
          currentPrompt: { input: "", parts: [] },
          currentMode: "normal",
          historyIndex: 0,
        }),
      }),
    ).toBe(true)
    expect(shouldAttemptPromptHistoryNavigation({ direction: 1, cursorOffset: 0, text: "recalled" })).toBe(false)
    expect(shouldAttemptPromptHistoryNavigation({ direction: 1, cursorOffset: 8, text: "recalled" })).toBe(true)
    expect(
      shouldAttemptPromptHistoryNavigation({
        direction: 1,
        cursorOffset: 9,
        text: "attach [Image 1]",
        parts: [
          {
            type: "text",
            text: "image placeholder",
            source: {
              text: {
                start: 7,
                end: 16,
                value: "[Image 1]",
              },
            },
          },
        ],
      }),
    ).toBe(true)
    expect(shouldAttemptPromptHistoryNavigation({ direction: 1, cursorOffset: 5, text: "line 1\nline 2" })).toBe(false)
    expect(shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 0, height: 2 })).toBe(false)
    expect(shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 1, height: 2 })).toBe(true)
    expect(shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 1, height: 6 })).toBe(true)
    expect(shouldAttemptPromptHistoryNavigation({ direction: 1, cursorOffset: promptCursorEndOffset("line 1\nline 2"), text: "line 1\nline 2" })).toBe(true)
    expect(shouldAttemptPromptHistoryNavigation({ direction: -1, cursorOffset: 0, text: "line 1\nline 2" })).toBe(true)
    expect(
      shouldPreferMessagePromptHistory({
        direction: 1,
        currentPromptMatchesHistory: promptHistoryMatchesCurrent({
          currentPrompt: { input: "recalled", parts: [] },
          currentMode: "normal",
          historyIndex: -1,
          historyPrompt: { input: "recalled", parts: [] },
        }),
      }),
    ).toBe(true)
    expect(
      shouldPreferMessagePromptHistory({
        direction: 1,
        currentPromptMatchesHistory: promptHistoryMatchesCurrent({
          currentPrompt: { input: "edited", parts: [] },
          currentMode: "normal",
          historyIndex: -1,
          historyPrompt: { input: "recalled", parts: [] },
        }),
      }),
    ).toBe(false)
    expect(
      promptHistoryMatchesCurrent({
        currentPrompt: {
          input: "attach [Image 1]",
          parts: [
            {
              type: "text",
              text: "image placeholder",
              source: {
                text: {
                  start: 8,
                  end: 17,
                  value: "[Image 1]",
                },
              },
            },
          ],
        },
        currentMode: "normal",
        historyIndex: -1,
        historyPrompt: {
          input: "attach [Image 1]",
          parts: [
            {
              type: "text",
              text: "image placeholder",
              source: {
                text: {
                  start: 7,
                  end: 16,
                  value: "[Image 1]",
                },
              },
            },
          ],
        },
      }),
    ).toBe(true)
    expect(
      shouldPreferMessagePromptHistory({
        direction: 1,
        currentPromptMatchesHistory: promptHistoryMatchesCurrent({
          currentPrompt: { input: "same text", parts: [{ type: "text", text: "inline attachment placeholder" }] },
          currentMode: "normal",
          historyIndex: -1,
          historyPrompt: { input: "same text", parts: [] },
        }),
      }),
    ).toBe(false)
    expect(
      shouldPreferMessagePromptHistory({
        direction: 1,
        currentPromptMatchesHistory: promptHistoryMatchesCurrent({
          currentPrompt: { input: "typed", parts: [] },
          currentMode: "normal",
          historyIndex: 0,
        }),
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

  test("builds prompt history only from loaded user messages in the current session", () => {
    const messages = [
      { id: "msg_001", role: "user" as const },
      { id: "msg_002", role: "assistant" as const },
      { id: "msg_003", role: "user" as const },
      { id: "msg_004", role: "user" as const },
    ]
    const partsByMessage = {
      msg_001: [{ type: "text", text: "older prompt kept by compacted history" }],
      msg_002: [{ type: "text", text: "assistant text is ignored" }],
      msg_003: [{ type: "compaction", auto: true, tail_start_id: "msg_001" }],
      msg_004: [{ type: "text", text: "latest prompt" }],
    }

    expect(sessionUserPromptHistory({ messages, partsByMessage }).map((item) => item.input)).toEqual([
      "older prompt kept by compacted history",
      "latest prompt",
    ])
  })

  test("keeps whitespace-only user prompts recallable from session history", () => {
    const messages = [{ id: "msg_001", role: "user" as const }]
    const partsByMessage = {
      msg_001: [{ type: "text", text: "   " }],
    }

    expect(sessionUserPromptHistory({ messages, partsByMessage }).map((item) => item.input)).toEqual(["   "])
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

  test("keeps stats selection on latest day across cached to fresh data", () => {
    const cachedDays = [{ day: "2026-07-01" }, { day: "2026-07-02" }, { day: "2026-07-03" }]
    const freshDays = [{ day: "2026-06-30" }, ...cachedDays]

    expect(
      statsSelectedDayIndex({ days: cachedDays, selectedDay: "2026-07-03", selectedIndex: 2, followLatest: true }),
    ).toBe(2)
    expect(
      statsSelectedDayIndex({ days: cachedDays, selectedDay: "2026-07-02", selectedIndex: 1, followLatest: false }),
    ).toBe(1)
    expect(
      statsSelectedDayIndex({ days: freshDays, selectedDay: "2026-07-02", selectedIndex: 1, followLatest: false }),
    ).toBe(2)
    expect(statsSelectedDayIndex({ days: freshDays, selectedIndex: 2, followLatest: false })).toBe(2)
  })

  test("refreshes stale stats cache when the latest cached day is behind today", () => {
    expect(
      statsCacheNeedsRefresh({
        updated: new Date("2026-07-03T22:40:00").getTime(),
        days: [{ day: "2026-06-23" }],
        now: new Date("2026-07-03T22:49:00").getTime(),
        staleMs: 60 * 60 * 1000,
      }),
    ).toBe(true)
    expect(
      statsCacheNeedsRefresh({
        updated: new Date("2026-07-03T22:40:00").getTime(),
        days: [{ day: "2026-07-03" }],
        now: new Date("2026-07-03T22:49:00").getTime(),
        staleMs: 60 * 60 * 1000,
        todayStaleMs: 60 * 60 * 1000,
      }),
    ).toBe(false)
  })

  test("refreshes current-day stats on the shorter today TTL", () => {
    expect(
      statsCacheNeedsRefresh({
        updated: new Date("2026-07-03T22:40:00").getTime(),
        days: [{ day: "2026-07-03" }],
        now: new Date("2026-07-03T22:42:00").getTime(),
        staleMs: 60 * 60 * 1000,
        todayStaleMs: 60 * 1000,
      }),
    ).toBe(true)
  })

  function statsDay(input: Partial<DailyUsage> & { day: string }): DailyUsage {
    return {
      day: input.day,
      time: input.time ?? 0,
      sessions: input.sessions ?? 0,
      messages: input.messages ?? 0,
      userMessages: input.userMessages ?? 0,
      userWords: input.userWords ?? 0,
      tokens: input.tokens ?? 0,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      cacheTokens: input.cacheTokens ?? 0,
      cost: input.cost ?? 0,
      aiResponseMs: input.aiResponseMs ?? 0,
      toolMs: input.toolMs ?? 0,
      changedFiles: input.changedFiles ?? 0,
    }
  }

  test("uses token breakdown when cached daily token total is missing", () => {
    expect(statsDayTokenValue(statsDay({ day: "2026-07-03", tokens: 0, inputTokens: 10, outputTokens: 5 }))).toBe(15)
    expect(statsDayTokenValue(statsDay({ day: "2026-07-03", tokens: 20, inputTokens: 10, outputTokens: 5 }))).toBe(20)
  })

  test("keeps daily heatmap active when AI activity exists without stored token usage", () => {
    expect(statsDayVisualValue(statsDay({ day: "2026-07-03", sessions: 1, messages: 2, userMessages: 1 }))).toBe(1)
    expect(statsDayVisualValue(statsDay({ day: "2026-07-03", sessions: 0, messages: 0, userMessages: 0 }))).toBe(0)
  })

  test("builds weekly and cumulative stats graph series without treating zero weeks as bars", () => {
    const days = [
      statsDay({ day: "2026-07-01", tokens: 0 }),
      statsDay({ day: "2026-07-02", tokens: 0 }),
      statsDay({ day: "2026-07-03", tokens: 5 }),
      statsDay({ day: "2026-07-04", tokens: 15 }),
    ]
    expect(statsGraphSeries({ days, mode: "weekly", rowCount: 2 }).map((point) => point.value)).toEqual([0, 20])
    expect(statsGraphSeries({ days, mode: "cumulative", rowCount: 2 }).map((point) => point.value)).toEqual([0, 20])
  })

  test("reserves only collapsed prompt input rows after submit", () => {
    expect(submittedPromptViewportHoldRows({ inputRows: 1 })).toBe(0)
    expect(submittedPromptViewportHoldRows({ inputRows: 8 })).toBe(7)
    expect(submittedPromptViewportHoldRows({ inputRows: 0 })).toBe(0)
    expect(submittedPromptViewportHoldRows({ inputRows: Number.NaN })).toBe(0)
  })

  test("does not restore scroll anchors during manual scroll grace", () => {
    expect(
      shouldRestoreSessionScrollAnchor({
        now: 1_100,
        manualScrollGraceUntil: 1_250,
        userMovedViewport: false,
        hasAnchor: true,
      }),
    ).toBe(false)
    expect(
      shouldRestoreSessionScrollAnchor({
        now: 1_300,
        manualScrollGraceUntil: 1_250,
        userMovedViewport: false,
        hasAnchor: true,
      }),
    ).toBe(true)
    expect(
      shouldRestoreSessionScrollAnchor({
        now: 1_300,
        manualScrollGraceUntil: 1_250,
        userMovedViewport: true,
        hasAnchor: true,
      }),
    ).toBe(false)
  })

  test("keeps paging boundary suppression through small scrollbar bounce near page seams", () => {
    const base = { scrollHeight: 300, viewportHeight: 30, releaseDistance: 10 }

    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "bottom",
        scrollTop: 270,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "bottom",
        scrollTop: 262,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "bottom",
        scrollTop: 259,
      }),
    ).toBe(true)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "top",
        scrollTop: 8,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "top",
        scrollTop: 11,
      }),
    ).toBe(true)

    const shortPage = { scrollHeight: 35, viewportHeight: 30, releaseDistance: 10 }

    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...shortPage,
        boundary: "bottom",
        scrollTop: 5,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...shortPage,
        boundary: "bottom",
        scrollTop: 0,
      }),
    ).toBe(true)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...shortPage,
        boundary: "top",
        scrollTop: 0,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...shortPage,
        boundary: "top",
        scrollTop: 5,
      }),
    ).toBe(true)
  })

  test("uses a larger default release threshold on short terminals", () => {
    const base = { scrollHeight: 200, viewportHeight: 12 }

    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "bottom",
        scrollTop: 180,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "bottom",
        scrollTop: 177,
      }),
    ).toBe(true)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "top",
        scrollTop: 9,
      }),
    ).toBe(false)
    expect(
      shouldReleaseSessionPagingBoundarySuppression({
        ...base,
        boundary: "top",
        scrollTop: 11,
      }),
    ).toBe(true)
  })

})
