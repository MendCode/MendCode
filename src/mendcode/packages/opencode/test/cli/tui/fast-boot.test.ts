import { describe, expect, test } from "bun:test"
import {
  homePromptBootstrapReady,
  initialTuiPluginReady,
  syncBootstrapReadiness,
  themeModeWaitMs,
  tuiFastBootEnabled,
} from "@/cli/cmd/tui/util/fast-boot"

describe("TUI fast boot", () => {
  test("defaults to fast boot while keeping an explicit opt-out", () => {
    expect(tuiFastBootEnabled({})).toBe(true)
    expect(tuiFastBootEnabled({ MENDCODE_FAST_BOOT: "false" })).toBe(false)
    expect(tuiFastBootEnabled({ MENDCODE_FAST_BOOT: "false", OPENCODE_FAST_BOOT: "true" })).toBe(false)
  })

  test("does not block first paint on metadata or session list in fast mode", () => {
    expect(syncBootstrapReadiness({ fastBoot: true })).toEqual({
      blockProviderMetadata: false,
      blockProviderUxMetadata: false,
      blockSessionList: false,
    })
    expect(syncBootstrapReadiness({ fastBoot: true, continueSession: true })).toEqual({
      blockProviderMetadata: false,
      blockProviderUxMetadata: false,
      blockSessionList: true,
    })
    expect(initialTuiPluginReady(true)).toBe(true)
    expect(themeModeWaitMs(true)).toBeLessThan(themeModeWaitMs(false))
  })

  test("does not mount a cold-start prompt before the global model is hydrated", () => {
    expect(
      homePromptBootstrapReady({
        providerMetadataReady: false,
        modelPolicyReady: false,
      }),
    ).toBe(false)
    expect(
      homePromptBootstrapReady({
        providerMetadataReady: true,
        modelPolicyReady: false,
      }),
    ).toBe(false)
    expect(
      homePromptBootstrapReady({
        providerMetadataReady: true,
        modelPolicyReady: true,
      }),
    ).toBe(true)
  })
})
