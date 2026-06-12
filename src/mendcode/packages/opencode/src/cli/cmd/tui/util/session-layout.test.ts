import { describe, expect, test } from "bun:test"
import { sessionTopbarLeftLabel } from "./session-layout"

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
})
