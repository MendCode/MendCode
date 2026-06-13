import { describe, expect, test } from "bun:test"
import { resolveActivePromptAgentName } from "../../../../src/cli/cmd/tui/component/prompt/agent"

describe("resolveActivePromptAgentName", () => {
  test("uses local primary agent so tab cycling updates the prompt mode", () => {
    expect(
      resolveActivePromptAgentName({
        sessionAgentName: "build",
        localAgentName: "plan",
        primaryAgentNames: ["build", "plan", "execute"],
      }),
    ).toBe("plan")
  })

  test("keeps session subagent when the session is not a primary mode", () => {
    expect(
      resolveActivePromptAgentName({
        sessionAgentName: "code-reviewer",
        localAgentName: "plan",
        primaryAgentNames: ["build", "plan", "execute"],
      }),
    ).toBe("code-reviewer")
  })
})
