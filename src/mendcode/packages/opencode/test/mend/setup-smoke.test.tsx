import { describe, expect, test } from "bun:test"
import { layoutAsciiGraph, renderAsciiGraph } from "@mendcode/plugin/tui"
import { setupSteps, requiredSetupSteps, type SetupState } from "../../src/mend/setup/state"
import { routeReturnTarget } from "../../src/cli/cmd/tui/context/route"
import {
  inferModelPresetAuthMode,
  isPublicGitHubURL,
  setupExtractorAuthMessage,
  setupLabelValueLine,
  setupMemoryDialogCurrentValue,
  setupMemoryLearningStatus,
  setupPresetDetails,
  setupPresetList,
  setupProviderAuthMessage,
  setupShouldChooseHomeSplitPanel,
  setupShouldShowExtractorAuthBlocker,
  truncateSetupText,
} from "../../src/cli/cmd/tui/routes/setup"
import { setupRailStepStatus } from "../../src/cli/cmd/tui/routes/setup/setup-rail"
import {
  compactLoopDetailLines,
  compactLoopSummaryLines,
  latestLoopWakeReason,
  loopContractPreviewRows,
  loopDetailRowLayout,
  loopRouteColumns,
  loopRouteFrameLayout,
  loopRouteHeaderLayout,
  loopRouteKeyHint,
  loopRouteStackedListHeight,
  loopSummaryRows,
  loopSupervisionRows,
} from "../../src/cli/cmd/tui/routes/loops"
import {
  dreamEvidenceLabel,
  dreamGraphProposalLabel,
  dreamLatestActivity,
  dreamTranscriptRows,
  memoryGraphCommandHints,
  memoryGraphExplorerLayout,
  memoryGraphFactProjectLabels,
  memoryGraphNavigationDirection,
  memoryGraphMiniMap,
  memoryGraphNodeTone,
  memoryGraphPanDirection,
  memoryGraphPanViewport,
  memoryGraphSearchMatches,
  memoryListWindow,
  memoryLayoutForDimensions,
  normalizeMemoryGraphViewPreference,
  memoryPreviewText,
  memorySidebarProjectWorkspaces,
  memoryTabCellWidths,
  memoryTabPresentation,
  shouldMemoryRouteHandleKey,
} from "../../src/cli/cmd/tui/routes/memory"
import {
  contextAutoCompactLabel,
  contextInventoryRows,
  contextUsageBarCells,
  contextUsageGridCells,
  contextUsageGridLayout,
  contextUsageGridLegend,
  contextUsageGridRows,
} from "../../src/cli/cmd/tui/routes/session/dialog-context-usage"
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
  test("starts with quick-start profiles and keeps health out of the setup flow", () => {
    expect(setupSteps).toEqual(["start", "provider", "models", "budget", "prompt", "tui", "memory", "permissions", "package"])
    expect(requiredSetupSteps).toEqual(["provider", "models", "budget", "prompt"])
    expect(setupRailStepStatus("start")).toBe("optional")
    expect(setupPresetList.map((preset) => preset.id)).toEqual(["default", "minimal", "full", "custom"])
    expect(setupPresetDetails.minimal.changes).toContain("memory off")
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

  test("only infers preset auth mode when a provider/model pair is unambiguous", () => {
    expect(inferModelPresetAuthMode("openai", "gpt-5-mini")).toBe("api-key")
    expect(inferModelPresetAuthMode("openai", "gpt-5.6")).toBe("api-key")
    expect(inferModelPresetAuthMode("openai", "gpt-5.6-sol")).toBe("chatgpt-subscription-oauth")
    expect(inferModelPresetAuthMode("openai", "gpt-5.2-codex")).toBeNull()
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

  test("dream transcript rows summarize events, proposals, graph links, and safety", () => {
    const detail = {
      run: { status: "completed", startedAt: "2026-07-02T10:00:00.000Z", completedAt: "2026-07-02T10:00:03.000Z", failureReason: null },
      events: [
        { at: "2026-07-02T10:00:00.000Z", status: "started", message: "Dream started" },
        { at: "2026-07-02T10:00:03.000Z", status: "completed", message: "Dream completed with 1 proposals" },
      ],
      evidence: [{ id: "file:AGENTS.md", sourceType: "file", sourcePath: "AGENTS.md", redacted: false }],
      proposals: [{ id: "prop_1", operation: "create", scope: "project", text: "Keep Dream reviewable." }],
      graphProposals: [{
        id: "dreamlink_1",
        createdAt: "2026-07-02T10:00:02.000Z",
        kind: "related",
        confidence: 0.8,
        reason: "Shared memory category: memory.policy",
        fromSummary: "Dream policy",
        toSummary: "Graph links",
      }],
      decisions: [{ at: "2026-07-02T10:00:02.500Z", status: "created-proposal", reason: "Dream proposed memory maintenance." }],
      safety: { reads: [{}], skippedSources: [], failures: [], redactions: 0 },
    } satisfies NonNullable<Parameters<typeof dreamTranscriptRows>[0]>
    const rows = dreamTranscriptRows(detail)
    const activityDetail = {
      run: { status: "completed", startedAt: "2026-07-02T10:00:00.000Z", completedAt: "2026-07-02T10:00:03.000Z", failureReason: null },
      events: rows.filter((row) => row.label === "completed").map((row) => ({ at: row.at, status: row.label, message: row.detail })),
      evidence: [],
      proposals: [],
      graphProposals: [],
      decisions: [],
      safety: null,
    } satisfies NonNullable<Parameters<typeof dreamLatestActivity>[0]>

    expect(rows.map((row) => row.label)).toContain("graph proposals")
    expect(rows.map((row) => row.label)).toContain("safety")
    expect(rows.map((row) => row.detail).join("\n")).toContain("1 pending")
    expect(dreamLatestActivity(activityDetail)?.label).toBe("completed")
  })

  test("dream latest activity prefers completed events over same-timestamp synthetic rows", () => {
    expect(dreamLatestActivity({
      run: { status: "completed", startedAt: "2026-07-02T10:00:00.000Z", completedAt: "2026-07-02T10:00:03.000Z", failureReason: null },
      events: [{ at: "2026-07-02T10:00:03.000Z", status: "completed", message: "Dream completed with 1 proposals" }],
      evidence: [{ id: "file:/tmp/secret/AGENTS.md", sourceType: "file", sourcePath: "/tmp/secret/AGENTS.md", redacted: true }],
      proposals: [{ id: "prop_1", operation: "create", scope: "project", text: "Keep Dream reviewable." }],
      graphProposals: [{ id: "dreamlink_1", createdAt: "2026-07-02T10:00:03.000Z", kind: "related", status: "pending", confidence: 0.8, reason: "Shared memory category: memory.policy", fromSummary: "Dream policy", toSummary: "Graph links" }],
      decisions: [{ at: "2026-07-02T10:00:03.000Z", status: "created-proposal", reason: "Dream proposed memory maintenance." }],
      safety: { reads: [{}], skippedSources: [], failures: [], redactions: 1 },
    })?.label).toBe("completed")
  })

  test("dream transcript and latest activity surface reviewed graph proposal outcomes", () => {
    const detail = {
      run: { status: "completed", startedAt: "2026-07-02T10:00:00.000Z", completedAt: "2026-07-02T10:00:03.000Z", failureReason: null },
      events: [{ at: "2026-07-02T10:00:03.000Z", status: "completed", message: "Dream completed with 1 graph proposals" }],
      evidence: [],
      proposals: [],
      graphProposals: [{
        id: "dreamlink_1",
        createdAt: "2026-07-02T10:00:02.000Z",
        reviewedAt: "2026-07-02T10:00:05.000Z",
        kind: "related",
        status: "rejected",
        confidence: 0.8,
        reason: "Shared memory category: memory.policy",
        rejectionReason: "Not related enough",
        fromSummary: "Dream policy",
        toSummary: "Graph links",
      }],
      decisions: [],
      safety: { reads: [], skippedSources: [], failures: [], redactions: 0 },
    } as const

    expect(dreamTranscriptRows(detail).some((row) => row.label === "rejected" && row.detail.includes("Not related enough"))).toBe(true)
    expect(dreamLatestActivity(detail)?.label).toBe("rejected")
  })

  test("dream helpers avoid leaking raw evidence paths and ids", () => {
    expect(dreamEvidenceLabel({
      id: "file:/Users/test/private/notes.md",
      sourceType: "file",
      sourcePath: "/Users/test/private/notes.md",
      redacted: true,
    })).toBe("file · notes.md · redacted")
    expect(dreamEvidenceLabel({
      id: "memory:fact_secret_internal_id",
      sourceType: "memory",
      sourcePath: null,
      redacted: false,
    })).toBe("memory · saved memory")
    expect(dreamGraphProposalLabel({
      kind: "related",
      reason: "Shared memory category: memory.policy",
      fromSummary: "Do not leak filesystem evidence paths to providers.",
      toSummary: "Use redacted Dream evidence summaries in Memory Center.",
    })).not.toContain("fact_secret_internal_id")
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
    expect(loopRouteKeyHint({ width: 46, narrow: true, compact: true })).toBe("↑ parent · c/g · a/h · i · o · q")
    expect(loopRouteKeyHint({ width: 88, narrow: true, compact: true })).toBe("↑ parent · c project · g all · a/h view · i inspect · pgup/dn page · o chat · q back")
  })

  test("loops route reserves non-shrinking responsive header rows", () => {
    expect(loopRouteHeaderLayout(loopRouteFrameLayout(117).narrow)).toEqual({
      flexDirection: "column",
      height: 2,
      flexShrink: 0,
    })
    expect(loopRouteHeaderLayout(loopRouteFrameLayout(118).narrow)).toEqual({
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
    })
  })

  test("loops detail metadata reserves a separator after full labels", () => {
    expect(loopDetailRowLayout(57)).toEqual({ labelWidth: 11, gap: 1, valueWidth: 45 })
    expect("evaluation".length).toBeLessThanOrEqual(loopDetailRowLayout(57).labelWidth)
    expect("latest run".length).toBeLessThanOrEqual(loopDetailRowLayout(57).labelWidth)
    expect("next action".length).toBeLessThanOrEqual(loopDetailRowLayout(57).labelWidth)
  })

  test("loops route summarizes supervised run state for the detail view", () => {
    const events = [
      {
        id: "evt_1",
        type: "wake",
        title: "External signal",
        summary: "GitHub issue updated.",
      },
    ]
    const rows = loopSupervisionRows({
      workflow: {
        id: "loop_1",
        state: "working",
        objective: "Keep issue triage current.",
        metrics: { inputTokens: 10, outputTokens: 5, cost: 0.0025 },
      },
      summary: {
        workflowID: "loop_1",
        state: "working",
        phase: "evaluating",
        objective: "Keep issue triage current.",
        verdict: "continue",
        verdictSummary: "Needs one more validation.",
        gateSummary: {
          total: 2,
          pass: 1,
          fail: 0,
          blocked: 0,
          awaitingApproval: 1,
          skip: 0,
          blocking: "approval-policy",
        },
        evidenceSummary: ["Focused test passed", "Diff artifact captured"],
        nextAction: "Ask for approval before posting.",
        memorySummary: { total: 3, open: 1, latest: ["Issue labels verified"] },
        costSummary: { tokens: 15, cost: 0.0025 },
      },
      runs: [
        {
          id: "run_1",
          state: "completed",
          trigger: "external-signal",
          phase: "gated",
          rubricResult: { status: "pass", score: 0.9, threshold: 0.85, blockers: [] },
          gateResults: [
            {
              id: "manual-review",
              status: "pass",
              waiver: { action: "waive", actor: "user:operator", reason: "Reviewed manually.", time: 1 },
            },
          ],
        },
      ],
      events,
      artifacts: [{ id: "artifact_1", kind: "diff", title: "Diff", summary: "Changed triage note." }],
    })

    expect(latestLoopWakeReason(events)).toBe("External signal: GitHub issue updated.")
    expect(rows.find((row) => row[0] === "verdict")?.[1]).toContain("Needs one more validation")
    expect(rows.find((row) => row[0] === "gates")?.[1]).toContain("approval-policy")
    expect(rows.find((row) => row[0] === "rubric")?.[1]).toBe("pass · 90% / 85%")
    expect(rows.find((row) => row[0] === "overrides")?.[1]).toBe("1 audited · user:operator")
    expect(rows.find((row) => row[0] === "evidence")?.[1]).toContain("Focused test passed")
    expect(rows.find((row) => row[0] === "memory")?.[1]).toContain("Issue labels verified")
    expect(rows.find((row) => row[0] === "changed")?.[1]).toBe("1 diff artifact")
    expect(rows.find((row) => row[0] === "cost")?.[1]).toBe("15 tokens · $0.0025")
    expect(rows.find((row) => row[0] === "next action")?.[1]).toBe("Ask for approval before posting.")

    const compactLines = compactLoopDetailLines({
      detail: {
        id: "loop_1",
        state: "working",
        objective: "Keep issue triage current.",
        rootSessionID: "ses_loop_1",
        spec: {
          budgetMode: "max-goal",
          successChecks: ["bun test test/triage.test.ts"],
          approvalPolicy: { requireApprovalFor: ["comment.issue"] },
        },
        metrics: { turns: 1 },
      },
      rows: [
        ["budget", "max-goal · 1/open"],
        ["checks", "1 success check"],
        ["approvals", "comment.issue"],
        ["chat", "ses_loop_1"],
      ],
      supervisionRows: rows,
    })

    expect(compactLines.join("\n")).toContain("contract · max-goal · 1/open")
    expect(compactLines.join("\n")).toContain("wake · External signal: GitHub issue updated.")
    expect(compactLines.join("\n")).toContain("run · completed · external-signal · gated")
    expect(compactLines.join("\n")).toContain("verdict · continue · Needs one more validation.")
    expect(compactLines.join("\n")).toContain("rubric · pass · 90% / 85%")
    expect(compactLines.join("\n")).toContain("overrides · 1 audited · user:operator")
    expect(compactLines.join("\n")).toContain("changed · 1 diff artifact")
    expect(compactLines.join("\n")).toContain("memory · 3 facts · 1 open · Issue labels verified")
    expect(compactLines.join("\n")).toContain("next · Ask for approval before posting.")
  })

  test("loops route builds loop designer contract preview rows", () => {
    const rows = loopContractPreviewRows({
      id: "loop_draft",
      name: "Draft issue triage loop",
      state: "draft",
      phase: "draft",
      objective: "Watch issues and prepare triage summaries.",
      spec: {
        trigger: { mode: "external-signal" },
        budgetMode: "max-goal",
        completionCriteria: ["Issue summary is ready"],
        successChecks: ["bun test test/triage.test.ts"],
        stopWhen: ["summary posted or approval denied"],
        evaluation: { mode: "independent" },
        workspace: { mode: "read-only" },
        costBudget: { maxCost: 1.5, maxTokens: 4000 },
        approvalPolicy: { requireApprovalFor: ["external-send", "push"], approvedActions: ["external-send"] },
        memory: { enabled: true, sections: ["verified", "open"] },
      },
      policy: {
        maxTurns: 5,
        maxRuntimeMs: 300000,
        requireApprovalFor: ["external-send", "push"],
        approvedActions: ["external-send"],
      },
    })

    expect(rows.find((row) => row[0] === "wake")?.[1]).toContain("matching external signal")
    expect(rows.find((row) => row[0] === "can do")?.[1]).toContain("without edits")
    expect(rows.find((row) => row[0] === "approval")?.[1]).toContain("push")
    expect(rows.find((row) => row[0] === "verify")?.[1]).toContain("bun test test/triage.test.ts")
    expect(rows.find((row) => row[0] === "judge")?.[1]).toContain("Issue summary is ready")
    expect(rows.find((row) => row[0] === "stop")?.[1]).toContain("summary posted")
    expect(rows.find((row) => row[0] === "budget")?.[1]).toContain("max-goal")
    expect(rows.find((row) => row[0] === "workspace")?.[1]).toBe("read-only")
    expect(rows.find((row) => row[0] === "memory")?.[1]).toBe("verified, open")
  })

  test("loops contract preview exposes executable validation without raw output", () => {
    const rows = loopContractPreviewRows({
      id: "loop_validation",
      state: "draft",
      spec: {
        successChecks: ["browser smoke passed"],
        validationChecks: [{ id: "diff-check", command: "git diff --check" }],
        retention: { maxArtifacts: 80, maxAgeMs: 86_400_000, maxBytes: 2_000_000 },
      },
    })

    expect(rows.find((row) => row[0] === "verify")?.[1]).toContain("browser smoke passed; git diff --check")
  })

  test("loops default detail stays bounded and keeps full inspection behind the summary toggle", () => {
    const detail = {
      id: "loop_summary",
      state: "sleeping",
      phase: "waiting",
      objective: "Watch a project without flooding the dashboard.",
      rootSessionID: "ses_loop_summary",
      nextWakeup: Date.now() + 60_000,
      spec: { trigger: { mode: "interval", intervalMs: 60_000 }, budgetMode: "unbounded-monitor" },
      metrics: { turns: 3, inputTokens: 10, outputTokens: 5 },
    } as const
    const summaryRows = loopSummaryRows({
      detail,
      summary: {
        workflowID: detail.id,
        state: detail.state,
        phase: detail.phase,
        verdict: "continue",
        verdictSummary: "Waiting for the next check.",
        nextAction: "sleep_until_next_interval",
        costSummary: { tokens: 15 },
      },
      runs: [{ id: "run_summary", state: "completed", trigger: "interval", phase: "monitor" }],
    })
    const lines = compactLoopSummaryLines({ detail, summaryRows })

    expect(summaryRows.map((row) => row[0])).toEqual(["state", "iteration", "next", "cadence", "run", "verdict", "next action", "usage"])
    expect(lines.join("\n")).toContain("verdict · continue · Waiting for the next check.")
    expect(lines.join("\n")).not.toContain("contract")
  })

  test("loops route preserves legacy report-only contract previews without explicit read-only workspace metadata", () => {
    const rows = loopContractPreviewRows({
      id: "loop_legacy_report_only",
      state: "active",
      policy: { requireApprovalFor: ["edit", "write", "apply_patch", "shell", "subagent", "push", "merge", "release"] },
    })

    expect(rows.find((row) => row[0] === "can do")?.[1]).toContain("without edits")
  })

  test("loops route approval wording excludes already-approved actions", () => {
    const rows = loopContractPreviewRows({
      id: "loop_preapproved",
      state: "draft",
      phase: "draft",
      spec: {
        approvalPolicy: {
          requireApprovalFor: ["external-send"],
          approvedActions: ["external-send"],
        },
      },
    })

    expect(rows.find((row) => row[0] === "approval")?.[1]).toBe(
      "No additional approval is pending inside the configured permission envelope.",
    )
  })

  test("loops compact detail keeps every designer preview section visible", () => {
    const contractRows = loopContractPreviewRows({
      id: "loop_draft",
      name: "Draft issue triage loop",
      state: "draft",
      phase: "draft",
      objective: "Watch issues and prepare triage summaries.",
      spec: {
        trigger: { mode: "external-signal" },
        budgetMode: "max-goal",
        completionCriteria: ["Issue summary is ready"],
        successChecks: ["bun test test/triage.test.ts"],
        stopWhen: ["summary posted or approval denied"],
        evaluation: { mode: "independent" },
        workspace: { mode: "read-only" },
        costBudget: { maxCost: 1.5, maxTokens: 4000 },
        approvalPolicy: { requireApprovalFor: ["external-send", "push"], approvedActions: ["external-send"] },
        memory: { enabled: true, sections: ["verified", "open"] },
      },
      policy: {
        maxTurns: 5,
        maxRuntimeMs: 300000,
        requireApprovalFor: ["external-send", "push"],
        approvedActions: ["external-send"],
      },
    })
    const lines = compactLoopDetailLines({
      detail: {
        id: "loop_draft",
        state: "draft",
        phase: "draft",
        rootSessionID: "ses_loop_draft",
        metrics: { turns: 0 },
      },
      rows: [["chat", "ses_loop_draft"]],
      contractRows,
      supervisionRows: [["memory", "0 facts"]],
    })

    expect(lines.join("\n")).toContain("contract · I will wake when matching external signal.")
    expect(lines.join("\n")).toContain("can do · Inspect, summarize, and produce evidence without edits.")
    expect(lines.join("\n")).toContain("approval · Needs approval for push.")
    expect(lines.join("\n")).toContain("verify · Verify by bun test test/triage.test.ts.")
    expect(lines.join("\n")).toContain("judge · independent judge checks Issue summary is ready.")
    expect(lines.join("\n")).toContain("stop · Stop when summary posted or approval denied.")
    expect(lines.join("\n")).toContain("budget · max-goal · 5 turns")
    expect(lines.join("\n")).toContain("workspace · read-only")
    expect(lines.join("\n")).toContain("memory plan · verified, open")
  })

  test("loops route tolerates partial summary payloads for legacy fallback rendering", () => {
    const rows = loopSupervisionRows({
      workflow: {
        id: "loop_legacy",
        state: "paused",
        memory: { entries: [{ summary: "Captured context" }] },
      },
      summary: {
        workflowID: "loop_legacy",
        state: "paused",
        memorySummary: {},
        costSummary: {},
      },
    })

    expect(rows.find((row) => row[0] === "memory")?.[1]).toBe("0 facts · 0 open")
    expect(rows.find((row) => row[0] === "cost")?.[1]).toBe("0 tokens")
    expect(rows.find((row) => row[0] === "next action")?.[1]).toBe("monitor")
  })

  test("loops route prefers the latest wake signal over a later started event", () => {
    expect(
      latestLoopWakeReason([
        {
          id: "evt_started",
          type: "started",
          title: "Run started",
          summary: "Worker picked up the loop.",
        },
        {
          id: "evt_wake",
          type: "wake",
          title: "GitHub issue updated",
          summary: "Issue #42 changed labels.",
        },
      ]),
    ).toBe("GitHub issue updated: Issue #42 changed labels.")
  })

  test("loops route changed-artifact summary stays scoped to the latest run", () => {
    const rows = loopSupervisionRows({
      workflow: {
        id: "loop_1",
        state: "working",
      },
      runs: [
        {
          id: "run_latest",
          state: "completed",
          trigger: "manual",
          phase: "done",
        },
      ],
      artifacts: [
        {
          id: "artifact_latest",
          kind: "diff",
          title: "Latest diff",
          summary: "Latest run changed files.",
          runID: "run_latest",
        },
        {
          id: "artifact_old",
          kind: "diff",
          title: "Older diff",
          summary: "Older run changed files.",
          runID: "run_old",
        },
      ],
    })

    expect(rows.find((row) => row[0] === "changed")?.[1]).toBe("1 diff artifact")
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

    expect(graph.rows.join("\n")).toMatch(/[\u2801-\u28ff]/)
    expect(graph.cells.flat().some((cell) => cell.relation === "supports")).toBe(true)
    expect(graph.cells.flat().some((cell) => cell.kind === "selected")).toBe(true)
    expect(graph.legend.join("\n")).toContain("Commands")
    expect(graph.status).toContain("2/2 materialized")
    expect(graph.status).toContain("0 legacy-derived")
    expect(graph.status).toContain("1/1 links")
    expect(graph.stats).toContain("connected 2")
    expect(graph.stats).toContain("isolated 0")
    expect(graph.minimap.length).toBeGreaterThan(0)
    expect(graph.edgeLabels.join("\n")).toContain("supports")
    expect(graph.labels.join("\n")).toContain("connected")
    expect(graph.focusLines.join("\n")).toContain("focus")
    expect(graph.relationRows.join("\n")).toContain("supports")
    expect(graph.isolatedRows).toEqual([])
  })

  test("shared ascii graph renderer is deterministic and provides a plain ascii fallback", () => {
    const input = {
      nodes: [
        { id: "commands", label: "Commands", group: "project.commands" },
        { id: "policy", label: "Policy", group: "memory.policy" },
        { id: "architecture", label: "Architecture", group: "project.architecture" },
      ],
      edges: [
        { from: "commands", to: "policy", kind: "supports" },
        { from: "policy", to: "architecture", kind: "conflicts" },
      ],
      iterations: 80,
    }
    const first = layoutAsciiGraph(input)
    const second = layoutAsciiGraph(input)

    expect(first.nodes.map((node) => [node.id, node.x, node.y])).toEqual(second.nodes.map((node) => [node.id, node.x, node.y]))
    expect(renderAsciiGraph(first, { width: 40, height: 10, marker: "braille", selectedID: "policy" }).rows.join("\n")).toMatch(/[\u2801-\u28ff]/)
    const ascii = renderAsciiGraph(first, { width: 40, height: 10, marker: "ascii", selectedID: "policy" }).rows.join("\n")
    expect(ascii).toContain("@")
    expect(ascii).not.toMatch(/[\u2801-\u28ff]/)
  })

  test("memory graph mini map keeps unlinked facts isolated instead of inventing edges", () => {
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

    expect(graph.cells.flat().filter((cell) => cell.kind === "node" || cell.kind === "selected").map((cell) => cell.char).join("")).toMatch(/[•◉]/)
    expect(graph.status).toContain("3/3 materialized")
    expect(graph.status).toContain("0/0 links")
    expect(graph.status).not.toContain("inferred")
    expect(graph.stats).toContain("connected 0")
    expect(graph.stats).toContain("isolated 3")
    expect(graph.scene.edges).toEqual([])
    expect(graph.edgeLabels).toEqual([])
    expect(graph.relationRows).toEqual([])
    expect(graph.isolatedRows.join("\n")).toContain("Run focused memory tests")
    expect(graph.legend.join("\n")).toContain("Commands")
  })

  test("memory graph mini map filters stale and volatile facts with their orphan links", () => {
    const graph = memoryGraphMiniMap({
      width: 48,
      height: 8,
      categories: [
        { id: "project.commands", label: "Commands", count: 1 },
        { id: "volatile.reject", label: "Volatile", count: 1 },
      ],
      facts: [
        { id: "visible", scope: "project", categoryIDs: ["project.commands"], text: "Durable command" },
        { id: "volatile", scope: "project", categoryIDs: ["volatile.reject"], text: "Transient command" },
        { id: "stale", scope: "project", categoryIDs: ["project.commands"], text: "Old command", stale: true },
      ],
      links: [
        { from: "visible", to: "volatile", kind: "related" },
        { from: "volatile", to: "stale", kind: "related" },
      ],
    })

    expect(graph.scene.nodes.map((node) => node.id)).toEqual(["visible"])
    expect(graph.scene.edges).toEqual([])
    expect(graph.status).toContain("2 filtered")
    expect(graph.status).toContain("2 links filtered")
  })

  test("memory graph sampling reserves and fills capacity for isolated facts", () => {
    const graph = memoryGraphMiniMap({
      facts: Array.from({ length: 20 }, (_, index) => ({
        id: `isolated_${index}`,
        text: `Isolated durable memory ${index}`,
        scope: "project",
        categoryIDs: ["memory.policy"],
        materialized: true,
        retrievalPriority: index,
      })),
      links: [],
      categories: [{ id: "memory.policy", label: "Memory policy", count: 20 }],
      width: 80,
      height: 10,
      maxNodes: 10,
    })

    expect(graph.scene.nodes).toHaveLength(10)
    expect(graph.stats).toContain("isolated 20")
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
    expect(graph.minimap).toEqual([])
    expect(graph.edgeLabels).toEqual([])
    expect(graph.focusLines).toEqual([])
    expect(graph.relationRows).toEqual([])
    expect(graph.isolatedRows).toEqual([])
    expect(graph.stats).toContain("visible 0/0")
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
    expect(graph.stats).toContain("visible 0/0")
    expect(graph.status).toContain("0/2 materialized")
    expect(graph.status).toContain("2 legacy-derived")
    expect(graph.status).toContain("0/0 links")
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

    expect(graph.rows.join("\n")).toMatch(/[\u2801-\u28ff]/)
    expect(graph.status).toContain("2/3 materialized")
    expect(graph.status).toContain("1 legacy-derived")
    expect(graph.status).toContain("1/1 links")
    expect(graph.stats).toContain("visible 2/2")
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
    expect(graph.labels.join("\n")).toContain("isolated")
    expect(graph.legend.join("\n")).toContain("Category 0")
    expect(graph.legend.join("\n")).not.toContain("Category 5")
  })

  test("memory graph detail view separates isolates from the connected canvas", () => {
    const graph = memoryGraphMiniMap({
      width: 60,
      height: 12,
      connectedOnly: true,
      selectedID: "b",
      categories: [{ id: "project", label: "Project", count: 3 }],
      facts: [
        { id: "a", scope: "project", categoryIDs: ["project"], text: "Connected source" },
        { id: "b", scope: "project", categoryIDs: ["project"], text: "Connected target" },
        { id: "c", scope: "project", categoryIDs: ["project"], text: "Standalone memory" },
      ],
      links: [{ from: "a", to: "b", kind: "related" }],
    })

    expect(graph.scene.nodes.map((node) => node.id).toSorted()).toEqual(["a", "b"])
    expect(graph.selectedID).toBe("b")
    expect(graph.nodeCells.b).toBeDefined()
    expect(graph.isolatedRows).toEqual(["○ Standalone memory"])
    expect(graph.stats).toContain("connected 2 · hidden isolates 1 · visible 2/3")
  })

  test("memory graph explorer gives wide terminals a dominant canvas and narrow terminals a stacked inspector", () => {
    const wide = memoryGraphExplorerLayout({ width: 160, height: 42 })
    const narrow = memoryGraphExplorerLayout({ width: 78, height: 28 })

    expect(wide.roomy).toBe(true)
    expect(wide.canvasWidth).toBeGreaterThan(wide.inspectorWidth)
    expect(wide.canvasHeight).toBe(30)
    expect(narrow.roomy).toBe(false)
    expect(narrow.inspectorWidth).toBe(78)
    expect(narrow.canvasWidth).toBe(76)
    expect(narrow.canvasHeight).toBeGreaterThanOrEqual(8)
  })

  test("memory graph inspector resolves project owners by workspace id or root", () => {
    const workspaces = [
      { id: "ws_mendcode", root: "/code/MendCode", displayName: "MendCode" },
      { id: "ws_web", root: "/code/MendCode-Web", displayName: "MendCode Web" },
    ]
    const labels = (scope: "global" | "project", ownerWorkspaceIDs: string[]) => memoryGraphFactProjectLabels({
      fact: { scope, ownerWorkspaceIDs },
      workspaces,
      activeRoot: "/code/MendCode",
      activeLabel: "MendCode",
    })

    expect(labels("project", ["ws_web"])).toEqual(["MendCode Web"])
    expect(labels("project", ["/code/MendCode"])).toEqual(["MendCode"])
    expect(labels("project", ["/code/UnknownProject"])).toEqual(["UnknownProject"])
    expect(labels("global", [])).toEqual(["Global memory"])
  })

  test("memory graph search matches memory text together with project identity", () => {
    const facts = [
      {
        id: "fact_a",
        legacyEntryID: null,
        scope: "project" as const,
        ownerWorkspaceIDs: ["ws_mendcode"],
        ownerGroupIDs: [],
        categoryIDs: ["project.commands"],
        text: "Keep the approved compaction plan verbatim.",
        normalizedSummary: "Keep the approved compaction plan verbatim.",
        provenance: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        verifiedAt: null,
        confidence: 0.9,
        durability: 0.9,
        changeRisk: 0.1,
        sensitivity: "low" as const,
        stale: false,
        retrievalPriority: 1,
        legacyMaterialized: false,
        materialized: true,
      },
      {
        id: "fact_b",
        legacyEntryID: null,
        scope: "project" as const,
        ownerWorkspaceIDs: ["ws_web"],
        ownerGroupIDs: [],
        categoryIDs: ["project.architecture"],
        text: "Use the web runtime adapter.",
        normalizedSummary: "Use the web runtime adapter.",
        provenance: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        verifiedAt: null,
        confidence: 0.8,
        durability: 0.8,
        changeRisk: 0.2,
        sensitivity: "low" as const,
        stale: false,
        retrievalPriority: 2,
        legacyMaterialized: false,
        materialized: true,
      },
    ]

    expect(memoryGraphSearchMatches({
      facts,
      query: "MendCode compaction",
      projectLabel: (fact) => fact.ownerWorkspaceIDs[0] === "ws_mendcode" ? "MendCode" : "MendCode Web",
    }).map((fact) => fact.id)).toEqual(["fact_a"])
  })

  test("memory route hotkeys stay inactive while a prompt dialog is open", () => {
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false })).toBe(true)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, defaultPrevented: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, textInputActive: true })).toBe(false)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: false, defaultPrevented: true, emergency: true })).toBe(true)
    expect(shouldMemoryRouteHandleKey({ dialogOpen: true, defaultPrevented: true, emergency: true })).toBe(false)
  })

  test("memory tabs stay content-sized instead of stretching across wide terminals", () => {
    const labels = ["  1 Memories", "● 2 Graph", "  3 Dream", "  4 Rules"]
    expect(memoryTabCellWidths({ width: 80, labels, gap: 2 })).toEqual(labels.map((label) => label.length))
    expect(memoryTabCellWidths({ width: 40, labels: [" 1", "●2", " 3", " 4"], gap: 1 })).toEqual([4, 4, 4, 4])
    expect(memoryTabCellWidths({ width: 65 })).toEqual([8, 8, 8, 8])
    expect(memoryTabPresentation({ width: 160, active: "graph" }).mode).toBe("full")
    expect(memoryTabPresentation({ width: 80, active: "graph" }).mode).toBe("full")
    expect(memoryTabPresentation({ width: 28, active: "graph" })).toMatchObject({ mode: "numeric", labels: [" 1", "●2", " 3", " 4"] })
  })

  test("memory graph command bar removes secondary actions on narrow terminals", () => {
    expect(memoryGraphCommandHints(140).map((item) => item.key)).toEqual(["arrows", "HJKL", "drag/trackpad", "+/-", "Esc"])
    expect(memoryGraphCommandHints(60).map((item) => item.key)).toEqual(["arrows", "HJKL", "+/-", "Esc"])
  })

  test("memory graph separates free pan from memory-to-memory navigation", () => {
    expect(memoryGraphPanDirection("left")).toEqual({ x: -1, y: 0 })
    expect(memoryGraphPanDirection("down")).toEqual({ x: 0, y: 1 })
    expect(memoryGraphNavigationDirection({ name: "left" })).toBeNull()
    expect(memoryGraphNavigationDirection({ name: "h" })).toEqual({ x: -1, y: 0 })
    expect(memoryGraphNavigationDirection({ name: "j" })).toEqual({ x: 0, y: 1 })
    expect(memoryGraphPanViewport({
      viewport: { x: undefined, y: undefined, zoom: 2 },
      transform: { centerX: 10, centerY: 20, scaleX: 2, scaleY: 4, dotsX: 2, dotsY: 4 },
      cells: { x: 4, y: -2 },
    })).toEqual({ x: 14, y: 18, zoom: 2 })
  })

  test("memory graph reserves primary selection tone outside category palette", () => {
    const tones = Array.from({ length: 14 }, (_, index) => memoryGraphNodeTone(index))
    expect(tones).not.toContain("primary")
    expect(tones).not.toContain("secondary")
    expect(tones).not.toContain("info")
    expect(new Set(tones).size).toBeGreaterThanOrEqual(6)
  })

  test("memory graph view defaults to the current connected project and migrates old preferences", () => {
    expect(normalizeMemoryGraphViewPreference(undefined, ["/code/A"], "/code/A")).toEqual({ version: 2, scope: "project", projectRoot: "/code/A", showIsolates: false })
    expect(normalizeMemoryGraphViewPreference({ version: 1, scope: "all", projectRoot: null, showIsolates: true }, ["/code/A"], "/code/A")).toEqual({ version: 2, scope: "project", projectRoot: "/code/A", showIsolates: false })
    expect(normalizeMemoryGraphViewPreference({ version: 2, scope: "project", projectRoot: "/code/A", showIsolates: false }, ["/code/A"], "/code/A")).toEqual({ version: 2, scope: "project", projectRoot: "/code/A", showIsolates: false })
    expect(normalizeMemoryGraphViewPreference({ version: 2, scope: "project", projectRoot: "/code/missing", showIsolates: false }, ["/code/A"], "/code/A")).toEqual({ version: 2, scope: "all", projectRoot: null, showIsolates: false })
  })

  test("memory list windows keep selections beyond fixed presentation caps visible", () => {
    expect(memoryListWindow(Array.from({ length: 20 }, (_, index) => index), 17, 8)).toEqual([
      { item: 12, index: 12 }, { item: 13, index: 13 }, { item: 14, index: 14 }, { item: 15, index: 15 },
      { item: 16, index: 16 }, { item: 17, index: 17 }, { item: 18, index: 18 }, { item: 19, index: 19 },
    ])
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
      blockProviderMetadata: false,
      blockProviderUxMetadata: false,
      blockSessionList: false,
    })
    expect(syncBootstrapReadiness({ fastBoot: true, continueSession: true })).toEqual({
      blockProviderMetadata: false,
      blockProviderUxMetadata: false,
      blockSessionList: true,
    })
    expect(syncBootstrapReadiness({ fastBoot: false })).toEqual({
      blockProviderMetadata: true,
      blockProviderUxMetadata: true,
      blockSessionList: false,
    })
    expect(
      isCurrentTuiBootstrap({
        generation: 2,
        currentGeneration: 2,
        workspace: "workspace-a",
        currentWorkspace: "workspace-a",
      }),
    ).toBe(true)
    expect(
      isCurrentTuiBootstrap({
        generation: 1,
        currentGeneration: 2,
        workspace: "workspace-a",
        currentWorkspace: "workspace-a",
      }),
    ).toBe(false)
    expect(
      isCurrentTuiBootstrap({
        generation: 2,
        currentGeneration: 2,
        workspace: "workspace-a",
        currentWorkspace: "workspace-b",
      }),
    ).toBe(false)
    expect(themeModeWaitMs(true)).toBe(50)
    expect(themeModeWaitMs(false)).toBe(1000)
    expect(startupLoadingText({ pluginsReady: false })).toBe("Loading plugins...")
    expect(startupLoadingText({ pluginsReady: true, syncLoading: true })).toBe("Loading workspace...")
    expect(startupLoadingText({ pluginsReady: true, syncLoading: false })).toBe("Finishing startup...")
  })
})
