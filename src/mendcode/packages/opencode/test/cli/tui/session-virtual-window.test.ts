import { describe, expect, test } from "bun:test"
import {
  sessionMeasuredHeight,
  sessionMessageVirtualWindow,
  sessionScrollAnchor,
  stickyUserIDFromVirtualWindow,
} from "@/cli/cmd/tui/util/session-virtual-window"
import { compareSessionMessages, sortSessionMessages } from "@/cli/cmd/tui/util/session-message-order"
import { sessionTranscriptRows } from "@/cli/cmd/tui/util/session-transcript-rows"

const messages = Array.from({ length: 300 }, (_, index) => ({
  id: `msg-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
}))

describe("session transcript virtual window", () => {
  test("does not commit transient zero-height measurements", () => {
    expect(sessionMeasuredHeight(0)).toBeUndefined()
    expect(sessionMeasuredHeight(0, 12)).toBe(12)
    expect(sessionMeasuredHeight(4.2)).toBe(5)
  })

  test("anchors only transcript rows, not layout spacers", () => {
    expect(
      sessionScrollAnchor({
        children: [
          { id: "box-padding", y: 0 },
          { id: "top-spacer", y: 1 },
          { id: "msg-10", y: 42, height: 7 },
          { id: "msg-11", y: 100, height: 7 },
        ],
        top: 30,
        viewportHeight: 24,
        transcriptChildIDs: new Set(["msg-10", "msg-11"]),
      }),
    ).toEqual({ id: "msg-10", offset: 12 })

    expect(
      sessionScrollAnchor({
        children: [{ id: "msg-far", y: 200, height: 7 }],
        top: 0,
        viewportHeight: 24,
        transcriptChildIDs: new Set(["msg-far"]),
      }),
    ).toBeUndefined()
  })

  test("keeps small sessions fully rendered", () => {
    expect(sessionMessageVirtualWindow({ total: 20, scrollTop: 0, viewportHeight: 30, followOutput: true })).toEqual({
      start: 0,
      end: 20,
      topSpacer: 0,
      bottomSpacer: 0,
      virtualized: false,
    })
  })

  test("keeps the normal 150-message reopen path fully rendered", () => {
    expect(sessionMessageVirtualWindow({ total: 150, scrollTop: 0, viewportHeight: 30, followOutput: true })).toEqual({
      start: 0,
      end: 150,
      topSpacer: 0,
      bottomSpacer: 0,
      virtualized: false,
    })
  })

  test("virtualizes very large sessions by default to keep reopen memory bounded", () => {
    expect(sessionMessageVirtualWindow({ total: 1_000, scrollTop: 0, viewportHeight: 30, followOutput: true })).toEqual(
      {
        start: 989,
        end: 1_000,
        topSpacer: 5_934,
        bottomSpacer: 0,
        virtualized: true,
      },
    )
  })

  test("renders the tail when explicit virtualization is enabled while following session output", () => {
    const window = sessionMessageVirtualWindow({
      total: 300,
      scrollTop: 0,
      viewportHeight: 30,
      followOutput: true,
      threshold: 100,
      overscan: 10,
      estimatedMessageHeight: 5,
    })

    expect(window.start).toBe(292)
    expect(window.end).toBe(300)
    expect(window.topSpacer).toBe(1460)
    expect(window.bottomSpacer).toBe(0)
  })

  test("keeps an identity-resolved submit anchor mounted instead of following the tail", () => {
    const window = sessionMessageVirtualWindow({
      total: 300,
      scrollTop: 0,
      viewportHeight: 30,
      followOutput: false,
      anchorIndex: messages.findIndex((message) => message.id === "msg-120"),
      threshold: 100,
      overscan: 10,
      estimatedMessageHeight: 5,
    })

    // Keep the physical viewport mounted while the identity anchor is brought
    // into the same window. The route can then restore to the anchor without
    // exposing the prefix spacer as a blank frame.
    expect(window.start).toBe(0)
    expect(window.end).toBe(130)
    expect(120).toBeGreaterThanOrEqual(window.start)
    expect(120).toBeLessThan(window.end)
  })

  test("moves the rendered range near the scroll position with overscan", () => {
    const window = sessionMessageVirtualWindow({
      total: 300,
      scrollTop: 500,
      viewportHeight: 30,
      followOutput: false,
      threshold: 80,
      overscan: 10,
      estimatedMessageHeight: 5,
    })

    expect(window.start).toBe(98)
    expect(window.end).toBe(109)
    expect(window.topSpacer).toBe(490)
    expect(window.bottomSpacer).toBe(955)
  })

  test("uses measured variable heights instead of treating a large response like a fixed row", () => {
    const heights = Array.from({ length: 300 }, (_, index) => (index < 100 ? 1 : index === 100 ? 100 : 2))
    const window = sessionMessageVirtualWindow({
      total: heights.length,
      scrollTop: 120,
      viewportHeight: 30,
      followOutput: false,
      threshold: 40,
      overscan: 10,
      itemHeights: heights,
    })

    expect(window.start).toBe(100)
    expect(window.end).toBe(101)
    expect(window.topSpacer).toBe(100)
    expect(window.bottomSpacer).toBe(398)
  })

  test("caps mounted rows even when thousands of one-line events are loaded", () => {
    const window = sessionMessageVirtualWindow({
      total: 10_000,
      scrollTop: 5_000,
      viewportHeight: 200,
      followOutput: false,
      threshold: 40,
      overscan: 100,
      maxMounted: 96,
      itemHeights: Array.from({ length: 10_000 }, () => 1),
    })

    expect(window.end - window.start).toBe(96)
    expect(window.topSpacer).toBe(4_900)
  })

  test("does not mount an invisible zero-height tail while following output", () => {
    const heights = [...Array(70).fill(1), ...Array(150).fill(0)]
    const window = sessionMessageVirtualWindow({
      total: heights.length,
      scrollTop: 0,
      viewportHeight: 30,
      followOutput: true,
      itemHeights: heights,
    })

    expect(window.end - window.start).toBeGreaterThan(0)
    expect(window.topSpacer).toBeLessThan(heights.length)
    expect(window.bottomSpacer).toBe(0)
  })

  test("keeps the complete bounded follow tail during a partial zero-height layout pass", () => {
    const window = sessionMessageVirtualWindow({
      total: 100,
      scrollTop: 0,
      viewportHeight: 30,
      followOutput: true,
      itemHeights: [...Array(70).fill(1), ...Array(30).fill(0)],
    })

    expect(window.start).toBe(0)
    expect(window.end).toBe(100)
    expect(window.bottomSpacer).toBe(0)
  })

  test("treats an all-zero measurement pass as unmeasured instead of rendering a blank window", () => {
    const window = sessionMessageVirtualWindow({
      total: 220,
      scrollTop: 0,
      viewportHeight: 30,
      followOutput: true,
      itemHeights: Array.from({ length: 220 }, () => 0),
    })

    expect(window.end).toBe(220)
    expect(window.end - window.start).toBeGreaterThan(0)
    expect(window.bottomSpacer).toBe(0)
    expect(window.topSpacer).toBeGreaterThan(0)
  })

  test("sticky user falls back to logical history before the mounted window", () => {
    const sticky = stickyUserIDFromVirtualWindow({
      messages,
      window: { start: 101 },
      mountedUserAnchors: [],
      top: 120,
      isUser: (message) => message.role === "user",
    })

    expect(sticky).toBe("msg-100")
  })

  test("sticky user stays hidden when no earlier user has scrolled past the viewport", () => {
    const sticky = stickyUserIDFromVirtualWindow({
      messages,
      window: { start: 0 },
      mountedUserAnchors: [],
      top: 0,
      isUser: (message) => message.role === "user",
    })

    expect(sticky).toBeUndefined()
  })

  test("mounted anchor wins over logical fallback", () => {
    const sticky = stickyUserIDFromVirtualWindow({
      messages,
      window: { start: 101 },
      mountedUserAnchors: [
        { id: "msg-102", y: 50 },
        { id: "msg-104", y: 150 },
      ],
      top: 100,
      isUser: (message) => message.role === "user",
    })

    expect(sticky).toBe("msg-102")
  })

  test("mounted anchor at the viewport boundary is sticky", () => {
    const sticky = stickyUserIDFromVirtualWindow({
      messages,
      window: { start: 101 },
      mountedUserAnchors: [{ id: "msg-102", y: 100 }],
      top: 100,
      isUser: (message) => message.role === "user",
    })

    expect(sticky).toBe("msg-102")
  })

  test("chooses the latest mounted sticky anchor without sorting the mounted list", () => {
    const sticky = stickyUserIDFromVirtualWindow({
      messages,
      window: { start: 101 },
      mountedUserAnchors: [
        { id: "msg-108", y: 90 },
        { id: "msg-102", y: 50 },
        { id: "msg-110", y: 120 },
      ],
      top: 100,
      isUser: (message) => message.role === "user",
    })

    expect(sticky).toBe("msg-108")
  })

  test("orders messages by creation time instead of assuming IDs are chronological", () => {
    const messages = [
      { id: "msg-z", time: { created: 20 } },
      { id: "msg-a", time: { created: 10 } },
      { id: "msg-b", time: { created: 20 } },
    ]

    expect(sortSessionMessages(messages).map((message) => message.id)).toEqual(["msg-a", "msg-b", "msg-z"])
    expect(compareSessionMessages(messages[1], messages[0])).toBeLessThan(0)
  })

  test("keeps queued messages in the same transcript row sequence", () => {
    const messages = [{ id: "old" }, { id: "queued" }, { id: "latest" }]
    expect(sessionTranscriptRows(messages, new Set(["queued"])).map((message) => message.id)).toEqual([
      "old",
      "latest",
      "queued",
    ])
  })

  test("stops tail-moving a queued turn once its own assistant starts", () => {
    const waiting = [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant", parentID: "user-1" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant", parentID: "user-1" },
    ]
    expect(sessionTranscriptRows(waiting, new Set(["user-2"])).map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "assistant-2",
      "user-2",
    ])

    const dispatched = [...waiting, { id: "assistant-3", role: "assistant", parentID: "user-2" }]
    expect(sessionTranscriptRows(dispatched, new Set(["user-2"])).map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "assistant-2",
      "user-2",
      "assistant-3",
    ])
  })

  test("keeps a later continuation after an intervening turn has started", () => {
    const messages = [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant", parentID: "user-1" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant", parentID: "user-2" },
      { id: "assistant-3", role: "assistant", parentID: "user-2" },
      { id: "assistant-4", role: "assistant", parentID: "user-1" },
    ]

    expect(sessionTranscriptRows(messages, new Set()).map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
      "assistant-3",
      "assistant-4",
    ])
  })

  test("keeps post-compaction assistant output after the compaction summary", () => {
    const messages = [
      { id: "user-1", role: "user" },
      { id: "assistant-before", role: "assistant", parentID: "user-1" },
      { id: "compaction-user", role: "user" },
      { id: "compaction-summary", role: "assistant", parentID: "compaction-user" },
      { id: "assistant-after", role: "assistant", parentID: "user-1" },
    ]

    expect(
      sessionTranscriptRows(messages, new Set(), { boundaryIDs: new Set(["compaction-user"]) }).map(
        (message) => message.id,
      ),
    ).toEqual(["user-1", "assistant-before", "compaction-user", "compaction-summary", "assistant-after"])
  })

  test("keeps a prompt queued during compaction after the resumed turn", () => {
    const waiting = [
      { id: "user-1", role: "user" },
      { id: "compaction-user", role: "user" },
      { id: "queued-user", role: "user" },
      { id: "compaction-summary", role: "assistant", parentID: "compaction-user" },
      { id: "compaction-continue", role: "user" },
      { id: "assistant-continue", role: "assistant", parentID: "compaction-continue" },
    ]
    const options = {
      boundaryIDs: new Set(["compaction-user"]),
      tailIDs: new Set(["queued-user"]),
    }

    expect(sessionTranscriptRows(waiting, new Set(), options).map((message) => message.id)).toEqual([
      "user-1",
      "compaction-user",
      "compaction-summary",
      "compaction-continue",
      "assistant-continue",
      "queued-user",
    ])

    const dispatched = [...waiting, { id: "assistant-queued", role: "assistant", parentID: "queued-user" }]
    expect(
      sessionTranscriptRows(dispatched, new Set(), {
        boundaryIDs: options.boundaryIDs,
        tailIDs: options.tailIDs,
      }).map((message) => message.id),
    ).toEqual([
      "user-1",
      "compaction-user",
      "compaction-summary",
      "compaction-continue",
      "assistant-continue",
      "queued-user",
      "assistant-queued",
    ])
  })

  test("deduplicates transcript rows before moving queued messages", () => {
    const messages = [
      { id: "old", version: 1 },
      { id: "duplicate", version: 1 },
      { id: "duplicate", version: 2 },
      { id: "queued", version: 1 },
    ]

    const rows = sessionTranscriptRows(messages, new Set(["queued"]))
    expect(rows.map((message) => message.id)).toEqual(["old", "duplicate", "queued"])
    expect(rows.find((message) => message.id === "duplicate")).toEqual({ id: "duplicate", version: 2 })
  })
})
