import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MEND_TUI_CUSTOMIZATION,
  readMendTuiCustomization,
  resetMendTuiCustomization,
  resolveMendSessionAccent,
  resolveMendTerminalTitle,
  writeMendTuiCustomization,
} from "../../src/mend/tui/customization"

describe("TUI customization contract", () => {
  test("uses the default chrome settings and preserves the legacy terminal title key", () => {
    const values: Record<string, unknown> = { terminal_title_enabled: false }
    const get = <Value = unknown>(key: string, fallback?: Value): Value =>
      values[key] === undefined ? (fallback as Value) : (values[key] as Value)

    expect(readMendTuiCustomization(get)).toMatchObject({
      ...DEFAULT_MEND_TUI_CUSTOMIZATION,
      terminalTitle: false,
      diffFiles: false,
    })
  })

  test("persists partial changes and reset restores the complete contract", () => {
    const values: Record<string, unknown> = {}
    const get = <Value = unknown>(key: string, fallback?: Value): Value =>
      values[key] === undefined ? (fallback as Value) : (values[key] as Value)
    const set = (key: string, value: unknown) => {
      values[key] = value
    }

    const next = writeMendTuiCustomization(get, set, { diffFiles: false, sessionAccent: "random" })
    expect(next.diffFiles).toBe(false)
    expect(next.sessionAccent).toBe("random")
    expect(readMendTuiCustomization(get).diffFiles).toBe(false)

    resetMendTuiCustomization(set)
    expect(readMendTuiCustomization(get)).toEqual(DEFAULT_MEND_TUI_CUSTOMIZATION)
    expect(values.terminal_title_enabled).toBe(true)
  })

  test("resolves terminal title templates and deterministic session accents", () => {
    expect(
      resolveMendTerminalTitle({
        template: "{product} · {session} · {route} · {path}",
        product: "MendCode",
        session: "Checkout",
        route: "Session",
        path: "~/repo",
      }),
    ).toBe("MendCode · Checkout · Session · ~/repo")

    const first = resolveMendSessionAccent({ sessionID: "ses_123", accent: "random", fallback: "#ffffff" })
    const second = resolveMendSessionAccent({ sessionID: "ses_123", accent: "random", fallback: "#ffffff" })
    expect(first).toBe(second)
    expect(resolveMendSessionAccent({ sessionID: "ses_123", accent: "theme", fallback: "#ffffff" })).toBe("#ffffff")
  })
})
