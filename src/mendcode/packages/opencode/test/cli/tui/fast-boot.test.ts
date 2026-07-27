import { describe, expect, test } from "bun:test"
import { initialTuiPluginReady, syncBootstrapReadiness, themeModeWaitMs, tuiFastBootEnabled } from "@/cli/cmd/tui/util/fast-boot"

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
})
