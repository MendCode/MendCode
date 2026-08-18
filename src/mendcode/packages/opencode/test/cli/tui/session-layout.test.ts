import { describe, expect, test } from "bun:test"
import {
  sessionContentWidth,
  sessionDiffStatsLabel,
  sessionHeaderTitleAlign,
  sessionHeaderTitleDisplay,
  sessionLoopReceipt,
  shouldRenderSessionLoopCard,
  shouldRenderSessionWorkflowCard,
  sessionPendingInputSessionIDs,
  sessionPendingInputStatus,
  sessionTaskContinuation,
  sessionTranscriptBottomSpacer,
  sessionTopMetricsWidth,
  sessionTopbarLayout,
  sessionTopbarLeftLabel,
  sessionTopbarLeftWidth,
  sessionTopbarNavLayout,
  sessionUsageBarDisplayWidth,
  sessionPromptVisible,
  truncateEndDisplay,
} from "../../../src/cli/cmd/tui/util/session-layout"

describe("session layout", () => {
  test("renders workflow cards for normalized and persisted full presentation profiles", () => {
    expect(shouldRenderSessionWorkflowCard("mendcode")).toBe(true)
    expect(shouldRenderSessionWorkflowCard("full")).toBe(true)
    expect(shouldRenderSessionWorkflowCard("minimal")).toBe(false)
    expect(shouldRenderSessionWorkflowCard("raw")).toBe(false)
    expect(shouldRenderSessionWorkflowCard()).toBe(false)
  })

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

  test("reserves transcript clearance above the prompt and pending-input footer", () => {
    expect(sessionTranscriptBottomSpacer()).toBe(3)
    expect(sessionTranscriptBottomSpacer(24)).toBe(27)
  })

  test("labels a question after compaction as waiting instead of assistant generation", () => {
    expect(
      sessionPendingInputStatus({ permissionCount: 0, questionCount: 1, planReviewCount: 0, assistantActive: true }),
    ).toBe("waiting for answer")
    expect(
      sessionPendingInputStatus({ permissionCount: 0, questionCount: 0, planReviewCount: 0, assistantActive: false }),
    ).toBe("idle")
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

  test("can show changed file count without changing the default diff label", () => {
    const diff = { added: 2_600, removed: 710, files: 12 }

    expect(sessionDiffStatsLabel(diff)).toBe("+2.6K -710")
    expect(sessionDiffStatsLabel(diff, { showFiles: true })).toBe("12 files +2.6K -710")
    expect(sessionDiffStatsLabel(diff, { showCounts: false, showFiles: true })).toBe("12 files")
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

  test("sizes the header title from terminal width instead of leftover spacing", () => {
    expect(sessionTopbarLayout({ contentWidth: 240, metricsWidth: 24, titleVisible: true })).toMatchObject({
      leftWidth: 77,
      titleWidth: 83,
      metricsWidth: 24,
    })
    expect(sessionTopbarLayout({ contentWidth: 240, metricsWidth: 24, navWidth: 80, titleVisible: true })).toMatchObject({
      leftWidth: 77,
      titleWidth: 83,
      metricsWidth: 24,
    })
  })

  test("keeps the title centered when the side widgets change", () => {
    const layout = sessionTopbarLayout({ contentWidth: 240, metricsWidth: 24, titleVisible: true })
    const titleStart = layout.leftWidth + layout.titleGapWidth

    expect(Math.abs(2 * titleStart + layout.titleWidth - 240)).toBeLessThanOrEqual(1)
  })

  test("caps nav and metrics so the proportional title keeps room on small terminals", () => {
    const layout = sessionTopbarLayout({ contentWidth: 60, metricsWidth: 40, navWidth: 50, titleVisible: true })

    expect(layout.metricsWidth).toBe(18)
    expect(layout.titleWidth).toBe(22)
    expect(layout.leftWidth).toBe(18)
    expect(layout.navWidth).toBeLessThanOrEqual(Math.floor(layout.leftWidth * 0.6))
    if (layout.navWidth > 0) expect(layout.pathWidth + layout.navWidth + 1).toBe(layout.leftWidth)
    else expect(layout.pathWidth).toBe(layout.leftWidth)
    expect(layout.titleGapWidth).toBe(1)
    expect(layout.metricsGapWidth).toBe(1)
    expect(layout.leftWidth + layout.titleWidth + layout.metricsWidth + layout.titleGapWidth + layout.metricsGapWidth).toBeLessThanOrEqual(60)
  })

  test("gives the path all non-metric width when the title is hidden", () => {
    expect(sessionTopbarLayout({ contentWidth: 80, metricsWidth: 16, navWidth: 20, titleVisible: false })).toMatchObject({
      leftWidth: 63,
      titleWidth: 0,
      metricsWidth: 16,
      metricsGapWidth: 1,
    })
  })

  test("centers the title and truncates only at the end", () => {
    expect(sessionHeaderTitleAlign(undefined)).toBe("center")
    expect(truncateEndDisplay("Centrar título con poco ancho", 16)).toBe("Centrar título…")
    expect(sessionHeaderTitleDisplay({ value: "Centrar título con poco ancho", maxWidth: 16 })).toBe("Centrar título…")
  })

  test("scrolls long titles without inserting a middle ellipsis when animations are enabled", () => {
    const first = sessionHeaderTitleDisplay({ value: "Centrar título con poco ancho", maxWidth: 16, animated: true })
    const next = sessionHeaderTitleDisplay({
      value: "Centrar título con poco ancho",
      maxWidth: 16,
      animated: true,
      offset: 3,
    })

    expect(first).not.toContain("…")
    expect(next).not.toContain("…")
    expect(first).not.toContain("   ")
    expect(next).not.toContain("   ")
    expect(next).toContain(" · ")
    expect(first).not.toBe(next)
    expect(Bun.stringWidth(first)).toBeLessThanOrEqual(16)
    expect(Bun.stringWidth(next)).toBeLessThanOrEqual(16)
  })

  test("keeps the subagent path readable while reserving narrow topbar regions", () => {
    const layout = sessionTopbarLayout({
      contentWidth: 60,
      metricsWidth: 40,
      navWidth: Bun.stringWidth("↖ Parent up ← Prev left → Next right"),
      titleVisible: true,
    })
    const path = sessionTopbarLeftLabel({
      branch: "main",
      path: "~/Code/MendCode",
      maxWidth: layout.pathWidth,
      isChildSession: true,
    })

    expect(layout.pathWidth).toBeGreaterThanOrEqual(8)
    expect(Bun.stringWidth(path)).toBeLessThanOrEqual(layout.pathWidth)
    expect(path).toContain("…")
    expect(path.endsWith("Code")).toBe(true)
  })

  test("collapses subagent navigation as complete items instead of clipping a trailing key", () => {
    const nav = sessionTopbarNavLayout({
      width: 13,
      items: [
        { icon: "↖", label: "Parent", key: "up" },
        { icon: "←", label: "Prev", key: "left" },
        { icon: "→", label: "Next", key: "right" },
      ],
    })

    expect(nav.items.map((item) => item.text)).toEqual(["↖ up", "← left", "→"])
    expect(nav.width).toBe(Bun.stringWidth(nav.items.map((item) => item.text).join(" ")))
    expect(nav.width).toBeLessThanOrEqual(13)
    expect(nav.items.every((item) => Bun.stringWidth(item.text) === item.width)).toBe(true)
  })

  test("keeps every topbar region bounded across narrow terminal widths", () => {
    Array.of(1, 2, 4, 8, 12, 20, 40, 60).forEach((contentWidth) => {
      const layout = sessionTopbarLayout({
        contentWidth,
        metricsWidth: 32,
        navWidth: 40,
        titleVisible: true,
      })
      const regions =
        layout.leftWidth +
        layout.titleWidth +
        layout.metricsWidth +
        layout.titleGapWidth +
        layout.metricsGapWidth

      expect(regions).toBeLessThanOrEqual(Math.max(1, contentWidth))
      expect(layout.pathWidth).toBeGreaterThanOrEqual(0)
      expect(layout.navWidth).toBeGreaterThanOrEqual(0)
      expect(layout.titleWidth).toBeGreaterThanOrEqual(0)
      expect(layout.metricsWidth).toBeGreaterThanOrEqual(0)
    })
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

  test("renders rich loop cards only for completed operations that resolved a loop", () => {
    expect(shouldRenderSessionLoopCard({ toolStatus: "error", workflowID: "loop_1" })).toBe(false)
    expect(shouldRenderSessionLoopCard({ toolStatus: "running", workflowID: "loop_1" })).toBe(false)
    expect(shouldRenderSessionLoopCard({ toolStatus: "completed", workflows: [] })).toBe(false)
    expect(shouldRenderSessionLoopCard({ toolStatus: "completed", workflowID: "loop_1" })).toBe(true)
    expect(
      shouldRenderSessionLoopCard({ toolStatus: "completed", workflows: [{ workflowID: "loop_1" }] }),
    ).toBe(true)
  })

  test("renders only the latest call when a task resumes the same subagent", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child", status: "completed" },
      { callID: "call-2", sessionID: "ses_child", taskID: "ses_child", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-1", sessionID: "ses_child" })).toEqual({
      duplicate: true,
      activeResume: false,
      resumed: false,
      resumeCount: 1,
    })
    expect(sessionTaskContinuation({ entries, callID: "call-2", sessionID: "ses_child", taskID: "ses_child" })).toEqual({
      duplicate: false,
      activeResume: true,
      resumed: true,
      resumeCount: 1,
    })
  })

  test("uses task_id to detect resumed task calls before metadata arrives", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child", status: "completed" },
      { callID: "call-2", taskID: "ses_child", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-2", taskID: "ses_child" })).toMatchObject({
      duplicate: false,
      activeResume: true,
      resumed: true,
    })
  })

  test("does not collapse unrelated task calls", () => {
    const entries = [
      { callID: "call-1", sessionID: "ses_child_1", status: "completed" },
      { callID: "call-2", sessionID: "ses_child_2", status: "running" },
    ]

    expect(sessionTaskContinuation({ entries, callID: "call-1", sessionID: "ses_child_1" })).toEqual({
      duplicate: false,
      activeResume: false,
      resumed: false,
      resumeCount: 0,
    })
    expect(sessionTaskContinuation({ entries, callID: "call-2", sessionID: "ses_child_2" })).toEqual({
      duplicate: false,
      activeResume: false,
      resumed: false,
      resumeCount: 0,
    })
  })
})
