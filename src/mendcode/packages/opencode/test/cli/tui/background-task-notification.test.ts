import { describe, expect, test } from "bun:test"
import { backgroundTaskToast } from "@tui/util/background-task-notification"

describe("background task notifications", () => {
  test("does not create a toast for successful completion", () => {
    expect(
      backgroundTaskToast({
        state: "completed",
        title: "Large implementation",
        summary: "A long successful result that should stay in task_status output.",
      }),
    ).toBeUndefined()
  })

  test("keeps failure signaling bounded and actionable", () => {
    const summary = "x".repeat(2_000)
    const notification = backgroundTaskToast({ state: "failed", title: "Inspect cache", summary })

    expect(notification).toMatchObject({ title: "Subagent failed", variant: "error", duration: 8_000 })
    expect(notification?.message.length).toBeLessThanOrEqual(96 + 2 + 240)
    expect(notification?.message).not.toContain(summary)
  })

  test("keeps needs-input signaling compact when no detail is available", () => {
    expect(backgroundTaskToast({ state: "needs_input", title: "Review changes" })).toEqual({
      title: "Subagent needs input",
      message: "Review changes: Action required",
      variant: "info",
      duration: 8_000,
    })
  })
})
