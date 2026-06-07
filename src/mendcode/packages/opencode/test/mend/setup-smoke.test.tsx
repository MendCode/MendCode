import { describe, expect, test } from "bun:test"
import { setupSteps, requiredSetupSteps } from "../../src/mend/setup/state"

describe("setup route smoke", () => {
  test("includes optional package, tui, memory, and permissions steps in the setup flow contract", () => {
    expect(setupSteps).toEqual(["provider", "models", "budget", "package", "tui", "prompt", "memory", "permissions"])
    expect(requiredSetupSteps).toEqual(["provider", "models", "budget", "prompt"])
  })
})
