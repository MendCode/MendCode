import { describe, expect, test } from "bun:test"
import { renderAsciiText } from "@/cli/cmd/tui/component/ascii-text"
import {
  configuredHomeLogoText,
  fittedHomeLogoText,
  formatHomeAgentInboxSummary,
  formatHomeAgentViewSummary,
  homeAgentViewElapsedLabel,
  homeAgentInboxSummaryLines,
  homeAgentInboxSummaryVisible,
  homeAgentViewPanelWidth,
  homeAgentViewRecentlyActive,
  homeAgentViewRowLayout,
  homeAgentViewSectionGapVisible,
  homeAgentViewSummaryLines,
  homeAgentViewSummaryVisible,
  homePromptPlaceholderText,
  homeRightPanelContainerWidth,
  homeSurfaceTextLayout,
  mergeAgentViewAggregateFallback,
  homeSplitIdentityPaneWidth,
  homeSplitIdentityWidth,
  homeSplitLogoMaxWidth,
  resolveHomePromptTarget,
  shouldOpenSelectedAgentViewSession,
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

describe("shouldOpenSelectedAgentViewSession", () => {
  test("does not let a pending new-session submit open the selected session", () => {
    expect(
      shouldOpenSelectedAgentViewSession({
        promptInput: "",
        submitPending: true,
        selectedSessionID: "selected-session",
      }),
    ).toBe(false)
  })

  test("only opens a selected session for an empty, idle prompt", () => {
    expect(
      shouldOpenSelectedAgentViewSession({
        promptInput: "",
        selectedSessionID: "selected-session",
      }),
    ).toBe(true)
    expect(
      shouldOpenSelectedAgentViewSession({
        promptInput: "new task",
        selectedSessionID: "selected-session",
      }),
    ).toBe(false)
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

  test("formats Agent View elapsed time from a stable start without a live timer", () => {
    const now = 1_800_000_010_000
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 11_000 })).toBe("11s")
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 65_000 })).toBe("1m")
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 7 * 24 * 60 * 60 * 1_000 })).toBe("1w")
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 30 * 24 * 60 * 60 * 1_000 })).toBe("1mo")
    expect(homeAgentViewElapsedLabel({ now, startedAt: now - 365 * 24 * 60 * 60 * 1_000 })).toBe("1y")
    expect(homeAgentViewElapsedLabel({ now })).toBe("0s")
  })

  test("keeps recently active Agent View rows visible through transient polling gaps", () => {
    const now = 1_800_000_010_000
    expect(homeAgentViewRecentlyActive({ now, lastSeenAt: now - 5_999, graceMs: 6_000 })).toBe(true)
    expect(homeAgentViewRecentlyActive({ now, lastSeenAt: now - 6_001, graceMs: 6_000 })).toBe(false)
    expect(homeAgentViewRecentlyActive({ now, graceMs: 6_000 })).toBe(false)
  })

  test("only shows the Agent View headline when waiting, looping, or working is active", () => {
    expect(homeAgentViewSummaryVisible({ waiting: 0, looping: 0, working: 0 })).toBe(false)
    expect(homeAgentViewSummaryVisible({ waiting: 1, looping: 0, working: 0 })).toBe(true)
    expect(homeAgentViewSummaryVisible({ waiting: 0, looping: 1, working: 0 })).toBe(true)
    expect(homeAgentViewSummaryVisible({ waiting: 0, looping: 0, working: 1 })).toBe(true)
  })

  test("only shows the inbox headline when pending or active commands exist", () => {
    expect(homeAgentInboxSummaryVisible({ pending: 1, active: 0, completed: 0, blocked: 0, pendingCapacity: 3, overLimitTargets: 0 })).toBe(true)
    expect(homeAgentInboxSummaryVisible({ pending: 0, active: 1, completed: 0, blocked: 0, pendingCapacity: 3, overLimitTargets: 0 })).toBe(true)
    expect(homeAgentInboxSummaryVisible({ pending: 0, active: 0, completed: 4, blocked: 2, pendingCapacity: 3, overLimitTargets: 0 })).toBe(false)
  })

  test("does not leave a leading gap when both headlines are hidden", () => {
    expect(homeAgentViewSectionGapVisible({ headlineVisible: false, precedingSectionCounts: [] })).toBe(false)
    expect(homeAgentViewSectionGapVisible({ headlineVisible: true, precedingSectionCounts: [] })).toBe(true)
    expect(homeAgentViewSectionGapVisible({ headlineVisible: false, precedingSectionCounts: [0, 2] })).toBe(true)
  })

  test("keeps background rows when aggregate refresh omits them transiently", () => {
    expect(
      mergeAgentViewAggregateFallback(
        [{ sessionID: "foreground" }],
        [{ sessionID: "background" }, { sessionID: "foreground" }],
      ),
    ).toEqual([{ sessionID: "foreground" }, { sessionID: "background" }])

    expect(
      mergeAgentViewAggregateFallback(
        [{ sessionID: "worker", state: "completed" }],
        [{ sessionID: "worker", state: "working" }],
      ),
    ).toEqual([{ sessionID: "worker", state: "working" }])
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

  test("uses active-only Agent View labels on narrow widths", () => {
    expect(
      formatHomeAgentViewSummary({
        waiting: 2,
        looping: 1,
        working: 3,
        width: 54,
      }),
    ).toBe("Agent View · 2 wait · 1 loop · 3 work")
    expect(
      formatHomeAgentViewSummary({
        waiting: 2,
        looping: 1,
        working: 3,
        width: 72,
      }),
    ).toBe("Agent View sessions · 2 waiting · 1 looping · 3 working")
    expect(
      formatHomeAgentViewSummary({
        waiting: 2,
        looping: 1,
        working: 3,
        width: 30,
      }),
    ).toBe("2 wait · 1 loop · 3 work")
    expect(homeAgentViewSummaryLines({ waiting: 2, looping: 1, working: 3, width: 30 })).toEqual([
      "Agent View sessions",
      "2 wait · 1 loop · 3 work",
    ])
  })

  test("uses honest Agent inbox queue copy and capacity slots", () => {
    expect(
      formatHomeAgentInboxSummary({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 54,
      }),
    ).toBe("Inbox · 3 queued · 4 slots · 1 active · 1 over")
    expect(
      formatHomeAgentInboxSummary({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 72,
      }),
    ).toBe("Agent inbox · 3 queued · 4 slots · 1 active · 1 over limit · 1 blocked")
    expect(
      formatHomeAgentInboxSummary({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 30,
      }),
    ).toBe("3 queued · 4 slots · 1 active")
    expect(
      homeAgentInboxSummaryLines({
        summary: { pending: 3, active: 1, completed: 1, blocked: 1, pendingCapacity: 4, overLimitTargets: 1 },
        width: 30,
      }),
    ).toEqual(["Agent inbox", "3 queued · 4 slots · 1 active", "1 blocked · 1 over"])
    expect(
      formatHomeAgentInboxSummary({
        summary: { pending: 0, active: 1, completed: 0, blocked: 0, pendingCapacity: 0, overLimitTargets: 0 },
        width: 54,
      }),
    ).toBe("Agent inbox · 0 queued · 0 slots · 1 active")
  })
})
