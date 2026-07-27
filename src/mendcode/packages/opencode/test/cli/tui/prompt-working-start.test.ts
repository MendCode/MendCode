import { describe, expect, test } from "bun:test"
import {
  shouldAcceptCompactionArcadeFocus,
  shouldBlurCompactionArcadeWhenOffscreen,
  shouldRenderCompactionArcade,
} from "@/cli/cmd/tui/component/compaction-panel"
import {
  promptCursorEndOffset,
  promptCursorOffsetAfterArrow,
  promptCursorOffsetFromMouse,
  fetchLoopWorkflowsFromServer,
  isRetryablePromptDelivery,
  promptDeliveryErrorMessage,
  promptDeliveryIsQueued,
  promptDeliveryRetryDelay,
  promptDraftHistoryAction,
  mergeOptimisticUserParts,
  optimisticUserMessage,
  supplementalSlashPromptParts,
  optimisticUserParts,
  promptHistoryMatchesCurrent,
  latestPendingAssistantID,
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
  sessionFollowSyncIsStale,
  sessionFollowSyncKind,
  sessionUserMovedViewport,
  sessionHasLocalQueuedTurn,
  sessionPinnedUserMessageID,
  sessionQueuedUserMessageIDs,
  sessionTranscriptRenderKey,
  sessionUserMessageQueued,
  sessionUserPromptHistory,
  shouldPinSessionStickyUserHeader,
  shouldDeferSessionFollowSync,
  shouldHoldSessionSubmitScroll,
  shouldReleaseSessionPagingBoundarySuppression,
  shouldRestoreSessionScrollAnchor,
  shouldUseSimpleSessionHistory,
} from "@/cli/cmd/tui/routes/session"
import {
  LOOP_HISTORY_PAGE_SIZE,
  LOOP_WORKFLOW_GLOBAL_CACHE_KEY,
  LOOP_WORKFLOW_PROJECT_CACHE_KEY,
  loopGlobalPageCacheKey,
  loopHistoryPage,
  loopHistoryPageFromContract,
  loopSnapshotResourceKey,
  loopStateCounts,
  loopWakeupLabel,
  loopWorkflowProjectLabel,
  shouldKeepRouteLoopSelection,
} from "@/cli/cmd/tui/routes/loops"
import {
  mapStatsSessionsInBatches,
  clockAscii,
  statsCacheNeedsRefresh,
  statsDayTokenValue,
  statsDayVisualValue,
  statsGraphSeries,
  statsSelectedDayIndex,
  usageInsightsCacheKey,
} from "@/cli/cmd/tui/routes/stats"
import type { DailyUsage } from "@/cli/cmd/tui/util/usage-insights"

describe("shared-server loop status", () => {
  test("turns a transient connection failure into an empty auxiliary result", async () => {
    const result = await fetchLoopWorkflowsFromServer({
      fetcher: async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?")
      },
      url: "http://127.0.0.1:1234",
      directory: "/tmp/project",
    })

    expect(result).toEqual([])
  })

  test("sends shared-server auth and directory routing headers", async () => {
    let request!: Request
    const result = await fetchLoopWorkflowsFromServer({
      fetcher: async (input, init) => {
        request = new Request(input, init)
        return new Response(JSON.stringify([{ id: "loop_1", state: "active" }]), {
          headers: { "content-type": "application/json" },
        })
      },
      url: "http://127.0.0.1:1234",
      headers: { authorization: "Basic test" },
      directory: "/tmp/project",
    })

    expect(result).toEqual([{ id: "loop_1", state: "active" }])
    expect(request.headers.get("authorization")).toBe("Basic test")
    expect(request.headers.get("accept")).toBe("application/json")
    expect(request.headers.get("x-mendcode-directory")).toBe(encodeURIComponent("/tmp/project"))
  })
})

describe("prompt draft history", () => {
  test("uses the terminal-safe undo binding only when the editor has an undo point", () => {
    expect(promptDraftHistoryAction({ undo: true, redo: false, canUndo: true, canRedo: false })).toBe("undo")
    expect(promptDraftHistoryAction({ undo: true, redo: false, canUndo: false, canRedo: false })).toBeUndefined()
  })

  test("uses the configured redo binding without stealing terminal suspend", () => {
    expect(promptDraftHistoryAction({ undo: false, redo: true, canUndo: false, canRedo: true })).toBe("redo")
    expect(promptDraftHistoryAction({ undo: true, redo: true, canUndo: true, canRedo: true })).toBe("undo")
  })
})

describe("prompt delivery recovery", () => {
  test("retries a delivery with no HTTP response instead of treating it as a rejection", () => {
    expect(isRetryablePromptDelivery({ error: new Error("network down") })).toBe(true)
    expect(
      isRetryablePromptDelivery({ error: { message: "bad request" }, response: new Response(null, { status: 400 }) }),
    ).toBe(false)
    expect(
      isRetryablePromptDelivery({
        error: { message: "server unavailable" },
        response: new Response(null, { status: 503 }),
      }),
    ).toBe(true)
  })

  test("keeps retrying prompt delivery at a short offline interval", () => {
    expect(promptDeliveryRetryDelay(1)).toBe(1000)
    expect(promptDeliveryRetryDelay(5)).toBe(1000)
    expect(promptDeliveryRetryDelay(99)).toBe(1000)
  })

  test("extracts structured server error messages", () => {
    expect(promptDeliveryErrorMessage({ data: { message: "invalid prompt" } })).toBe("invalid prompt")
    expect(promptDeliveryErrorMessage(undefined)).toBe("The server rejected this prompt.")
  })

  test("does not render an accepted delivery as queued", () => {
    expect(promptDeliveryIsQueued("pending")).toBe(true)
    expect(promptDeliveryIsQueued("accepted")).toBe(false)
  })
})

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

describe("queued user turn", () => {
  test("ignores an older unfinished assistant after a newer response completed", () => {
    expect(
      latestPendingAssistantID([
        { id: "msg_001", role: "user", time: { created: 1 } },
        { id: "msg_002", role: "assistant", time: { created: 2 } },
        { id: "msg_003", role: "user", time: { created: 3 } },
        { id: "msg_004", role: "assistant", time: { created: 4, completed: 5 } },
      ]),
    ).toBeUndefined()
  })

  test("keeps the latest unfinished assistant active across a newer queued user", () => {
    expect(
      latestPendingAssistantID([
        { id: "msg_001", role: "user", time: { created: 1 } },
        { id: "msg_002", role: "assistant", time: { created: 2 } },
        { id: "msg_003", role: "user", time: { created: 3 } },
      ]),
    ).toBe("msg_002")
  })

  test("stays visibly queued across later assistant tool iterations", () => {
    const activeUser = { id: "msg_001", role: "user" }
    const queuedUser = { id: "msg_003", role: "user" }
    const messages = [
      activeUser,
      { id: "msg_002", role: "assistant", parentID: activeUser.id },
      queuedUser,
      { id: "msg_004", role: "assistant", parentID: activeUser.id },
    ]

    expect(
      sessionUserMessageQueued({
        messageID: queuedUser.id,
        pendingAssistantID: "msg_004",
        messages,
      }),
    ).toBe(true)
    expect(
      sessionUserMessageQueued({
        messageID: activeUser.id,
        pendingAssistantID: "msg_004",
        messages,
      }),
    ).toBe(false)
    expect(
      sessionUserMessageQueued({
        messageID: queuedUser.id,
        pendingAssistantID: "msg_005",
        messages: [...messages, { id: "msg_005", role: "assistant", parentID: queuedUser.id }],
      }),
    ).toBe(false)
  })

  test("returns queued users for the bottom dock without hiding dispatched users", () => {
    const messages = [
      { id: "msg_001", role: "user" },
      { id: "msg_002", role: "assistant", parentID: "msg_001" },
      { id: "msg_003", role: "user" },
      { id: "msg_004", role: "user" },
      { id: "msg_005", role: "assistant", parentID: "msg_004" },
      { id: "msg_006", role: "user" },
    ]

    expect(sessionQueuedUserMessageIDs({ messages, pendingAssistantID: "msg_002" })).toEqual(["msg_003", "msg_006"])
    expect(sessionQueuedUserMessageIDs({ messages, pendingAssistantID: "msg_005" })).toEqual(["msg_006"])
  })

  test("keeps queued users visible during the completed-tool-iteration gap", () => {
    const messages = [
      { id: "msg_001", role: "user" },
      { id: "msg_002", role: "assistant", parentID: "msg_001", finish: "tool-calls", time: { completed: 2 } },
      { id: "msg_003", role: "user" },
    ]

    expect(
      sessionQueuedUserMessageIDs({
        messages,
        pendingAssistantID: "msg_002",
        working: true,
      }),
    ).toEqual(["msg_003"])
    expect(sessionQueuedUserMessageIDs({ messages, pendingAssistantID: "msg_002" })).toEqual([])
  })

  test("does not queue a new prompt behind a completed final assistant", () => {
    const messages = [
      { id: "msg_001", role: "user" },
      { id: "msg_002", role: "assistant", parentID: "msg_001", finish: "stop", time: { completed: 2 } },
      { id: "msg_003", role: "user" },
    ]

    expect(
      sessionQueuedUserMessageIDs({
        messages,
        pendingAssistantID: "msg_002",
        working: true,
      }),
    ).toEqual([])
  })

  test("does not mark an older user queued when the active assistant belongs to a later user", () => {
    const olderUser = { id: "msg_001", role: "user" }
    const activeUser = { id: "msg_003", role: "user" }
    const messages = [olderUser, activeUser, { id: "msg_004", role: "assistant", parentID: activeUser.id }]

    expect(
      sessionUserMessageQueued({
        messageID: olderUser.id,
        pendingAssistantID: "msg_004",
        messages,
      }),
    ).toBe(false)
  })

  test("keeps the active turn pinned while a later user message is queued", () => {
    const messages = [
      { id: "msg_001", role: "user", time: {} },
      { id: "msg_002", role: "assistant", parentID: "msg_001", finish: "tool-calls", time: { completed: 2 } },
      { id: "msg_003", role: "user", time: {} },
      { id: "msg_004", role: "assistant", parentID: "msg_001", time: {} },
    ]

    expect(
      sessionPinnedUserMessageID({
        messages,
        pendingAssistantID: "msg_004",
        submittedUserMessageID: "msg_003",
      }),
    ).toBe("msg_001")

    expect(
      sessionPinnedUserMessageID({
        messages: [
          messages[0],
          { id: "msg_002", role: "assistant", parentID: "msg_001", finish: "tool-calls", time: { completed: 2 } },
          messages[2],
        ],
        pendingAssistantID: "msg_002",
        working: true,
      }),
    ).toBe("msg_001")
  })

  test("keeps the submitted user pinned through response settlement and releases it when idle", () => {
    const user = { id: "msg_003", role: "user", time: {} }
    const running = [user, { id: "msg_004", role: "assistant", parentID: user.id, time: {} }]
    expect(
      sessionPinnedUserMessageID({
        messages: running,
        pendingAssistantID: "msg_004",
        submittedUserMessageID: user.id,
      }),
    ).toBe(user.id)

    expect(
      sessionPinnedUserMessageID({
        messages: [
          user,
          { id: "msg_004", role: "assistant", parentID: user.id, finish: "stop", time: { completed: 5 } },
        ],
        submittedUserMessageID: user.id,
      }),
    ).toBeUndefined()

    expect(
      sessionPinnedUserMessageID({
        messages: [
          user,
          { id: "msg_004", role: "assistant", parentID: user.id, finish: "stop", time: { completed: 5 } },
        ],
        submittedUserMessageID: user.id,
        working: true,
      }),
    ).toBe(user.id)
  })

  test("pins the active user only after it crosses the viewport top", () => {
    expect(
      shouldPinSessionStickyUserHeader({
        pinnedUserID: "msg_new",
        pinnedAnchor: { id: "msg_new", y: 140 },
        top: 100,
      }),
    ).toBe(false)

    expect(
      shouldPinSessionStickyUserHeader({
        pinnedUserID: "msg_new",
        pinnedAnchor: { id: "msg_new", y: 40 },
        top: 100,
      }),
    ).toBe(true)

    expect(
      shouldPinSessionStickyUserHeader({
        pinnedUserID: "msg_new",
        pinnedAnchor: { id: "msg_old", y: 140 },
        top: 100,
      }),
    ).toBe(false)
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
    expect(shouldEnableSessionInterrupt({ statusType: "busy", autocompleteVisible: true })).toBe(false)
    expect(shouldEnableSessionInterrupt({ statusType: "retry" })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "idle" })).toBe(false)
    expect(shouldEnableSessionInterrupt({ statusType: "idle", hasActiveWorkingAssistant: true })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "idle", hasPendingPromptDelivery: true })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "busy", promptFocused: false })).toBe(false)
    expect(shouldEnableSessionInterrupt({ statusType: "busy", promptFocused: true })).toBe(true)
    expect(shouldEnableSessionInterrupt({ statusType: "busy", autocompleteVisible: true })).toBe(false)
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
    expect(shouldInterruptImmediately({ statusType: "idle", hasActiveWorkingAssistant: true })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "idle", hasPendingPromptDelivery: true })).toBe(true)
    expect(shouldInterruptImmediately({ statusType: "idle", hasActiveWorkingAssistant: true, hasDraft: true })).toBe(
      false,
    )
  })

  test("accepts prompt interrupt only when the prompt textarea owns focus", () => {
    const promptInput = {}
    const arcadeInput = {}
    expect(
      shouldAcceptPromptInterruptFocus({ inputFocused: true, currentFocusedRenderable: promptInput, promptInput }),
    ).toBe(true)
    expect(
      shouldAcceptPromptInterruptFocus({ inputFocused: true, currentFocusedRenderable: arcadeInput, promptInput }),
    ).toBe(false)
    expect(
      shouldAcceptPromptInterruptFocus({ inputFocused: false, currentFocusedRenderable: promptInput, promptInput }),
    ).toBe(false)
  })

  test("accepts compaction arcade input only while the arcade owns renderer focus", () => {
    const promptInput = {}
    const arcadeInput = {}
    expect(
      shouldAcceptCompactionArcadeFocus({
        arcadeFocused: true,
        currentFocusedRenderable: arcadeInput,
        arcadeInput,
      }),
    ).toBe(true)
    expect(
      shouldAcceptCompactionArcadeFocus({
        arcadeFocused: true,
        currentFocusedRenderable: promptInput,
        arcadeInput,
      }),
    ).toBe(false)
    expect(
      shouldAcceptCompactionArcadeFocus({
        arcadeFocused: false,
        currentFocusedRenderable: arcadeInput,
        arcadeInput,
      }),
    ).toBe(false)
  })

  test("only blurs focused compaction arcade after it leaves the visible screen", () => {
    expect(shouldBlurCompactionArcadeWhenOffscreen({ focused: true, screenY: 5, height: 10, viewportHeight: 20 })).toBe(
      false,
    )
    expect(
      shouldBlurCompactionArcadeWhenOffscreen({ focused: true, screenY: -9, height: 10, viewportHeight: 20 }),
    ).toBe(false)
    expect(
      shouldBlurCompactionArcadeWhenOffscreen({ focused: true, screenY: 19, height: 10, viewportHeight: 20 }),
    ).toBe(false)
    expect(
      shouldBlurCompactionArcadeWhenOffscreen({ focused: true, screenY: -10, height: 10, viewportHeight: 20 }),
    ).toBe(true)
    expect(
      shouldBlurCompactionArcadeWhenOffscreen({ focused: true, screenY: 20, height: 10, viewportHeight: 20 }),
    ).toBe(true)
    expect(
      shouldBlurCompactionArcadeWhenOffscreen({ focused: false, screenY: 20, height: 10, viewportHeight: 20 }),
    ).toBe(false)
  })

  test("renders compaction arcade only in the explicit arcade presentation", () => {
    expect(shouldRenderCompactionArcade({ style: "cockpit", arcade: "snake" })).toBe(false)
    expect(shouldRenderCompactionArcade({ style: "minimal", arcade: "snake" })).toBe(false)
    expect(shouldRenderCompactionArcade({ style: "arcade", arcade: "snake" })).toBe(true)
    expect(shouldRenderCompactionArcade({ style: "arcade", arcade: "off" })).toBe(false)
  })

  test("keeps plain left and right arrows available for prompt cursor movement", () => {
    expect(shouldHandlePromptCursorArrow({ name: "left", ctrl: false, meta: false, shift: false, super: false })).toBe(
      true,
    )
    expect(shouldHandlePromptCursorArrow({ name: "right", ctrl: false, meta: false, shift: false, super: false })).toBe(
      true,
    )
    expect(shouldHandlePromptCursorArrow({ name: "left", ctrl: true, meta: false, shift: false, super: false })).toBe(
      false,
    )
    expect(shouldHandlePromptCursorArrow({ name: "up", ctrl: false, meta: false, shift: false, super: false })).toBe(
      false,
    )

    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 0, direction: "left" })).toBe(0)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 1, direction: "left" })).toBe(0)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 1, direction: "right" })).toBe(2)
    expect(promptCursorOffsetAfterArrow({ text: "abc", cursorOffset: 3, direction: "right" })).toBe(3)
    expect(promptCursorEndOffset("line 1\nline 2")).toBe("line 1\nline 2".length)
    expect(promptCursorEndOffset("好a")).toBe("好a".length)
    expect(promptCursorOffsetAfterArrow({ text: "好a", cursorOffset: 2, direction: "right" })).toBe(2)
  })

  test("treats virtual prompt parts as atomic cursor ranges", () => {
    const text = "ask [Image 1] now"
    const imageStart = text.indexOf("[Image 1]")
    const imageEnd = imageStart + "[Image 1]".length
    const atomicRanges = [{ start: imageStart, end: imageEnd }]

    expect(promptCursorOffsetAfterArrow({ text, cursorOffset: imageStart - 1, direction: "right", atomicRanges })).toBe(
      imageStart,
    )
    expect(promptCursorOffsetAfterArrow({ text, cursorOffset: imageStart, direction: "right", atomicRanges })).toBe(
      imageEnd,
    )
    expect(promptCursorOffsetAfterArrow({ text, cursorOffset: imageStart + 3, direction: "right", atomicRanges })).toBe(
      imageEnd,
    )
    expect(promptCursorOffsetAfterArrow({ text, cursorOffset: imageEnd, direction: "left", atomicRanges })).toBe(
      imageStart - 1,
    )
    expect(promptCursorOffsetAfterArrow({ text, cursorOffset: imageStart + 3, direction: "left", atomicRanges })).toBe(
      imageStart - 1,
    )
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
    expect(
      shouldUseStoredPromptHistoryFallback({
        historyItems: () => [{ input: "loaded", parts: [] }],
        messageHistoryCount: 1,
      }),
    ).toBe(false)
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
    expect(
      shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 0, height: 2 }),
    ).toBe(false)
    expect(
      shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 1, height: 2 }),
    ).toBe(true)
    expect(
      shouldSnapPromptCursorToEnd({ direction: 1, cursorOffset: 5, text: "line 1\nline 2", visualRow: 1, height: 6 }),
    ).toBe(true)
    expect(
      shouldAttemptPromptHistoryNavigation({
        direction: 1,
        cursorOffset: promptCursorEndOffset("line 1\nline 2"),
        text: "line 1\nline 2",
      }),
    ).toBe(true)
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

  test("keeps the transcript mounted when a compaction summary completes", () => {
    const streaming = [
      { id: "msg_001", role: "user" as const, time: { completed: 1 } },
      { id: "msg_002", role: "assistant" as const, parentID: "msg_001", summary: true, time: {} },
    ]
    const completed = [streaming[0], { ...streaming[1], time: { completed: 2 } }]
    const afterSubmit = [...completed, { id: "msg_003", role: "user" as const, time: { completed: 3 } }]
    const streamingStartID = latestFullSessionHistoryStartID(streaming)
    const completedStartID = latestFullSessionHistoryStartID(completed)
    const afterSubmitStartID = latestFullSessionHistoryStartID(afterSubmit)

    expect(streamingStartID).toBeUndefined()
    expect(completedStartID).toBe("msg_002")
    expect(afterSubmitStartID).toBe(completedStartID)
    const renderKey = sessionTranscriptRenderKey("ses_test")
    expect(renderKey).toBe("ses_test")
    expect(sessionTranscriptRenderKey("ses_test")).toBe(renderKey)
    expect(streamingStartID).not.toBe(completedStartID)
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

  test("keys global loop cache entries by the requested page contract", () => {
    expect(loopGlobalPageCacheKey({ offset: 0 })).toBe("global:0:50")
    expect(loopGlobalPageCacheKey({ offset: 50 })).not.toBe(loopGlobalPageCacheKey({ offset: 0 }))
    expect(loopGlobalPageCacheKey({ offset: 0, limit: 25 })).not.toBe(loopGlobalPageCacheKey({ offset: 0 }))
    expect(LOOP_WORKFLOW_PROJECT_CACHE_KEY).toBe("project")
    expect(loopGlobalPageCacheKey({ offset: 0, scope: "project" })).toBe("project:0:50")
  })

  test("does not label scheduled blocked loops as manual", () => {
    const blocked = {
      state: "blocked",
      spec: { trigger: { mode: "interval", intervalMs: 900_000 } },
    } as Parameters<typeof loopWakeupLabel>[0]
    const waiting = {
      state: "active",
      spec: { trigger: { mode: "external-signal" } },
    } as Parameters<typeof loopWakeupLabel>[0]

    expect(loopWakeupLabel(blocked)).toBe("not scheduled (blocked)")
    expect(loopWakeupLabel(waiting)).toBe("waiting for external-signal")
    expect(loopStateCounts([{ state: "sleeping" }, { state: "blocked" }, { state: "blocked" }])).toEqual({ scheduled: 1, blocked: 2 })
  })

  test("holds a deep-linked loop selection until its server page resolves", () => {
    expect(shouldKeepRouteLoopSelection({ requestedID: "loop_51", loading: true, items: [{ id: "loop_1" }] })).toBe(
      true,
    )
    expect(shouldKeepRouteLoopSelection({ requestedID: "loop_51", loading: true, items: [{ id: "loop_51" }] })).toBe(
      false,
    )
    expect(shouldKeepRouteLoopSelection({ requestedID: "loop_51", loading: false, items: [{ id: "loop_1" }] })).toBe(
      false,
    )
  })

  test("uses stable global loop dashboard identity and project labels", () => {
    expect(LOOP_WORKFLOW_GLOBAL_CACHE_KEY).toBe("global")
    expect(loopSnapshotResourceKey({ id: "loop_1", time: { updated: 123 } })).toBe("loop_1:123")
    expect(loopSnapshotResourceKey({ id: "loop_1", time: { updated: 123 } })).toBe(
      loopSnapshotResourceKey({ id: "loop_1", time: { updated: 123 } }),
    )
    expect(
      loopWorkflowProjectLabel({
        projectID: "project-1",
        project: { id: "project-1", worktree: "/Users/example/Code/MendCode" },
      }),
    ).toBe("MendCode")
  })

  test("pages archived loop history at a bounded page size", () => {
    const archived = Array.from({ length: LOOP_HISTORY_PAGE_SIZE + 2 }, (_, index) => `loop_${index + 1}`)

    expect(loopHistoryPage({ items: archived, page: 0 })).toMatchObject({
      page: 0,
      pageCount: 2,
      start: 0,
      end: LOOP_HISTORY_PAGE_SIZE,
      total: LOOP_HISTORY_PAGE_SIZE + 2,
      items: archived.slice(0, LOOP_HISTORY_PAGE_SIZE),
    })
    expect(loopHistoryPage({ items: archived, page: 1 })).toMatchObject({
      page: 1,
      start: LOOP_HISTORY_PAGE_SIZE,
      end: LOOP_HISTORY_PAGE_SIZE + 2,
      items: archived.slice(LOOP_HISTORY_PAGE_SIZE),
    })
    expect(loopHistoryPage({ items: archived, page: 99 })).toMatchObject({
      page: 1,
      items: archived.slice(LOOP_HISTORY_PAGE_SIZE),
    })

    expect(
      loopHistoryPageFromContract({
        items: ["loop_51", "loop_52"],
        page: { offset: LOOP_HISTORY_PAGE_SIZE, limit: LOOP_HISTORY_PAGE_SIZE, total: LOOP_HISTORY_PAGE_SIZE + 2 },
      }),
    ).toMatchObject({
      page: 1,
      pageCount: 2,
      start: LOOP_HISTORY_PAGE_SIZE,
      end: LOOP_HISTORY_PAGE_SIZE + 2,
      total: LOOP_HISTORY_PAGE_SIZE + 2,
      items: ["loop_51", "loop_52"],
    })
  })

  test("loads stats sessions in bounded batches and exposes the first batch early", async () => {
    let active = 0
    let peak = 0
    const batchSizes: number[] = []
    const result = await mapStatsSessionsInBatches(
      [1, 2, 3, 4, 5, 6, 7],
      async (value) => {
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(2)
        active--
        return value * 2
      },
      {
        concurrency: 3,
        onBatch: (items) => batchSizes.push(items.length),
      },
    )

    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
    expect(batchSizes).toEqual([3, 6, 7])
  })

  test("keeps stats day selection stable across cached to fresh data", () => {
    const cachedDays = [{ day: "2026-07-01" }, { day: "2026-07-02" }, { day: "2026-07-03" }]
    const freshDays = [{ day: "2026-06-30" }, ...cachedDays, { day: "2026-07-04" }]

    expect(statsSelectedDayIndex({ days: cachedDays, selectedDay: "2026-07-03", selectedIndex: 2 })).toBe(2)
    expect(statsSelectedDayIndex({ days: cachedDays, selectedDay: "2026-07-02", selectedIndex: 1 })).toBe(1)
    expect(statsSelectedDayIndex({ days: freshDays, selectedDay: "2026-07-02", selectedIndex: 1 })).toBe(2)
    expect(statsSelectedDayIndex({ days: freshDays, selectedDay: "2026-07-03", selectedIndex: 2 })).toBe(3)
    expect(statsSelectedDayIndex({ days: freshDays, selectedIndex: 2 })).toBe(2)
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

  test("isolates scoped stats caches while sharing global insights", () => {
    expect(usageInsightsCacheKey("global", {}, "/repo/a")).toBe(usageInsightsCacheKey("global", {}, "/repo/b"))
    expect(usageInsightsCacheKey("directory", { path: "apps/web" }, "/repo/a")).not.toBe(
      usageInsightsCacheKey("directory", { path: "apps/api" }, "/repo/a"),
    )
    expect(usageInsightsCacheKey("project", { scope: "project" }, "/repo/a")).not.toBe(
      usageInsightsCacheKey("project", { scope: "project" }, "/repo/b"),
    )
    expect(usageInsightsCacheKey("directory", { path: "web" }, "/repo|apps")).not.toBe(
      usageInsightsCacheKey("directory", { directory: "apps|web" }, "/repo"),
    )
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

  test("uses the reported daily total and falls back to token breakdown when missing", () => {
    expect(statsDayTokenValue(statsDay({ day: "2026-07-03", tokens: 0, inputTokens: 10, outputTokens: 5 }))).toBe(15)
    expect(statsDayTokenValue(statsDay({ day: "2026-07-03", tokens: 20, inputTokens: 10, outputTokens: 5 }))).toBe(20)
    expect(statsDayTokenValue(statsDay({ day: "2026-07-03", tokens: 10, inputTokens: 10, outputTokens: 5 }))).toBe(10)
  })

  test("keeps every clock row aligned", () => {
    const rows = clockAscii("09:37")
    expect(rows).toHaveLength(7)
    expect(new Set(rows.map((row) => row.length)).size).toBe(1)
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

  test("does not treat a queued prompt layout resize as manual scrolling", () => {
    expect(
      sessionUserMovedViewport({
        scrollTop: 900,
        lastScrollTop: 840,
        scrollHeight: 1_200,
        lastScrollHeight: 1_200,
        viewportHeight: 48,
        lastViewportHeight: 48,
      }),
    ).toBe(true)
    expect(
      sessionUserMovedViewport({
        scrollTop: 900,
        lastScrollTop: 840,
        scrollHeight: 1_200,
        lastScrollHeight: 1_200,
        viewportHeight: 42,
        lastViewportHeight: 48,
      }),
    ).toBe(false)
  })

  test("does not refetch the transcript for canonical incremental message events", () => {
    expect(sessionFollowSyncKind("message.updated")).toBeUndefined()
    expect(sessionFollowSyncKind("message.part.updated")).toBeUndefined()
    expect(sessionFollowSyncKind("message.part.delta")).toBeUndefined()
    expect(sessionFollowSyncKind("session.status")).toBeUndefined()
    expect(sessionFollowSyncKind("session.next.text.started")).toBe("immediate")
    expect(sessionFollowSyncKind("session.next.text.delta")).toBe("live")
    expect(sessionFollowSyncIsStale({ now: 1_500, lastSyncAt: 0, lastEventAt: 1_200, intervalMs: 600 })).toBe(false)
    expect(sessionFollowSyncIsStale({ now: 1_800, lastSyncAt: 0, lastEventAt: 1_200, intervalMs: 600 })).toBe(true)
  })

  test("defers follow refreshes while paging or viewing an older transcript window", () => {
    expect(shouldDeferSessionFollowSync({ hasMoreNewer: false, loadingOlder: false, loadingNewer: false })).toBe(false)
    expect(shouldDeferSessionFollowSync({ hasMoreNewer: true, loadingOlder: false, loadingNewer: false })).toBe(true)
    expect(shouldDeferSessionFollowSync({ hasMoreNewer: false, loadingOlder: true, loadingNewer: false })).toBe(true)
    expect(shouldDeferSessionFollowSync({ hasMoreNewer: false, loadingOlder: false, loadingNewer: true })).toBe(true)
  })

  test("holds follow-sync while the single submit scroll is pending", () => {
    expect(shouldHoldSessionSubmitScroll({ sessionID: "ses_001", submitSessionID: "ses_001" })).toBe(true)
    expect(shouldHoldSessionSubmitScroll({ sessionID: "ses_001", submitSessionID: "ses_002" })).toBe(false)
    expect(shouldHoldSessionSubmitScroll({ sessionID: "ses_001" })).toBe(false)
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
