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
  setupShouldChooseHomeSplitPanel,
  setupShouldShowExtractorAuthBlocker,
  truncateSetupText,
} from "../../src/cli/cmd/tui/routes/setup"
import { setupRailStepStatus } from "../../src/cli/cmd/tui/routes/setup/setup-rail"
import { loopRouteColumns, loopRouteFrameLayout, loopRouteKeyHint, loopRouteStackedListHeight } from "../../src/cli/cmd/tui/routes/loops"
import { memoryGraphMiniMap, memoryLayoutForDimensions, memoryPreviewText, memorySidebarProjectWorkspaces, memoryTabCellWidths, shouldMemoryRouteHandleKey, sideChatInputArtifacts } from "../../src/cli/cmd/tui/routes/memory"
import { contextAutoCompactLabel, contextInventoryRows, contextUsageBarCells, contextUsageGridCells, contextUsageGridLayout, contextUsageGridLegend, contextUsageGridRows } from "../../src/cli/cmd/tui/routes/session/dialog-context-usage"
import { startupLoadingText } from "../../src/cli/cmd/tui/component/startup-loading"
import {
  initialTuiPluginReady,
  isCurrentTuiBootstrap,
  syncBootstrapReadiness,
  syncReadyForStatus,
  themeModeWaitMs,
  tuiFastBootEnabled,
} from "../../src/cli/cmd/tui/util/fast-boot"

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

  test("centered home welcome skips the split-panel follow-up", () => {
    expect(setupShouldChooseHomeSplitPanel("centered")).toBe(false)
    expect(setupShouldChooseHomeSplitPanel("split")).toBe(true)
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

  test("memory graph mini map renders terminal-native nodes and links", () => {
    const graph = memoryGraphMiniMap({
      width: 48,
      height: 8,
      categories: [
        { id: "project.commands", label: "Commands", count: 1 },
        { id: "memory.policy", label: "Memory policy", count: 1 },
      ],
      facts: [
        { id: "a", scope: "project", categoryIDs: ["project.commands"], text: "Run focused memory tests from packages/opencode." },
        { id: "b", scope: "project", categoryIDs: ["memory.policy"], text: "Memory graph uses typed links." },
      ],
      links: [{ from: "a", to: "b", kind: "supports" }],
    })

    expect(graph.rows.join("\n")).toContain("·")
    expect(graph.legend.join("\n")).toContain("Commands")
    expect(graph.status).toContain("2/2 materialized")
    expect(graph.status).toContain("0 legacy-derived")
    expect(graph.status).toContain("1 explicit")
  })

  test("memory graph mini map infers compact fallback edges when links are absent", () => {
    const graph = memoryGraphMiniMap({
      width: 42,
      height: 7,
      categories: [
        { id: "project.commands", label: "Commands", count: 2 },
        { id: "architecture", label: "Architecture", count: 1 },
      ],
      facts: [
        { id: "a", scope: "project", categoryIDs: ["project.commands"], text: "Run focused memory tests from packages/opencode." },
        { id: "b", scope: "project", categoryIDs: ["project.commands"], text: "Use the package directory for Bun tests." },
        { id: "c", scope: "project", categoryIDs: ["architecture"], text: "Memory graph stores categories beside facts." },
      ],
      links: [],
    })

    expect(graph.rows.join("\n")).toContain("┈")
    expect(graph.status).toContain("3/3 materialized")
    expect(graph.status).toContain("0 explicit")
    expect(graph.status).toContain("2 inferred")
    expect(graph.legend.join("\n")).toContain("Commands")
  })

  test("memory graph mini map keeps empty state honest when nothing is materialized", () => {
    const graph = memoryGraphMiniMap({
      width: 42,
      categories: [{ id: "project.commands", label: "Commands", count: 1 }],
      facts: [],
      links: [],
    })

    expect(graph.rows).toEqual([])
    expect(graph.emptyState).toBe("empty")
    expect(graph.status).toContain("0/0 materialized")
    expect(graph.status).toContain("0 legacy-derived")
  })

  test("memory graph mini map reports legacy-derived facts without inventing graph nodes", () => {
    const graph = memoryGraphMiniMap({
      width: 48,
      categories: [{ id: "project.commands", label: "Commands", count: 2 }],
      facts: [
        { id: "legacy_a", scope: "project", categoryIDs: ["project.commands"], text: "Run Bun tests from the package directory.", materialized: false },
        { id: "legacy_b", scope: "project", categoryIDs: ["project.commands"], text: "Keep memory graph links explicit.", materialized: false },
      ],
      links: [],
    })

    expect(graph.rows).toEqual([])
    expect(graph.emptyState).toBe("legacy-only")
    expect(graph.status).toContain("0/2 materialized")
    expect(graph.status).toContain("2 legacy-derived")
    expect(graph.status).toContain("0 explicit")
    expect(graph.status).toContain("0 inferred")
  })

  test("memory graph mini map separates materialized facts from legacy-derived counts", () => {
    const graph = memoryGraphMiniMap({
      width: 48,
      categories: [{ id: "project.commands", label: "Commands", count: 2 }],
      facts: [
        { id: "graph_a", scope: "project", categoryIDs: ["project.commands"], text: "Materialized fact A." },
        { id: "graph_b", scope: "project", categoryIDs: ["project.commands"], text: "Materialized fact B." },
        { id: "legacy_a", scope: "project", categoryIDs: ["project.commands"], text: "Legacy-only fact.", materialized: false },
      ],
      links: [{ from: "graph_a", to: "graph_b", kind: "supports" }],
    })

    expect(graph.rows.join("\n")).toContain("·")
    expect(graph.status).toContain("2/3 materialized")
    expect(graph.status).toContain("1 legacy-derived")
    expect(graph.status).toContain("1 explicit")
  })

  test("memory graph mini map legend only describes visible categories", () => {
    const categories = Array.from({ length: 8 }, (_, index) => ({
      id: `category.${index}`,
      label: `Category ${index}`,
      count: 1,
    }))
    const graph = memoryGraphMiniMap({
      width: 48,
      height: 8,
      categories,
      facts: Array.from({ length: 20 }, (_, index) => ({
        id: `fact_${index.toString().padStart(2, "0")}`,
        scope: "project",
        categoryIDs: [`category.${index % categories.length}`],
        text: `Memory graph fact ${index}`,
        retrievalPriority: index,
      })),
      links: [],
    })

    expect(graph.labels.join("\n")).toContain("Memory graph fact 0")
    expect(graph.legend.join("\n")).toContain("Category 0")
    expect(graph.legend.join("\n")).not.toContain("Category 5")
  })

  test("memory route hotkeys stay inactive while a prompt dialog is open", () => {
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false })).toBe(true)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, defaultPrevented: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, textInputActive: true })).toBe(false)
  })

  test("memory tabs distribute across available width", () => {
    expect(memoryTabCellWidths({ width: 60, count: 5 })).toEqual([12, 11, 11, 11, 11])
    expect(memoryTabCellWidths({ width: 14, count: 5 }).reduce((sum, value) => sum + value, 0)).toBe(10)
  })

  test("context usage label reflects configured compaction threshold", () => {
    expect(contextAutoCompactLabel({ usage: { context: 70, contextLimit: 100 }, thresholdPercent: 85 })).toBe(
      "Auto-compact at 85% · ~15 tokens remaining",
    )
    expect(contextAutoCompactLabel({ usage: { context: 99, contextLimit: 100 }, thresholdPercent: 100 })).toBe(
      "Auto-compact at 100% · ~1 tokens remaining",
    )
    expect(contextUsageBarCells({ context: 25, contextLimit: 100 }).filter(Boolean)).toHaveLength(12)
    expect(contextUsageGridCells({
      usage: { context: 50, contextLimit: 100, rawInput: 20, cacheRead: 5, cacheWrite: 0, rawOutput: 10, reasoning: 15 },
      messages: 4,
      toolCalls: 2,
    }).map((cell) => cell.symbol).join("")).toContain("⚙")
    expect(contextUsageGridCells({
      usage: { context: 3, contextLimit: 144, rawInput: 1, cacheRead: 0, cacheWrite: 0, rawOutput: 1, reasoning: 1 },
      messages: 1,
      toolCalls: 1,
    }).filter((cell) => cell.kind !== "free")).toHaveLength(1)
    const gridRows = contextUsageGridRows(contextUsageGridCells({
      usage: { context: 50, contextLimit: 100, rawInput: 20, cacheRead: 5, cacheWrite: 0, rawOutput: 10, reasoning: 15 },
      messages: 4,
      toolCalls: 2,
    }))
    expect(gridRows).toHaveLength(6)
    expect(gridRows.every((row) => row.length === 8)).toBe(true)
    expect(contextUsageGridLayout(80)).toEqual({ cells: 48, columns: 8, compactLegend: true })
    expect(contextUsageGridLayout(130)).toEqual({ cells: 128, columns: 16, compactLegend: false })
    expect(contextUsageGridLayout(170)).toEqual({ cells: 240, columns: 24, compactLegend: false })
    expect(contextUsageGridRows(contextUsageGridCells({
      usage: { context: 50, contextLimit: 100, rawInput: 20, cacheRead: 5, cacheWrite: 0, rawOutput: 10, reasoning: 15 },
      messages: 4,
      toolCalls: 2,
      cellCount: contextUsageGridLayout(170).cells,
    }), contextUsageGridLayout(170).columns)).toHaveLength(10)
    expect(contextUsageGridLegend(true).map((item) => item.label)).toEqual(["input", "tools", "cache", "think", "output", "free"])
    expect(contextInventoryRows({ messages: 10, turns: 4, textParts: 6, toolCalls: 2, reasoningParts: 4, compactions: 0 })).toEqual([
      { label: "Messages", value: "10" },
      { label: "Turns", value: "4" },
      { label: "Text", value: "6" },
      { label: "Tools", value: "2" },
      { label: "Reasoning", value: "4" },
      { label: "Compactions", value: "0" },
    ])
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

  test("fast boot allows first paint without treating loading sync as hydrated", () => {
    expect(tuiFastBootEnabled({})).toBe(true)
    expect(tuiFastBootEnabled({ OPENCODE_FAST_BOOT: "1" })).toBe(true)
    expect(tuiFastBootEnabled({ OPENCODE_FAST_BOOT: "0" })).toBe(false)
    expect(tuiFastBootEnabled({ OPENCODE_FAST_BOOT: "1", MENDCODE_FAST_BOOT: "false" })).toBe(false)
    expect(initialTuiPluginReady(true)).toBe(true)
    expect(initialTuiPluginReady(false)).toBe(false)
    expect(syncReadyForStatus("loading")).toBe(false)
    expect(syncReadyForStatus("partial")).toBe(true)
    expect(syncReadyForStatus("complete")).toBe(true)
    expect(syncBootstrapReadiness({ fastBoot: true })).toEqual({
      blockProviderUxMetadata: false,
      blockSessionList: false,
    })
    expect(syncBootstrapReadiness({ fastBoot: true, continueSession: true })).toEqual({
      blockProviderUxMetadata: false,
      blockSessionList: true,
    })
    expect(syncBootstrapReadiness({ fastBoot: false })).toEqual({
      blockProviderUxMetadata: true,
      blockSessionList: false,
    })
    expect(isCurrentTuiBootstrap({
      generation: 2,
      currentGeneration: 2,
      workspace: "workspace-a",
      currentWorkspace: "workspace-a",
    })).toBe(true)
    expect(isCurrentTuiBootstrap({
      generation: 1,
      currentGeneration: 2,
      workspace: "workspace-a",
      currentWorkspace: "workspace-a",
    })).toBe(false)
    expect(isCurrentTuiBootstrap({
      generation: 2,
      currentGeneration: 2,
      workspace: "workspace-a",
      currentWorkspace: "workspace-b",
    })).toBe(false)
    expect(themeModeWaitMs(true)).toBe(50)
    expect(themeModeWaitMs(false)).toBe(1000)
    expect(startupLoadingText({ pluginsReady: false })).toBe("Loading plugins...")
    expect(startupLoadingText({ pluginsReady: true, syncLoading: true })).toBe("Loading workspace...")
    expect(startupLoadingText({ pluginsReady: true, syncLoading: false })).toBe("Finishing startup...")
  })
})
