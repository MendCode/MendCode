import { describe, expect, test } from "bun:test"
import {
  sessionContentWidth,
  sessionLoopReceipt,
  sessionPendingInputSessionIDs,
  sessionTaskContinuation,
  sessionTopMetricsWidth,
  sessionTopbarLeftLabel,
  sessionTopbarLeftWidth,
  sessionUsageBarDisplayWidth,
  sessionPromptVisible,
} from "../../../src/cli/cmd/tui/util/session-layout"

describe("session layout", () => {
  test("shows the prompt for child sessions when there are no blocking prompts", () => {
    expect(
      sessionPromptVisible({
        isChildSession: true,
        permissionCount: 0,
        questionCount: 0,
        planReviewCount: 0,
      }),
    ).toBe(true)
  })

  test("hides the prompt while blocking prompts are active", () => {
    expect(
      sessionPromptVisible({
        isChildSession: false,
        permissionCount: 1,
        questionCount: 0,
        planReviewCount: 0,
      }),
    ).toBe(false)
  })

  test("hides the prompt for child sessions while their own blocking prompts are active", () => {
    expect(
      sessionPromptVisible({
        isChildSession: true,
        permissionCount: 1,
        questionCount: 0,
        planReviewCount: 0,
      }),
    ).toBe(false)
  })

  test("uses the current child session for pending input", () => {
    expect(
      sessionPendingInputSessionIDs({
        sessionID: "child-2",
        parentID: "parent-1",
        visibleSessionIDs: ["parent-1", "child-1", "child-2"],
      }),
    ).toEqual(["child-2"])
  })

  test("uses the visible parent family for parent pending input", () => {
    expect(
      sessionPendingInputSessionIDs({
        sessionID: "parent-1",
        visibleSessionIDs: ["parent-1", "child-1", "child-2"],
      }),
    ).toEqual(["parent-1", "child-1", "child-2"])
  })

  test("subtracts session side padding from the resize-sensitive content width", () => {
    expect(sessionContentWidth(120, false)).toBe(116)
    expect(sessionContentWidth(120, true)).toBe(120)
    expect(sessionContentWidth(3, false)).toBe(1)
  })

  test("keeps topbar metrics width deterministic", () => {
    const usage = {
      context: 6_508,
      contextLimit: 100_000,
      contextPercent: 6,
    }

    expect(sessionUsageBarDisplayWidth(usage)).toBe(11)
    expect(
      sessionTopMetricsWidth({
        diff: { added: 2_600, removed: 710 },
        usage,
      }),
    ).toBe(24)
  })

  test("truncates the topbar path before it can overlap metrics", () => {
    const metricsWidth = 24
    const leftWidth = sessionTopbarLeftWidth({ contentWidth: 60, metricsWidth })
    const label = sessionTopbarLeftLabel({
      branch: "vorlen-desktop-ui-polish",
      path: "~/Code/vorlen/vorlen-agent-final",
      maxWidth: leftWidth,
    })

    expect(leftWidth).toBe(35)
    expect(Bun.stringWidth(label)).toBeLessThanOrEqual(leftWidth)
    expect(label).toContain("…")
  })

  test("labels running loop actions with in-progress copy", () => {
    expect(sessionLoopReceipt({ action: "activate", toolStatus: "running" })).toEqual({ label: "starting", tone: "active" })
    expect(sessionLoopReceipt({ action: "pause", toolStatus: "running" })).toEqual({ label: "pausing", tone: "warning" })
    expect(sessionLoopReceipt({ action: "show", toolStatus: "running" })).toEqual({ label: "searching", tone: "info" })
  })

  test("labels completed loop tool actions with outcome copy", () => {
    expect(sessionLoopReceipt({ action: "activate", toolStatus: "completed" })).toEqual({ label: "started", tone: "success" })
    expect(sessionLoopReceipt({ action: "resume", toolStatus: "completed" })).toEqual({ label: "resumed", tone: "success" })
    expect(sessionLoopReceipt({ action: "update_agent", toolStatus: "completed" })).toEqual({ label: "updated", tone: "success" })
    expect(sessionLoopReceipt({ action: "stop", toolStatus: "completed" })).toEqual({ label: "stopped", tone: "danger" })
    expect(sessionLoopReceipt({ action: "list", toolStatus: "completed" })).toEqual({ label: "searched", tone: "muted" })
  })

  test("falls back to workflow state when no action outcome is available", () => {
    expect(sessionLoopReceipt({ workflowState: "sleeping", workflowPhase: "waiting" })).toEqual({ label: "waiting", tone: "warning" })
    expect(sessionLoopReceipt({ workflowState: "draft", workflowPhase: "draft" })).toEqual({ label: "draft", tone: "info" })
    expect(sessionLoopReceipt({ workflowState: "active", workflowPhase: "ready" })).toEqual({ label: "ready", tone: "info" })
    expect(sessionLoopReceipt({ workflowState: "working", workflowPhase: "monitor" })).toEqual({ label: "running", tone: "active" })
    expect(sessionLoopReceipt({ workflowState: "blocked", workflowPhase: "budget_exhausted" })).toEqual({ label: "budget reached", tone: "warning" })
    expect(sessionLoopReceipt({ workflowState: "needs_input" })).toEqual({ label: "needs input", tone: "warning" })
    expect(sessionLoopReceipt({ workflowState: "failed" })).toEqual({ label: "failed", tone: "danger" })
    expect(sessionLoopReceipt({ workflowState: "completed" })).toEqual({ label: "complete", tone: "success" })
  })

  test("uses workflow state for show/list and problem states", () => {
    expect(sessionLoopReceipt({ action: "show", toolStatus: "completed", workflowState: "sleeping", workflowPhase: "waiting" })).toEqual({ label: "waiting", tone: "warning" })
    expect(sessionLoopReceipt({ action: "list", toolStatus: "completed", workflowState: "completed" })).toEqual({ label: "complete", tone: "success" })
    expect(sessionLoopReceipt({ action: "activate", toolStatus: "completed", workflowState: "failed" })).toEqual({ label: "failed", tone: "danger" })
  })

  test("keeps resumed task calls attached to the original subagent card", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child", status: "completed" },
      { callID: "call-2", sessionID: "ses_child", taskID: "ses_child", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-1", sessionID: "ses_child" })).toEqual({
      duplicate: false,
      activeResume: true,
      resumeCount: 1,
    })
    expect(sessionTaskContinuation({ entries, callID: "call-2", sessionID: "ses_child", taskID: "ses_child" })).toEqual({
      duplicate: true,
      activeResume: false,
      resumeCount: 1,
    })
  })

  test("uses task_id to detect resumed task calls before metadata arrives", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child", status: "completed" },
      { callID: "call-2", taskID: "ses_child", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-2", taskID: "ses_child" }).duplicate).toBe(true)
  })

  test("does not collapse unrelated task calls", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child_1", status: "completed" },
      { callID: "call-2", sessionID: "ses_child_2", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-1", sessionID: "ses_child_1" })).toEqual({
      duplicate: false,
      activeResume: false,
      resumeCount: 0,
    })
    expect(sessionTaskContinuation({ entries, callID: "call-2", sessionID: "ses_child_2" })).toEqual({
      duplicate: false,
      activeResume: false,
      resumeCount: 0,
    })
  })
})
