import { describe, expect, test } from "bun:test"
import { setupSteps, requiredSetupSteps } from "../../src/mend/setup/state"
import {
  setupExtractorAuthMessage,
  setupLabelValueLine,
  setupMemoryLearningStatus,
  setupShouldShowExtractorAuthBlocker,
  truncateSetupText,
} from "../../src/cli/cmd/tui/routes/setup"

describe("setup route smoke", () => {
  test("includes optional package, tui, memory, and permissions steps in the setup flow contract", () => {
    expect(setupSteps).toEqual(["provider", "models", "budget", "package", "tui", "prompt", "memory", "permissions"])
    expect(requiredSetupSteps).toEqual(["provider", "models", "budget", "prompt"])
  })

  test("keeps setup status copy within terminal row budgets", () => {
    const blocker = "OpenAI OAuth token expired and MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID is missing"
    const message = setupExtractorAuthMessage(blocker)
    const line = setupLabelValueLine("Extractor auth", message, 72)

    expect(message).toContain("OAuth expired")
    expect(line.length).toBeLessThanOrEqual(72)
    expect(truncateSetupText("abcdef", 4)).toBe("a...")
  })

  test("treats connected runtime provider auth as ready for memory learning", () => {
    const auth = {
      providerID: "openai",
      mendRunReady: false,
      oauthExpired: true,
      oauthRefreshReady: false,
      blockers: ["OpenAI OAuth token expired and MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID is missing"],
    }

    expect(setupMemoryLearningStatus({
      generate: true,
      outputCallsProviders: true,
      auth,
      connectedProviderIDs: ["openai"],
    })).toBe("ready")
    expect(setupShouldShowExtractorAuthBlocker({
      generate: true,
      auth,
      connectedProviderIDs: ["openai"],
    })).toBe(false)
  })
})
