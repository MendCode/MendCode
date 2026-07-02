import { describe, expect, test } from "bun:test"
import { sessionMessageVirtualWindow, stickyUserIDFromVirtualWindow } from "@/cli/cmd/tui/util/session-virtual-window"

const messages = Array.from({ length: 300 }, (_, index) => ({
  id: `msg-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
}))

describe("session transcript virtual window", () => {
  test("keeps small sessions fully rendered", () => {
    expect(sessionMessageVirtualWindow({ total: 20, scrollTop: 0, viewportHeight: 30, followOutput: true })).toEqual({
      start: 0,
      end: 20,
      topSpacer: 0,
      bottomSpacer: 0,
      virtualized: false,
    })
  })

  test("virtualizes very large sessions by default to keep reopen memory bounded", () => {
    expect(sessionMessageVirtualWindow({ total: 1_000, scrollTop: 0, viewportHeight: 30, followOutput: true })).toEqual({
      start: 946,
      end: 1_000,
      topSpacer: 5_676,
      bottomSpacer: 0,
      virtualized: true,
    })
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

    expect(window.start).toBe(250)
    expect(window.end).toBe(300)
    expect(window.topSpacer).toBe(1250)
    expect(window.bottomSpacer).toBe(0)
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

    expect(window.start).toBe(90)
    expect(window.end).toBe(140)
    expect(window.topSpacer).toBe(450)
    expect(window.bottomSpacer).toBe(800)
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
})
