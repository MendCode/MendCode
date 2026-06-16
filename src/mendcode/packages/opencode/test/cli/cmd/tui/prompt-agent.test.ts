import { describe, expect, test } from "bun:test"
import {
  resolveActivePromptAgentName,
  resolveSelectedPromptModel,
  resolveSelectedPromptVariant,
} from "../../../../src/cli/cmd/tui/component/prompt/agent"

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

describe("resolveSelectedPromptModel", () => {
  test("keeps explicit local model override for subagent sessions", () => {
    expect(
      resolveSelectedPromptModel({
        sessionUsesSubagent: true,
        localModel: { providerID: "openai", modelID: "gpt-5.5" },
        localOverride: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
        sessionModel: { providerID: "openai", id: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" })
  })

  test("keeps historical subagent model when there is no explicit override", () => {
    expect(
      resolveSelectedPromptModel({
        sessionUsesSubagent: true,
        localModel: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
  })

  test("uses local model for primary sessions", () => {
    expect(
      resolveSelectedPromptModel({
        sessionUsesSubagent: false,
        localModel: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" })
  })
})

describe("resolveSelectedPromptVariant", () => {
  test("uses local variant with an explicit override", () => {
    expect(
      resolveSelectedPromptVariant({
        sessionUsesSubagent: true,
        localVariant: "max",
        hasLocalOverride: true,
        userModel: { variant: "low" },
      }),
    ).toBe("max")
  })
})
