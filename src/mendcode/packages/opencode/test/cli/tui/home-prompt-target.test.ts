import { describe, expect, test } from "bun:test"
import { renderAsciiText } from "@/cli/cmd/tui/component/ascii-text"
import {
  configuredHomeLogoText,
  fittedHomeLogoText,
  homeAgentViewPanelWidth,
  homePromptPlaceholderText,
  homeSplitIdentityWidth,
  homeSplitLogoMaxWidth,
  resolveHomePromptTarget,
} from "@/cli/cmd/tui/routes/home"
import { defaultTuiProfile } from "@/mend/profile"
import { defaultHomeMascot } from "@/mend/tui/mascot"

describe("resolveHomePromptTarget", () => {
  test("keeps Agent View selection out of /new prompt submissions", () => {
    expect(
      resolveHomePromptTarget({
        workspaceID: "workspace-1",
        selectedAgentViewSessionID: "selected-session",
      }),
    ).toEqual({
      historyScope: "project:workspace-1",
      sessionID: undefined,
    })
  })
})

describe("homePromptPlaceholderText", () => {
  test("selected session copy still says Enter starts /new", () => {
    expect(homePromptPlaceholderText({ selectedTitle: "Existing session" })).toEqual([
      "New task here — Enter starts /new. Selected session: Existing session",
    ])
  })

  test("selected session copy does not imply submitting into that session", () => {
    expect(homePromptPlaceholderText({ selectedTitle: "Existing session" })[0]).not.toContain("opens selected")
  })
})

describe("configuredHomeLogoText", () => {
  test("renders the configured ASCII title in title mode, including default MendCode", () => {
    const profile = structuredClone(defaultTuiProfile())
    profile.identity.logoMode = "title"
    profile.identity.logoFont = "shadow"

    expect(configuredHomeLogoText({ profile })).toBe(renderAsciiText("MendCode", "shadow"))
  })

  test("renders mascot mode and setup preview ASCII without falling back to the legacy logo", () => {
    const profile = structuredClone(defaultTuiProfile())
    profile.identity.logoMode = "mascot"

    expect(configuredHomeLogoText({ profile })).toBe(defaultHomeMascot)
    expect(configuredHomeLogoText({ profile, surfaceHomeAscii: "CUSTOM\nASCII" })).toBe("CUSTOM\nASCII")
  })

  test("falls back to a logo font that fits the available home width", () => {
    const small = renderAsciiText("MendCode", "small")
    const smallWidth = small.split("\n").reduce((max, line) => Math.max(max, line.length), 0)
    const profile = structuredClone(defaultTuiProfile())
    profile.identity.logoMode = "title"
    profile.identity.logoFont = "shadow"

    expect(configuredHomeLogoText({ profile, maxWidth: smallWidth, maxHeight: 5 })).toBe(small)
    expect(fittedHomeLogoText({ value: "MendCode", font: "shadow", maxWidth: smallWidth, maxHeight: 5 })).toBe(small)
  })
})

describe("Home split welcome sizing", () => {
  test("reserves title width in mascot mode while keeping Agent View compact", () => {
    expect(homeAgentViewPanelWidth({ available: 120 })).toBe(54)
    expect(homeAgentViewPanelWidth({ available: 26 })).toBe(30)

    expect(
      homeSplitIdentityWidth({
        logoWidth: 10,
        titleWidth: 72,
        panelWidth: 130,
      }),
    ).toBe(74)
  })

  test("caps identity width so the right Agent View still fits", () => {
    expect(
      homeSplitIdentityWidth({
        logoWidth: 8,
        titleWidth: 120,
        panelWidth: 100,
        agentMinWidth: 42,
      }),
    ).toBe(54)
  })

  test("uses a conservative split logo width so large fonts fall back before the right panel clips them", () => {
    expect(homeSplitLogoMaxWidth({ terminalWidth: 100, split: true, rightPanel: "agentManager" })).toBe(30)
    expect(homeSplitLogoMaxWidth({ terminalWidth: 100, split: false, rightPanel: "agentManager" })).toBe(92)
  })
})
