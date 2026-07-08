import { describe, expect, test } from "bun:test"
import { renderAsciiText } from "@/cli/cmd/tui/component/ascii-text"
import {
  configuredHomeLogoText,
  fittedHomeLogoText,
  formatHomeAgentViewSummary,
  formatHomeCoordinatorSummary,
  homeAgentViewElapsedLabel,
  homeAgentViewPanelWidth,
  homeAgentViewRecentlyActive,
  homeAgentViewRowLayout,
  homePromptPlaceholderText,
  homeRightPanelContainerWidth,
  homeSurfaceTextLayout,
  mergeAgentViewAggregateFallback,
  homeSplitIdentityPaneWidth,
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

describe("homeSurfaceTextLayout", () => {
  test("recomputes width and lines from the current surface text", () => {
    expect(homeSurfaceTextLayout("M\nC")).toEqual({ lines: ["M", "C"], width: 1 })
    expect(homeSurfaceTextLayout("MENDCODE\n  wide")).toEqual({ lines: ["MENDCODE", "  wide"], width: 8 })
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

  test("centers the split identity pane against the fixed Agent View column", () => {
    expect(homeSplitIdentityPaneWidth({ panelWidth: 120, rightPanelWidth: 54, twoColumn: true })).toBe(62)
    expect(homeSplitIdentityPaneWidth({ panelWidth: 120, rightPanelWidth: 54, twoColumn: false })).toBe(116)
  })

  test("sizes the split right panel container with its resize padding", () => {
    expect(homeRightPanelContainerWidth({ rightPanelWidth: 54, twoColumn: true })).toBe(55)
    expect(homeRightPanelContainerWidth({ rightPanelWidth: 44, twoColumn: false })).toBe(44)
  })

  test("formats active Agent View elapsed time from a stable start", () => {
    const now = 1_800_000_010_000
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 11_000 })).toBe("11s")
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 65_000 })).toBe("1m")
    expect(homeAgentViewElapsedLabel({ now })).toBe("0s")
  })

  test("keeps recently active Agent View rows visible through transient polling gaps", () => {
    const now = 1_800_000_010_000
    expect(homeAgentViewRecentlyActive({ now, lastSeenAt: now - 5_999, graceMs: 6_000 })).toBe(true)
    expect(homeAgentViewRecentlyActive({ now, lastSeenAt: now - 6_001, graceMs: 6_000 })).toBe(false)
    expect(homeAgentViewRecentlyActive({ now, graceMs: 6_000 })).toBe(false)
  })

  test("keeps background rows when aggregate refresh omits them transiently", () => {
    expect(
      mergeAgentViewAggregateFallback(
        [{ sessionID: "foreground" }],
        [{ sessionID: "background" }, { sessionID: "foreground" }],
      ),
    ).toEqual([{ sessionID: "foreground" }, { sessionID: "background" }])
  })

  test("stacks Agent View metadata before title and timestamps collide", () => {
    expect(homeAgentViewRowLayout({ width: 54 })).toEqual({
      compact: true,
      markerWidth: 2,
      titleWidth: 35,
      detailWidth: 52,
      timeWidth: 16,
    })
    expect(homeAgentViewRowLayout({ width: 44 })).toEqual({
      compact: true,
      markerWidth: 2,
      titleWidth: 27,
      detailWidth: 42,
      timeWidth: 14,
    })
    expect(homeAgentViewRowLayout({ width: 72 })).toEqual({
      compact: false,
      markerWidth: 2,
      titleWidth: 30,
      detailWidth: 22,
      timeWidth: 16,
    })
  })

  test("uses clearer compact Home Agent View labels on narrow widths", () => {
    expect(
      formatHomeAgentViewSummary({
        needsInput: 2,
        looping: 1,
        working: 3,
        completed: 4,
        pendingCommands: 1,
        width: 54,
      }),
    ).toBe("Workers · 2 wait · 1 loop · 3 work · 4 done · 1 cmd")
    expect(
      formatHomeAgentViewSummary({
        needsInput: 2,
        looping: 1,
        working: 3,
        completed: 4,
        pendingCommands: 1,
        width: 72,
      }),
    ).toBe("Worker sessions · 2 waiting · 1 looping · 3 working · 4 done · 1 queued")
  })

  test("uses clearer coordinator queue and usage hint copy", () => {
    expect(
      formatHomeCoordinatorSummary({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 48,
      }),
    ).toBe("Queue · 3/4 queued · 1 run · 1 blocked")
    expect(
      formatHomeCoordinatorSummary({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 72,
      }),
    ).toBe("Commands (detach with /bg) · 3/4 queued · 1 over limit · 1 running · 1 blocked")
  })
})
