import { describe, expect, test } from "bun:test"
import {
  sessionContentWidth,
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
        isChildSession: true,
        permissionCount: 1,
        questionCount: 0,
        planReviewCount: 0,
      }),
    ).toBe(false)
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
})
