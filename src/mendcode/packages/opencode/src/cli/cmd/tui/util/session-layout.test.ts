import { describe, expect, test } from "bun:test"
import { sessionHeaderTitleJustify, sessionTopbarLeftLabel, sessionTopbarLeftWidthWithTitle } from "./session-layout"

describe("session topbar layout", () => {
  test("labels child sessions as subagents", () => {
    const label = sessionTopbarLeftLabel({
      branch: "main",
      path: "~/Code/MendCode",
      maxWidth: 80,
      isChildSession: true,
    })

    expect(label).toStartWith("Subagent | ")
  })

  test("does not label parent sessions as subagents", () => {
    const label = sessionTopbarLeftLabel({
      branch: "main",
      path: "~/Code/MendCode",
      maxWidth: 80,
    })

    expect(label).not.toContain("Subagent")
  })

  test("keeps subagent labels within the available width", () => {
    const label = sessionTopbarLeftLabel({
      branch: "feature/very-long-branch-name",
      path: "~/Code/MendCode/src/mendcode/packages/opencode",
      maxWidth: 18,
      isChildSession: true,
    })

    expect(Bun.stringWidth(label)).toBeLessThanOrEqual(18)
  })

  test("reserves room for configurable header title", () => {
    expect(sessionTopbarLeftWidthWithTitle({ contentWidth: 120, metricsWidth: 24, titleVisible: false })).toBe(95)
    expect(sessionTopbarLeftWidthWithTitle({ contentWidth: 120, metricsWidth: 24, titleVisible: true })).toBe(50)
    expect(sessionHeaderTitleJustify("left")).toBe("flex-start")
    expect(sessionHeaderTitleJustify("center")).toBe("center")
    expect(sessionHeaderTitleJustify("right")).toBe("flex-end")
  })
})
