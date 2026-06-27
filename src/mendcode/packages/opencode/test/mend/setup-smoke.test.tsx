import { describe, expect, test } from "bun:test"
import { setupSteps, requiredSetupSteps, type SetupState } from "../../src/mend/setup/state"
import { routeReturnTarget } from "../../src/cli/cmd/tui/context/route"
import {
  isPublicGitHubURL,
  setupExtractorAuthMessage,
  setupLabelValueLine,
  setupMemoryDialogCurrentValue,
  setupMemoryLearningStatus,
  setupProviderAuthMessage,
  setupShouldShowExtractorAuthBlocker,
  truncateSetupText,
} from "../../src/cli/cmd/tui/routes/setup"
import { setupRailStepStatus } from "../../src/cli/cmd/tui/routes/setup/setup-rail"
import { loopRouteColumns, loopRouteFrameLayout, loopRouteKeyHint, loopRouteStackedListHeight } from "../../src/cli/cmd/tui/routes/loops"
import { memoryLayoutForDimensions, memoryPreviewText, memorySidebarProjectWorkspaces, shouldMemoryRouteHandleKey, sideChatInputArtifacts } from "../../src/cli/cmd/tui/routes/memory"

describe("setup route smoke", () => {
  test("includes optional health, package, tui, memory, and permissions steps in the setup flow contract", () => {
    expect(setupSteps).toEqual(["provider", "models", "budget", "health", "package", "tui", "prompt", "memory", "permissions"])
    expect(requiredSetupSteps).toEqual(["provider", "models", "budget", "prompt"])
    expect(setupRailStepStatus("health")).toBe("optional")
  })

  test("keeps setup status copy within terminal row budgets", () => {
    const blocker = "OpenAI OAuth token expired and MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID is missing"
    const message = setupExtractorAuthMessage(blocker)
    const line = setupLabelValueLine("Extractor auth", message, 72)

    expect(message).toContain("OAuth expired")
    expect(line.length).toBeLessThanOrEqual(72)
    expect(truncateSetupText("abcdef", 4)).toBe("a...")
  })

  test("keeps provider setup status honest when live auth is blocked", () => {
    const state: SetupState = {
      version: 0 as const,
      completedOnce: false,
      completedSteps: ["provider"],
      currentStep: "provider" as const,
      dismissedAt: null,
      lastOpenedAt: null,
      updatedAt: "now",
    }

    expect(setupRailStepStatus("provider", state, { authReady: false, authBlocked: true })).toBe("auth blocked")
    expect(setupRailStepStatus("provider", state, { authReady: true })).toBe("complete")
    expect(setupRailStepStatus("provider", undefined, { authReady: false, authBlocked: false })).toBe("pending")
    expect(setupProviderAuthMessage("missing env:OPENAI_API_KEY")).toContain("OPENAI_API_KEY")
    expect(setupProviderAuthMessage("missing usable OpenAI auth state")).toContain("OAuth or API key")
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

  test("accepts only canonical public GitHub repo URLs for package import", () => {
    expect(isPublicGitHubURL("https://github.com/org/repo")).toBe(true)
    expect(isPublicGitHubURL("https://github.com/org/repo.git")).toBe(true)
    expect(isPublicGitHubURL("https://github.com/org/repo/tree/main")).toBe(false)
    expect(isPublicGitHubURL("https://github.com/org/repo/issues/1")).toBe(false)
    expect(isPublicGitHubURL("https://token@github.com/org/repo")).toBe(false)
    expect(isPublicGitHubURL("https://github.com/org/repo?token=secret")).toBe(false)
    expect(isPublicGitHubURL("file:///tmp/repo")).toBe(false)
  })

  test("memory dialog highlights generated proposals when learning is enabled", () => {
    expect(setupMemoryDialogCurrentValue({ enabled: true, generate: true })).toBe("generate")
    expect(setupMemoryDialogCurrentValue({ enabled: true, generate: false })).toBe("enable-use")
    expect(setupMemoryDialogCurrentValue({ enabled: false, generate: false })).toBe("disable")
  })

  test("memory route returns to its caller instead of losing session context", () => {
    expect(routeReturnTarget({
      type: "memory",
      returnTo: { type: "session", sessionID: "ses_test" },
    })).toEqual({ type: "session", sessionID: "ses_test" })
  })

  test("memory dashboard previews redact sensitive inline values", () => {
    expect(memoryPreviewText("Use OPENAI_API_KEY=sk-test-secret-value for local smoke", 80)).toBe(
      "Use OPENAI_API_KEY=<redacted> for local smoke",
    )
    expect(memoryPreviewText("token: abcdefghijklmnopqrstuvwxyz", 80)).toBe("token=<redacted>")
  })

  test("memory route uses numeric terminal dimensions for wide multipane layout", () => {
    const layout = memoryLayoutForDimensions({ width: 180, height: 40 })

    expect(layout.wide).toBe(true)
    expect(layout.medium).toBe(true)
    expect(layout.tiny).toBe(false)
    expect(layout.contentWidth).toBe(174)
  })

  test("loops route does not force a wider frame than compact terminals", () => {
    expect(loopRouteFrameLayout(44)).toEqual({
      compact: true,
      paddingX: 0,
      width: 44,
      narrow: true,
      stacked: true,
    })

    expect(loopRouteFrameLayout(60)).toMatchObject({ compact: true, paddingX: 1, width: 58, stacked: true })
    expect(loopRouteFrameLayout(72)).toMatchObject({ compact: true, paddingX: 1, width: 70, stacked: true })
    expect(loopRouteFrameLayout(88)).toMatchObject({ compact: true, paddingX: 1, width: 86, stacked: true })
    expect(loopRouteFrameLayout(95)).toMatchObject({ compact: true, stacked: true })
    expect(loopRouteFrameLayout(96)).toMatchObject({ compact: false, stacked: false })
    expect(loopRouteColumns({ width: 44, stacked: true })).toEqual({ listWidth: 44, detailWidth: 44 })
    expect(loopRouteColumns({ width: 120, stacked: false })).toEqual({ listWidth: 38, detailWidth: 79 })
  })

  test("loops route keeps stacked widths intentional", () => {
    expect(loopRouteStackedListHeight(1, true)).toBe(6)
    expect(loopRouteStackedListHeight(1, false)).toBe(8)
    expect(loopRouteStackedListHeight(12, true)).toBe(10)
    expect(loopRouteStackedListHeight(12, false)).toBe(16)
    expect(loopRouteStackedListHeight(12, true, 14)).toBe(6)
    expect(loopRouteStackedListHeight(12, true, 12)).toBe(4)
    expect(loopRouteStackedListHeight(12, false, 20)).toBe(8)
    expect(loopRouteKeyHint({ width: 46, narrow: true, compact: true })).toBe("a/h · o · q")
    expect(loopRouteKeyHint({ width: 88, narrow: true, compact: true })).toBe("a/h view · o chat · q back")
  })

  test("memory route keeps the side chat pane visible on medium-height terminals", () => {
    const layout = memoryLayoutForDimensions({ width: 140, height: 28 })

    expect(layout.wide).toBe(true)
    expect(layout.medium).toBe(true)
    expect(layout.tiny).toBe(false)
  })

  test("memory route hotkeys stay inactive while a prompt dialog is open", () => {
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false })).toBe(true)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, defaultPrevented: true })).toBe(false)
  })

  test("memory side chat summarizes pasted text in the input chrome", () => {
    expect(sideChatInputArtifacts("line one\nline two\nline three")).toEqual(["pasted text · 3 lines · 28 chars"])
    expect(sideChatInputArtifacts("![clip](data:image/png;base64,abc)")).toEqual(["pasted image ref · 1"])
    expect(sideChatInputArtifacts("/tmp/clip.png\n/tmp/context.md")).toEqual(["pasted image ref · 1", "pasted file ref · 1"])
    expect(sideChatInputArtifacts("short")).toEqual([])
  })

  test("memory sidebar keeps current project fixed and sorts other project memories", () => {
    const otherOld = {
      id: "old",
      root: "/repo/old",
      displayName: "old",
      firstUserMessageAt: "2026-06-15T00:00:00.000Z",
      lastActiveAt: "2026-06-15T00:00:00.000Z",
      gitRoot: null,
      repoFingerprint: null,
      worktreePath: null,
      source: "current-session" as const,
      groupIDs: [],
      archived: false,
    }
    const otherNew = { ...otherOld, id: "new", root: "/repo/new", displayName: "new", lastActiveAt: "2026-06-17T00:00:00.000Z" }
    const current = { ...otherOld, id: "current", root: "/repo/current", displayName: "current", lastActiveAt: "2026-06-18T00:00:00.000Z" }

    expect(memorySidebarProjectWorkspaces({
      currentRoot: "/repo/current/",
      workspaces: [otherOld, current, otherNew],
    }).map((workspace) => workspace.id)).toEqual(["new", "old"])
  })
})
