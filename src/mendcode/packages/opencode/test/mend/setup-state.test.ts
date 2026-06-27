import { describe, expect, test } from "bun:test"
import { isSetupComplete } from "../../src/mend/setup/state"

describe("setup state optional steps", () => {
  test("health, package, tui, memory, and permissions steps are optional for completion", () => {
    expect(isSetupComplete({
      version: 0,
      completedOnce: false,
      currentStep: "prompt",
      completedSteps: ["provider", "models", "budget", "health", "package", "tui", "prompt"],
      dismissedAt: null,
      lastOpenedAt: null,
      updatedAt: null,
    })).toBe(true)
  })
})
