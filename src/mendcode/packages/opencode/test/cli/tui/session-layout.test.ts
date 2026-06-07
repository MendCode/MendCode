import { describe, expect, test } from "bun:test"
import { sessionPromptVisible } from "../../../src/cli/cmd/tui/util/session-layout"

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
})
