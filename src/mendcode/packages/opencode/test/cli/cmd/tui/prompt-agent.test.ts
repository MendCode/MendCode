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
        hasSession: true,
        sessionUsesSubagent: true,
        localModel: { providerID: "openai", modelID: "gpt-5.5" },
        localOverride: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        localOverrideUpdatedAt: 200,
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
        userModelCreatedAt: 100,
        sessionModel: { providerID: "openai", id: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" })
  })

  test("uses latest user message when local override is older than the submitted turn", () => {
    expect(
      resolveSelectedPromptModel({
        hasSession: true,
        sessionUsesSubagent: false,
        localModel: { providerID: "openai", modelID: "gpt-5.5-fast" },
        localOverride: { providerID: "openai", modelID: "gpt-5.5-fast" },
        localOverrideUpdatedAt: 100,
        userModel: { providerID: "openai", modelID: "gpt-5.4" },
        userModelCreatedAt: 200,
        sessionModel: { providerID: "openai", id: "gpt-5.4" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
  })

  test("uses local model override when it was changed after the latest user message", () => {
    expect(
      resolveSelectedPromptModel({
        hasSession: true,
        sessionUsesSubagent: false,
        localModel: { providerID: "openai", modelID: "gpt-5.5-fast" },
        localOverride: { providerID: "openai", modelID: "gpt-5.5-fast" },
        localOverrideUpdatedAt: 300,
        userModel: { providerID: "openai", modelID: "gpt-5.4" },
        userModelCreatedAt: 200,
        sessionModel: { providerID: "openai", id: "gpt-5.4" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.5-fast" })
  })

  test("keeps historical subagent model when there is no explicit override", () => {
    expect(
      resolveSelectedPromptModel({
        hasSession: true,
        sessionUsesSubagent: true,
        localModel: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
  })

  test("keeps the historical session model for primary sessions without a local override", () => {
    expect(
      resolveSelectedPromptModel({
        hasSession: true,
        sessionUsesSubagent: false,
        localModel: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
  })

  test("uses the local model before a session exists", () => {
    expect(
      resolveSelectedPromptModel({
        hasSession: false,
        sessionUsesSubagent: false,
        localModel: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        userModel: { providerID: "openai", modelID: "gpt-5.2" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" })
  })
})

describe("resolveSelectedPromptVariant", () => {
  test("uses explicit local variant override inside an existing session", () => {
    expect(
      resolveSelectedPromptVariant({
        hasSession: true,
        localVariant: "fast",
        hasLocalVariantOverride: true,
        localVariantOverrideUpdatedAt: 200,
        userModel: { variant: "low" },
        userModelCreatedAt: 100,
      }),
    ).toBe("fast")
  })

  test("uses latest user variant when local variant override is older than the submitted turn", () => {
    expect(
      resolveSelectedPromptVariant({
        hasSession: true,
        localVariant: "low",
        hasLocalVariantOverride: true,
        localVariantOverrideUpdatedAt: 100,
        userModel: { variant: "medium" },
        userModelCreatedAt: 200,
      }),
    ).toBe("medium")
  })

  test("falls back to the historical variant when there is no explicit local variant override", () => {
    expect(
      resolveSelectedPromptVariant({
        hasSession: true,
        hasLocalVariantOverride: false,
        localVariant: "medium",
        userModel: { variant: "low" },
        sessionModel: { variant: "medium" },
      }),
    ).toBe("low")
  })

  test("uses the local variant outside a session", () => {
    expect(
      resolveSelectedPromptVariant({
        hasSession: false,
        localVariant: "medium",
        hasLocalVariantOverride: false,
        userModel: { variant: "low" },
      }),
    ).toBe("medium")
  })

  test("uses the configured local default variant before a session exists", () => {
    expect(
      resolveSelectedPromptVariant({
        hasSession: false,
        localVariant: "medium",
        hasLocalVariantOverride: false,
      }),
    ).toBe("medium")
  })
})
