import { DEFAULT_COMPACT_AT_TOKENS, claudeFastModel, estimateTokens } from "@mendcode/protocol/wire"
import { claudeAlias } from "./claude-models"
import { createConsole } from "./console"
import { readEnvironmentImport } from "./environment-import"
import { focusedHandoff } from "./focused-handoff"
import { createLimitCheckpoint } from "./limit-checkpoint"
import { planHandoff } from "./handoff"
import { threadMcpEnabled, type BridgeEngine } from "./thread-mcp-policy"
import { createHostMcp } from "./host-mcp"
import { createIdleGc } from "./idle-gc"
import { createSessionSharing } from "./session-sharing"
import { createMflow } from "./mflow"
import { createMflowHttp, mflowListenerAddress } from "./mflow-http"
import { createMflowHooks } from "./mflow-hooks"
import { commandPromptText } from "@mendcode/mcp"
import { createProjectRest } from "./project-rest"
import { ProjectRestError } from "./project-git"
import { createProjectControl, projectSources } from "./project-control"
import { createGithub, githubLocalOnly, githubProcess, githubToolSummary, type GithubProcess } from "./github"
import { createStaticShare } from "./session-static-share"
import { sandboxStatus } from "./sandbox-status"
import { createChannels, type ChannelsOptions } from "./channels"
import { createSessionMetadata } from "./session-metadata"
import { sessionStatsText } from "./session-stats-text"
import { createFanout } from "./fanout"
import { attachPrReference } from "./pr-reference"
import { createSessionLifecycle, lifecycleOf } from "./session-lifecycle"
import { ghProcess } from "./pr-watch"
import { createContinuity } from "./continuity"
import { createBudgets, type BudgetPort, type BudgetUsage } from "./budgets"
import { createSetupService } from "./setup"
import { createAIConfigService, AIConfigError } from "./ai-config"
import { createReasoningService } from "./reasoning"
import { createActivityAudio, type AudioPlayer } from "./activity-audio"
import { createVoice, type VoiceRecorder } from "./voice"
import { createVoiceRecorder } from "./voice-recorder"
import type { LocalDictation } from "./voice-local"
import { createReviews } from "./review"
import { createCacheControl } from "./cache"
import { createMessageMutations } from "./message-mutations"
import { createSessionHttpApi, validateSessionHttpListener } from "./session-http"
import { createDebug } from "./debug"
import { queryDatabase } from "./debug-db"
import { createTracing, validateOtlp, type OtlpExporter } from "./tracing"
import { createMemoryModel } from "./memory-model"
import { createMemoryControl } from "./memory-control"
import { memorySettings } from "./memory-config"
import { daemonLogs } from "./daemon-logs"
import { consolidateMemory } from "./memory-consolidation"
import { createSemanticConsolidator } from "./memory-consolidator"
import { createMemoryAssistant } from "./memory-assistant"
import { createInteractions } from "./interactions"
import { readFileApi } from "./file-rest"
import { viewFile } from "./file-view"
import { GitCommitRefusal, gitCommit } from "./git-commit"
import { GIT_ACTIONS_OFF, denyingRule } from "./git-actions-policy"
import { gitPrCreate, gitPrView } from "./git-pr"
import { gitInit } from "./git-init"
import { gitPublish } from "./git-publish"
import { gitPush } from "./git-push"
import { GitActionRefusal } from "./git-remote"
import { editFile } from "./file-edit"
import { FileApiError } from "./file-rest-process"
import { createFileFrecency } from "./file-frecency"
import { createModelResolutions } from "./model-resolutions"
import { createMemorySharing } from "./memory-sharing"
import { createMemoryWorkspaces } from "./memory-workspaces"
import { readPlanReviews } from "./plan-review"
import { permissionsStatus } from "./permissions"
import { readScratchpad, writeScratchpad } from "./scratchpad"
import { changeBacklog, readBacklog } from "./backlog"
import { createSessionRecall, SessionRecallError } from "./session-recall"
import { createComputerControl, type ComputerOptions } from "./computer"
import { createBrowserControl, type BrowserOptions } from "./browser"
import { parseRemoteAddress } from "@mendcode/protocol/wire"
import { writeDiagnosticsSnapshot } from "./diagnostics"
import { remoteBackoff, remoteTokens, validateRemoteListener, type RemoteListenerOptions } from "./remote"
import { isLoopbackHost, isReadOnlyCommand } from "@mendcode/protocol/wire"
import { createHttpAdapter, httpConfig, type HttpOptions, type HttpPeer } from "./http"
import { createPtyService, PtyError } from "./pty"
import type { PtyDriver } from "./pty-native"
import { createWorkspaces } from "./workspaces"
import { existsSync, rmSync } from "node:fs"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { defaultLocalTransport, localEndpointPath, removeLocalEndpoint, writeLocalEndpoint, type LocalTransport } from "@mendcode/client/local-endpoint"
import { homedir } from "node:os"
import path from "node:path"
import { remoteInstructions } from "./remote-instructions"
import { ancestorLayers, BUILTIN_PACKAGE, claimLook, diagnosticLines, emptyDiagnostics, extensionLayers, foreignLayers, withForeignLayers, installPackage, listPackages, LookOwnedError, manifestCompatProblem, packageKey, PackageError, PackageNotInstalledError, readLayerThemes, releaseLook, removePackage, restorePackage, RESERVED_AGENTS, stageCapturedLook, type ExtensionLayer, type PackageHost, type ResourceDiagnostics } from "@mendcode/packages"
import { EXTENSION_API_VERSION } from "@mendcode/extension-api"
import { canonicalDir, createCustomToolRegistry, shell, type CustomToolRegistry, type SessionRecallPort } from "@mendcode/tools"
import { createPackageCatalog } from "./package-catalog"
import { createPackageAuthoring } from "./package-authoring"
import { AttachmentError, decodeAttachment, imageDimensions, readAttachment, resolvePastedPath } from "./attachments"
import { createClipboardReader, type ClipboardReader } from "./clipboard"
import { createTuiControl } from "./tui-control"
import { createThemes } from "./themes"
import { composePromptParts, createPromptModes, promptBuildReport } from "./prompt-modes"
import { promptFilesFor } from "./prompt-context"
import { createUiReload, type UiReloadReport } from "./customize-ui"
import { NotGitError, readChanges } from "./changes"
import { expandCommand, loadCustomCommands as loadCommandFiles, mcpCommands, mcpCatalogCommands, skillCommandText } from "./custom-commands"
import { fileClaims } from "./precedence"
import { createSelfPackages } from "./self-packages"
import { createCommandExecution } from "./command-execution"
import { createInlineShellTable, type InlineShell } from "./inline-shell"
import { expandMcpMentions, expandMcpPrompt, type McpContentPort } from "./mcp-content"
import { createRunLimitsStore, type RunLimitsStore } from "./run-limits"
import { createSessionPermissionRules } from "./session-permission-rules"
import { createGrantStore, type AgentPort, type EngineHooks, type GoalPort, type GrantStore, type SecretsPort } from "@mendcode/engine-native"
import { createGoalPrompts } from "./goal-prompts"
import { createGoals } from "./goals"
import { createUsageLimit } from "./usage-limit"
import { createQuotaRefresh, windowsSpent, type RefreshProbe } from "./quota-refresh"
import type { CodegraphStatus, CodegraphStatusHub } from "./codegraph-status"
import { graphIndexMode } from "./graph-gate"
import { normalizeQuotaRefresh, type QuotaRefreshProvider } from "@mendcode/protocol/wire"
import { capPermission, memoryNoticeMeta, memoryNoticeText, restatesRequest, structuredValidator } from "@mendcode/engine-native"
import { memoryMaintenance } from "./memory-maintenance"
import { createMemoryExtraction, type ExtractedMemory } from "./memory-extraction"
import { createChildTasks } from "./child-tasks"
import { createTaskOwnerWake } from "./task-owner-wake"
import { createSessionBackground } from "./session-background"
import { createAgentRegistry } from "./agents"
import { createAgentFile } from "./agent-create"
import { generateAgentContent } from "./agent-generate"
import { readEventsWindow } from "./events-window"
import { createSecretsService } from "./secrets"
import { createEngineHooks, createExtensions, createPromptFiles, forgetSessionEntries, type DaemonExtensions, type PromptFiles } from "./extensions"
import { createExtensionSessions } from "./extension-sessions"
import { createExtensionDialogs, DIALOGS_CAPABILITY } from "./extension-dialogs"
import { createStatusScripts } from "./status-scripts"
import { approvalRulePatch, offerFor } from "./approval-rules"
import { createShellHooks } from "./shell-hooks"
import { withShellHooks } from "./shell-hooks-engine"
import { readSessionHistory } from "./session-reader"
import { loadSystemPrompt, createSkillLoader, type SkillLoader } from "@mendcode/engine-native"
import { systemPartsWith } from "./extensions/prompt-files"
import { packageContextCost } from "./package-context"
import { createSessionAutomation } from "./session-automation"
import { readContextWindow, windowOverride } from "./session-context-window"
import { sessionContextWindow } from "./model-context-window"
import { createMentionRouting, expandAgentMentions, leadingMention } from "./agent-mentions"
import { createRestSessions } from "./session-rest"
import { createRestMutations } from "./session-rest-mutate"
import { createServerControl, processMemory } from "./server-control"
import { createServerConfigExtras } from "./server-config-extras"
import { createSessionHistory } from "./session-history"
import { sessionPanelSavings } from "./session-panel"
import { withExternalAgent, withHandoff } from "./external-turn"
import { createPortableContext, handoffNote } from "./portable-context"
import { harnessContextReport } from "./harness-context"
import type { ContextReport } from "@mendcode/protocol"

/** How much of a harness session's transcript `/context` reads, newest first (about a million tokens). */
const HARNESS_CONTEXT_CHARS = 4_000_000
import { createSessionTransfer } from "./session-transfer"
import { createForeignThreads } from "./thread-foreign"
import { createSetupImport } from "./setup-import"
import { createTurnSnapshots, withTurnSnapshots } from "./turn-snapshots"
import { activeRecipe, readRecipes } from "./recipes"
import { createCompoundHost } from "./compound"
import type { CompoundCall } from "@mendcode/engine-native"
import { catalogChoice, catalogConfig, catalogPresets } from "./catalog-control"
import { createProviderAuth, type ProviderAuthService } from "./provider-auth"
import { createCatalogRest, CatalogRestError } from "./catalog-rest"
import { addMcpConfig, decideMcpConfig, pendingMcpServers } from "./mcp-config"
import { builtinDir } from "./builtin"
import { installPlugin } from "./extensions/plugin-install"
import { createPluginMetadata } from "./extensions/plugin-metadata"
import type { Completion } from "@mendcode/dream"
import {
  type ModelRole,
  CommandId,
  DREAM_DEFAULT_MAX_TOKENS,
  MAX_PINNED_MEMORIES,
  MEMORY_CATEGORIES,
  memoryPolicyFor,
  redactEventText,
  redactSecrets,
  visibleEvents,
  createIdFactory,
  decodeFrame,
  encodeFrame,
  isCompatibleVersion,
  MAX_FRAME_BYTES,
  TEXT_PUT_MAX_BYTES,
  inlineTexts,
  pastedText,
  ATTACHMENT_READ_CHUNK,
  PROTOCOL_VERSION,
  type BlobRef,
  type ClientId,
  type Command,
  type ErrorCode,
  type ForegroundState,
  type Frame,
  type GlobalEvent,
  type MemoryEntry,
  type MemoryId,
  type ModelChoice,
  type DreamTrigger,
  type McpServerStatus,
  type McpStatusReport,
  type MemoryCategoryInfo,
  type MemoryScope,
  type MemoryGraphReport,
  type MemoryLink,
  type MemoryLinkKind,
  type ModelInfo,
  type QueueId,
  type SessionEvent,
  type Settings,
  type SessionId,
  type UsageProfile,
} from "@mendcode/protocol"
import { effectiveSettings, featureOn, modelContextOf } from "@mendcode/protocol/wire"
import {
  createJobScheduler,
  createResourceRegistry,
  createScope,
  createSessionActor,
  realClock,
  type Clock,
  type TimerHandle,
  type EnginePort,
  type GlobalEventDraft,
  type SessionActor,
  type SessionEventDraft,
} from "@mendcode/kernel"
import { openStore, type Store } from "@mendcode/store"
import { checkProblems, createLoopService, createProblems, describeTemplate, loopUpdateInput, LOOP_TEMPLATES, type CreateLoopInput } from "@mendcode/loops"
import { createLoopControl } from "./loop-control"
import { runLoopCheck, workspaceFingerprint } from "./loop-checks"
import { createLoopPort } from "./loop-port"
import { createWorktreePort } from "./worktree-port"
import { createPrWatch, type GhRun } from "./pr-watch"
import { createReviewSessions, REVIEW_AGENT, REVIEW_EXCLUDED_TOOLS, reviewMessage } from "./pr-review/sessions"
import { createGitWorktrees, isGitCheckout } from "./loop-worktree"
import { createWorkflowsHost } from "./workflows"
import { createWorkflowRouter } from "./workflow-routing"
import { createWorkflowMerge } from "./workflow-merge"
import { createTaskWorktrees } from "./task-worktree"
import { createAutomationLedgerHost } from "./automation-ledger"
import { defaultPermissionFor, profileOf, rolesFor, rolesPatch, shellFor } from "./profiles"
import { memoryGraph } from "./memory-graph"
import { checkWindow, dateKey, nextCheckIn, windows } from "./dream-schedule"
import { createEvolutionPromotions } from "./evolution-promotion"
import { createPeers } from "./peers"
import { createThreads, threadMentions } from "./threads"
import { tierDisabledPackages } from "./package-tier"
import { createAgentGate, createPeerOrigin, type AgentOrigin } from "./agent-origin"
import { continuationTurnOptions, REMOTE_HOST_SETTINGS, remoteExecutionCommand, remoteExecutionSettings, remoteTurnOptions } from "./remote-policy"
import { SETTINGS_PROPOSAL_LOCAL } from "./settings-tool"
import { createAgentCommands } from "./agent-commands"
import { asideTranscript, createAsideStore } from "./aside"
import { ASIDE_AGENT, createAsideSessions } from "./aside-session"
import { RECAP_SYSTEM, RECAP_TIMEOUT_MS, recapPrompt, recapText } from "./recap"
import { readSidebar, sidebarScope, updateSidebar } from "./sidebar"
import { systemReport } from "./system-report"
import { recentContext } from "./recent-context"
import { acpAgentKey } from "@mendcode/engine-acp"
import { contextLimits, modelCompactAt } from "./context-limits"
import { createIdleCompaction } from "./idle-compaction"
import { queryFiles } from "./files-query"
import { createWorktreeManager } from "./worktrees"
import { createTsmManager } from "./tsm"
import { daemonLogger, type LogLevel } from "./logging"
import { readGitStatus } from "./git-status"
import { readGitBranch } from "./git-branch"
import { searchFiles } from "./files-index"
import { createInteractiveProcesses } from "./interactive-processes"
import { createBackgroundTasks, type BackgroundPort, type InteractivePort, type LoopPort, type PeerPort, type ReviewPort, type WorkflowPort } from "@mendcode/tools"
import { backgroundNotice, isBackgroundNotice, watchNotice } from "./background-notice"
import { catalogId, catalogModel, filteredCatalog, imageRefusal, invalidChoice, modelsReport, nearModels, resolveModel, usableEffort, modelEngine, type ModelCatalog } from "./models"
import type { ProviderService } from "./providers"
import { createActivityThrottle } from "./session-activity"
import { createUsageToday, localDay } from "./usage-today"
import type { WastePrice } from "./usage-waste"
import { createUsageQuery, createUsageWaste } from "./usage"
import { createReleaseControl, type ReleaseOptions } from "./release-control"
import { createUsageWeather, type UsageWeatherService } from "./usage-weather"
import { createIdeBridge, type IdeAdapter } from "./ide"
import { createTuiRequests } from "./tui-requests"
import { DEV_VERSION } from "@mendcode/program"

/** A client that cannot keep up is disconnected and resumes later with afterSeq (never unbounded buffering). */
export const MAX_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024
const REPLAY_PAGE = 500
const RECENT_COMMANDS = 1_000
/** `storage.clean` without an age and without the retentionDays setting. */
const DEFAULT_RETENTION_DAYS = 90
/** `storage.clean` with `compact`: sessions idle this long lose the streaming deltas of their finished messages. */
const DEFAULT_DELTA_IDLE_DAYS = 3
const BUSY = new Set(["generating", "tool", "waiting_approval", "compacting", "cancelling"])
/** `session.tree`: nodes returned in all, how many forks get their unmerged count, and how deep sub-agents of sub-agents go. */
const TREE_NODES = 400
const TREE_MERGE_COUNTS = 50
const TREE_TASK_DEPTH = 4
const oneLine = (text: string, max: number) => redactSecrets(text).text.replace(/\s+/g, " ").trim().slice(0, max)

type Connection = {
  id: number
  response?(frame: Frame): void
  signal?: AbortSignal
  directory?: string
  trace?: boolean
  remoteAddress?: string
  peer?: { name: string; hash: string; readOnly: boolean }
  /** The client was started by a session's own shell: it reads, and works only inside that session's authority (agent-origin.ts). */
  agent?: AgentOrigin | undefined
  rejected?: boolean
  /** Loopback TCP local transport: the per-start secret was presented. */
  localAuthed?: boolean
  authTimer?: ReturnType<typeof setTimeout>
  clientId?: ClientId
  socket: { write(data: Uint8Array): number; end(): void }
  /** Bytes the kernel socket did not accept yet; flushed on `drain`. */
  pending: Uint8Array[]
  backlog: number
  decoder: TextDecoder
  buffer: string
  subscriptions: Map<SessionId, number>
  /** A local terminal that draws extension dialogs (`extension-dialogs` in its hello); nobody else is asked one. */
  dialogs?: boolean
  /** Status-line watches by resolved directory: the function stops this connection's watch. */
  statusWatches: Map<string, () => void>
}

const encoder = new TextEncoder()

function flush(connection: Connection) {
  while (connection.pending.length > 0) {
    const chunk = connection.pending[0]!
    const written = connection.socket.write(chunk)
    connection.backlog -= written
    if (written < chunk.byteLength) {
      connection.pending[0] = chunk.subarray(written)
      return
    }
    connection.pending.shift()
  }
}

/** MCP server control; the process entry passes the manager. Absent in tests and offline engines. */
export interface McpControl extends Omit<McpContentPort, "getPrompt"> {
  cachedPrompts?(directory: string): import("@mendcode/mcp").McpServerPrompt[]
  listPrompts?(directory: string): Promise<{ prompts: import("@mendcode/mcp").McpServerPrompt[]; issues: Array<{ server?: string; message: string }> }>
  getPrompt?(input: { directory: string; server: string; name: string; args: Record<string, string> }): Promise<string | import("@mendcode/protocol").McpPromptResult>
  getPromptResult?(input: { directory: string; server: string; name: string; args: Record<string, string> }): Promise<import("@mendcode/protocol").McpPromptResult>
  debug?(input: { directory: string; server: string }): Promise<import("@mendcode/protocol").McpDebugReport>
  invalidate?(directory?: string): void | Promise<void>
  suspend?(input: { directory?: string; server: string }): Promise<void>
  status(directory: string): Promise<McpStatusReport>
  restart(input: { directory: string; server: string }): Promise<McpServerStatus>
  startAuth?(input: { directory: string; server: string }): Promise<{ url: string; completion: Promise<McpServerStatus> }>
  cancelAuth?(input: { directory: string; server: string }): Promise<void>
  forgetAuth?(input: { directory: string; server: string }): Promise<McpServerStatus>
  connect?(input: { directory: string; server: string }): Promise<McpServerStatus>
  disconnect?(input: { directory: string; server: string }): Promise<McpServerStatus>
  finishAuth?(input: { directory: string; server: string; code: string }): Promise<McpServerStatus>
  waitAuth?(input: { directory: string; server: string; signal?: AbortSignal }): Promise<McpServerStatus>
}

/** What an engine takes from the daemon's extensions: the loaded modules, the engine's interception points and the prompt files. */
export type EngineExtensions = DaemonExtensions & { hooks: EngineHooks; prompts: PromptFiles; reload(directory: string): Promise<UiReloadReport> }

export type DaemonOptions = RemoteListenerOptions & {
  /**
   * `descendants`: every local client that descends from this process is agent-origin unless the user opened its terminal
   * here. On for the real daemon; off by default so a host that starts its own clients (tests, embeddings) is not refused.
   * Clients that come from a session's shell are recognised either way.
   */
  agentOrigin?: { descendants?: boolean }
  /**
   * Where other programs keep this user's chats, for `threads` (thread-foreign.ts): Codex and Claude Code homes and the previous
   * MendCode's database. Absent: `threads` knows only this daemon's sessions, which is what a private data directory gets.
   */
  foreignThreads?: { homes: Required<import("./session-import-source").ForeignHomes>; v1Db?: string }
  /** Native PTY is opt-in. Tests and embeddings can supply a local driver. */
  pty?: { enabled?: boolean; driver?: PtyDriver }
  /** Model-owned interactive processes (`shell_session`); never reachable from HTTP or remote clients, and independent of `pty`. Tests can supply a local driver. */
  interactive?: { driver?: PtyDriver }
  http?: HttpOptions
  /** False disables the adapter's TCP listener; a string enables the loopback session HTTP bridge. */
  httpListen?: boolean | string
  web?: string
  audioPlayer?: AudioPlayer
  /** Dictation test seams: the microphone recorder and the transcription transport. */
  voice?: { recorder?: VoiceRecorder; fetch?: typeof fetch; /** On-device dictation; main.ts gives it, tests leave it out. */ local?: LocalDictation }
  petImages?: import("../../tools/src/tools/image_api").ImageApi
  release?: ReleaseOptions
  computer?: ComputerOptions
  /** Model-owned headless browser (`browser` tool); opt-in, never reachable from HTTP or remote clients. Tests supply a fake driver. */
  browser?: Omit<BrowserOptions, "hasSession">
  dir: string
  /** Package registry and tarball access; tests pass local fakes. Defaults to `npm pack` and `fetch`. */
  packageFetchers?: import("@mendcode/packages").PackageFetchers
  console?: { request?: typeof fetch; openUrl?(url: string): Promise<void>; debounceMs?: number }
  mflowListen?: string
  /** Chat bridge test seams (docs/channels.md): the Telegram transport, environment and daemon client. */
  channels?: Pick<ChannelsOptions, "fetch" | "env" | "connect">
  socketPath: string
  /** `tcp` listens on 127.0.0.1 behind a per-start secret published in `<dir>/mendd.endpoint` (Windows default); `unix` uses `socketPath`. Defaults from the platform and `MENDCODE_V2_LOCAL_TRANSPORT`. */
  localTransport?: LocalTransport
  defaultDirectory?: string
  engine(input: { /** Queue a notice in a session from the engine (Claude Code answered a background task's end on its own). */ notify(sessionId: SessionId, text: string): void; /** Background tasks an engine runs by itself (Claude Code's), listed with the daemon's own shells. */ engineBackground(sessionId: SessionId, tasks: ReadonlyArray<{ id: string; description: string; kind: string }>, stop?: (taskId: string) => Promise<void>): void; /** What an engine's background sub-agent does after its turn ended, recorded under that turn. */ engineAgentEvent(sessionId: SessionId, turnId: import("@mendcode/protocol").TurnId, event: import("@mendcode/kernel").EngineEvent): void; trace: import("@mendcode/protocol").TracePort; budget: BudgetPort; reasoning: import("@mendcode/engine-native").ReasoningPort; continuity: import("@mendcode/kernel").ContinuityForSession; tasks: import("@mendcode/kernel").TaskPort; clock: Clock; store: Store; grants: GrantStore; runLimits: RunLimitsStore; sessionRules(sessionId: SessionId): readonly import("@mendcode/protocol").PermissionRule[]; emitGlobal(event: GlobalEventDraft): void; secrets: SecretsPort; memory: MemoryAccess; background(sessionId: SessionId): BackgroundPort; interactive(sessionId: SessionId): InteractivePort; workflows(sessionId: SessionId): WorkflowPort; peers(sessionId: SessionId): PeerPort; sessionMeta(sessionId: SessionId): NonNullable<import("@mendcode/tools").ToolContext["sessionMeta"]>; threads(sessionId: SessionId): import("@mendcode/tools").ThreadPort; packages(sessionId: SessionId): import("@mendcode/tools").PackagePort; loops(sessionId: SessionId): LoopPort; worktrees(sessionId: SessionId): import("@mendcode/tools").WorktreePort; prWatch(sessionId: SessionId): import("@mendcode/tools").PrWatchPort; review(sessionId: SessionId): ReviewPort; goals(sessionId: SessionId): GoalPort; customTools: CustomToolRegistry; skills: SkillLoader; extensionLayers(directory: string): ExtensionLayer[]; agents: AgentPort; plans: { latest(sessionId: SessionId): import("@mendcode/protocol").PlanReview | undefined }; extensions: EngineExtensions; recall(sessionId: SessionId): SessionRecallPort; compound(sessionId: SessionId): CompoundCall | undefined; aiConfig(sessionId: SessionId): import("@mendcode/tools").AIConfigPort; inlineShell(text: string): InlineShell[]; computer(sessionId: SessionId): import("@mendcode/tools").ComputerPort; browser(sessionId: SessionId): import("@mendcode/tools").BrowserPort; harness: { args(sessionId: SessionId): string[]; servers(sessionId: SessionId): ReturnType<ReturnType<typeof createHostMcp>["servers"]>; waiting(): boolean; instructions(sessionId: SessionId): Promise<string | undefined> }; /** The local owner's settings write (`mendcode_settings` after the user approved): saved, announced, followed. */ settingsWrite(patch: Record<string, unknown>): Promise<Settings> }): EnginePort & { stop?(): void }
  reasoningEvaluator?: import("@mendcode/engine-native").ReasoningEvaluator
  /** Extension diagnostics (load failures, the first error of each extension); defaults to stderr. */
  log?(level: "debug" | "info" | "warn" | "error", message: string): void
  logLevel?: LogLevel
  trace?: boolean
  otlp?: OtlpExporter
  /** Per-handler time limit of extension hooks in ms (HOOK_TIMEOUT_MS by default). */
  extensionHookTimeoutMs?: number
  /** Consecutive failures after which an extension handler is stopped for the session (3 by default); tests lower it. */
  extensionBreakerThreshold?: number
  /** Home folder whose `.agents` and `.claude` skills, commands and agents are read; none when unset (tests stay hermetic). */
  foreignHome?: string
  /** Whether extensions load at all; defaults to `MENDCODE_EXTENSIONS !== "0"`. */
  extensionsEnabled?: boolean
  /** Whether shell command hooks (`hooks.json`) run at all; defaults to `MENDCODE_HOOKS !== "0"`. */
  shellHooksEnabled?: boolean
  /** `--safe-mode`: reported in `daemon.info`; the host also turns extensions, hooks, MCP and project tools off (docs/tiers.md). Packages are dropped here. */
  safeMode?: boolean
  clock?: Clock
  cancelGraceMs?: number
  /** Reported in the handshake so clients can detect a stale daemon. */
  buildId?: string
  mcp?: McpControl
  lsp?: Pick<import("@mendcode/lsp").LspManager, "query"> & Partial<Pick<import("@mendcode/lsp").LspManager, "diagnostics" | "status" | "workspaceSymbols">>
  /** `lsp install`: downloads a builtin server into the LSP cache (main.ts passes `installLspServer` with the cache folder). */
  lspInstall?: (input: { server: "typescript" | "python" | "go"; cwd: string }) => Promise<{ id: string; command?: string[]; already?: boolean; reason?: string }>
  formatter?: Pick<import("@mendcode/lsp").FormatterManager, "status" | "file">
  githubProcess?: GithubProcess
  /** PR watch (docs/pr-watch.md): `gh` runner and poll period; tests inject a fake runner, production runs the user's own `gh` every minute. */
  prWatch?: { run?: GhRun; intervalMs?: number }
  /** The PR reviewer's processes and review children (docs/pr-review.md); tests inject fakes. `noGraph` skips the code graph. */
  prReview?: { hosted?: import("./github").GithubProcess; run?: GhRun; call?: import("./pr-review/publish").GhCall; git?: import("./pr-review/context").GitRun; intervalMs?: number; noGraph?: boolean; sessions?(owner: string, directory: string): import("./pr-review/engine").ReviewSessionFactory }
  /** Where the code graph's indexer reports its counts (`codegraph.status` to local terminals, for the footer). Absent: no counts are sent. */
  codegraphStatus?: CodegraphStatusHub
  /** `codegraph.overview` (the Galaxy panel's code mode): builds or refreshes the code graph of a directory on that explicit request. Absent: the reply says the code graph is off. */
  codeOverview?: import("@mendcode/codegraph").CodeOverview
  /** Which folders the code graph indexes (`/graph`, `codegraph_index`; docs/code-graph.md). Absent: every folder but the home folder. */
  codeGate?: import("@mendcode/codegraph").IndexGate
  /** Quota refresh probes (docs/usage-limit.md): how the daemon asks each provider for its windows when the user listed it in `quotaRefresh`. Production supplies the engine paths; tests inject fakes and a short tick. No probe is ever sent without the user's setting. */
  quotaRefresh?: { probes?: Partial<Record<QuotaRefreshProvider, RefreshProbe>>; tickMs?: number; random?: () => number }
  /** Hermetic bridge transport for tests; production binds only 127.0.0.1. */
  /** Tests serve the native-tools bridge without a socket. */
  hostMcpListener?: Parameters<typeof createHostMcp>[0]["listen"]
  threadMcpListener?: Parameters<typeof import("./thread-mcp")["createThreadMcp"]>[0]["listen"]
  /** Injectable for tests; defaults to the real OS clipboard reader (osascript/sips, wl-paste/xclip). */
  clipboard?: ClipboardReader
  /** Local IDE adapter; tests provide a fake and never launch a real editor. */
  ide?: IdeAdapter
  /**
   * One tool-less model completion for Dream (and Evolution); without it `dream.run` is refused. `model` is the dream
   * role's model when the engine lets the user choose. Returning the provider's token counts lets the run keep to its
   * budget exactly; a plain string is counted by estimate.
   */
  extractMemory?(job: import("@mendcode/protocol").ExtractionJob, signal: AbortSignal, onUsage?: (usage: BudgetUsage) => void): Promise<ExtractedMemory[]>
  dream?: { complete(prompt: string, signal: AbortSignal, model?: ModelChoice): Promise<Completion> }
  /** One tool-less model call (`/btw` side questions); without it they are refused. */
  complete?(input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice; onText?(text: string): void }): Promise<string>
  /** Setup helper completion with observed usage when the adapter exposes it. */
  setupTimeoutMs?: number
  setupComplete?(input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice; onText?(text: string): void }): Promise<{ text: string; usage?: BudgetUsage | undefined }>
  /** Reported by `daemon.info`. `login` checks the subscription login (never returns the token). */
  info?: { engine: string; model?: string; effort?: string; login?(): Promise<{ ok: boolean; message?: string }> }
  /** Models `/model` can pick from; without it the engine picks its own and choices are refused. */
  models?: ModelCatalog
  /** Local host fakes for compound acceptance tests; production uses isolated git worktrees. */
  compoundHost?: Pick<Parameters<typeof createCompoundHost>[0], "workspace" | "snapshot" | "check">
  /** API-key providers (providers.json); without it the `providers.*` commands are refused. The process entry builds it and feeds its models into `models`. */
  providers?: ProviderService
  providerAuth?: ProviderAuthService
  /** Called after an accepted `daemon.shutdown` once resources are released (the process entry exits here). */
  onShutdown?(): void
  /** A session was deleted: what the process entry keeps for it outside the daemon (One Tree's files) goes too. */
  onSessionRemoved?(sessionId: SessionId): void
  /** A detached daemon stops itself after this long with no client, no work and nothing standing (`keepAliveReport`); unset keeps it running. */
  idleExitMs?: number
  /** Opens an http/https address in the default browser (`url.open`, a click on a link); the system handler by default. */
  openUrl?(url: string): Promise<void>
  /** Opens an image file in the system's viewer, or shows it in its folder (`image.open`); the system handler by default. */
  openImage?(input: { path: string; reveal?: boolean }): Promise<void>
  /** The subscription account for `/usage` (name, email, plan); without it the report has no profile. */
  usageProfile?(): Promise<UsageProfile>
  /** A model's public API price (USD per million tokens), for the waste report's dollars: models.dev's, by provider (a subscription by its vendor's API). */
  listPrice?(provider: string, model: string): WastePrice | undefined
  /** Runtime installation is opt-in; omitted in the standard daemon. Never checks releases implicitly. */
  runtimeUpgrade?(input: import("@mendcode/protocol").RestUpgradeInput, signal: AbortSignal): Promise<import("@mendcode/protocol").RestUpgradeResult>
  runtimeInfo?: { version: string; channel: string }
  memoryUsage?(): ReturnType<typeof process.memoryUsage>
  /** Explicit host opt-in. Absent means no weather network access. */
  usageWeather?: UsageWeatherService
}

/**
 * What an engine may do with memory: read the saved entries a session may see (all, or those matching its prompt) and
 * propose new ones. A proposal follows its category's policy: review (pending, the default), auto (saved) or never (dropped).
 */
export type MemoryAccess = {
  request(directory: string, input: import("@mendcode/protocol").MemoryModelInput): Record<string, unknown>
  saved(directory: string): MemoryEntry[]
  /** Saved memories visible to a session: its profile's user memories, its project's and (with `sessionId`) its own. */
  visible(input: { directory: string; sessionId?: SessionId }): MemoryEntry[]
  /** Those matching any distinctive word of `prompt`, best first; `rank` is bm25 (lower is better). */
  related(input: { directory: string; sessionId?: SessionId; prompt: string; limit: number }): Array<{ memory: MemoryEntry; rank: number }>
  links(memoryIds: MemoryId[]): MemoryLink[]
  propose(entry: { scope: MemoryScope; directory?: string; sessionId?: SessionId; text: string; category: string }): { memoryId?: string; outcome: "pending" | "saved" | "dropped" }
  /** Saved memories visible from `directory` and their links. */
  graph(directory: string): MemoryGraphReport
  /** Links two saved memories; undefined when refused. */
  link(input: { from: MemoryId; to: MemoryId; kind: MemoryLinkKind }): MemoryLink | undefined
}

/** The `body.id` of a frame that failed validation, if it is a well-formed command id. */
function rawCommandId(line: string): string | undefined {
  try {
    const id = (JSON.parse(line) as { body?: { id?: unknown } } | null)?.body?.id
    return typeof id === "string" && CommandId.safeParse(id).success ? id : undefined
  } catch {
    return undefined
  }
}

export async function startDaemon(options: DaemonOptions) {
  if (options.otlp) validateOtlp(options.otlp)
  // Asked for at start (the environment switch): refuse to start. Switched on later (`/tier computer on`): it stays off on such a listener, see `computerOn`.
  const computerLoopback = !options.listen || isLoopbackHost(parseRemoteAddress(options.listen).hostname)
  if (options.computer?.enabled === true && !computerLoopback) throw new Error("Computer control requires a loopback-only daemon listener")
  const computerSwitch = options.computer?.enabled
  const computerOn = () => computerLoopback && (typeof computerSwitch === "function" ? computerSwitch() : computerSwitch === true)
  const remoteConfig = validateRemoteListener(options)
  const sessionHttpConfig = validateSessionHttpListener(typeof options.httpListen === "string" ? options.httpListen : undefined)
  const serverConfig = httpConfig(options.dir, options.http)
  if (serverConfig.enabled && !remoteTokens(options.dir).list().length) throw new Error("HTTP server requires a remote token; create one against --dir first")
  const tokens = remoteTokens(options.dir)
  const backoff = remoteBackoff()
  const clock = options.clock ?? realClock
  const pty = createPtyService({ enabled: options.pty?.enabled ?? serverConfig.pty, ...(options.pty?.driver ? { driver: options.pty.driver } : {}), now: () => clock.now(), active: (peer) => { try { return tokens.active(peer) } catch { return false } } })
  const clipboard = options.clipboard ?? createClipboardReader()
  const ide = createIdeBridge(options.dir, options.ide)
  const tuiControl = createTuiControl(options.dir)
  // `auto` follows the model of each call; outside a session (status, sources, /setup) it reads the project's main model.
  const promptModel = (directory: string) => resolveModel({ role: "main", roles: rolesFor(store.settings.get(), directory), catalog }).model
  const promptModes = createPromptModes(options.dir, { defaultModel: promptModel })
  const projectControl = createProjectControl({ dir: options.dir, settings: () => store.settings.get(), now: () => clock.now(), model: promptModel })
  const promptInstructions = projectControl.instructions
  let promptPackaged: ReturnType<typeof loadSystemPrompt> | undefined
  const storeWarnings: string[] = []
  let warnStore = (message: string) => { storeWarnings.push(message) }
  const store = openStore({ dir: options.dir, now: () => clock.now(), warn: (message) => warnStore(message) })
  // Instruction URLs in the user's settings are downloaded ahead, so the first prompt already has them (remote-instructions.ts).
  void remoteInstructions(options.dir).prefetch(store.settings.get().instructions ?? [])
  if (options.models) options = { ...options, models: filteredCatalog(options.models, () => store.settings.get()) }
  const worktrees = createWorktreeManager({ dir: options.dir, sessions: (directory) => store.listSessions({ directory, limit: 100 }).map((session) => session.sessionId), focus: (directory) => promptModes.status(directory).focusID })
  const evolutionPromotions = createEvolutionPromotions({ store, dir: options.dir, now: () => clock.now() })
  const tsm = createTsmManager({ dir: options.dir, worktrees })
  const github = createGithub(options.githubProcess ? { process: options.githubProcess } : {})
  const ids = createIdFactory({ now: () => clock.now() })
  const registry = createResourceRegistry()
  const root = createScope({ name: "mendd", clock, registry })
  const audio = createActivityAudio({ dir: options.dir, clock, ...(options.audioPlayer ? { player: options.audioPlayer } : {}) })
  /** Opt-in dictation (`voice.enabled`): the daemon alone records and uploads; never reachable from remote clients. */
  const voice = createVoice({ dir: options.dir, clock, settings: () => effectiveSettings(store.settings.get(), { safeMode: options.safeMode }), recorder: options.voice?.recorder ?? createVoiceRecorder(), ...(options.voice?.local ? { local: options.voice.local } : {}), allowed: () => featureOn(store.settings.get(), "voice", { safeMode: options.safeMode === true }), live: (owner, update) => { const connection = owner as Connection; if (connections.has(connection)) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: { type: "voice.live", gseq: 0, at: clock.now(), ...update } }) }, ...(options.providers?.imageTransport ? { credentials: (provider: string) => options.providers!.imageTransport!(provider) } : {}), ...(options.voice?.fetch ? { fetch: options.voice.fetch } : {}) })
  const connections = new Set<Connection>()
  /** `attachment.put` pieces of a file still being sent, by connection and upload id (a long paste as text). */
  const partialUploads = new Map<string, { pieces: Uint8Array[]; bytes: number }>()
  const trace = createTracing({ dir: options.dir, enabled: () => options.trace === true || [...connections].some((connection) => connection.trace === true), openTelemetry: () => store.settings.get().experimental?.openTelemetry === true, ...(options.otlp ? { exporter: options.otlp } : {}) })
  const tracedTurns = new Map<SessionId, { turnId: import("@mendcode/protocol").TurnId; span: ReturnType<typeof trace.start> }>()
  let mflowListener: ReturnType<typeof Bun.serve> | undefined
  const mflow = createMflow({ dir: options.dir, now: () => clock.now(), listener: () => mflowListener?.url.origin })
  const actors = new Map<SessionId, SessionActor>()
  /** Background tasks Claude Code runs for a session, as it last reported them; shown with the daemon's own shells (`background.list`). */
  const engineTasks = new Map<SessionId, Array<{ id: string; description: string; kind: string; startedAt: number }>>()
  /** Background agents an engine runs inside its own process (Claude Code's): stopping the daemon stops that process, so they are running work. */
  /** How to stop one of a session's engine tasks (Claude Code's `stop_task`), while it has any. */
  const engineTaskStops = new Map<SessionId, (taskId: string) => Promise<void>>()
  const engineJobs = () => [...engineTasks.values()].reduce((count, tasks) => count + tasks.length, 0)
  const idleGc = createIdleGc({ clock, busy: () => [...actors.values()].some(actorWorking) || scheduler.snapshot().length > 0 || engineJobs() > 0 })
  /** A session with something in flight that a restart or a reload would drop: a turn, or a compaction (which has no turn of its own). */
  const actorWorking = (actor: SessionActor) => { const now = actor.snapshot(); return Boolean(now.turnId) || now.foreground === "compacting" }
  const recentCommands = new Map<string, Frame>()
  const serverEventObservers = new Set<(event: import("@mendcode/protocol").RestServerEvent) => void>()
  const disposingDirectories = new Set<string>()
  let disposingGlobal = false
  function publishServerEvent(event: SessionEvent | GlobalEvent) {
    if (!serverEventObservers.size) return
    const { type, ...properties } = event
    const directory = "sessionId" in event ? store.sessionDirectory(event.sessionId) : "directory" in event ? event.directory : undefined
    let projectedType: string = type
    if (event.type === "server.lifecycle") projectedType = event.change === "upgraded" ? "installation.updated" : event.directory ? "server.instance.disposed" : "server.disposed"
    const value = JSON.parse(redactSecrets(JSON.stringify({ directory: directory ?? "global", payload: { id: "seq" in event ? `${event.sessionId}:${event.seq}` : `global:${event.gseq}`, type: projectedType, properties } })).text) as import("@mendcode/protocol").RestServerEvent
    for (const observe of serverEventObservers) try { observe(value) } catch { serverEventObservers.delete(observe) }
  }
  let nextConnection = 1

  const logLine = daemonLogger(() => options.logLevel ?? store.settings.get().logLevel ?? "INFO", options.log ?? ((level: "info" | "warn" | "error", message: string) => void process.stderr.write(`${level.toUpperCase()} ${message}\n`)))
  warnStore = (message) => logLine("warn", message)
  for (const message of storeWarnings.splice(0)) warnStore(message)

  /** Pasted secrets (K1): markers in everything stored or shown to the model, values only in the encrypted store and in tool runs. */
  const secrets = createSecretsService({ store, log: logLine })
  /** Opt-in Telegram bridge: idle (no network, no listener) until channels.json enables it. */
  const channels = createChannels({ dir: options.dir, socketPath: options.socketPath, now: () => clock.now(), mask: (sessionId, text) => secrets.mask(sessionId as SessionId, text), log: (level, message) => logLine(level, message), transcribe: (clip) => voice.transcribe(clip), ...options.channels })

  /** Text a user typed with its secrets swapped for markers; `undefined` (with the reply sent by the caller) when the key file is unusable. */
  function captured(sessionId: SessionId, text: string): { text: string } | { ok: false; code: ErrorCode; message: string } {
    const result = secrets.capture(sessionId, text)
    return "error" in result ? { ok: false, code: "internal", message: result.error } : result
  }

  /** Answers of recent `user.submit` calls by session and `clientRequestId` (bounded), so a retried send is not queued twice. */
  const submitRequests = new Map<string, { ok: true; result?: Record<string, unknown> }>()
  function rememberRequest(key: string, answer: { ok: true; result?: Record<string, unknown> }) {
    submitRequests.set(key, answer)
    if (submitRequests.size > 1000) submitRequests.delete(submitRequests.keys().next().value!)
  }

  /** Only the native engine has a point between tool results where a queued message can join the running turn; Claude Code, Codex and ACP turns cannot take one. */
  /** The session's main model and the external harness that runs it (none for the native engine). */
  function sessionRunner(sessionId: SessionId) {
    if (options.info?.engine !== "native") return undefined
    const directory = store.sessionDirectory(sessionId)
    if (!directory) return undefined
    const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }
    const model = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), directory), catalog })
    return { model, engine: modelEngine(model, catalog) }
  }

  /** Claude Code and pi take a message typed while they work into the running turn on their own; the native engine does it after tool results. */
  const harnessSteers = (engine: ReturnType<typeof modelEngine>) => engine === "claude" || engine === "pi"

  function engineTakesSteer(sessionId: SessionId): boolean {
    const runner = sessionRunner(sessionId)
    if (!runner) return false
    return runner.engine ? harnessSteers(runner.engine) : !runner.model.model.startsWith("acp:")
  }

  /**
   * The queue policy: the user's, else `after-tools` wherever the engine takes a message mid-turn (MendCode's own, Claude Code,
   * pi), as Claude Code does; Codex and ACP agents wait for the response.
   */
  function queueModeOf(sessionId: SessionId) {
    return store.settings.get().queue?.mode ?? (engineTakesSteer(sessionId) ? "after-tools" as const : undefined)
  }

  /**
   * Background shell tasks of every session; one that ends on its own tells its session with a notice. A running turn reads it after its
   * next tool result (so the model that started the task is not left waiting for it); an idle session is woken by it, and after a user
   * cancel it waits for the user (FC-13).
   */
  const interactive = createInteractiveProcesses(options.interactive?.driver ? { driver: options.interactive.driver } : {})
  // The exit notice is dropped unread once shell_output gave the model that task's exit and final output itself.
  const background: ReturnType<typeof createBackgroundTasks> = createBackgroundTasks({ onExit: (sessionId, task, tail) => void actorFor(sessionId as SessionId)?.notify(secrets.mask(sessionId as SessionId, backgroundNotice(task, tail)), undefined, false, "steer", true, () => background.exitShown(sessionId, task.id)), onWatch: (sessionId, task, lines, final) => void actorFor(sessionId as SessionId)?.notify(secrets.mask(sessionId as SessionId, watchNotice(task, lines, final)), undefined, false, "steer", true) })

  /** Where extensions are found for a project: what ships with MendCode, enabled packages, then the user's and the project's own folders. */
  const builtin = builtinDir(options.dir)
  // Safe mode drops every installed package (user and project); MendCode's own folder and the user's and project's own folders stay.
  const runtimeDisabledPackages = () => [...(store.settings.get().disabledPackages ?? []), ...tierDisabledPackages(store.settings.get())]
  /** What a package's `compatibility` is checked against when it is installed or enabled. */
  const packageHost: PackageHost = { appVersion: options.runtimeInfo?.version ?? DEV_VERSION, apiVersion: EXTENSION_API_VERSION }
  const layersFor = (directory: string) => extensionLayers({ userDir: options.dir, directory: path.resolve(directory), disabled: runtimeDisabledPackages(), disabledResources: store.settings.get().disabledPackageResources ?? [], builtinDir: builtin })
    .filter((layer) => !options.safeMode || !layer.pkg || layer.pkg === BUILTIN_PACKAGE)
  /**
   * The layers the skill, command and agent loaders read: `layersFor` plus the data-only `.agents` and `.claude` folders (settings
   * `foreignResources`, default on) and the `.mendcode` folders of the project's parent folders inside its repository.
   */
  const resourceLayersFor = (directory: string) => {
    const layers = layersFor(directory)
    const parents = ancestorLayers({ directory: path.resolve(directory), ...(options.foreignHome ? { home: options.foreignHome } : {}) })
    const foreign = store.settings.get().foreignResources === false ? { user: [], project: [] } : foreignLayers({ directory: path.resolve(directory), home: options.foreignHome })
    return withForeignLayers(layers, { user: foreign.user, project: [...parents, ...foreign.project] }, options.dir)
  }
  const packageCatalog = createPackageCatalog({ capabilities: () => featureOn(store.settings.get(), "package_capabilities"), host: packageHost, userDir: options.dir, now: clock.now, disabled: () => store.settings.get().disabledPackages ?? [], runtimeDisabled: runtimeDisabledPackages, disabledResources: () => store.settings.get().disabledPackageResources ?? [], ...(options.packageFetchers ? { fetchers: options.packageFetchers } : {}), layers: layersFor, promptMode: (directory) => promptModes.status(directory).mode, setDisabled: (keys) => {
    const settings = store.settings.set({ disabledPackages: keys.length ? keys : null })
    globalSink.append({ type: "settings.changed", settings })
  }, setDisabledResources: (keys) => {
    const settings = store.settings.set({ disabledPackageResources: keys.length ? keys : null })
    globalSink.append({ type: "settings.changed", settings })
  }, reload: (directory) => reloadPackages(directory) })
  const packageAuthoring = createPackageAuthoring({ settings: () => store.settings.get(), prompt: (directory) => promptModes.status(directory), tui: () => tuiControl.run({ operation: "status" }).profile, now: clock.now, reload: (directory) => reloadPackages(directory) })
  /** After a package is installed, enabled, disabled, removed or edited: the MCP server set is rebuilt (stale servers stop) before the UI reloads. */
  const reloadPackages = async (directory: string) => {
    await options.mcp?.invalidate?.()
    return uiReload.reload(directory)
  }

  type ManagedCommand = Extract<Command, { type: "packages.list" | "packages.install" | "packages.capture" | "packages.remove" | "packages.restore" | "packages.enable" }>
  async function managePackages(command: ManagedCommand): Promise<Record<string, unknown>> {
    const directory = path.resolve(command.directory)
    if (command.type === "packages.capture") {
      // The stored profile becomes a package's look, installed through the same audit and look claim as any folder.
      const staged = stageCapturedLook({ userDir: options.dir, name: command.name, profile: tuiControl.run({ operation: "status" }).profile })
      try {
        const report = await managePackages({ ...command, type: "packages.install", source: staged.dir, scope: "user" })
        return { ...report, skipped: staged.skipped }
      } finally { staged.cleanup() }
    }
    const setDisabled = (keys: string[]) => globalSink.append({ type: "settings.changed", settings: store.settings.set({ disabledPackages: keys.length ? keys : null }) })
    try {
      if (command.type === "packages.install") {
        const installed = await installPackage({ spec: command.source, scope: command.scope, userDir: options.dir, directory, replace: command.replace === true, now: clock.now, host: packageHost, ...(options.packageFetchers ? { fetchers: options.packageFetchers } : {}) })
        const key = packageKey(command.scope, installed.name)
        const disabled = store.settings.get().disabledPackages ?? []
        const next = disabled.filter((entry) => entry !== key)
        if (next.length !== disabled.length) setDisabled(next)
        // Installing enables it, so it claims the look like `packages.enable` does; when another package owns the look this one stays installed but off.
        try { claimLook({ userDir: options.dir, directory, key, disabled: runtimeDisabledPackages() }) } catch (error) {
          if (error instanceof LookOwnedError) { setDisabled([...new Set([...next, key])]); await reloadPackages(directory) }
          throw error
        }
      }
      if (command.type === "packages.remove") {
        if (!removePackage({ name: command.name, scope: command.scope, userDir: options.dir, directory, purge: command.purge === true, now: clock.now }))
          throw new PackageNotInstalledError(`${packageKey(command.scope, command.name)} is not installed`)
        releaseLook({ userDir: options.dir, directory, key: packageKey(command.scope, command.name) })
      }
      if (command.type === "packages.restore") {
        restorePackage({ name: command.name, scope: command.scope, userDir: options.dir, directory })
        // Back from the Trash it stays off until the user enables it (which checks it again).
        setDisabled([...new Set([...(store.settings.get().disabledPackages ?? []), packageKey(command.scope, command.name)])])
      }
      if (command.type === "packages.enable") {
        const pkg = listPackages({ userDir: options.dir, directory }).find((item) => item.key === command.key)
        if (!pkg) throw new PackageError(`${command.key} is not installed`)
        if (command.enabled && pkg.manifest) {
          const incompatible = manifestCompatProblem(pkg.manifest, packageHost)
          if (incompatible) throw new PackageError(`${command.key} ${incompatible}`)
        }
        // Claiming the look can refuse (another package owns it); that happens before anything is changed.
        const claim = command.enabled ? claimLook({ userDir: options.dir, directory, key: command.key, disabled: runtimeDisabledPackages(), ...(command.switch ? { switch: true } : {}) }) : undefined
        if (!command.enabled) releaseLook({ userDir: options.dir, directory, key: command.key })
        const current = store.settings.get().disabledPackages ?? []
        setDisabled(command.enabled ? [...new Set([...current.filter((key) => key !== command.key), ...(claim?.off ? [claim.off] : [])])] : [...new Set([...current, command.key])])
      }
    } catch (error) {
      if (error instanceof PackageError) throw error
      throw error
    }
    if (command.type !== "packages.list") await reloadPackages(directory)
    const packages = listPackages({ userDir: options.dir, directory, disabled: runtimeDisabledPackages() })
    const layers = resourceLayersFor(directory)
    for (const pkg of packages) {
      const cost = packageContextCost(pkg, layers.find((layer) => layer.dir === pkg.dir))
      if (cost) Object.assign(pkg, { contextCost: cost })
    }
    return { directory, packages }
  }

  const selfPackagePorts = new Map<SessionId, import("@mendcode/tools").PackagePort>()
  const selfPackages = (sessionId: SessionId) => {
    let port = selfPackagePorts.get(sessionId)
    if (!port) {
      const directory = store.sessionDirectory(sessionId)
      if (!directory) throw new PackageError("Session directory unavailable")
      port = createSelfPackages({ userDir: options.dir, directory, host: packageHost, local: () => !options.safeMode && featureOn(store.settings.get(), "package_tools") && store.meta.get(`session.local-tools.restricted:${sessionId}`) !== "true", trusted: () => (store.settings.get().trustedToolDirs ?? []).includes(canonicalDir(directory)), disabled: runtimeDisabledPackages, disabledResources: () => store.settings.get().disabledPackageResources ?? [], layers: () => resourceLayersFor(directory), manage: (command) => managePackages(command as ManagedCommand), catalog: (command) => packageCatalog(command as Parameters<typeof packageCatalog>[0]) })
      selfPackagePorts.set(sessionId, port)
    }
    return port
  }

  /** Script-backed status lines of watched projects; sent only to the connections watching that directory. */
  const statusLines = createStatusScripts({
    clock,
    layersFor,
    isTrusted: (directory) => (store.settings.get().trustedToolDirs ?? []).includes(canonicalDir(directory)),
    quotas: () => store.latestQuota(),
    publish: (line) => {
      const event: GlobalEvent = { type: "status.line", gseq: 0, at: clock.now(), ...line }
      for (const connection of connections) if (connection.clientId && connection.statusWatches.has(line.directory)) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
  })

  /** Custom tools of every layer's `tools/`; project ones (the project's own and its packages') once the directory is trusted. */
  const customTools = createCustomToolRegistry({ userDir: options.dir, trustedDirs: () => store.settings.get().trustedToolDirs ?? [], layers: layersFor })

  /**
   * Extensions (TypeScript modules: hooks, tools, commands): loaded lazily per directory, project ones only in directories
   * trusted for project tools (the same `trustedToolDirs` and matching as custom tools). `MENDCODE_EXTENSIONS=0` turns them off.
   */
  const extensionsEnabled = options.extensionsEnabled ?? process.env.MENDCODE_EXTENSIONS !== "0"
  /** Scripted-run limits (`session.run.configure`) and an extension's `setActiveTools`: the engine reads them, they die with the session. */
  const runLimits = createRunLimitsStore()
  const manager = createExtensions({
    dataDir: options.dir,
    layersFor,
    isTrusted: (directory) => {
      const canonical = canonicalDir(directory)
      return (store.settings.get().trustedToolDirs ?? []).some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
    },
    notify: (sessionId, text) => void actorFor(sessionId as SessionId)?.notify(text),
    log: logLine,
    enabled: extensionsEnabled,
    isDisabled: (name) => (store.settings.get().disabledExtensions ?? []).includes(name),
    tier: () => store.settings.get().tier,
    // `api.toast`: shown on this machine's terminals only, never stored and never part of the model's context.
    feedback: ({ extension, text, level }) => {
      const event: GlobalEvent = { type: "extension.feedback", gseq: 0, at: clock.now(), extension, text, level }
      for (const connection of connections) if (connection.clientId && !connection.remoteAddress && !connection.peer) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
    ...(options.extensionHookTimeoutMs ? { hookTimeoutMs: options.extensionHookTimeoutMs } : {}),
    ...(options.extensionBreakerThreshold ? { breakerThreshold: options.extensionBreakerThreshold } : {}),
    // `api.setModel`, `setThinkingLevel`, `setActiveTools`, `sendUserMessage`: what `/model`, a narrower tool list and a typed message do, nothing more.
    sessions: createExtensionSessions({
      directory: (sessionId) => store.hasSession(sessionId) ? store.sessionDirectory(sessionId) : undefined,
      current: (sessionId) => resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog }),
      engineOf: (sessionId) => {
        if (options.info?.engine && options.info.engine !== "native") return options.info.engine
        const model = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog })
        return model.model.startsWith("acp:") ? acpAgentKey(model.model) : modelEngine(model, catalog) ?? "native"
      },
      catalog: async (directory) => {
        await catalog.refresh?.()
        const extra = catalog.selectable ? await manager.providerModels(directory) : []
        return extra.length ? { ...catalog, list: () => [...catalog.list().filter((model) => !extra.some((item) => item.id === model.id)), ...extra] } : catalog
      },
      choose: (sessionId, choice) => {
        store.setSessionModel(sessionId, choice)
        usageLimit.revalidate(sessionId)
        reasoning.port.manual(sessionId)
      },
      runLimits,
      submit: async (sessionId, text, delivery) => {
        const actor = actorFor(sessionId)
        if (!actor) return { ok: false, error: "sendUserMessage: unknown session" }
        const swapped = captured(sessionId, text)
        if ("ok" in swapped) return { ok: false, error: `sendUserMessage: ${swapped.message}` }
        const result = await actor.handle({ id: ids("command"), clientId: extensionClientId, type: "user.submit", sessionId, text: swapped.text, attachments: [], ...(delivery === "steer" ? { delivery: "steer" as const } : {}) })
        return result.ok ? { ok: true } : { ok: false, error: `sendUserMessage: ${result.message}` }
      },
    }),
    dialogs: { ask: (request) => extensionDialogs.ask(request) },
    flagValues: (sessionId) => sessionFlags(sessionId as SessionId),
    sessionExists: (sessionId) => store.hasSession(sessionId as SessionId),
    now: () => clock.now(),
  })
  const extensionClientId = ids("client")
  /** The extension flags (`--name`, `--name=value`) the CLI invocation of a session passed, kept with the session (`extensions.flags`). */
  const sessionFlags = (sessionId: SessionId): Record<string, string | boolean> | undefined => {
    const stored = store.meta.get(`session.extension-flags:${sessionId}`)
    if (!stored) return undefined
    try { return JSON.parse(stored) as Record<string, string | boolean> } catch { return undefined }
  }
  /** Extension dialogs (`api.ui`): asked as the session's async questions, shown only where a local terminal declared it draws them. */
  const extensionDialogs = createExtensionDialogs({
    canShow: (sessionId) => [...connections].some((connection) => connection.dialogs === true && !connection.remoteAddress && !connection.peer && connection.subscriptions.has(sessionId)),
    turnOf: (sessionId) => actors.get(sessionId)?.snapshot().turnId,
    requestId: () => ids("request"),
    turnId: () => ids("turn"),
    emit: (event) => void sessionSink.append(event),
    mask: (sessionId, text) => secrets.mask(sessionId, text),
  })
  /**
   * Shell command hooks (`hooks.json`): user ones run as configured, project ones only in a directory trusted for project
   * tools. They are read from this machine's folders only; nothing a client sends configures them. `MENDCODE_HOOKS=0` turns them off.
   */
  const shellHooks = createShellHooks({
    layersFor,
    isTrusted: (directory) => {
      const canonical = canonicalDir(directory)
      return (store.settings.get().trustedToolDirs ?? []).some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
    },
    now: () => clock.now(),
    log: logLine,
    mask: (sessionId, text) => secrets.mask(sessionId as SessionId, text),
    enabled: options.shellHooksEnabled ?? process.env.MENDCODE_HOOKS !== "0",
    continueSession: (sessionId, text) => void actorFor(sessionId as SessionId)?.notify(text),
    isChild: (sessionId) => store.tasks.list().some((task) => task.taskId === sessionId) || workflows.execution(sessionId as SessionId) !== undefined || asideSessions.isAside(sessionId as SessionId),
    // `http` hooks reach only URLs the user listed in `allowedHttpHookUrls`; `prompt` hooks use the budgeted completion (native engine only).
    allowedHttpUrls: () => store.settings.get().allowedHttpHookUrls,
    ...(options.complete ? { complete: (request: { system: string; prompt: string; signal: AbortSignal }) => completeBudgeted!(request) } : {}),
  })
  const pluginMetadata = createPluginMetadata(options.dir)
  /** Custom agents (`agents/*.md` of every layer); project ones follow the directory's trust, like custom tools. */
  const agents = createAgentRegistry({
    layers: resourceLayersFor,
    isTrusted: (directory) => {
      const canonical = canonicalDir(directory)
      return (store.settings.get().trustedToolDirs ?? []).some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
    },
    // A child in its own worktree reads agents (and their trust) from its parent's project, as a workflow agent does from its source.
    directoryOf: (sessionId) => workflowContext(sessionId)?.workflow.sourceDirectory ?? store.sessionDirectory((store.meta.get(`session.fanout.owner:${sessionId}`) || (store.tasks.list().find((task) => task.taskId === sessionId && task.worktree)?.parentId ?? sessionId)) as SessionId),
    selected: (sessionId) => livePermission(sessionId) === "plan" ? "plan" : store.sessionAgent(sessionId),
    planExitAgent: () => store.settings.get().plan_exit_agent ?? store.settings.get().planExitAgent,
    settings: () => store.settings.get(),
    modelExists: (id) => (options.models?.list() ?? []).some((model) => model.id === id),
    select: (sessionId, name) => store.setSessionAgent(sessionId, name === "build" ? undefined : name),
    isChild: (sessionId) => store.tasks.list().some((task) => task.taskId === sessionId) || workflows.execution(sessionId) !== undefined || asideSessions.isAside(sessionId),
  })
  /** Pre-change copies of the files a turn's write/edit/apply_patch calls touch, so `session.undo` can put them back. */
  const snapshots = createTurnSnapshots({ store })
  const mflowHooks = createMflowHooks({
    service: mflow,
    inner: withShellHooks(createEngineHooks(manager), shellHooks),
    alive: (sessionId, turnId) => { const snapshot = actors.get(sessionId as SessionId)?.snapshot(); return snapshot?.turnId === turnId && !snapshot.stopping },
    onWait: (sessionId, wait) => globalSink.append({ type: "mflow.waiting", sessionId: sessionId as SessionId, file: wait?.file ?? null, deadlineAt: wait?.deadlineAt ?? null }),
    cancel: (sessionId) => {
      const actor = actors.get(sessionId as SessionId), turnId = actor?.snapshot().turnId
      if (actor && turnId) void actor.handle({ id: ids("command"), clientId: ids("client"), type: "turn.cancel", sessionId: sessionId as SessionId, turnId })
    },
  })
  const extensions: EngineExtensions = Object.assign(manager, { hooks: withTurnSnapshots(mflowHooks.hooks, snapshots), prompts: createPromptFiles({ layersFor, enabled: extensionsEnabled }), reload: (directory: string) => uiReload.reload(directory) })

  const asides = createAsideStore(options.dir)
  /** `/btw`: a hidden child session per main session, running the read-only agent on the aside model (docs/btw.md). */
  const asideSessions = createAsideSessions({
    meta: store.meta,
    hasSession: (id) => store.hasSession(id),
    directory: (id) => store.sessionDirectory(id),
    create(main, directory) {
      const side = ids("session")
      store.createSession({ id: side, directory, title: "btw", parentId: main })
      store.secrets.copy(main, side)
      store.setSessionAgent(side, ASIDE_AGENT)
      return side
    },
    model(main, side) {
      if (!catalog.selectable) return undefined
      // The aside role (then `small`, then the session's model); a role never resolves to a Claude Code model, which runs whole sessions only.
      const choice = resolveModel({ role: "aside", session: store.sessionModel(main), roles: rolesFor(store.settings.get(), store.sessionDirectory(main)), catalog })
      store.setSessionModel(side, choice)
      return catalogModel(catalog, choice.model)?.name ?? choice.model
    },
    transcript(main, afterSeq) {
      const last = store.lastSeq(main) ?? 0
      const events = visibleEvents(store.readAfter(main, Math.max(afterSeq, last - 4_000), 4_000))
      // What is still being written is sent again, finished, with the next question.
      const open = new Map<string, number>()
      for (const event of events) {
        if (event.type === "item.started") open.set(event.itemId, event.seq)
        else if (event.type === "item.completed") open.delete(event.itemId)
      }
      return { text: asideTranscript(events), seq: open.size ? Math.min(...open.values()) - 1 : last }
    },
    permission: (main) => capPermission(livePermission(main), agents.port().primary(main)?.permission),
    async submit(side, text, mode) {
      const actor = actorFor(side)
      if (!actor) throw new Error("side session is gone")
      await actor.handle({ id: ids("command"), clientId: taskClientId, type: "session.permission.set", sessionId: side, mode })
      const result = await actor.handle({ id: ids("command"), clientId: taskClientId, type: "user.submit", sessionId: side, text, attachments: [] })
      if (!result.ok) throw new Error(result.message)
    },
    async cancel(side) {
      const turnId = actors.get(side)?.snapshot().turnId
      if (turnId) await actorFor(side)!.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId: side, turnId })
    },
    deny(side, requestId, reason) {
      void actorFor(side)?.handle({ id: ids("command"), clientId: taskClientId, type: "request.resolve", sessionId: side, requestId, decision: { kind: "deny", reason } })
    },
    remove: (side) => void removeSession(side),
    removeLater(side) {
      // The turn that just ended may still hold its actor for a moment: the side session goes once it is free.
      let tries = 0
      const attempt = () => { if (!stopped && removeSession(side) === "busy" && ++tries < 50) setTimeout(attempt, 100).unref?.() }
      setTimeout(attempt, 0).unref?.()
    },
    thread: (main) => asides.get(main),
    save(main, thread, persist) {
      asides.set(main, thread, persist)
      publishAside(main, thread)
    },
    redact: (text) => redactSecrets(text).text,
  })

  /** "Approve for this session" grants: the engine reads them, `permissions.list` and `permissions.revoke` manage them. */
  const grants = createGrantStore(() => clock.now(), store.permissionRecords)
  /** Per-session permission rules set through REST `permission`: the engine reads them, they die with the session. */
  const sessionPermissions = createSessionPermissionRules({ dir: options.dir, parentOf: (id) => store.sessionInfo(id)?.parentId as SessionId | undefined })

  // globalSink is declared below; the engine only calls emitGlobal after startup, so the closure is safe.
  const skills = createSkillLoader({ userDir: options.dir, layers: resourceLayersFor, paths: (directory) => projectSources(directory, store.settings.get()).skills, enabled: (directory, name) => !(store.settings.get().disabledSkills?.[canonicalDir(directory)] ?? []).includes(name) })
  /**
   * Command files plus the enabled skills the user can run as `/name`; built-in and custom commands win a name clash and the clash is reported.
   * What ships with MendCode itself (the `builtin` package's skills) stays out of the slash menu: the model and `/skills` reach it, the menu keeps its fixed built-in list.
   */
  const slashSkills = (directory: string) => skills.list(directory).filter((skill) => skill.pkg !== BUILTIN_PACKAGE && skills.enabled(directory, skill.name))
  const loadCustomCommands = (input: Parameters<typeof loadCommandFiles>[0]) => loadCommandFiles({ ...input, skills: slashSkills(input.directory) })
  /**
   * What `/doctor` prints about skills, commands and agents: names another layer overrides, entries a cap left out, fields
   * no loader reads, fields read but not applied, and files that failed. One line per finding, in the same words everywhere.
   */
  const resourceChecks = async (directory: string): Promise<Array<{ name: string; ok: boolean; detail: string }>> => {
    const commandReport = emptyDiagnostics()
    await loadCommandFiles({ directory, userDir: options.dir, layers: resourceLayersFor(directory), skills: slashSkills(directory), report: commandReport })
    const agentReport = agents.report({ directory })
    const agentFindings: ResourceDiagnostics = { ...emptyDiagnostics(), overridden: agentReport.overridden ?? [], problems: agentReport.problems }
    const all: Array<[string, ResourceDiagnostics]> = [["skills", skills.inspect(directory).diagnostics], ["commands", commandReport], ["agents", agentFindings]]
    return all.flatMap(([kind, diagnostics]) => diagnosticLines(diagnostics, 12).map((detail) => ({ name: `${kind} resources`, ok: diagnostics.problems.length === 0 && diagnostics.dropped.length === 0, detail })))
  }
  /** `/name args` of a skill: the skill's text goes in as an argument so shell markers inside it stay inert. */
  const skillInvocation = (directory: string, command: { name: string; skill?: boolean | undefined }, args: string) => {
    const loaded = command.skill ? skills.load(directory, command.name, { user: true }) : undefined
    if (command.skill && !loaded) throw new Error(`skill ${command.name} is not available`)
    return loaded ? skillCommandText({ dir: loaded.skill.dir, body: loaded.body }, args) : undefined
  }
  const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: options.info?.model ?? "engine default" } }
  const modelResolutions = createModelResolutions(options.dir)
  const providerAuth =options.providerAuth ?? createProviderAuth({ dir: options.dir, providers: options.providers })
  const aiConfig = createAIConfigService({ dir: options.dir, catalog, resolve: modelResolutions.apply, settings: () => store.settings.get(), engine: options.info?.engine ?? "unknown", sessionDirectory: (sessionId) => store.sessionDirectory(sessionId), now: () => clock.now(), ...(options.providers ? { providers: () => options.providers!.list(true) } : {}) })
  const budgets = createBudgets({ dir: options.dir, settings: () => store.settings.get(), seed: () => store.usageDaily({ from: "0000-01-01", to: "9999-12-31" }).reduce((sum, row) => ({ costMicros: sum.costMicros + row.costMicros, knownCalls: sum.knownCalls + row.calls - row.costUnknownCalls, unknownCalls: sum.unknownCalls + row.costUnknownCalls }), { costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
  let petGenerator: ReturnType<typeof import("./pet-generator").createPetGenerator> | undefined
  const reasoning = createReasoningService({ safeMode: options.safeMode === true, dir: options.dir, store, catalog, engine: options.info?.engine ?? "unknown", budget: budgets, ...(options.reasoningEvaluator ? { evaluator: options.reasoningEvaluator } : {}) })
  const setup = createSetupService({ dir: options.dir, store, catalog, engine: options.info?.engine ?? "unknown", complete: Boolean(options.complete || options.setupComplete), budgets, prompt: (directory) => promptModes.status(directory), ...(options.info?.login ? { login: options.info.login } : {}), ...(options.providers?.inventory ? { inventory: () => options.providers!.inventory!() } : {}) })
  const setupCalls = new Set<AbortController>()
  const completeBudgeted: DaemonOptions["complete"] = options.complete ? async (request) => {
    const model = request.model ?? catalog.defaults
    await budgets.guard({ model: model.model, signal: request.signal })
    try {
      const answer = options.setupComplete ? await options.setupComplete(request) : { text: await options.complete!(request) }
      budgets.record(answer.usage)
      return answer.text
    } catch (error) { budgets.record(); throw error }
  } : undefined
  const extractBudgeted: DaemonOptions["extractMemory"] = options.extractMemory ? async (job, signal) => {
    const model = resolveModel({ role: "memoryExtractor", roles: rolesFor(store.settings.get(), job.directory), catalog })
    await budgets.guard({ model: model.model, signal })
    let usage: BudgetUsage | undefined
    try { return await options.extractMemory!(job, signal, (value) => { usage = value }) }
    finally { budgets.record(usage) }
  } : undefined
  const debug = createDebug({ options, store, agents, extensions: manager, customTools, skills, id: () => ids("session"), paths: (directory) => systemReport("config-paths", { dir: options.dir, directory, socketPath: options.socketPath, engine: options.info?.engine ?? "unknown", settings: store.settings.get(), catalog }).facts.paths })
  const taskClientId = ids("client")
  const sessionBackground = createSessionBackground({
    store, now: () => clock.now(), mask: (sessionId, text) => secrets.mask(sessionId, text),
    changed: (sessionId) => { globalSink.append({ type: "session.background.changed", sessionId }) },
    metadataChanged: (sessionId) => { globalSink.append({ type: "agent-commands.changed", sourceSessionId: sessionId, targetSessionId: sessionId }) },
  })
  const ownerWake = createTaskOwnerWake({ store, mask: (sessionId, text) => secrets.mask(sessionId, text), notify: async (sessionId, text, queueId) => actorFor(sessionId)?.notify(text, queueId, true), state: (sessionId) => {
    const actor = actorFor(sessionId)?.snapshot()
    return actor?.held && store.lastTurnStatus(sessionId) === "cancelled" ? "cancelled" : actor?.turnId || actor?.held || actor?.paused || actor?.pendingRequests || actor?.queue.length ? "busy" : "ready"
  } })
  root.onDispose(ownerWake.stop)
  const compoundCalls = new Map<SessionId, CompoundCall>()
  let threadBridge: ReturnType<typeof import("./thread-mcp")["createThreadMcp"]> | undefined
  // MendCode's native tools for a Claude Code session (`harness_tools`): no listener until such a session starts a process.
  const hostBridge = createHostMcp({
    enabled: () => !options.safeMode && featureOn(store.settings.get(), "harness_tools"),
    directory: (sessionId) => store.sessionDirectory(sessionId),
    tools: async (input) => (await rawEngine.hostTools?.(input)) ?? [],
    call: async (input) => (await rawEngine.hostCall?.(input)) ?? { output: "Native tools are unavailable", isError: true },
    ...(options.hostMcpListener ? { listen: options.hostMcpListener } : {}),
  })
  const tasks = createChildTasks({
    store, now: () => clock.now(), id: () => ids("session"),
    queueId: () => ids("queue"), wake: () => ownerWake.schedule(),
    changed: (task) => { globalSink.append({ type: "task.changed", sessionId: task.taskId, parentId: task.parentId }); mentionRouting.settled(task) },
    isolation: {
      refused: (parent) => options.safeMode ? "is off in safe mode" : !featureOn(store.settings.get(), "task_worktree") ? "needs the full tier (task_worktree)" : livePermission(parent) === "plan" ? "is not available in plan mode" : undefined,
      worktrees: createTaskWorktrees({ dir: options.dir, merge: createWorkflowMerge({ dir: options.dir }) }),
    },
    background: (task) => { sessionBackground.register(task.taskId, { state: task.state === "running" ? "working" : task.state === "cancelled" || task.state === "interrupted" ? "stopped" : task.state, summary: task.result.slice(0, 4000) }) },
    agent: (parent, name, command) => command ? !agents.selectable(store.sessionDirectory(parent)!, name, true) : agents.port().subagents(store.sessionDirectory(parent)!).some((agent) => agent.name === name),
    permission: (parent) => capPermission(livePermission(parent), agents.port().primary(parent)?.permission),
    model: (parent, input) => {
      const previous = input.task_id ? store.sessionModel(input.task_id) : undefined
      const hash = input.model?.lastIndexOf("#") ?? -1
      const shorthand = hash > 0 ? input.model!.slice(hash + 1) : undefined
      if (shorthand && input.variant && shorthand !== input.variant) throw new Error("conflicting task variants")
      let raw = hash > 0 ? input.model!.slice(0, hash) : input.model
      // A model named without its provider (`gpt-6.1-terra`) is the one catalog id it can only mean.
      if (raw) raw = catalogId(catalog, raw) ?? raw
      if (input.engine) {
        if (store.meta.get(`session.local-tools.restricted:${parent}`) === "true") throw new Error("cross-engine delegation is local only")
        if (options.safeMode || store.settings.get().tier !== "full" || !featureOn(store.settings.get(), "subagents")) throw new Error("cross-engine delegation needs the full tier")
        const engineOf = (model: ModelChoice) => modelEngine(model, catalog) ?? (model.model.startsWith("acp:") ? acpAgentKey(model.model) : "native")
        raw ??= previous?.model
        // Another engine is never given a model it was not asked for; the error names that engine's ids so the next call can be exact.
        const ofEngine = catalog.list(true).filter((model) => engineOf({ model: model.id }) === input.engine).map((model) => model.id)
        if (!raw) throw new Error(ofEngine.length ? `engine delegation needs an exact model; ${input.engine} models: ${ofEngine.slice(0, 6).join(", ")}` : `no ${input.engine} model is configured: ${input.engine === "native" ? "connect a provider in /connect" : `${input.engine} must be installed and signed in`} (\`mendcode models\` lists the ids)`)
        if (engineOf({ model: raw }) !== input.engine) throw new Error(`model ${raw} does not run on the ${input.engine} engine${ofEngine.length ? `; its models: ${ofEngine.slice(0, 6).join(", ")}` : ""}`)
      }
      const agent = agents.port().subagents(store.sessionDirectory(parent)!).find((agent) => agent.name === (input.agent ?? (input.task_id ? store.sessionAgent(input.task_id) : "general")))
      if (input.engine && input.engine !== "native" && agent && (agent.tools || agent.deny?.some((tool) => tool !== "todo") || agent.permissionRules?.length)) throw new Error("external child engines cannot enforce this agent's tool/path rules; choose general or native")
      const fallback = previous ?? resolveModel({ role: "subagent", session: store.sessionModel(parent), roles: rolesFor(store.settings.get(), store.sessionDirectory(parent)), catalog, cheapSubagent: featureOn(store.settings.get(), "cheap_subagents", { safeMode: options.safeMode }) })
      const variant = input.variant ?? shorthand ?? (!raw && !previous ? agent?.model ? agent.variant : store.settings.get().subagent_variant : undefined)
      const choice = { ...(raw ? { model: raw } : !previous && agent?.model ? { model: agent.model } : fallback), ...(variant ? { variant } : {}), ...(!variant && !raw && !previous && agent?.effort ? { effort: agent.effort } : {}) }
      if (!catalog.selectable && !raw && !variant && !agent?.model && !agent?.effort) return previous
      const problem = invalidChoice(choice, catalog, input.engine ? "main" : "subagent")
      // The model that asked gets the ids it probably meant, so its next call can be right.
      const near = problem?.startsWith("unknown model") ? nearModels(catalog, choice.model) : []
      if (problem) throw new Error(near.length ? `${problem}; use an exact id such as ${near.join(", ")}` : `${problem}; \`mendcode models\` lists the ids`)
      return choice
    },
    describe: (parent, model) => {
      const settings = store.settings.get()
      const choice = usableEffort(model ?? resolveModel({ role: "subagent", session: store.sessionModel(parent), roles: rolesFor(settings, store.sessionDirectory(parent)), catalog, cheapSubagent: featureOn(settings, "cheap_subagents", { safeMode: options.safeMode }) }), catalog)
      const info = catalogModel(catalog, choice.model)
      const engine = info?.engine ?? (choice.model.startsWith("acp:") ? acpAgentKey(choice.model) : "native")
      // The same conditions the engines apply: the built-in OpenAI host (providers.ts), Codex's fast tier, Claude Code's fast mode on Opus (main.ts).
      const fast = (store.sessionModel(parent)?.fast ?? settings.serviceTier === "fast") && ((engine === "native" && info?.provider === "openai") || engine === "codex" || (engine === "claude" && claudeFastModel(claudeAlias(choice).model)))
      return { model: choice.model, ...(info?.name ? { name: info.name.slice(0, 160) } : {}), ...(info?.provider ? { provider: info.provider } : {}), engine, ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.variant ? { variant: choice.variant } : {}), ...(fast ? { fast: true } : {}) }
    },
    submit: async (sessionId, text, mode, command) => {
      const actor = actorFor(sessionId)!
      const safe = captured(sessionId, text)
      if ("ok" in safe) throw new Error(safe.message)
      await actor.handle({ id: ids("command"), clientId: taskClientId, type: "session.permission.set", sessionId, mode })
      const display = command ? captured(sessionId, command.displayText) : undefined
      if (display && "ok" in display) throw new Error(display.message)
      const result = await actor.handle({ id: ids("command"), clientId: taskClientId, type: "user.submit", sessionId, text: safe.text, attachments: command?.attachments ?? [], ...(display ? { displayText: display.text } : {}) }, display?.text)
      if (!result.ok) throw new Error(result.message)
    },
    cancel: async (sessionId) => {
      const turnId = actors.get(sessionId)?.snapshot().turnId
      if (turnId) await actorFor(sessionId)!.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId, turnId })
    },
  })
  /** `@name message` to a child this session already has: it continues that child (docs/agents.md, "`@agent` mentions"). */
  const mentionRouting = createMentionRouting({
    children: (parentId) => tasks.list(parentId),
    task: (taskId) => store.tasks.list().find((task) => task.taskId === taskId),
    file: path.join(options.dir, "agent-mentions.json"),
    resume: (parentId, task, prompt) => tasks.port.run(parentId, { description: task.description, prompt, task_id: task.taskId, background: true }, new AbortController().signal),
    failed: (parentId, task, message) => void actorFor(parentId)?.notify(secrets.mask(parentId, `A message for @${task.agent} (task ${task.taskId}) could not be sent when it finished: ${message}`)),
  })
  const recall = createSessionRecall(store)
  const computer = createComputerControl(store, options.dir, { ...options.computer, enabled: computerOn })
  const browser = createBrowserControl({ ...options.browser, hasSession: (sessionId) => store.hasSession(sessionId as SessionId) })

  /** Inline shell of custom commands: held here, run by the engine as `shell` tool calls of the turn (docs/commands.md). */
  const inlineShells = createInlineShellTable()
  const commandExecution = createCommandExecution({
    catalog,
    ...(options.info?.engine ? { engine: options.info.engine } : {}),
    inlineShell: (command) => inlineShells.hold(command),
    prompt: async (input) => {
      if (!options.mcp?.getPrompt && !options.mcp?.getPromptResult) throw new Error("MCP prompts are unavailable")
      const result = await (options.mcp.getPromptResult?.(input) ?? options.mcp.getPrompt!(input))
      return typeof result === "string" ? result : commandPromptText(result)
    },
  })
  const continuity = createContinuity({ store, now: () => clock.now(), requestId: () => ids("request"), emit: (event) => void sessionSink.append(event), mask: (sessionId, text) => secrets.mask(sessionId, text), notify: async (record, text) => actorFor(record.sessionId)?.notify(text) })
  const rawEngine = options.engine({
    notify: (sessionId, text) => void actorFor(sessionId)?.notify(secrets.mask(sessionId, text)),
    engineAgentEvent: (sessionId, turnId, event) => actorFor(sessionId)?.agentEvent(turnId, event),
    engineBackground: (sessionId, tasks, stop) => {
      const before = new Map((engineTasks.get(sessionId) ?? []).map((task) => [task.id, task.startedAt]))
      if (tasks.length) engineTasks.set(sessionId, tasks.map((task) => ({ ...task, startedAt: before.get(task.id) ?? clock.now() })))
      else engineTasks.delete(sessionId)
      if (tasks.length && stop) engineTaskStops.set(sessionId, stop)
      else engineTaskStops.delete(sessionId)
      globalSink.append({ type: "session.background.changed", sessionId })
    },
    continuity: continuity.forSession,
    compound: (sessionId) => compoundCalls.get(sessionId),
    reasoning: reasoning.port,
    budget: budgets,
    trace,
    // A side session (`/btw`) runs as a child: its agent's tools and model, no orientation, no recall.
    tasks: { ...tasks.modelPort, isChild: (sessionId) => tasks.modelPort.isChild(sessionId) || asideSessions.isAside(sessionId) },
    clock,
    store,
    grants,
    runLimits,
    sessionRules: sessionPermissions.effective,
    customTools,
    skills,
    extensions,
    secrets,
    extensionLayers: layersFor,
    agents: agents.port(),
    plans: { latest: (sessionId) => readPlanReviews(store, sessionId, 1)[0] },
    background: (sessionId) => background.forSession(sessionId),
    interactive: (sessionId) => interactive.forSession(sessionId),
    // The host is built below; tools only call this during turns, after startup.
    workflows: (sessionId) => workflows.port(sessionId, store.sessionInfo(sessionId)?.directory ?? process.cwd()),
    peers: (sessionId) => peers.port(sessionId),
    threads: (sessionId) => threads.port(sessionId),
    packages: selfPackages,
    sessionMeta: (sessionId) => async (request) => {
      if (!featureOn(store.settings.get(), "session_meta", { safeMode: options.safeMode }) || store.meta.get(`session.local-tools.restricted:${sessionId}`) === "true") throw new Error("Session metadata is disabled or local only")
      if (request.action === "settle") return lifecycle.requestSettle(sessionId, request.reason)
      return lifecycle.run(sessionId, request)
    },
    recall: (sessionId) => recall.port(sessionId),
    computer: (sessionId) => computer.port(sessionId),
    harness: { args: (sessionId) => hostBridge.args(sessionId), servers: (sessionId) => hostBridge.servers(sessionId), waiting: () => hostBridge.waiting(), instructions: (sessionId) => hostBridge.instructions(sessionId) },
    settingsWrite: (patch) => writeSettings(patch),
    browser: (sessionId) => {
      const port = browser.port(sessionId)
      return { run: async (request, signal) => store.meta.get(`session.local-tools.restricted:${sessionId}`) === "true" && ["tabs", "open_tab", "select_tab", "close_tab"].includes(request.action)
        ? { ok: false as const, error: "Browser tab control is local only" }
        : port.run(request, signal) }
    },
    review: (sessionId) => reviews.port(sessionId),
    // Built below with the loop service; tools only call this during turns.
    loops: (sessionId) => createLoopPort({ directory: store.sessionInfo(sessionId)?.directory ?? process.cwd(), service: loops, create: createLoop }),
    // The project service is built on first use; the `worktree` tool only calls this during turns.
    worktrees: (sessionId) => worktreePort(sessionId),
    prWatch: (sessionId) => prWatch.port(sessionId),
    // Built below with the goal service; the goal tools only call this during turns.
    goals: (sessionId) => goals.port(sessionId),
    aiConfig: (sessionId) => aiConfig.port(sessionId),
    inlineShell: (text) => inlineShells.find(text),
    emitGlobal: (event) => void globalSink.append(event),
    memory: {
      request: (directory, input) => modelMemory.request(directory, input),
      saved: (directory) => store.memories.list({ directory, status: "saved", profile: profileOf(store.settings.get(), directory) }),
      visible: ({ directory, sessionId }) => store.memories.list({ directory, status: "saved", profile: profileOf(store.settings.get(), directory), ...(sessionId ? { session: sessionId } : {}) }),
      related: ({ directory, sessionId, prompt, limit }) => store.memories.related({ text: prompt, directory, limit, profile: profileOf(store.settings.get(), directory), ...(sessionId ? { session: sessionId } : {}) }),
      links: (memoryIds) => store.memories.links(memoryIds),
      propose: (entry) => proposeMemory(entry),
      graph: (directory) => graphFor(directory),
      link: (input) => linkMemories(input),
    },
  })

  /** The engine that runs a model's turns, as the handoff records it: the daemon's own ("native"), "claude", "pi" or "acp:<agent>"; undefined where the engine cannot be switched (Codex, faux). */
  const engineKeyOf = (model: ModelChoice, models: ModelCatalog = catalog) => (modelEngine(model, models) ?? (model.model.startsWith("acp:") ? acpAgentKey(model.model) : options.info?.engine === "native" ? "native" : undefined))
  // Saved optional-engine choices must not fall through to native calls. OpenCode Zen is a separate, catalogued provider.
  const retiredEngineChoice = (model: ModelChoice) => ["opencode", "cursor"].includes(model.model.split(":")[0]!) && !catalog.list().some((entry) => entry.id === model.model && !entry.engine)
  /** Half of where the native engine packs this model: what it takes of another engine's conversation, so the next call has room. */
  const rebuildBudget = (choice: ModelChoice) => {
    const info = catalog.list().find((entry) => entry.id === choice.model)
    const settings = store.settings.get()
    const at = (info ? modelCompactAt({ model: info, providers: options.providers?.list(true) ?? [], settings }) : undefined) ?? settings.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS
    return Math.floor(at / 2)
  }
  /**
   * The conversation another engine ran, appended to the native history as its own messages (docs/sessions.md, "Engine
   * switch"). Done when the session moves to the native engine, outside any turn, so the next turn's undo mark includes it;
   * a session that moved before this existed gets it at its next turn or `/compact`.
   */
  const importForeign = (sessionId: SessionId, choice: ModelChoice, untilTurnId?: string) => {
    if (options.info?.engine !== "native" || engineKeyOf(choice) !== "native") return undefined
    const rebuilt = portable.rebuild({ sessionId, untilTurnId, budgetTokens: rebuildBudget(choice), to: choice.model, write: true })
    if (rebuilt) store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), ...rebuilt.messages])
    return rebuilt
  }
  const retiredEngineError = { status: "error" as const, code: "engine_unavailable", message: "[DAEMON]: optional engine removed; select an available model or use a portable handoff" }

  /** The text and the other attachments of a message whose `text/plain` attachments are put back in where their labels stand. */
  function withPastedTexts(input: { text: string; attachments: BlobRef[] }): { text: string; attachments: BlobRef[] } {
    const texts = new Map<number, string>()
    input.attachments.forEach((ref, index) => {
      if (ref.mime !== "text/plain") return
      try { texts.set(index, pastedText(store.readBlob(ref.sha256))) } catch { texts.set(index, "\n[a pasted text is no longer available]\n") }
    })
    const inlined = inlineTexts(input.text, input.attachments, texts)
    return { text: inlined.text, attachments: inlined.refs }
  }

  const engine: typeof rawEngine = {
    ...rawEngine,
    async runTurn(turn) {
      // A system continuation must not acquire tools its paused peer turn could not call, including after restart.
      const restrictionKey = `session.local-tools.restricted:${turn.sessionId}`
      if (turn.authority?.synthetic) {
        const turnOptions = continuationTurnOptions(turn.turnOptions, store.meta.get(restrictionKey) === "true")
        if (turnOptions) turn = { ...turn, turnOptions }
      } else {
        const excluded = turn.turnOptions?.excludeTools ?? []
        store.meta.set(restrictionKey, String(excluded.includes("threads") && excluded.includes("pr_watch")))
      }
      const model = turn.selection?.model ?? resolveModel({ role: "main", session: store.sessionModel(turn.sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(turn.sessionId)), catalog })
      if (retiredEngineChoice(model)) return retiredEngineError
      // Only the native engine runs a command's inline shell through its own permission pipeline; no other engine may see a marker as an approved command.
      if (inlineShells.find(turn.text).length && (options.info?.engine !== "native" || modelEngine(model, catalog) || model.model.startsWith("acp:"))) return { status: "error", code: "unsupported", message: "[DAEMON]: inline shell in commands needs the native engine and a native model" }
      if (turn.turnOptions && Object.keys(turn.turnOptions).length) {
        // The model may have changed since the prompt was queued; an engine that cannot honour the options refuses rather than ignores them.
        if (options.info?.engine !== "native" || modelEngine(model, catalog) || model.model.startsWith("acp:")) {
          const excluded = turn.turnOptions.excludeTools ?? []
          // This exact restriction is enforced here, not delegated to the outside engine. It also survives synthetic wakes.
          const localPolicyOnly = Object.keys(turn.turnOptions).every((key) => key === "excludeTools") && excluded.every((key) => remoteTurnOptions().excludeTools!.includes(key)) && excluded.includes("threads") && excluded.includes("pr_watch")
          if (!localPolicyOnly) return { status: "error", code: "unsupported", message: "[DAEMON]: per-prompt options need the native engine" }
          turn = { ...turn, turnOptions: undefined }
        }
        // A message recorded without a reply calls no model, so no budget applies.
        if (turn.turnOptions?.noReply) return rawEngine.runTurn(turn)
      }
      try {
        const report = budgets.report(model.model)
        if (report.enforcement.blockers.length) throw new Error(report.enforcement.blockers.join("; "))
      } catch (error) { return { status: "error", code: "budget", message: (error as Error).message } }
      // Native requests check again before every call, including retries and compaction.
      if (options.info?.engine !== "native" || modelEngine(model, catalog) || model.model.startsWith("acp:")) {
        try { await budgets.guard({ model: model.model, signal: turn.signal, ask: turn.ask }) }
        catch (error) { return { status: "error", code: "budget", message: (error as Error).message } }
      }
      // The conversation this engine did not run (the session moved between native, Claude Code and ACP agents, a fork
      // started on one, a fork was merged back) goes in front of the message as budgeted context (docs/sessions.md).
      const external = Boolean(modelEngine(model, catalog)) || model.model.startsWith("acp:")
      // A long paste kept as a text attachment goes back into the message for an engine that reads it as text, here and in
      // every message it takes mid-turn; the native engine reads it from the attachment itself.
      if (external) {
        const takeQueued = turn.takeQueued
        turn = { ...turn, ...withPastedTexts(turn), ...(takeQueued ? { takeQueued: async () => { const queued = await takeQueued(); return queued ? { ...queued, ...withPastedTexts(queued) } : undefined } } : {}) }
      }
      if (!external) importForeign(turn.sessionId, model, turn.turnId)
      const carried = portable.prepare({ sessionId: turn.sessionId, turnId: turn.turnId, key: engineKeyOf(model) })
      // An engine of another program (Claude Code, an ACP agent) takes the agent override as a permission ceiling and instructions.
      const profile = agents.port().primary(turn.sessionId, turn.selection?.agent)
      const routed = withHandoff(external ? withExternalAgent(turn, profile) : turn, carried.blocks)
      const key = model.model.startsWith("acp:") ? acpAgentKey(model.model) as `acp:${string}` : modelEngine(model, catalog) ?? options.info?.engine
      let lease: ReturnType<NonNullable<typeof threadBridge>["open"]> | undefined
      try {
        if ((key === "claude" || key === "codex" || key?.startsWith("acp:")) && threadMcpEnabled(store.settings.get(), key as BridgeEngine, options.safeMode)) {
          const bridgeKey = key as BridgeEngine
          const module = await import("./thread-mcp")
          const { createOrchestrationReceipts } = await import("./orchestration-receipts")
          const { bridgeAuthorizer } = await import("./thread-mcp-approval")
          threadBridge ??= module.createThreadMcp({ clock, ...(options.threadMcpListener ? { listen: options.threadMcpListener } : {}) })
          const directory = store.sessionDirectory(turn.sessionId)!
          const allowed = () => !turn.signal.aborted && threadMcpEnabled(store.settings.get(), bridgeKey, options.safeMode) && store.sessionDirectory(turn.sessionId) === directory && store.meta.get(restrictionKey) !== "true"
          if (allowed()) lease = threadBridge.open({
            engine: bridgeKey, turn: routed, allowed, threads: threads.port(turn.sessionId),
            receipts: { project: directory, run: createOrchestrationReceipts(store.meta).run },
            authorize: bridgeAuthorizer({ turn: routed, directory, settings: () => store.settings.get(), profile: () => agents.port().primary(turn.sessionId, turn.selection?.agent), sessionRules: () => sessionPermissions.effective(turn.sessionId), allowed, mask: (text) => secrets.mask(turn.sessionId, text) }),
            create: async (title) => {
              const id = ids("session")
              const safe = captured(turn.sessionId, title)
              if ("ok" in safe) return { ok: false, message: safe.message }
              try { tasks.admitIdle(turn.sessionId, id) }
              catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Child admission denied" } }
              store.createSession({ id, directory, title: safe.text, parentId: turn.sessionId })
              store.setSessionModel(id, model)
              announceSession(id, directory, turn.sessionId)
              await actorFor(id)!.handle({ id: ids("command"), clientId: taskClientId, type: "session.permission.set", sessionId: id, mode: routed.permissionMode() })
              globalSink.append({ type: "task.changed", sessionId: id, parentId: turn.sessionId })
              return { ok: true, output: `sessionId=${id} state=idle` }
            },
            delegate: async (args, signal) => {
              const safe = captured(turn.sessionId, args.prompt)
              if ("ok" in safe) return { ok: false, message: safe.message }
              const description = captured(turn.sessionId, args.description)
              if ("ok" in description) return { ok: false, message: description.message }
              const task = await tasks.port.run(turn.sessionId, { ...args, description: description.text, prompt: safe.text }, signal)
              return { ok: true, output: `task_id: ${task.taskId}\nstate: ${task.state}\n${secrets.mask(task.taskId, task.result)}` }
            },
          })
          if (lease) routed.externalMcp = { args: lease.args, servers: lease.servers, cwd: directory, scrub: lease.scrub, waiting: lease.waiting, stream: lease.stream }
        }
        // Calls Claude Code or an ACP agent makes to MendCode's tools during this turn run as calls of this turn.
        const leave = key === "claude" || key?.startsWith("acp:") ? hostBridge.enter(routed) : undefined
        const outcome = await rawEngine.runTurn(routed).finally(() => leave?.())
        if (outcome.status === "ok") carried.commit()
        return outcome.status === "error" && lease ? { ...outcome, message: lease.scrub(outcome.message) } : outcome
      } catch (error) {
        if (lease) throw new Error(lease.scrub(error instanceof Error ? error.message : String(error)))
        throw error
      } finally { lease?.release() }
    },
    async compact(turn) {
      const selected = turn.selection?.model ?? resolveModel({ role: "main", session: store.sessionModel(turn.sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(turn.sessionId)), catalog })
      if (retiredEngineChoice(selected)) return retiredEngineError
      if (options.info?.engine !== "native") {
        const model = resolveModel({ role: "compaction", roles: rolesFor(store.settings.get(), store.sessionDirectory(turn.sessionId)), catalog })
        try { await budgets.guard({ model: model.model, signal: turn.signal }) }
        catch (error) { return { status: "error", code: "budget", message: (error as Error).message } }
      }
      const outcome = await rawEngine.compact(turn)
      if (outcome.status !== "ok" || !outcome.empty) return outcome
      // Nothing of its own yet after an engine switch: the other engine's conversation becomes its history, then packs like any.
      if (importForeign(turn.sessionId, selected)) return rawEngine.compact(turn)
      const key = engineKeyOf(selected)
      const handoff = key ? portable.preview({ sessionId: turn.sessionId, key }) : undefined
      return handoff ? { ...outcome, note: handoffNote(handoff, selected.model) } : outcome
    },
  }

  function send(connection: Connection, frame: Frame) {
    // The whole settings object (proxy URL credentials, provider parameters) is not for a read-only peer; `settings.get` is denied to it as well.
    if (connection.peer?.readOnly && frame.kind === "global" && frame.body.type === "settings.changed") return
    // A read-only token cannot read drafts (`draft.get`, `draft.list`), so it does not hear of one in an activity push either.
    if (connection.peer?.readOnly && frame.kind === "global" && frame.body.type === "session.activity" && frame.body.draft !== undefined) {
      const { draft: _typed, ...rest } = frame.body
      frame = { ...frame, body: rest }
    }
    if (connection.response) return connection.response(frame)
    const bytes = encoder.encode(encodeFrame(frame))
    connection.pending.push(bytes)
    connection.backlog += bytes.byteLength
    flush(connection)
    if (connection.backlog > MAX_CLIENT_BACKLOG_BYTES) connection.socket.end()
  }

  /** Loops and workflows observe every session event (a map lookup per event each). */
  let extractedNotices: MemoryEntry[] = []
  const extraction = createMemoryExtraction({
    store, now: () => clock.now(), settings: (directory) => memorySettings(store.settings.get(), directory), extract: extractBudgeted,
    commit: (job, memories) => {
      let proposed = 0
      const notices: MemoryEntry[] = []
      extractedNotices = notices
      // What the user asked in this turn: a fact that only restates it is the task, not a durable fact, so it waits for review.
      const asked = job.text.split("\n").filter((line) => line.startsWith("user:")).map((line) => line.slice(5)).join(" ")
      for (const memory of memories.slice(0, 20)) {
        if (!memory.text.trim() || memory.text.length > 2_000) continue
        const entries = store.memories.list({ directory: job.directory, profile: profileOf(store.settings.get(), job.directory) })
        const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
        if (entries.some((entry) => normalized(entry.text) === normalized(memory.text) && entry.status !== "archived")) continue
        const result = proposeMemory({ ...memory, directory: job.directory, forceReview: memorySettings(store.settings.get(), job.directory).memoryRequireApproval !== false || restatesRequest(asked, memory.text) })
        if (result.outcome !== "dropped") proposed++
        if (result.outcome === "saved" && result.memoryId) {
          const written = store.memories.get(result.memoryId as MemoryId)
          if (written) notices.push(written)
        }
      }
      maintainMemory(job.directory)
      return proposed
    },
    settled: (job) => {
      const notices = extractedNotices
      extractedNotices = []
      for (const memory of notices) {
        const itemId = ids("item")
        const notice = { action: "saved" as const, memoryId: memory.memoryId, scope: memory.scope, text: memory.text }
        sessionSink.append({ type: "item.started", sessionId: job.sessionId, turnId: job.turnId, itemId, kind: "artifact" })
        sessionSink.append({ type: "item.completed", sessionId: job.sessionId, itemId, status: "ok", text: memoryNoticeText(notice), meta: memoryNoticeMeta(notice) })
      }
    },
  })
  function maintainMemory(directory?: string) {
    const settings = memorySettings(store.settings.get(), directory)
    const report = memoryMaintenance(store.memories.list({ ...(directory ? { directory } : {}), profile: profileOf(settings, directory) }), settings.memoryMaintenance)
    if (report.policy === "auto-consolidate" && settings.memoryEnabled !== false) for (const duplicate of report.duplicates) {
      store.memories.update(duplicate.memoryId, { status: "archived" })
      globalSink.append({ type: "memory.changed", memoryId: duplicate.memoryId, change: "updated" })
    }
    return report
  }
  const catalogRest = createCatalogRest({
    providers: options.providers, auth: providerAuth, extensions, catalog, engine, mcp: options.mcp, lsp: options.lsp,
    commands: async (directory) => {
      const commands = await loadCustomCommands({ directory, userDir: options.dir, layers: resourceLayersFor(directory), prompts: mcpCommands(options.mcp?.cachedPrompts?.(directory) ?? []), extra: await extensions.commandEntries(directory) })
      const prompts = (await options.mcp?.catalog?.(directory))?.prompts ?? []
      const seen = new Set(commands.map((command) => command.name))
      for (const prompt of prompts) {
        const command = mcpCatalogCommands([prompt])[0]!
        if (!seen.has(command.name)) { commands.push(command); seen.add(command.name) }
      }
      return commands.map(({ body, mcp: _mcp, ...summary }) => ({ ...summary, template: body }))
    },
    changed: (directory, server) => { if (!stopped) globalSink.append({ type: "mcp.changed", directory, server }) },
  })
  extraction.wake()
  const metadata = createSessionMetadata({ store, complete: options.info?.engine === "native" ? options.complete : undefined, settings: () => store.settings.get(), agent: (id, role) => agents.auxiliary(store.sessionDirectory(id)!, role), model: (id, role) => resolveModel({ role, session: store.sessionModel(id), roles: rolesFor(store.settings.get(), store.sessionDirectory(id)), catalog }), changed: (id) => publishActivity(id, actors.get(id)?.snapshot().foreground ?? "idle", true) })
  const sessionObservers: Array<(event: SessionEvent) => void> = [asideSessions.observe, tasks.observe, sessionBackground.observe, ownerWake.observe, extraction.observe, metadata.observe, (event) => { if (event.type === "turn.completed") maintainMemory(store.sessionDirectory(event.sessionId)) }]
  // An engine alias (`claude-opus`) resolves to a concrete id in the first answer's usage; remember it so the next launch names it at once.
  sessionObservers.push((event) => {
    if (event.type !== "usage.recorded") return
    const alias = modelResolutions.aliasOf(event.provider, event.model, catalog.list())
    // The window the engine states for the model it ran replaces the catalog's figure in the next models report.
    if (alias && event.contextWindow) modelResolutions.noteWindow(event.provider, event.model, event.contextWindow)
    // A session pinned to a full id of the family (`claude-haiku-4-5`) says nothing about what the alias means today.
    if (alias && !resolveModel({ role: "main", session: store.sessionModel(event.sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(event.sessionId)), catalog }).model.startsWith(`${alias}-`)) modelResolutions.note(event.provider, alias, event.model)
  })
  const interactions = createInteractions((sessionId) => store.sessionDirectory(sessionId))
  sessionObservers.push(interactions.observe)
  // Idle bridge children are sessions too. Reuse the lineage invalidation event for their turns.
  sessionObservers.push((event) => {
    if (!["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted", "server.request", "server.request.resolved"].includes(event.type)) return
    if (!store.meta.get(`orchestration.lineage:${event.sessionId}`) || tasks.port.isChild(event.sessionId)) return
    const parentId = store.sessionInfo(event.sessionId)?.parentId as SessionId | undefined
    if (parentId) globalSink.append({ type: "task.changed", sessionId: event.sessionId, parentId })
  })

  /** `session.start` for extensions: fire and forget, isolated. */
  function announceSession(sessionId: SessionId, directory: string, parentId?: string) {
    void shellHooks.sessionStart({ sessionId, cwd: directory, source: parentId ? "child" : "startup", ...(parentId ? { parentId } : {}) }).catch(() => {})
    if (!extensionsEnabled) return
    void extensions.fire("session.start", directory, { sessionId, cwd: directory, ...(parentId ? { parentId } : {}) }).catch(() => {})
  }

  /** `turn.start` / `turn.end` for extensions, from the session event log; the queued text is remembered until its turn starts. */
  const queuedText = new Map<string, string>()
  const TURN_ENDS = { "turn.completed": "completed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted", "turn.failed": "failed" } as const
  sessionObservers.push((event) => {
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      // The external `notify` command: a Notification hook whose matcher names `turn_completed` or `turn_failed`.
      const directory = store.sessionInfo(event.sessionId)?.directory
      if (directory) void shellHooks.notification({ sessionId: event.sessionId, cwd: directory, type: event.type === "turn.completed" ? "turn_completed" : "turn_failed", title: event.type === "turn.completed" ? "turn finished" : "turn failed", message: event.type === "turn.failed" ? event.error.message : "" }).catch(() => {})
    }
    if (event.type === "turn.completed") {
      const directory = store.sessionInfo(event.sessionId)?.directory
      if (directory) {
        void shellHooks.stop({ sessionId: event.sessionId, cwd: directory }).catch(() => {})
        void shellHooks.subagentStop({ sessionId: event.sessionId, cwd: directory }).catch(() => {})
      }
    }
    if (event.type === "server.request") {
      // `Notification` hooks: the agent is waiting for the user (an approval or a question).
      const directory = store.sessionInfo(event.sessionId)?.directory
      if (directory) void shellHooks.notification({ sessionId: event.sessionId, cwd: directory, type: event.kind === "approval" ? "permission_prompt" : "question", title: event.title, message: event.detail }).catch(() => {})
    }
    if (!extensionsEnabled) return
    if (event.type === "queue.edited") {
      if (queuedText.has(event.queueId)) queuedText.set(event.queueId, event.text)
      return
    }
    if (event.type === "queue.added") {
      queuedText.set(event.queueId, event.text)
      if (queuedText.size > 500) queuedText.delete(queuedText.keys().next().value!)
      return
    }
    if (event.type !== "turn.started" && !(event.type in TURN_ENDS)) return
    const cwd = store.sessionInfo(event.sessionId)?.directory
    if (!cwd) return
    if (event.type === "turn.started") {
      const text = queuedText.get(event.queueId) ?? ""
      queuedText.delete(event.queueId)
      void extensions.fire("turn.start", cwd, { sessionId: event.sessionId, cwd, turnId: event.turnId, text }).catch(() => {})
    } else if (event.type in TURN_ENDS) void extensions.fire("turn.end", cwd, { sessionId: event.sessionId, cwd, turnId: (event as { turnId: string }).turnId, outcome: TURN_ENDS[event.type as keyof typeof TURN_ENDS] }).catch(() => {})
  })
  /** Footer "today": seeded from the store once, then counted per usage.recorded (see usage-today.ts). */
  const usageWeather = createUsageWeather(options.usageWeather, () => clock.now())
  const usageToday = createUsageToday({
    clock,
    seed: (() => {
      const day = localDay(clock.now())
      return store.usageDaily({ from: day, to: day }).reduce(
        (sum, entry) => ({ tokens: sum.tokens + entry.input + entry.output + entry.reasoning + entry.cacheRead + entry.cacheWrite, calls: sum.calls + entry.calls, costMicros: sum.costMicros + entry.costMicros }),
        { tokens: 0, calls: 0, costMicros: 0 },
      )
    })(),
    emit: (event) => {
      for (const connection of connections) if (connection.clientId) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
  })

  /** What a running turn is doing right now, for the agent view: when it started, tools in flight, requests waiting. */
  const live = new Map<SessionId, { since: number; tools: Map<string, string>; pending: Map<string, string> }>()
  function liveInfo(sessionId: SessionId): { since?: number; tool?: string; pending?: string; paused?: boolean } {
    const paused = actors.get(sessionId)?.snapshot().paused ? { paused: true } : {}
    const entry = live.get(sessionId)
    if (!entry) return paused
    const tool = [...entry.tools.values()].at(-1)
    const pending = [...entry.pending.values()].at(-1)
    return { since: entry.since, ...(tool ? { tool } : {}), ...(pending ? { pending } : {}), ...paused }
  }
  function trackLive(event: SessionEvent) {
    const id = event.sessionId
    if (event.type === "turn.started") return void live.set(id, { since: event.at, tools: new Map(), pending: new Map() })
    if (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.interrupted" || event.type === "turn.failed") return void live.delete(id)
    // The queue length lands right after the event; publish once the actor has settled.
    if (event.type === "queue.added" || event.type === "queue.changed") return void queueMicrotask(() => publishActivity(id, actors.get(id)?.snapshot().foreground ?? "idle"))
    const entry = live.get(id)
    if (!entry) return
    let changed = false
    if (event.type === "item.started" && event.kind === "tool_call") (entry.tools.set(event.itemId, String(event.meta?.tool ?? "tool").slice(0, 200)), (changed = true))
    else if (event.type === "item.completed") changed = entry.tools.delete(event.itemId)
    else if (event.type === "server.request") (entry.pending.set(event.requestId, event.title.slice(0, 200)), (changed = true))
    else if (event.type === "server.request.resolved") changed = entry.pending.delete(event.requestId)
    if (changed) publishActivity(id, actors.get(id)?.snapshot().foreground ?? "idle")
  }

  /** What follows an event the store appended: live tracking, usage, observers and the clients watching the session. */
  function broadcast(event: SessionEvent) {
    if (event.type === "turn.started") {
      try { snapshots.begin(event.sessionId, event.turnId, store.sessionDirectory(event.sessionId) ?? "") }
      catch (error) { logLine("warn", `[DAEMON]: could not capture ${event.turnId}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (extensionsEnabled) {
      const directory = store.sessionDirectory(event.sessionId)
      if (directory) void extensions.fireEvent(directory, event).catch(() => {})
    }
    trackLive(event)
    if (event.type === "usage.recorded") { budgets.record(event); usageToday.record(event) }
    // A finished turn's file snapshots get their "after" state now (for undo's conflict check and redo).
    if (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.interrupted" || event.type === "turn.failed") {
      try {
        snapshots.seal(event.sessionId, event.turnId)
      } catch (error) {
        logLine("warn", `[DAEMON]: could not seal the file snapshot of ${event.turnId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const observe of sessionObservers) observe(event)
    publishServerEvent(event)
    for (const connection of connections) {
      const cursor = connection.subscriptions.get(event.sessionId)
      if (cursor === undefined || event.seq <= cursor) continue
      connection.subscriptions.set(event.sessionId, event.seq)
      send(connection, { v: PROTOCOL_VERSION, kind: "event", body: event })
    }
  }

  const sessionSink = {
    append(draft: SessionEventDraft) {
      // Secrets never reach the session log or its clients (K1); the engine keeps its own history for the model.
      const priced = draft.type === "usage.recorded" && draft.costMicros === undefined ? budgets.price(draft) : undefined
      const event = store.sessionSink.append(redactEventText(priced === undefined ? draft : { ...draft, costMicros: priced }))
      if (event.type === "turn.started") tracedTurns.set(event.sessionId, { turnId: event.turnId, span: trace.start("session.turn", { sessionId: event.sessionId, turnId: event.turnId }) })
      const active = tracedTurns.get(event.sessionId)
      trace.start("daemon.event", { sessionId: event.sessionId, seq: event.seq, ...(active ? { turnId: active.turnId } : {}) }, event.type).end()
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
        active?.span.end(event.type === "turn.failed" ? "error" : event.type === "turn.cancelled" ? "cancelled" : "ok")
        tracedTurns.delete(event.sessionId)
      }
      broadcast(event)
      return event
    },
  }

  /** Undo, redo, fork points, timeline and export. Busy means a turn is running or still finishing: its history must not be rewritten under it. */
  const transfers = createSessionTransfer({ store, ids })
  const setupImport = createSetupImport({ dir: options.dir })
  const history = createSessionHistory({
    store,
    snapshots,
    publish: broadcast,
    isBusy: (sessionId) => {
      const actor = actors.get(sessionId)?.snapshot()
      return live.has(sessionId) || (actor !== undefined && (actor.turnId !== undefined || BUSY.has(actor.foreground)))
    },
    now: () => clock.now(),
  })
  /** Portable handoff between engines and merge-back of forks (docs/sessions.md): context for an engine that did not run the conversation. */
  const portable = createPortableContext({ store, history, cap: () => store.settings.get().handoffTokenCap, primary: "native" })
  const messageMutations = createMessageMutations({
    store, capture: captured, publish: broadcast,
    busy: (id) => live.has(id) || Boolean(actors.get(id)?.snapshot().turnId) || BUSY.has(actors.get(id)?.snapshot().foreground ?? "idle"),
  })
  const consoleService = createConsole({ dir: options.dir, settings: () => store.settings.get(), now: () => clock.now(), ...options.console })
  const sessionSharing = createSessionSharing({ dir: options.dir, store, console: consoleService, history, settings: () => store.settings.get(), now: () => clock.now(), ...(options.console?.debounceMs === undefined ? {} : { debounceMs: options.console.debounceMs }) })
  sessionObservers.push(sessionSharing.observe)
  const staticShare = createStaticShare({ dir: options.dir, store, history, gh: options.githubProcess ?? githubProcess, now: () => clock.now() })
  function publishAside(sessionId: SessionId, thread: import("@mendcode/protocol").AsideThread) {
    const event: GlobalEvent = { type: "aside.changed", gseq: 0, at: clock.now(), sessionId, thread }
    for (const connection of connections) if (connection.clientId) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
  }
  const limitCheckpoint = createLimitCheckpoint(store, () => clock.now(), (sessionId) => {
    // Do not deliver a higher sequence from inside the current event's broadcast.
    queueMicrotask(() => { if (store.sessionInfo(sessionId)) sessionSink.append({ type: "limit.checkpoint", sessionId }) })
  }, (sessionId) => {
    if (store.meta.get(`session.local-tools.restricted:${sessionId}`) === "true") return false
    const model = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog })
    return !model.model.includes(":") && !catalog.list().find((entry) => entry.id === model.model)?.provider
  }, () => tuiControl.run({ operation: "profile" }).profile.limitCheckpoint !== false)
  sessionObservers.push(limitCheckpoint.observe)
  const globalSink = {
    append(draft: GlobalEventDraft) {
      const event: GlobalEvent = store.globalSink.append(draft)
      limitCheckpoint.quota(event)
      publishServerEvent(event)
      for (const connection of connections) if (connection.clientId) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
      return event
    },
  }
  const reviews = createReviews({
    dir: options.dir,
    directory: (sessionId) => store.sessionDirectory(sessionId),
    now: () => clock.now(),
    changed: (sessionId, review, reload) => {
      const event: GlobalEvent = { type: "review.changed", gseq: 0, at: clock.now(), sessionId, review, ...(reload ? { reload: true } : {}) }
      for (const connection of connections) if (connection.clientId) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
  })
  // Project folders are watched only for directories trusted for project resources (the same list as custom tools and extensions).
  const uiReload = createUiReload({ dir: options.dir, emit: (event) => globalSink.append(event), projects: () => (store.settings.get().trustedToolDirs ?? []).filter((trusted) => path.isAbsolute(trusted)), load: async (directory) => {
    extensions.invalidateAll()
    const listed = await extensions.list(directory)
    // Servers an extension registers (`api.registerMcpServer`) follow its reload: added, changed or gone from the next turn.
    await options.mcp?.invalidate?.()
    return listed.flatMap((entry) => entry.errors.map((error) => `${entry.name}: ${error}`))
  } })
  const tuiRequests = createTuiRequests()
  /** Live session panel: pushed to every terminal, throttled per session, never persisted. */
  const activity = createActivityThrottle({
    clock,
    emit: (event) => {
      for (const connection of connections) if (connection.clientId) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
  })
  /** Chats a terminal's "new chat" handed out that nothing was typed in yet: other terminals do not hear of them until they have something. */
  const quietEmpties = new Set<SessionId>()
  /** Sub-agent sessions that asked the user something: their activity is published until they end. */
  const askingChildren = new Set<SessionId>()
  /** `draft` is given only when the session's unsent draft changed (null: it was cleared); other pushes leave a terminal's idea of it alone. */
  function publishActivity(sessionId: SessionId, state: ForegroundState, force = false, draft?: import("@mendcode/protocol").SessionDraft | null) {
    const info = store.sessionInfo(sessionId)
    if (!info) return
    // A sub-agent is heard of once it waits on the user (its parent's Agents strip says "needs you"), until it ends.
    if (info.parentId) {
      if (state === "waiting_approval") askingChildren.add(sessionId)
      else if (!askingChildren.has(sessionId)) return
      if (state === "idle" || state === "error") askingChildren.delete(sessionId)
    }
    if (quietEmpties.has(sessionId)) {
      if (store.emptySessions.has(sessionId)) return
      quietEmpties.delete(sessionId)
    }
    const queued = actors.get(sessionId)?.snapshot().queue.length
    activity.push({ sessionId, directory: info.directory, title: info.title, state, updatedAt: info.updatedAt, archivedAt: info.archivedAt, lifecycle: lifecycleOf(store, sessionId), ...(queued ? { queued } : {}), ...(draft !== undefined ? { draft } : {}), ...liveInfo(sessionId) }, { force })
  }
  const scheduler = createJobScheduler({ clock, scope: root.child("jobs"), sink: globalSink, ids })

  /**
   * Dream for one project as a P5 background job: it yields to foreground work and never touches a
   * session actor (FC-01). One run per project at a time.
   */
  function startDream(directory: string, trigger: DreamTrigger = "manual", policy?: "disabled" | "preview" | "auto-consolidate", deterministic = false): { runId: number; completion: Promise<import("@mendcode/protocol").DreamRun> } | { error: string; code: ErrorCode } {
    const dream = options.dream
    if (!dream) return { error: "[DAEMON]: Dream needs the native engine", code: "invalid_command" }
    if (store.dreamRuns.list(directory).some((run) => run.status === "running")) return { error: "[DAEMON]: a Dream run is already in progress for this project", code: "busy" }
    const run = store.dreamRuns.start(directory, trigger)
    let finish!: (run: import("@mendcode/protocol").DreamRun) => void
    const completion = new Promise<import("@mendcode/protocol").DreamRun>((resolve) => { finish = resolve })
    globalSink.append({ type: "dream.changed", run })
    scheduler.schedule({
      jobType: "dream",
      priority: "P5",
      run: async (job) => {
        const settings = memorySettings(store.settings.get(), directory)
        const evolutionRevision = store.evolution.policyRevision()
        const consolidationPolicy = policy ?? settings.dreamConsolidationPolicy ?? "disabled"
        let closing: Parameters<typeof store.dreamRuns.finish>[1]
        try {
          const { runDream } = await import("@mendcode/dream")
          const result = await runDream({
            directory,
            // Newest events of each session, and its last event number: an unchanged session reuses its cached digest without reading them.
            sessions: (dir) =>
              store.listSessions({ directory: dir, limit: 12 }).map((s) => ({ sessionId: s.sessionId, title: s.title, seq: s.lastSeq, events: () => visibleEvents(store.readAfter(s.sessionId, Math.max(0, s.lastSeq - 2_000), 2_000)) })),
            memories: (dir) => store.memories.list({ directory: dir, profile: profileOf(store.settings.get(), dir) }),
            complete: async (prompt, signal) => {
              const model = resolveModel({ role: "dream", roles: rolesFor(store.settings.get(), directory), catalog })
              await budgets.guard({ model: model.model, signal })
              try {
                const completion = await dream.complete(prompt, signal, model)
                const usage = typeof completion === "string" ? undefined : completion.usage
                budgets.record(usage ? { provider: model.model.split(":")[0]!, model: model.model, ...usage } : undefined)
                return completion
              } catch (error) { budgets.record(); throw error }
            },
            // A user-scope proposal belongs to the profile of the project Dream read; the category's policy decides what becomes of it.
            propose: (entry) => proposeMemory({ ...entry, directory: entry.directory ?? directory, ...(consolidationPolicy === "preview" ? { forceReview: true } : {}) }).outcome,
            revise: (entry) => void addRevision(entry),
            signal: job.signal,
            checkpoint: job.checkpoint,
            maxTokens: settings.dreamMaxTokens ?? DREAM_DEFAULT_MAX_TOKENS,
            digests: { get: (sessionId, input) => store.digests.get(sessionId as SessionId, input), put: (sessionId, input) => store.digests.put(sessionId as SessionId, input) },
            ...(settings.evolution && settings.evolution !== "off" ? { evolution: { mode: settings.evolution, workflows: settings.evolutionWorkflows === true, port: {
              record: (entries) => { if (store.evolution.policyRevision() === evolutionRevision) store.evolution.record(entries) },
              recurring: (dir) => store.evolution.policyRevision() === evolutionRevision ? store.evolution.recurring(dir) : [],
              suggest: (candidate) => store.evolution.policyRevision() === evolutionRevision ? store.evolution.suggest({ ...candidate, policyRevision: evolutionRevision }) : undefined,
            }, runId: run.runId } } : {}),
          })
          closing =
            result.status === "done"
              ? { status: "done", proposed: result.proposed, notes: result.notes, report: result.report }
              : result.status === "skipped"
                ? { status: "skipped", notes: result.reason, report: result.report }
                : { status: "failed", error: result.error, report: result.report }
          if (result.status !== "failed" && consolidationPolicy !== "disabled") {
            // Semantic consolidation only when the user configured a `memoryConsolidator` role this daemon can call; otherwise the host gates alone decide.
            const configured = deterministic || !options.models?.selectable ? undefined : rolesFor(store.settings.get(), directory).memoryConsolidator
            const consolidator = configured ? resolveModel({ role: "memoryConsolidator", roles: rolesFor(store.settings.get(), directory), catalog }) : undefined
            const usable = consolidator && consolidator.model === configured?.model ? consolidator : undefined
            const meter = usable ? (await import("@mendcode/dream")).createMeter({ limit: Math.max(0, (settings.dreamMaxTokens ?? DREAM_DEFAULT_MAX_TOKENS) - result.report.budget.used), signal: job.signal, complete: async (prompt, signal) => {
              await budgets.guard({ model: usable.model, signal })
              try {
                const completion = await dream.complete(prompt, signal, usable)
                const usage = typeof completion === "string" ? undefined : completion.usage
                budgets.record(usage ? { provider: usable.model.split(":")[0]!, model: usable.model, ...usage } : undefined)
                return completion
              } catch (error) { budgets.record(); throw error }
            } }) : undefined
            const { fallback, ...pass } = await consolidateMemory({ entries: () => store.memories.list({ directory, profile: profileOf(store.settings.get(), directory) }), policy: consolidationPolicy, limit: settings.memoryGlobalCompactionMaxEntries ?? 50,
              apply: async (memory) => { await cliMemory.run(directory, { operation: "apply", memoryId: memory.memoryId }) },
              archive: (memory) => { store.memories.update(memory.memoryId, { status: "archived" }); globalSink.append({ type: "memory.changed", memoryId: memory.memoryId, change: "updated" }) },
              ...(meter ? { semantic: createSemanticConsolidator({ call: meter.call }) } : {}),
            })
            const consolidation = { ...pass, ...(meter && usable && pass.mode === "semantic" ? { semantic: { model: usable.model.slice(0, 200), ...meter.snapshot().model, ...(fallback ? { fallback } : {}) } } : {}) }
            closing.report = { ...result.report, consolidation }
            closing.notes = `${closing.notes ?? ""}${closing.notes ? " · " : ""}consolidation ${consolidationPolicy}${consolidation.mode === "semantic" ? " (semantic)" : ""}: ${consolidation.applied} applied, ${consolidation.archived} archived, ${consolidation.pendingAfter} pending`
            if (result.status === "skipped" && consolidation.decisions.length) closing.status = "done"
            if (consolidation.decisions.some((decision) => decision.outcome === "failed")) closing = { ...closing, status: "failed", error: "Consolidation could not resolve a proposal" }
          }
        } catch (error) {
          // A bug or a storage error must not leave the run "running" forever: that would refuse every later run of the project.
          closing = { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error) }
        }
        const finished = store.dreamRuns.finish(run.runId, closing)
        if (finished) { globalSink.append({ type: "dream.changed", run: finished }); finish(finished) }
      },
    })
    return { runId: run.runId, completion }
  }

  /**
   * Scheduled Dream (settings.dreamAt). The daemon remembers the day of the last window it handled (meta `dream.window`).
   * At each check a newer window runs once for every project with a session updated in the last 24 h: `scheduled` when it is
   * on time, `recovered` when the daemon was down or the machine asleep (first check after it; several missed days are one
   * run). Checks happen at the window and at most every 15 minutes before it, so a wake from sleep is noticed soon. Turning
   * the schedule on or changing its time never recovers a window retroactively. Off (no timer) while dreamAt is unset — P6.
   */
  const DREAM_WINDOW_KEY = "dream.window"
  let dreamTimer: TimerHandle | undefined
  /** `reset`: the schedule was just turned on or moved, so the window that already passed today counts as handled. */
  function armDreamSchedule(reset = false): { status: string; reason: string; runs: Array<{ runId: number }> } {
    dreamTimer?.cancel()
    dreamTimer = undefined
    const at = store.settings.get().dreamAt
    const runs: Array<{ runId: number }> = []
    if (!at || !options.dream) return { status: "skipped", reason: !at ? "Schedule disabled" : "Dream is not configured", runs }
    const handled = store.meta.get(DREAM_WINDOW_KEY)
    if (reset || handled === undefined) store.meta.set(DREAM_WINDOW_KEY, dateKey(windows(clock.now(), at).last))
    else {
      const verdict = checkWindow({ now: clock.now(), at, handled })
      if (verdict.action === "run") {
        store.meta.set(DREAM_WINDOW_KEY, verdict.day)
        const since = clock.now() - 86_400_000
        const active = new Set(store.listSessions({ limit: 500 }).filter((s) => s.updatedAt >= since && !s.title.startsWith("loop · ") && !s.title.startsWith("workflow · ")).map((s) => s.directory))
        for (const directory of active) {
          const started = startDream(directory, verdict.trigger)
          if (!("error" in started)) runs.push({ runId: started.runId })
        }
      }
    }
    dreamTimer = clock.setTimer(nextCheckIn(clock.now(), at), () => armDreamSchedule())
    return { status: runs.length ? "started" : "skipped", reason: runs.length ? "Daily window due" : "No unhandled active window", runs }
  }

  /**
   * Storage retention. `storage.clean` and the daily timer share this: sessions open in a terminal are
   * protected on top of the store's own rules (active turn, queue, live loop).
   */
  async function cleanStorage(input: { olderThanDays: number; dryRun?: boolean; vacuum?: boolean; compact?: boolean; deltaIdleDays?: number; worktrees?: boolean; worktreeIdleDays?: number }) {
    const protect = new Set<string>()
    for (const connection of connections) for (const id of connection.subscriptions.keys()) protect.add(id)
    // A full vacuum goes last, after compaction has rewritten rows, so it gives back everything at once.
    const { sessionIds, ...cleaned } = store.cleanStorage({ olderThanDays: input.olderThanDays, protect, ...(input.dryRun ? { dryRun: true } : {}), ...(input.vacuum && !input.compact ? { vacuum: true } : {}) })
    let result: typeof cleaned & { compactedRows?: number; compactComplete?: boolean; deltaEventsRemoved?: number; worktreesRemoved?: number; worktreeBytes?: number } = cleaned
    if (input.compact) {
      const compacted = store.compactStorage({ protect, deltaIdleDays: input.deltaIdleDays ?? DEFAULT_DELTA_IDLE_DAYS, ...(input.dryRun ? { dryRun: true } : {}), ...(input.vacuum ? { vacuum: true } : {}) })
      result = {
        ...cleaned,
        bytesReclaimed: cleaned.bytesReclaimed + compacted.bytesReclaimed,
        vacuumed: cleaned.vacuumed || compacted.vacuumed,
        compactedRows: compacted.engineRows + compacted.eventRows + compacted.snapshotRows,
        compactComplete: compacted.complete,
        deltaEventsRemoved: compacted.deltaEvents,
      }
    }
    if (input.worktrees) {
      const worktrees = await projectRestService().storage.clean({ ...(input.worktreeIdleDays === undefined ? {} : { idleDays: input.worktreeIdleDays }), ...(input.dryRun ? { dryRun: true } : {}) })
      result = { ...result, worktreesRemoved: worktrees.removed, worktreeBytes: worktrees.bytes }
    }
    if (!input.dryRun) {
      // Idle actors of removed sessions hold nothing worth keeping; drop them like a deleted session.
      for (const id of sessionIds as SessionId[]) {
        actors.delete(id)
        sessionScopes.get(id)?.dispose()
        sessionScopes.delete(id)
        scheduler.setForegroundBusy(id, false)
        activity.forget(id)
        secrets.drop(id)
      }
    }
    return result
  }

  /** Daily at 03:30 local while `retentionDays` is set (off, no timer, otherwise — P6). A missed window is not caught up. */
  const RETENTION_AT = { hours: 3, minutes: 30 }
  let retentionTimer: TimerHandle | undefined
  function armRetentionSchedule() {
    retentionTimer?.cancel()
    retentionTimer = undefined
    const armed = store.settings.get()
    if (!armed.retentionDays && !armed.worktreeGcDays) return
    const next = new Date(clock.now())
    next.setHours(RETENTION_AT.hours, RETENTION_AT.minutes, 0, 0)
    if (next.getTime() <= clock.now()) next.setDate(next.getDate() + 1)
    retentionTimer = clock.setTimer(next.getTime() - clock.now(), () => {
      const { retentionDays, worktreeGcDays } = store.settings.get()
      // Retention also compacts: what the daily pass keeps is moved into the compact forms.
      if (retentionDays || worktreeGcDays) {
        void cleanStorage({ olderThanDays: retentionDays ?? 0, ...(retentionDays ? { compact: true } : {}), ...(worktreeGcDays ? { worktrees: true, worktreeIdleDays: worktreeGcDays } : {}) }).catch((error: unknown) => logLine("warn", `[DAEMON]: daily storage pass failed: ${error instanceof Error ? error.message : String(error)}`))
      }
      armRetentionSchedule()
    })
  }

  /** Users save directly; agent proposals land as pending for review (approval-first, like v1). */
  /** The saved memories visible from `directory` (its profile's user memories and its project's) as a graph. */
  const workspaceMemory = createMemoryWorkspaces({ store, profile: (directory) => profileOf(store.settings.get(), directory) })
  const sharingMemory = createMemorySharing({ dir: options.dir, store, profile: (directory) => profileOf(store.settings.get(), directory), id: () => ids("memory"), changed: (memoryId) => announceMemory(memoryId, "added") })

  const modelMemory = createMemoryModel({ store, profile: (directory) => profileOf(store.settings.get(), directory), id: () => ids("memory"), categories: categoriesReport, changed: (memoryId, change, entry) => announceMemory(memoryId, change, entry), propose: proposeMemory,
    control: {
      categoryPolicy: (category, policy) => {
        const policies = { ...store.settings.get().memoryPolicies }
        if (policy === undefined || policy === MEMORY_CATEGORIES.find((entry) => entry.id === category)!.policy) delete policies[category]
        else policies[category] = policy
        globalSink.append({ type: "settings.changed", settings: store.settings.set({ memoryPolicies: Object.keys(policies).length ? policies : null }) })
      },
      settings: (patch) => { globalSink.append({ type: "settings.changed", settings: store.settings.set(patch) }); extraction.wake() },
      dreamAt: (at) => { globalSink.append({ type: "settings.changed", settings: store.settings.set({ dreamAt: at }) }); armDreamSchedule(true) },
      dryRun: (directory) => { const started = startDream(directory, "manual", "preview"); return "error" in started ? { error: started.error } : { runId: started.runId } },
    } })
  const cliMemory = createMemoryControl({ store, profile: (directory) => profileOf(store.settings.get(), directory), id: () => ids("memory"), now: () => clock.now(), extract: extractBudgeted, resolve: modelMemory.resolve,
    changed: (memoryId, change, entry) => announceMemory(memoryId, change, entry),
    settingsChanged: () => { globalSink.append({ type: "settings.changed", settings: store.settings.get() }); extraction.wake() },
  })
  const memoryAssistant = createMemoryAssistant({ dir: options.dir, store, complete: completeBudgeted, browse: workspaceMemory.browse, profile: (directory) => profileOf(store.settings.get(), directory), draft: modelMemory.draft, model: (directory) => options.models?.selectable ? resolveModel({ role: "memoryAssistant", roles: rolesFor(store.settings.get(), directory), catalog: options.models }) : undefined, models: (directory) => {
    if (!options.models?.selectable) return []
    const roles = rolesFor(store.settings.get(), directory)
    const candidates = (["memoryAssistant", "memoryExtractor", "small", "main"] as const).map((role) => resolveModel({ role, roles, catalog: options.models! }))
    return candidates.filter((candidate, index) => candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index)
  }, now: () => clock.now() })

  function graphFor(directory: string | undefined) {
    const saved = store.memories.list({ ...(directory ? { directory, profile: profileOf(store.settings.get(), directory) } : {}), status: "saved" })
    return memoryGraph(saved, store.memories.links(saved.map((memory) => memory.memoryId)))
  }

  /** Links two saved memories; pending or archived ones cannot be linked. */
  function linkMemories(input: { from: MemoryId; to: MemoryId; kind: MemoryLinkKind }) {
    if (store.memories.get(input.from)?.status !== "saved" || store.memories.get(input.to)?.status !== "saved") return undefined
    const link = store.memories.link(input)
    if (link) globalSink.append({ type: "memory.changed", memoryId: link.from, change: "linked" })
    return link
  }

  /**
   * Stores a memory. A user-scope memory keeps no directory: the one given only says which profile it belongs to. A
   * session-scope memory belongs to `sessionId` (its directory is the session's) and goes with it.
   */
  function addMemory(entry: { scope: MemoryScope; directory?: string; sessionId?: SessionId; text: string; category: string; source: "user" | "agent"; status: "saved" | "pending"; pinned?: boolean; details?: MemoryEntry["details"] }) {
    const memoryId = ids("memory")
    const directory = entry.scope === "session" && entry.sessionId ? store.sessionInfo(entry.sessionId)?.directory : entry.directory
    const place = entry.scope === "user" ? { profile: profileOf(store.settings.get(), directory) } : directory ? { directory } : {}
    store.memories.add({
      memoryId,
      scope: entry.scope,
      ...place,
      ...(entry.scope === "session" && entry.sessionId ? { sessionId: entry.sessionId } : {}),
      text: entry.text,
      category: entry.category,
      status: entry.status,
      source: entry.source,
      ...(entry.pinned ? { pinned: true } : {}),
      ...(entry.details ? { details: entry.details } : {}),
    })
    announceMemory(memoryId, "added")
    return memoryId
  }

  /** `memory.changed` with what changed (scope, status, text), so a client can say it. A deleted memory is passed in as it was. */
  function announceMemory(memoryId: MemoryId, change: "added" | "updated" | "deleted" | "linked", before?: MemoryEntry) {
    const entry = change === "deleted" ? before : change === "linked" ? undefined : store.memories.get(memoryId)
    const described = entry && !entry.details?.action ? { scope: entry.scope, status: entry.status, text: entry.text.replace(/\s+/g, " ").trim().slice(0, 200) } : {}
    globalSink.append({ type: "memory.changed", memoryId, change, ...described })
  }

  /**
   * Where `memory.update` with a `scope` puts a memory. User scope keeps the memory's profile, or takes the one of the
   * project or session it came from; session scope takes the session's project as its directory. A pending Dream revision
   * refers to its target by id and so cannot move.
   */
  function memoryDestination(command: { scope?: MemoryScope | undefined; directory?: string | undefined; sessionId?: SessionId | undefined }, current: MemoryEntry): { place: { scope: MemoryScope; directory?: string; sessionId?: SessionId; profile?: string } } | { error: string; code: ErrorCode } {
    if (current.kind === "update" || current.kind === "archive") return { error: "a pending revision cannot change scope", code: "invalid_command" }
    if (command.scope === "project") return { place: { scope: "project", directory: command.directory! } }
    if (command.scope === "session") {
      const sessionId = command.sessionId!
      if (!store.hasSession(sessionId)) return { error: "session memory needs the id of an existing session", code: "unknown_session" }
      const directory = store.sessionInfo(sessionId)?.directory
      return { place: { scope: "session", sessionId, ...(directory ? { directory } : {}) } }
    }
    return { place: { scope: "user", profile: current.scope === "user" ? (current.profile ?? profileOf(store.settings.get(), undefined)) : profileOf(store.settings.get(), current.directory) } }
  }

  /**
   * The agent's (or Dream's, or Evolution's) proposal, handled by its category's policy: `never` drops it, `review` leaves
   * it pending, `auto` saves it. A text that had a secret redacted always waits for review, and `cap: "review"` means
   * the caller allows nothing beyond review (Evolution's suggest mode). The agent only knows markers, but a proposal is
   * stored for long: a secret it still carries (read from a file) is redacted.
   */
  function proposeMemory(entry: { scope: MemoryScope; directory?: string; sessionId?: SessionId; text: string; category: string; forceReview?: boolean; cap?: "review"; details?: MemoryEntry["details"] }): { memoryId?: string; outcome: "pending" | "saved" | "dropped" } {
    const safe = redactSecrets(entry.text)
    const settings = memorySettings(store.settings.get(), entry.directory)
    if (settings.memoryEnabled === false) return { outcome: "dropped" }
    const entries = store.memories.list({ ...(entry.directory ? { directory: entry.directory } : {}), profile: profileOf(settings, entry.directory) }).filter((memory) => memory.status !== "archived")
    if (entries.length >= (settings.memoryMaxEntries ?? 50)) return { outcome: "dropped" }
    if (entry.scope === "project" && entries.filter((memory) => memory.scope === "project").length >= (settings.memoryProjectMaxEntries ?? 3)) return { outcome: "dropped" }
    const policy = memoryPolicyFor(entry.category, settings.memoryPolicies)
    if (policy === "never") return { outcome: "dropped" }
    if (entry.scope === "session" && !(entry.sessionId && store.hasSession(entry.sessionId))) return { outcome: "dropped" }
    const review = policy === "review" || safe.count > 0 || entry.forceReview === true || entry.cap === "review"
    const { forceReview: _forceReview, cap: _cap, ...rest } = entry
    const memoryId = addMemory({ ...rest, text: safe.text, source: "agent", status: review ? "pending" : "saved" })
    return { memoryId, outcome: review ? "pending" : "saved" }
  }

  /** Every category with the policy in force. */
  function categoriesReport(): MemoryCategoryInfo[] {
    const overrides = store.settings.get().memoryPolicies
    return MEMORY_CATEGORIES.map((category) => ({ id: category.id, label: category.label, description: category.description, defaultPolicy: category.policy, policy: overrides?.[category.id] ?? category.policy }))
  }

  /** A Dream revision waits as a pending row that copies the target's scope and category; it is never applied on its own. */
  function addRevision(entry: { kind: "update" | "archive"; targetId: string; text: string; reason: string }) {
    const target = store.memories.get(entry.targetId as MemoryId)
    if (!target || target.status !== "saved") return undefined
    const memoryId = ids("memory")
    store.memories.add({
      memoryId,
      scope: target.scope,
      ...(target.directory ? { directory: target.directory } : {}),
      ...(target.profile ? { profile: target.profile } : {}),
      text: entry.kind === "archive" ? target.text : redactSecrets(entry.text).text,
      category: target.category,
      status: "pending",
      source: "agent",
      kind: entry.kind,
      targetId: target.memoryId,
      reason: entry.reason,
    })
    announceMemory(memoryId, "added")
    return memoryId
  }

  const sessionScopes = new Map<SessionId, ReturnType<typeof root.child>>()

  /** An idle session with no queue and no subscribers holds no memory; its actor is rebuilt on demand (I11). */
  function maybeEvict(sessionId: SessionId) {
    const actor = actors.get(sessionId)
    if (!actor) return
    const snapshot = actor.snapshot()
    // A command posted in the same pass (a child resumed as its turn ends) is waiting in the mailbox: evicting now would drop it.
    if (snapshot.turnId || snapshot.queue.length > 0 || snapshot.paused || snapshot.mailbox > 0) return
    // A user cancel holds the session, and the hold lives in the actor: while a background task still runs, a rebuilt actor
    // would give its exit notice a turn of its own instead of keeping it for the user's next message (FC-13).
    if (snapshot.held && background.listAll(sessionId).some((task) => task.status === "running")) return
    for (const connection of connections) if (connection.subscriptions.has(sessionId)) return
    actors.delete(sessionId)
    sessionScopes.get(sessionId)?.dispose()
    sessionScopes.delete(sessionId)
    scheduler.setForegroundBusy(sessionId, false)
    engine.release?.(sessionId)
  }

  function actorFor(sessionId: SessionId) {
    const existing = actors.get(sessionId)
    if (existing) return existing
    if (!store.hasSession(sessionId)) return undefined
    const scope = root.child(`session:${sessionId}`)
    sessionScopes.set(sessionId, scope)
    const actor = createSessionActor({
      sessionId,
      clock,
      scope,
      engine,
      sink: sessionSink,
      ids,
      ...(options.cancelGraceMs ? { cancelGraceMs: options.cancelGraceMs } : {}),
      restoredQueue: store.queueOf(sessionId).map((entry) => (entry.notice && isBackgroundNotice(entry.text) ? { ...entry, rides: true as const } : entry)),
      permissionMode: store.permissionModeOf(sessionId),
      queueMode: () => queueModeOf(sessionId),
      canSteer: () => engineTakesSteer(sessionId),
      waitingNotice: () => ownerWake.waiting(sessionId),
      onForeground: (state) => {
        scheduler.setForegroundBusy(sessionId, BUSY.has(state))
        publishActivity(sessionId, state)
        if (state === "idle") { queueMicrotask(() => maybeEvict(sessionId)); idleGc.idle() }
      },
      onPause: () => publishActivity(sessionId, actors.get(sessionId)?.snapshot().foreground ?? "idle", true),
    })
    actors.set(sessionId, actor)
    return actor
  }

  /** The session's permission mode right now: the running actor's, else the stored one. */
  const livePermission = (sessionId: SessionId) => actors.get(sessionId)?.snapshot().permissionMode ?? store.permissionModeOf(sessionId)

  async function withdrawAsyncNotices(sessionId?: SessionId) {
    const experimental = store.settings.get().experimental
    const sessions = sessionId ? [sessionId] : [...new Set(store.continuity.list().map((record) => record.sessionId))]
    for (const id of sessions) {
      const notices = store.queueOf(id).filter((entry) => entry.notice && (sessionId ? entry.text.startsWith("[Async ") : experimental?.async_tools !== true && entry.text.startsWith("[Async job ") || experimental?.async_questions !== true && entry.text.startsWith("[Async question ")))
      for (const entry of notices) await actorFor(id)?.handle({ type: "queue.remove", sessionId: id, queueId: entry.queueId, id: ids("command"), clientId: taskClientId })
    }
  }

  /**
   * The events from a session's last `turn.started` to its end, read newest page first: a restart after a crash in a long
   * session parses its last turn, not its whole log. Undefined when the session never started a turn.
   */
  function lastTurnEvents(sessionId: SessionId) {
    let tail: SessionEvent[] = []
    let before: number | undefined
    for (;;) {
      const page = store.readBefore(sessionId, before, REPLAY_PAGE)
      if (!page.length) return undefined
      const startIndex = page.findLastIndex((event) => event.type === "turn.started")
      if (startIndex >= 0) return page.slice(startIndex).concat(tail)
      tail = page.concat(tail)
      before = page[0]!.seq
    }
  }

  /** A turn that was running when the previous daemon died is closed as interrupted, never re-run (FC-37, I15). */
  function recoverInterruptedTurns() {
    for (const { sessionId } of store.sessionsWithActiveTurn()) {
      const events = lastTurnEvents(sessionId)
      const started = events?.[0]
      if (started?.type !== "turn.started") continue
      const openItems = new Set<string>()
      const openRequests = new Set<string>()
      const planRequests = new Set<string>()
      for (const event of events!) {
        if (event.type === "item.started") openItems.add(event.itemId)
        if (event.type === "item.completed") openItems.delete(event.itemId)
        if (event.type === "server.request" && !event.async) { openRequests.add(event.requestId); if (event.planReview) planRequests.add(event.requestId) }
        if (event.type === "server.request.resolved") openRequests.delete(event.requestId)
      }
      for (const requestId of openRequests) sessionSink.append({ type: "server.request.resolved", sessionId, requestId: requestId as never, resolution: "abandoned", ...(planRequests.has(requestId) ? { planReview: { kind: "plan_review", action: "close", reason: "Interrupted by restart" } } : {}) })
      for (const itemId of openItems) sessionSink.append({ type: "item.completed", sessionId, itemId: itemId as never, status: "interrupted" })
      sessionSink.append({ type: "turn.interrupted", sessionId, turnId: started.turnId, reason: "restart" })
      sessionSink.append({ type: "foreground.state", sessionId, state: store.queueOf(sessionId).length > 0 ? "queued" : "idle" })
      // Only a daemon that ended without stopping (a kill, a crash, the process hosting it gone) leaves a turn open.
      logLine("warn", `[DAEMON]: session ${sessionId} had a turn running when the previous daemon ended without stopping; marked interrupted`)
    }
  }
  recoverInterruptedTurns()
  for (const task of store.tasks.list()) if (task.background && task.state === "interrupted" && ["queued", "working", "needs_input"].includes(store.sessionBackground.get(task.taskId)?.state ?? "")) sessionBackground.register(task.taskId, { state: "stopped", summary: task.result.slice(0, 4000) })
  ownerWake.schedule()
  continuity.recover()

  /**
   * Loops: each run is a normal message in the loop's root session, submitted as the daemon's own
   * client, so the session actor keeps all its guarantees. Started after crash recovery so an
   * interrupted run is closed as interrupted.
   */
  const loopClientId = ids("client")
  const loops = createLoopService({
    store: store.loops,
    clock,
    ids,
    createSession: ({ directory, title, readOnly }) => {
      const id = ids("session")
      store.createSession({ id, directory, title })
      store.meta.set(`session.title.manual:${id}`, "true")
      announceSession(id, directory)
      const actor = actorFor(id)
      // The mailbox keeps order: plan mode is set before the audit prompt that follows is handled.
      // A loop's own session follows the user's default for new sessions, like any session they create.
      const mode = readOnly ? "plan" : defaultPermissionFor(store.settings.get(), directory)
      if (mode && mode !== "ask") void actor?.handle({ id: ids("command"), clientId: loopClientId, type: "session.permission.set", sessionId: id, mode })
      return id
    },
    runCheck: runLoopCheck,
    fingerprint: workspaceFingerprint,
    // Worktree loops: each run gets its own git worktree under the data dir, never inside the user's checkout.
    worktree: createGitWorktrees({ root: path.join(options.dir, "loop-worktrees") }),
    submit: async ({ sessionId, text }) => {
      const actor = actorFor(sessionId)
      if (!actor) return { error: "loop session no longer exists" }
      const swapped = captured(sessionId, text)
      if ("ok" in swapped) return { error: swapped.message }
      const result = await actor.handle({ id: ids("command"), clientId: loopClientId, type: "user.submit", sessionId, text: swapped.text, attachments: [] })
      return result.ok ? { queueId: result.result?.queueId as QueueId } : { error: result.message }
    },
    // A hung auditor is cancelled by its exact turn (explicit target, FC-09/10).
    cancelTurn: ({ sessionId, turnId }) => actorFor(sessionId)?.handle({ id: ids("command"), clientId: loopClientId, type: "turn.cancel", sessionId, turnId }),
    onChange: (loop) => void globalSink.append({ type: "loop.changed", loop }),
  })
  sessionObservers.push(loops.observe)
  loops.start()

  /** Creates and edits share the input checks and the worktree's git checkout requirement. */
  async function loopProblem(input: CreateLoopInput): Promise<string | undefined> {
    const problems = [...checkProblems(input.checks ?? []), ...(createProblems(input) ? [createProblems(input)!] : [])]
    if (problems.length) return problems[0]!
    if (input.workspace === "worktree" && !(await isGitCheckout(input.directory))) return `${input.directory} is not a git checkout, so its runs cannot use worktrees`
    return undefined
  }

  async function createLoop(input: CreateLoopInput): Promise<{ ok: true; loop: ReturnType<typeof loops.create> } | { ok: false; message: string }> {
    const problem = await loopProblem(input)
    if (problem) return { ok: false, message: problem }
    return { ok: true, loop: loops.create(input) }
  }

  /** Workflows: the host loads its package only when a workflow command arrives or a run is still live. */
  const workflowClientId = ids("client")
  const workflowRouter = createWorkflowRouter({ dir: options.dir, catalog, crossEngine: () => options.safeMode ? "cross-engine agents are off in safe mode" : store.settings.get().tier !== "full" || !featureOn(store.settings.get(), "subagents") ? "an agent on another engine needs the full tier" : undefined, roles: (directory) => rolesFor(store.settings.get(), directory), sessionModel: (run) => run.originSessionId ? store.sessionModel(run.originSessionId) : undefined, agent: (directory, name) => agents.port().subagents(directory).find((agent) => agent.name === name) })
  const automationLedger = createAutomationLedgerHost(store)
  const workflows = createWorkflowsHost({
    store: store.workflows,
    definitions: store.workflowDefinitions,
    clock,
    ids,
    layersFor,
    dataDir: options.dir,
    journal: store.workflowJournal,
    merge: createWorkflowMerge({ dir: options.dir }),
    isTrusted: (directory) => {
      const canonical = canonicalDir(directory)
      return (store.settings.get().trustedToolDirs ?? []).some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
    },
    defaultPermission: (directory) => defaultPermissionFor(store.settings.get(), directory),
    prepareTask: workflowRouter.prepare,
    routingProblems: workflowRouter.problems,
    validateAgent: workflowRouter.agentProblem,
    createSession: ({ directory, title, parentId, readOnly, permission, model, agent }) => {
      const id = ids("session")
      store.createSession({ id, directory, title, ...(parentId ? { parentId } : {}) })
      if (model) store.setSessionModel(id, model)
      if (agent) store.setSessionAgent(id, agent)
      announceSession(id, directory, parentId)
      const mode = readOnly ? "plan" : permission
      if (mode && mode !== "ask") void actorFor(id)?.handle({ id: ids("command"), clientId: workflowClientId, type: "session.permission.set", sessionId: id, mode })
      return id
    },
    submit: async ({ sessionId, text }) => {
      const actor = actorFor(sessionId)
      if (!actor) return { error: "workflow session no longer exists" }
      const swapped = captured(sessionId, text)
      if ("ok" in swapped) return { error: swapped.message }
      const result = await actor.handle({ id: ids("command"), clientId: workflowClientId, type: "user.submit", sessionId, text: swapped.text, attachments: [] })
      return result.ok ? { queueId: result.result?.queueId as QueueId } : { error: result.message }
    },
    cancelTurn: ({ sessionId, turnId }) => actorFor(sessionId)?.handle({ id: ids("command"), clientId: workflowClientId, type: "turn.cancel", sessionId, turnId }),
    deleteSession: (sessionId) => removeSession(sessionId) !== "busy",
    runCheck: runLoopCheck,
    fingerprint: workspaceFingerprint,
    ledger: (workflowId, category, query) => (store.automationLedger.known("workflow", workflowId) ? store.automationLedger.page("workflow", workflowId, category, query) : undefined),
    emit: (event) => void globalSink.append(event),
  })
  sessionObservers.push(workflows.observe)
  function workflowContext(sessionId: SessionId) {
    if (!workflows.loaded()) return undefined
    let owner: SessionId | undefined = sessionId
    for (let depth = 1; owner && depth <= 10; depth++) {
      const workflow = workflows.execution(owner)
      if (workflow) return { owner, depth, workflow }
      owner = (store.sessionInfo(owner)?.parentId ?? undefined) as SessionId | undefined
    }
    return undefined
  }
  sessionObservers.push((event) => {
    if (event.type !== "usage.recorded") return
    const context = workflowContext(event.sessionId)
    if (context && context.owner !== event.sessionId) workflows.recordUsage(context.owner, event)
  })

  /**
   * Compaction while idle, before the provider's prompt cache expires (docs/compaction.md). Any session this daemon holds that
   * meets the conditions, with or without a terminal attached. "Idle" is what eviction means by it (no turn, nothing queued, not
   * paused), plus nothing a turn is about to be started for: a pending request, a background task or a child task still running.
   */
  const usageWaste = createUsageWaste({
    store,
    ...(options.defaultDirectory ? { defaultDirectory: options.defaultDirectory } : {}),
    now: () => clock.now(),
    settings: () => store.settings.get(),
    // The user's own tariff first (budgets.prices, by catalog id), then the public list price.
    price: (provider, model) => {
      const prices = store.settings.get().budgets?.prices ?? {}
      return prices[`${provider}:${model}`] ?? prices[model] ?? options.listPrice?.(provider, model)
    },
    providerType: (id) => options.providers?.list(true).find((provider) => provider.id === id)?.type,
    feature: (id) => featureOn(store.settings.get(), id, { safeMode: options.safeMode }),
  })
  const idleCompaction = createIdleCompaction({
    clock,
    enabled: () => featureOn(store.settings.get(), "idle_compact", { safeMode: options.safeMode }),
    settings: () => store.settings.get(),
    provider: (id) => options.providers?.list(true).find((provider) => provider.id === id),
    packs: (sessionId) => engineTakesSteer(sessionId),
    child: (sessionId) => store.tasks.list().some((task) => task.taskId === sessionId) || workflowContext(sessionId) !== undefined,
    idle: (sessionId) => {
      const snapshot = actors.get(sessionId)?.snapshot()
      if (snapshot ? snapshot.turnId !== undefined || snapshot.queue.length > 0 || snapshot.paused : store.queueOf(sessionId).length > 0) return false
      if (live.has(sessionId) || store.pendingRequestsOf(sessionId).length > 0) return false
      if (background.listAll(sessionId).some((task) => task.status === "running")) return false
      return !tasks.list(sessionId).some((task) => task.state === "queued" || task.state === "running" || task.state === "needs_input")
    },
    compact: async (sessionId) => (await actorFor(sessionId)?.compactIdle()) ?? false,
  })
  sessionObservers.push(idleCompaction.observe)
  const runWorkflowTurn = engine.runTurn.bind(engine)
  const routedWorkflowInput = (input: Parameters<typeof engine.runTurn>[0]) => {
    const context = workflowContext(input.sessionId)
    if (!context) return input
    const { workflow, depth } = context
    const { execution } = workflow
    const restricted = { ...workflow, reserveChild: () => execution.budget?.maxDepth !== undefined && depth >= execution.budget.maxDepth ? false : workflow.reserveChild() }
    return { ...input, workflow: restricted, selection: { ...input.selection, ...(execution.model ? { model: execution.model } : {}), ...(execution.agent && depth === 1 ? { agent: execution.agent } : {}) }, permissionMode: () => execution.readOnly ? "plan" as const : capPermission(input.permissionMode(), execution.permission) }
  }
  engine.runTurn = (input) => runWorkflowTurn(routedWorkflowInput(input))
  if (engine.runShell) {
    const runWorkflowShell = engine.runShell.bind(engine)
    engine.runShell = (input) => runWorkflowShell(routedWorkflowInput(input))
  }

  const compoundClientId = ids("client")
  const compound = createCompoundHost({
    ...options.compoundHost,
    dir: options.dir, catalog, supported: options.info?.engine === "native",
    roles: (directory) => rolesFor(store.settings.get(), directory),
    createSession: (directory, title, origin) => {
      const id = ids("session")
      store.createSession({ id, directory, title, ...(origin ? { parentId: origin } : {}) })
      announceSession(id, directory, origin)
      return id
    },
    cancel: (sessionId) => { const turnId = actors.get(sessionId)?.snapshot().turnId; if (turnId) void actorFor(sessionId)?.handle({ id: ids("command"), clientId: compoundClientId, type: "turn.cancel", sessionId, turnId }) },
    execute: async ({ sessionId, prompt, permission, call, signal }) => {
      compoundCalls.set(sessionId, call)
      store.setSessionModel(sessionId, call.choice)
      const actor = actorFor(sessionId)!
      await actor.handle({ id: ids("command"), clientId: compoundClientId, type: "session.permission.set", sessionId, mode: call.critic ? "plan" : permission })
      const safe = captured(sessionId, prompt)
      if ("ok" in safe) return { state: "blocked", text: "", reason: safe.message }
      let answer = ""
      let denied = false
      const items = new Set<string>()
      let finish: (result: { state: "completed" | "failed" | "blocked"; text: string; reason?: string }) => void = () => {}
      const completion = new Promise<{ state: "completed" | "failed" | "blocked"; text: string; reason?: string }>((resolve) => { finish = resolve })
      const observe = (event: SessionEvent) => {
        if (event.sessionId !== sessionId) return
        if (event.type === "item.started" && event.kind === "agent_message") items.add(event.itemId)
        if (event.type === "item.completed" && items.has(event.itemId)) answer = event.text ?? ""
        if (event.type === "server.request.resolved" && event.resolution === "denied") denied = true
        if (event.type === "turn.completed") finish({ state: denied || signal.aborted ? "blocked" : "completed", text: answer, ...(denied ? { reason: "User denied a required tool" } : {}) })
        if (event.type === "turn.failed") finish({ state: "failed", text: answer, reason: event.error.message })
        if (event.type === "turn.cancelled" || event.type === "turn.interrupted") finish({ state: "blocked", text: answer, reason: "Turn cancelled or interrupted" })
      }
      const aborted = () => {
        const turnId = actors.get(sessionId)?.snapshot().turnId
        if (turnId) void actor.handle({ id: ids("command"), clientId: compoundClientId, type: "turn.cancel", sessionId, turnId })
        finish({ state: "blocked", text: answer, reason: "Compound runtime limit or cancellation" })
      }
      sessionObservers.push(observe)
      signal.addEventListener("abort", aborted, { once: true })
      try {
        if (signal.aborted) return { state: "blocked", text: "", reason: "Cancelled" }
        const reply = await actor.handle({ id: ids("command"), clientId: compoundClientId, type: "user.submit", sessionId, text: safe.text, attachments: [] })
        if (!reply.ok) return { state: "blocked", text: "", reason: reply.message }
        return await completion
      } finally {
        signal.removeEventListener("abort", aborted)
        sessionObservers.splice(sessionObservers.indexOf(observe), 1)
        compoundCalls.delete(sessionId)
      }
    },
  })

  /** Child tasks of a session and, recursively, theirs that still run (bounded: a stop never walks an unbounded tree). */
  function activeDescendants(sessionId: SessionId): SessionId[] {
    const found: SessionId[] = []
    const queue: SessionId[] = [sessionId]
    for (let parent = queue.shift(); parent && found.length < 64; parent = queue.shift()) {
      for (const task of tasks.list(parent)) {
        if (!["queued", "running", "needs_input"].includes(task.state) || found.includes(task.taskId)) continue
        found.push(task.taskId)
        queue.push(task.taskId)
      }
    }
    return found
  }
  /**
   * Agent control. pause/resume flip the actor's pause flag (the running turn is never cut); stop cancels the running
   * turn and every running child task, which also holds the queue like a user cancel. Authority is the caller's: this runs
   * for a local client or a full-access peer (as turn.cancel does) and, for session-to-session requests, only after the
   * target session approved the command.
   */
  async function controlSession(sessionId: SessionId, action: "pause" | "resume" | "stop") {
    const actor = actorFor(sessionId)
    if (!actor) throw new Error("Unknown session")
    if (action !== "stop") {
      const paused = await actor.pause(action === "pause")
      if (!paused) goals.resumed(sessionId)
      return { paused, cancelledTurn: false, cancelledChildren: 0 }
    }
    let cancelledChildren = 0
    for (const childId of activeDescendants(sessionId)) {
      const turnId = actors.get(childId)?.snapshot().turnId
      if (turnId) await actorFor(childId)!.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId: childId, turnId })
      cancelledChildren++
    }
    const turnId = actor.snapshot().turnId
    if (turnId) await actor.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId, turnId })
    return { paused: actor.snapshot().paused, cancelledTurn: turnId !== undefined, cancelledChildren }
  }

  const agentCommands = createAgentCommands({
    store, clock,
    control: controlSession,
    id: () => ids("command"),
    changed: (sourceSessionId, targetSessionId) => { globalSink.append({ type: "agent-commands.changed", sourceSessionId, targetSessionId }) },
    mask: (sessionId, text) => {
      const safe = captured(sessionId, text)
      if ("ok" in safe) throw new Error(safe.message)
      return safe.text
    },
    notify: async (sessionId, text, delivery) => actorFor(sessionId)?.notify(text, undefined, false, delivery),
    submit: async (sessionId, text) => {
      const result = await actorFor(sessionId)?.handle({ id: ids("command"), clientId: ids("client"), type: "user.submit", sessionId, text, attachments: [] })
      return result?.ok ? result.result?.queueId as QueueId : undefined
    },
  })
  sessionObservers.push(agentCommands.observe)
  agentCommands.recover()

  /** Messages between the sessions of one project (`sessions`, `tell`); answers return to the sender as notices. */
  const peers = createPeers({
    clock,
    stats: (sessionId) => { const stats = store.sessionStats.get(sessionId, clock.now()); return stats ? sessionStatsText(stats) : undefined },
    waiting: (sessionId) => agentCommands.waiting(sessionId),
    deliver: async (from, to, text, mode) => {
      const waiting = actors.get(to)?.snapshot().foreground !== undefined && actors.get(to)?.snapshot().foreground !== "idle"
      try {
        const command = await agentCommands.create(from, to, { kind: "peer_message", text: text.slice(0, 4000), ...(mode ? { mode } : {}) })
        return command.queueId ? { ok: true, waiting } : { ok: false, message: command.error ?? "Target could not take the message" }
      } catch (error) { return { ok: false, message: String(error) } }
    },
    sessions: (directory, limit) => store.listSessions({ directory, limit }),
    info: (sessionId) => store.sessionInfo(sessionId),
    state: (sessionId) => actors.get(sessionId)?.snapshot().foreground ?? "idle",
    notify: async (sessionId, text, delivery) => actorFor(sessionId)?.notify(text, undefined, false, delivery),
  })
  sessionObservers.push(peers.observe)
  sessionObservers.push(mflowHooks.observe)

  /** `threads` tool and `@thread` mentions: bounded, redacted views of the project's other local sessions (docs/sessions.md). */
  const threads = createThreads({
    clock,
    store,
    ...(options.foreignThreads ? { foreign: createForeignThreads(options.foreignThreads) } : {}),
    peers: (sessionId) => peers.port(sessionId),
    state: (sessionId) => actors.get(sessionId)?.snapshot().foreground ?? "idle",
    busy: (sessionId) => {
      const snapshot = actors.get(sessionId)?.snapshot()
      return snapshot !== undefined && (snapshot.foreground !== "idle" || snapshot.queue.length > 0)
    },
    interrupt: async (sessionId) => {
      const actor = actors.get(sessionId)
      const turnId = actor?.snapshot().turnId
      if (!actor || !turnId) return false
      const result = await actor.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId, turnId })
      return result.ok
    },
    merge: ({ fork, into }) => {
      const merged = portable.merge({ fork, into })
      return merged.ok ? { ok: true, ...merged.result } : { ok: false, message: merged.message }
    },
  })
  sessionObservers.push(threads.observe)

  const lifecycle = createSessionLifecycle({
    store, now: () => clock.now(), gh: options.prWatch?.run ?? ghProcess,
    regenerate: metadata.regenerate,
    busy: (id) => !!actors.get(id)?.snapshot().turnId || store.sessionSummary(id)?.queued !== 0 || store.pendingRequestsOf(id).length > 0,
    changed: (id) => publishActivity(id, actors.get(id)?.snapshot().foreground ?? "idle", true),
    settled: (id) => { void usageLimit.handle({ type: "usage.limit", id: ids("command"), clientId: taskClientId, sessionId: id, action: "dismiss" }) },
  })

  const fanout = createFanout({
    store, now: () => clock.now(), id: () => ids("session"),
    leases: createGitWorktrees({ root: path.join(options.dir, "fanout-worktrees") }),
    valid: (model) => invalidChoice({ model }, options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }),
    state: (id) => actors.get(id)?.snapshot().foreground ?? store.lastTurnStatus(id) ?? "idle",
    start: async (branch, prompt, owner) => {
      store.setSessionAgent(branch.sessionId, store.sessionAgent(owner))
      announceSession(branch.sessionId, branch.directory, owner)
      const actor = actorFor(branch.sessionId)
      if (!actor) return "Session unavailable"
      const mode = store.permissionModeOf(owner)
      await actor.handle({ type: "session.permission.set", id: ids("command"), clientId: taskClientId, sessionId: branch.sessionId, mode })
      const capturedPrompt = captured(branch.sessionId, prompt)
      if ("ok" in capturedPrompt) return capturedPrompt.message
      const result = await actor.handle({ type: "user.submit", id: ids("command"), clientId: taskClientId, sessionId: branch.sessionId, text: capturedPrompt.text, attachments: [] })
      return result.ok ? undefined : "Branch prompt was refused"
    },
  })
  function fanoutSummary(id: SessionId) {
    const group = fanout.compare(id)
    if (!("owner" in group) || !group.branches.length) return
    const text = ["Fan-out", ...group.branches.map((branch, index) => `${index + 1}. ${branch.model} · ${branch.state}${branch.error ? ` · ${branch.error}` : ""}\n   ${branch.branch}${branch.summary ? `\n   ${branch.summary}` : ""}`), "/fanout compare · /fanout open N · /fanout changes N"].join("\n")
    sessionSink.append({ type: "session.orchestration", sessionId: group.owner, groupId: group.branches[0]!.sessionId, text: redactSecrets(text).text.slice(0, 8000) })
  }
  sessionObservers.push((event) => {
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type) && store.meta.get(`session.fanout.owner:${event.sessionId}`)) queueMicrotask(() => fanoutSummary(event.sessionId))
    if (event.type === "foreground.state" && event.state === "idle" && featureOn(store.settings.get(), "session_meta", { safeMode: options.safeMode })) queueMicrotask(() => lifecycle.evaluate(event.sessionId))
  })

  /** Linked pull requests polled through `gh`; wakes a session only on a change (docs/pr-watch.md). Off unless `experimental.pr_watch` is on. */
  const prWatch = createPrWatch({
    dir: options.dir,
    ...(options.prWatch?.run ? { run: options.prWatch.run } : {}),
    ...(options.prWatch?.intervalMs ? { intervalMs: options.prWatch.intervalMs } : {}),
    enabled: () => effectiveSettings(store.settings.get(), { safeMode: options.safeMode }).experimental?.pr_watch === true,
    sessionExists: (sessionId) => store.hasSession(sessionId as SessionId),
    sessionDirectory: (sessionId) => store.sessionInfo(sessionId as SessionId)?.directory,
    notify: async (sessionId, text) => actorFor(sessionId as SessionId)?.notify(text, undefined, true),
    mask: (sessionId, text) => secrets.mask(sessionId as SessionId, text),
  })
  root.onDispose(prWatch.stop)

  /** The PR reviewer (docs/pr-review.md): needs the tier's permit and `experimental.pr_review`; nothing loads until a watch exists or `/pr review` runs. */
  const prReviewOn = () => featureOn(store.settings.get(), "pr_review", { safeMode: options.safeMode }) && effectiveSettings(store.settings.get(), { safeMode: options.safeMode }).experimental?.pr_review === true
  const reviewSessions = createReviewSessions({
    create({ owner, directory, title, model: chosen, editing }) {
      const id = ids("session")
      const parent = owner && store.hasSession(owner as SessionId) ? owner as SessionId : undefined
      store.createSession({ id, directory, title, ...(parent ? { parentId: parent } : {}) })
      const agent = editing ? agents.defaultName(directory) : REVIEW_AGENT
      if (agent !== "plan" && agent !== "build") store.setSessionAgent(id, agent)
      // The review prompt is the whole brief: no instruction files (the PR's own CLAUDE.md would steer its reviewer) and no skills.
      if (!editing) runLimits.configure(id, { excludeTools: REVIEW_EXCLUDED_TOOLS, noContextFiles: true })
      if (editing) announceSession(id, directory, parent)
      const model = chosen ?? (parent ? store.sessionModel(parent) : undefined)
      if (model) store.setSessionModel(id, model)
      return id
    },
    async submit(id, text, editing) {
      const actor = actorFor(id)
      if (!actor) throw new Error("[PR_REVIEW]: review session is gone")
      if (!editing) await actor.handle({ id: ids("command"), clientId: taskClientId, type: "session.permission.set", sessionId: id, mode: "plan" })
      const message = reviewMessage(text, (bytes) => store.putBlob(bytes, "text/plain"))
      const result = await actor.handle({ id: ids("command"), clientId: taskClientId, type: "user.submit", sessionId: id, ...message })
      if (!result.ok) throw new Error(`[PR_REVIEW]: ${result.message}`)
    },
    deny(id, requestId, reason) { void actorFor(id)?.handle({ id: ids("command"), clientId: taskClientId, type: "request.resolve", sessionId: id, requestId, decision: { kind: "deny", reason } }) },
    async cancel(id) {
      const turnId = actors.get(id)?.snapshot().turnId
      if (turnId) await actorFor(id)!.handle({ id: ids("command"), clientId: taskClientId, type: "turn.cancel", sessionId: id, turnId })
    },
    remove(id) {
      let tries = 0
      const attempt = () => { if (!stopped && removeSession(id) === "busy" && ++tries < 50) setTimeout(attempt, 100).unref?.() }
      setTimeout(attempt, 0).unref?.()
    },
  })
  sessionObservers.push(reviewSessions.observe)
  let prReview: import("./pr-review/service").PrReviewService | undefined
  async function prReviewService() {
    if (prReview) return prReview
    const { createPrReviewService } = await import("./pr-review/service")
    prReview ??= createPrReviewService({
      dir: options.dir,
      ...(options.prReview?.run ? { run: options.prReview.run } : {}),
      ...(options.prReview?.call ? { call: options.prReview.call } : {}),
      ...(options.prReview?.git ? { git: options.prReview.git } : {}),
      ...(options.prReview?.intervalMs ? { intervalMs: options.prReview.intervalMs } : {}),
      enabled: prReviewOn,
      graphOn: () => !options.prReview?.noGraph && featureOn(store.settings.get(), "codegraph", { safeMode: options.safeMode }),
      sessionDirectory: (sessionId) => store.sessionInfo(sessionId as SessionId)?.directory,
      sessionExists: (sessionId) => store.hasSession(sessionId as SessionId),
      // A busy session refuses the notice (undefined): the reviewer's outbox holds it and offers it again when the session is idle.
      notify: (sessionId, text) => actorFor(sessionId as SessionId)?.notify(secrets.mask(sessionId as SessionId, text), undefined, true),
      sessions: (owner, directory) => options.prReview?.sessions?.(owner, directory) ?? reviewSessions.factory({ owner, directory }),
      editor: (owner, directory) => options.prReview?.sessions?.(owner, directory) ?? reviewSessions.factory({ owner, directory, editing: true }),
      schedule: (run) => new Promise<void>((resolve) => { scheduler.schedule({ jobType: "pr_review", priority: "P4", run: async () => { try { await run() } finally { resolve() } } }) }),
    })
    root.onDispose(prReview.stop)
    return prReview
  }
  if (["watches.json", "outbox.json"].some((file) => existsSync(path.join(options.dir, "pr-review", file)))) void prReviewService()
  sessionObservers.push((event) => {
    if (prReview && event.type === "foreground.state" && event.state === "idle") queueMicrotask(() => void prReview?.idle(event.sessionId))
  })

  /**
   * The quota refresh probe (docs/usage-limit.md). Gate, the `permit` pattern of `pr_watch`: only the user's own `quotaRefresh` entries
   * start anything (a tier never does), `--safe-mode` always turns it off, and `tui.change` from a remote peer cannot add entries.
   * One schedule for every client, running only while a client is connected.
   */
  const quotaRefreshEntries = () => {
    if (!featureOn(store.settings.get(), "quota_refresh", { safeMode: options.safeMode })) return []
    try { return normalizeQuotaRefresh(tuiControl.run({ operation: "profile" }).profile.quotaRefresh) } catch { return [] }
  }
  const quotaRefresh = createQuotaRefresh({
    clock,
    entries: quotaRefreshEntries,
    active: () => connections.size > 0,
    latest: (provider) => store.latestQuota().find((snapshot) => snapshot.provider === provider),
    limited: (provider) => {
      const snapshot = store.latestQuota().find((quota) => quota.provider === provider)
      return snapshot !== undefined && windowsSpent(snapshot, clock.now())
    },
    probes: options.quotaRefresh?.probes ?? {},
    report: (snapshot) => void globalSink.append(snapshot),
    // A one-line toast on this machine's terminals, like `api.toast`: never stored and never part of a model's context.
    notify: (text) => {
      const event: GlobalEvent = { type: "extension.feedback", gseq: 0, at: clock.now(), extension: "quota refresh", text: text.slice(0, 300), level: "warning" }
      for (const connection of connections) if (connection.clientId && !connection.remoteAddress && !connection.peer) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
    },
    ...(options.quotaRefresh?.tickMs ? { tickMs: options.quotaRefresh.tickMs } : {}),
    ...(options.quotaRefresh?.random ? { random: options.quotaRefresh.random } : {}),
  })
  quotaRefresh.start()
  root.onDispose(quotaRefresh.stop)

  /** The code graph's counts to this machine's terminals when the index changes: on the wire only, never stored, never to a remote peer. */
  const codegraphEvent = (status: CodegraphStatus | { directory: string; state: "none" }): GlobalEvent => ({
    type: "codegraph.status", gseq: 0, at: clock.now(), directory: status.directory, state: status.state,
    files: "files" in status ? status.files : 0, symbols: "symbols" in status ? status.symbols : 0, edges: "edges" in status ? status.edges : 0, partial: "partial" in status ? status.partial : false,
    ...("reason" in status ? { reason: status.reason.slice(0, 40) } : {}),
  })
  /**
   * Whether the code graph indexes `directory` (index-gate.ts), told to the footer once: `skipped` with the reason, or `none` when a skip
   * no longer holds (after `/graph on`). Nothing is published for a folder it indexes; its counts come from the indexer.
   */
  const publishGraphGate = async (directory: string) => {
    if (!options.codeGate || !options.codegraphStatus || !featureOn(store.settings.get(), "codegraph", { safeMode: options.safeMode })) return
    const verdict = await options.codeGate.check({ cwd: directory, mode: graphIndexMode(store.settings.get(), directory) }).catch(() => undefined)
    if (!verdict) return
    const last = options.codegraphStatus.get(directory)
    if (!verdict.index) {
      if (last?.state !== "skipped" || last.reason !== verdict.reason) options.codegraphStatus.publish({ cwd: directory, state: "skipped", reason: verdict.reason })
    } else if (last?.state === "skipped") options.codegraphStatus.publish({ cwd: directory, state: "none", files: 0, symbols: 0, edges: 0, partial: false })
  }
  /** After settings were saved (`settings.set`, an approved `mendcode_settings` proposal): every client hears, then each service that reads them follows. */
  async function settingsSaved(before: Settings, settings: Settings, patch: Record<string, unknown>) {
    globalSink.append({ type: "settings.changed", settings })
    // `/graph on|off|auto` or the global choice: the footers of the folders whose choice changed learn the new verdict.
    if ("projectConfig" in patch || "codegraph_index" in patch) {
      const touched = new Set([...Object.keys(before.projectConfig ?? {}), ...Object.keys(settings.projectConfig ?? {}), ...(options.codegraphStatus?.snapshot() ?? []).map((status) => status.directory)])
      for (const directory of touched) if (graphIndexMode(before, directory) !== graphIndexMode(settings, directory)) void publishGraphGate(directory)
    }
    continuity.configure()
    await withdrawAsyncNotices()
    if ("trustedToolDirs" in patch || "disabledPackages" in patch || "disabledPackageResources" in patch || "tier" in patch || "features" in patch) extensions.invalidateProject()
    if ("trustedToolDirs" in patch) uiReload.sync()
    if ("models" in patch || "profiles" in patch || "experimental" in patch || "tier" in patch || "features" in patch) reasoning.port.invalidate()
    // MCP follows the tier, the packages and the project trust: the cached config is dropped and servers that are no longer allowed stop.
    if ("tier" in patch || "features" in patch || "trustedToolDirs" in patch || "disabledPackages" in patch || "disabledPackageResources" in patch) await options.mcp?.invalidate?.(undefined)
    armDreamSchedule("dreamAt" in patch)
    extraction.wake()
    armRetentionSchedule()
    if ("autoupdate" in patch) releases.wake()
  }
  /** The local owner's write: what a local `settings.set` does. Throws when the result is invalid, before anything is saved. */
  async function writeSettings(patch: Record<string, unknown>): Promise<Settings> {
    const before = store.settings.get()
    const settings = store.settings.set(patch)
    await settingsSaved(before, settings, patch)
    return settings
  }
  if (options.codegraphStatus) root.onDispose(options.codegraphStatus.subscribe((status) => {
    const event = codegraphEvent(status)
    for (const connection of connections) if (connection.clientId && !connection.remoteAddress && !connection.peer) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: event })
  }))

  /** The Git page's push, create pull request and PR tab run git and gh on the network: off unless `experimental.git_actions` is on (docs/git.md). */
  const gitActionsOn = () => effectiveSettings(store.settings.get(), { safeMode: options.safeMode }).experimental?.git_actions === true
  /** A line in the session's transcript that says what the Git page did: an event of the log, never a model turn. */
  const gitNote = (sessionId: SessionId | undefined, groupId: string, text: string) => {
    if (sessionId && store.hasSession(sessionId)) sessionSink.append({ type: "session.orchestration", sessionId, groupId: `git:${groupId}`.slice(0, 64), text: redactSecrets(text).text.slice(0, 1000) })
  }

  /**
   * Session goals: counted and continued from the session events (docs/goals.md). A continuation is a steering turn the
   * session actor starts only when it is free, so queued messages, approvals and cancels keep their priority.
   */
  const goals = createGoals({
    store,
    clock,
    ids,
    dir: options.dir,
    emit: (event) => void sessionSink.append(event),
    steer: async (sessionId, steering) => (await actorFor(sessionId)?.steer(steering)) ?? false,
    prompts: createGoalPrompts({ layersFor, enabled: extensionsEnabled }),
    log: logLine,
  })
  sessionObservers.push(goals.observe)
  goals.recover()

  /**
   * A turn that hit the provider's usage limit is paused, not failed (docs/usage-limit.md): the user picks Resume at
   * reset or Snooze, and a scheduled resume survives a restart. Resuming continues a usage-limited goal through the goal,
   * otherwise it starts a steering turn that tells the agent to carry on from where it stopped.
   */
  const usageLimit = createUsageLimit({
    store,
    clock,
    emit: (event) => void sessionSink.append(event),
    quotas: () => store.latestQuota(),
    log: logLine,
    // Armed by default in every tier (the `usage_resume` feature; `/tier usage_resume off` stops it).
    armed: () => featureOn(store.settings.get(), "usage_resume", { safeMode: options.safeMode }),
    provider: (sessionId) => {
      const choice = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog })
      return catalog.list().find((model) => model.id === choice.model)?.provider
    },
    model: (sessionId) => {
      const choice = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog })
      return [choice.model, choice.variant].filter(Boolean).join("#")
    },
    draftSince: (sessionId, since) => {
      const draft = store.drafts.get(sessionId)
      return draft !== undefined && draft.updatedAt > since && (draft.text.trim() !== "" || draft.attachments.length > 0)
    },
    resume: async (sessionId) => {
      if (store.goals.current(sessionId)?.goal.status === "usage_limited" && goals.handle({ id: ids("command"), clientId: taskClientId, type: "goal.update", sessionId, status: "active" }).ok) return true
      const actor = actorFor(sessionId)
      if (!actor) return false
      const text = "The provider's usage limit has reset. Continue the work you were doing when it stopped, from where you left off."
      if (await actor.steer({ text, label: "usage limit · resumed", meta: { usageLimit: "resume" }, force: true })) return true
      return (await actor.notify(text)) !== undefined
    },
  })
  sessionObservers.push(usageLimit.observe)
  usageLimit.recover()
  workflows.boot()
  armDreamSchedule()
  armRetentionSchedule()

  /** Deletes a session and everything it holds; refused while a turn runs in it. */
  function removeSession(sessionId: SessionId): "removed" | "unknown" | "busy" {
    if (!store.hasSession(sessionId)) return "unknown"
    if (actors.get(sessionId)?.snapshot().turnId || sessionSharing.status(sessionId).url) return "busy"
    // Its side chat goes with it.
    const side = asideSessions.sideOf(sessionId)
    if (side) removeSession(side)
    for (const other of connections) other.subscriptions.delete(sessionId)
    maybeEvict(sessionId)
    actors.delete(sessionId)
    sessionScopes.get(sessionId)?.dispose()
    sessionScopes.delete(sessionId)
    scheduler.setForegroundBusy(sessionId, false)
    activity.forget(sessionId)
    continuity.cancelSession(sessionId)
    background.killSession(sessionId)
    interactive.killSession(sessionId)
    void browser.forget(sessionId)
    goals.forget(sessionId)
    usageLimit.forget(sessionId)
    engine.forget?.(sessionId)
    options.onSessionRemoved?.(sessionId)
    store.deleteSession(sessionId)
    secrets.drop(sessionId)
    grants.revoke(sessionId, "all")
    runLimits.delete(sessionId)
    forgetSessionEntries(options.dir, sessionId)
    sessionPermissions.delete(sessionId)
    selfPackagePorts.delete(sessionId)
    quietEmpties.delete(sessionId)
    return "removed"
  }

  const attachedToTerminal = (sessionId: SessionId) => [...connections].some((connection) => connection.subscriptions.has(sessionId))

  /**
   * A terminal's "new chat" for one project: the empty chat it already has (a second terminal gets the same one), else none. Every
   * other empty chat of the project that no terminal is attached to goes, so blank sessions left by earlier versions disappear
   * the next time someone opens a new chat there.
   */
  function takeEmptySession(directory: string): SessionId | undefined {
    const spare = store.emptySessions.list({ directory })
    const keep = spare.find((entry) => attachedToTerminal(entry.sessionId)) ?? spare[0]
    if (!keep) return undefined
    for (const entry of spare) if (entry !== keep && !attachedToTerminal(entry.sessionId)) removeSession(entry.sessionId)
    quietEmpties.add(keep.sessionId)
    return keep.sessionId
  }

  /** Daemon start: the empty chats earlier runs left behind hold nothing, so they are removed (a draft, queue entry, goal, setting or turn keeps a chat). */
  for (const entry of store.emptySessions.list()) removeSession(entry.sessionId)

  function reply(connection: Connection, commandId: string, result: { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }) {
    let frame: Frame = result.ok
      ? { v: PROTOCOL_VERSION, kind: "ack", id: commandId as never, ...(result.result ? { result: result.result } : {}) }
      : { v: PROTOCOL_VERSION, kind: "error", id: commandId as never, error: { code: result.code, message: result.message } }
    // A reply the client would reject as oversized must become an explicit error, never a silent timeout.
    const size = Buffer.byteLength(encodeFrame(frame))
    if (size > MAX_FRAME_BYTES)
      frame = { v: PROTOCOL_VERSION, kind: "error", id: commandId as never, error: { code: "internal", message: `[DAEMON]: reply of ${size} bytes exceeds the ${MAX_FRAME_BYTES}-byte frame limit` } }
    recentCommands.set(cacheKey(connection, commandId), frame)
    if (recentCommands.size > RECENT_COMMANDS) recentCommands.delete(recentCommands.keys().next().value!)
    send(connection, frame)
  }

  function subscribe(connection: Connection, sessionId: SessionId, afterSeq: number) {
    // Replay is synchronous and the store is the only writer in this process, so no event can slip
    // between the replay and the live stream: no gap, no duplicate (I4).
    connection.subscriptions.set(sessionId, afterSeq)
    for (let cursor = afterSeq; ; ) {
      const page = store.readAfter(sessionId, cursor, REPLAY_PAGE)
      for (const event of page) send(connection, { v: PROTOCOL_VERSION, kind: "event", body: event })
      if (page.length === 0) break
      cursor = page[page.length - 1]!.seq
      connection.subscriptions.set(sessionId, cursor)
      if (page.length < REPLAY_PAGE) break
    }
  }

  /** A retry that arrives while the original is still running waits for it and gets the same answer. */
  const inflight = new Map<string, Promise<void>>()
  /** The running `user.submit` of each `clientRequestId` (by session), so a concurrent retry waits for it. */
  const submitsInflight = new Map<string, Promise<void>>()
  const cacheKey = (connection: Connection, id: string) => `${connection.peer?.hash ?? "unix"}:${connection.clientId ?? connection.id}:${connection.directory ?? ""}:${id}`
  function rejectRemote(connection: Connection, code: "unauthorized" | "rate_limited", id?: CommandId) {
    connection.rejected = true
    tuiRequests.forget(connection)
    if (connection.peer) tuiRequests.forget(`http:${connection.peer.hash}`)
    clearTimeout(connection.authTimer)
    send(connection, { v: PROTOCOL_VERSION, kind: "error", ...(id ? { id } : {}), error: { code, message: code === "rate_limited" ? "remote auth rate limited" : "remote auth failed" } })
    connection.socket.end()
  }
  function activePeer(connection: Connection) {
    try { return connection.peer !== undefined && tokens.active(connection.peer) } catch { return false }
  }
  /** Everything that keeps a session from moving to another directory except its own running turn and queue. */
  function busyAside(id: SessionId) {
    return Boolean(
      options.info && !["native", "faux"].includes(options.info.engine) ||
      store.pendingRequestsOf(id).length ||
      background.forSession(id).list().some((task) => task.status === "running") ||
      interactive.running(id) > 0 ||
      ["active", "paused", "blocked"].includes(store.goals.current(id)?.goal.status ?? "") ||
      loops.list(store.sessionDirectory(id)).some((loop) => ["active", "running", "needs_input", "verifying"].includes(loop.state)) ||
      store.workflows.all().some((run) => run.directory === store.sessionDirectory(id) && ["running", "needs_input", "verifying"].includes(run.state))
    )
  }
  /** The `worktree` tool's view of one session: creating, entering and leaving a git worktree workspace. */
  function worktreePort(sessionId: SessionId) {
    const service = projectRestService()
    return createWorktreePort({ sessionId, store, dataDir: options.dir, settings: () => store.settings.get(), host: { run: (directory, request, signal) => service.run(directory, request, signal), warpInTurn: (input) => service.warpInTurn(input) } })
  }
  let projectRest: ReturnType<typeof createProjectRest> | undefined
  function projectRestService() {
    return projectRest ??= createProjectRest({
      dir: options.dir, defaultDirectory: options.defaultDirectory ?? process.cwd(), store, workspaces: workspaceCatalog, manager: worktrees,
      occupied: (directory) => store.listSessions({ directory, roots: false, archived: true, limit: 1 }).length > 0 || loops.list(directory).length > 0 || store.workflows.all().some((run) => run.directory === directory),
      busy: (id) => Boolean(actors.get(id)?.snapshot().turnId || store.lastTurnStatus(id) === "running" || store.queueOf(id).length || busyAside(id)),
      busyAside,
      // A move during the session's own turn (the `worktree` tool) keeps the turn and drops only the approvals.
      settle: (id) => grants.revoke(id, "all"),
      release: (id) => {
        actors.delete(id)
        sessionScopes.get(id)?.dispose()
        sessionScopes.delete(id)
        scheduler.setForegroundBusy(id, false)
        continuity.cancelSession(id)
        secrets.drop(id)
        grants.revoke(id, "all")
      },
      publish: (event) => {
        publishServerEvent(event)
        for (const connection of connections) {
          const cursor = connection.subscriptions.get(event.sessionId)
          if (cursor === undefined || event.seq <= cursor) continue
          connection.subscriptions.set(event.sessionId, event.seq)
          send(connection, { v: PROTOCOL_VERSION, kind: "event", body: event })
        }
      },
      changed: (id) => publishActivity(id, "idle", true),
      updated: (project) => {
        const event = JSON.parse(redactSecrets(JSON.stringify({ directory: project.worktree, payload: { id: ids("command"), type: "project.updated", properties: project } })).text) as import("@mendcode/protocol").RestServerEvent
        for (const observe of serverEventObservers) observe(event)
      },
    })
  }
  /** Whether `directory` is, or lies inside, the folder of a session or the daemon's default folder (symlinks resolved, either spelling). */
  function knownProjectDirectory(directory: string): boolean {
    const known = (candidate: string) => store.listSessions({ directory: candidate, limit: 1, roots: false, archived: true }).length > 0
    const defaults = canonicalDir(options.defaultDirectory ?? process.cwd())
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      if (canonicalDir(current) === defaults || known(current) || known(canonicalDir(current))) return true
      if (path.dirname(current) === current) return false
    }
  }

  const peerOrigin = createPeerOrigin({ descendants: options.agentOrigin?.descendants === true })
  const agentGate = createAgentGate({ modeOf: (sessionId) => (store.hasSession(sessionId) ? livePermission(sessionId) : undefined) })

  async function handleOnce(connection: Connection, command: Command) {
    if (connection.rejected) return
    if (connection.remoteAddress && !activePeer(connection)) return rejectRemote(connection, "unauthorized", command.id)
    if ((connection.remoteAddress || connection.peer) && command.type.startsWith("memory.")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: memory is local only" })
    if (connection.peer?.readOnly && !isReadOnlyCommand(command.type)) {
      return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "forbidden", message: "read-only token" } })
    }
    if ((connection.remoteAddress || connection.peer) && remoteExecutionCommand(command.type)) {
      return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: execution resources are managed locally" })
    }
    // A client a session started from its own shell never changes permissions, settings or another session's authority.
    if (connection.agent && command.type !== "hello") {
      const refusal = agentGate.check(connection.agent, command)
      if (refusal) return reply(connection, command.id, { ok: false, code: "forbidden", message: refusal })
    }
    // A read-only peer observes projects the daemon already knows; it cannot point a read at any other folder of the machine.
    if (connection.peer?.readOnly && command.type !== "hello" && command.type !== "session.list" && "directory" in command && typeof command.directory === "string" && !knownProjectDirectory(command.directory)) {
      return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "forbidden", message: "read-only token: directory is not a known project" } })
    }
    const targetSessionId = "sessionId" in command ? command.sessionId : undefined
    const targetDirectory = "directory" in command ? command.directory : targetSessionId ? store.sessionDirectory(targetSessionId) : connection.directory
    if (targetDirectory && projectRest?.locked(targetDirectory) && command.type !== "project.rest" && !isReadOnlyCommand(command.type)) return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "busy", message: "Project mutation in progress" } })
    if ((disposingGlobal || targetDirectory && disposingDirectories.has(canonicalDir(targetDirectory))) && !isReadOnlyCommand(command.type) && !inflight.has(cacheKey(connection, command.id))) return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "busy", message: "Instance disposal in progress" } })
    if (connection.directory && command.type !== "hello") {
      const directory = "directory" in command ? command.directory : undefined
      const sessionId = "sessionId" in command ? command.sessionId : undefined
      const parentId = "parentId" in command ? command.parentId : undefined
      const sessionDirectory = sessionId ? store.sessionDirectory(sessionId) : undefined
      const parentDirectory = parentId ? store.sessionDirectory(parentId) : undefined
      const workflowId = "workflowId" in command ? command.workflowId : undefined
      const workflowDirectory = workflowId ? store.workflows.all().find((run) => run.workflowId === workflowId)?.directory : undefined
      if (workflowDirectory && canonicalDir(workflowDirectory) !== connection.directory) return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "target_mismatch", message: "workflow outside selected workspace" } })
      if (directory && command.type !== "workspace.create" && canonicalDir(directory) !== connection.directory || sessionDirectory && canonicalDir(sessionDirectory) !== connection.directory || parentDirectory && canonicalDir(parentDirectory) !== connection.directory) {
        return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "target_mismatch", message: "session or directory outside selected workspace" } })
      }
      if (directory && command.type !== "workspace.create") command = { ...command, directory: connection.directory } as Command
      if (command.type === "session.list" && !command.directory) command = { ...command, directory: connection.directory }
    }
    if (command.type === "hello") return handle(connection, command)
    if (!connection.clientId || command.clientId !== connection.clientId) {
      return send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "invalid_command", message: "hello required with matching client id" } })
    }
    if (command.type === "trace.configure") return handle(connection, command)
    const key = cacheKey(connection, command.id)
    const running = inflight.get(key)
    if (running) {
      await running
      const cached = recentCommands.get(cacheKey(connection, command.id))
      if (cached) send(connection, cached)
      return
    }
    // Sends with the same `clientRequestId` run one after another: a retry that arrives while the first still runs waits for its
    // answer (`submitRequests`) instead of queueing the message a second time.
    const requestKey = command.type === "user.submit" && command.clientRequestId ? `${command.sessionId}:${command.clientRequestId}` : undefined
    const sameRequest = requestKey ? submitsInflight.get(requestKey) : undefined
    if (sameRequest) await sameRequest.catch(() => {})
    const span = command.type.startsWith("trace.") ? undefined : trace.start("daemon.command", { commandId: command.id, ...("sessionId" in command && command.sessionId ? { sessionId: command.sessionId } : {}), backlog: connection.backlog }, command.type)
    const task = handle(connection, command)
    inflight.set(key, task)
    if (requestKey) submitsInflight.set(requestKey, task)
    try {
      await task
      span?.end(recentCommands.get(key)?.kind === "error" ? "error" : "ok")
    } catch (error) {
      span?.end("error")
      throw error
    } finally {
      inflight.delete(key)
      if (requestKey && submitsInflight.get(requestKey) === task) submitsInflight.delete(requestKey)
    }
  }

  const sessionAutomation = createSessionAutomation({ store, foreground: (id) => actors.get(id)?.snapshot().foreground, loops: () => loops.list(), tasks: (id) => tasks.list(id) })
  const loopControl = createLoopControl({ service: loops, create: createLoop, now: clock.now, children: (id) => tasks.list(id).map((task) => ({ sessionId: task.taskId, title: task.description, state: task.state })) })
  const restSessions = createRestSessions({ dir: options.dir, store, permissions: sessionPermissions, now: () => clock.now(), detail: sessionAutomation.detail, actor: actorFor, mask: (id, text) => secrets.mask(id, text),
  changes: (id, itemId) => { const outcome = history.changes({ sessionId: id, ...(itemId ? { atItemId: itemId } : {}) }); return outcome.ok ? outcome.result : undefined },
  model: (id) => {
    if (!options.models?.selectable) return undefined
    const choice = resolveModel({ role: "main", session: store.sessionModel(id), roles: rolesFor(store.settings.get(), store.sessionDirectory(id)), catalog: options.models })
    const info = catalogModel(options.models, choice.model)
    if (!info) return undefined
    return { providerID: info.provider ?? "openai", modelID: info.provider && choice.model.startsWith(`${info.provider}:`) ? choice.model.slice(info.provider.length + 1) : choice.model, ...(choice.variant ? { variant: choice.variant } : {}) }
  } })
  sessionObservers.push(restSessions.observe)

  /** The harness that keeps this session's request itself (Claude Code, Codex), by the model it runs on; undefined for the daemon's own engine. */
  function harnessOf(sessionId: SessionId): { name: string; model: string } | undefined {
    if (!options.models) return undefined
    const choice = resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(sessionId)), catalog: options.models })
    const engineName = modelEngine(choice, options.models)
    return engineName === "claude" ? { name: "Claude Code", model: choice.model } : engineName === "codex" ? { name: "Codex", model: choice.model } : undefined
  }

  /** `/context` for a harness session: its last call's measured context and MendCode's transcript of the turns (`harness-context.ts`). */
  function harnessReport(sessionId: SessionId, harness: { name: string; model: string }): ContextReport {
    const lastUsage = store.recentUsage(sessionId, 1)[0]
    const info = catalogModel(options.models!, harness.model)
    const { turns } = history.portableTurns({ sessionId, turns: store.turns.list(sessionId).filter((turn) => !turn.reverted), maxChars: HARNESS_CONTEXT_CHARS, keepFirst: false })
    const contextWindow = readContextWindow(store.meta, sessionId) ?? lastUsage?.contextWindow ?? info?.contextWindow
    return harnessContextReport({ harness: harness.name, model: harness.model, turns, lastUsage, contextWindow, compactAtTokens: lastUsage?.compactAt ?? contextWindow ?? DEFAULT_COMPACT_AT_TOKENS })
  }
  const restMutations = createRestMutations({ store, messages: restSessions.messages, apply: (command) => messageMutations.apply(command) })

  const fileFrecency = createFileFrecency(options.dir)
  const serverConfigExtras = createServerConfigExtras({ dir: options.dir, changed: ({ mcp, plugin, directory }) => {
    extensions.invalidateAll()
    if (mcp) options.mcp?.invalidate?.(directory)
    if (plugin && directory) void uiReload.reload(directory).catch(() => {})
  } })
  const serverControl = createServerControl({ store, catalog, extras: serverConfigExtras,
    logLevel: () => options.logLevel ?? store.settings.get().logLevel ?? "INFO",
    log: options.log ?? ((level, message) => void process.stderr.write(`${level.toUpperCase()} ${message}\n`)),
    changed: (settings, patch) => {
      globalSink.append({ type: "settings.changed", settings })
      extensions.invalidateAll()
      options.mcp?.invalidate?.()
      armDreamSchedule("dreamAt" in patch)
      extraction.wake()
      armRetentionSchedule()
    },
    upgraded: (version) => void globalSink.append({ type: "server.lifecycle", change: "upgraded", version }),
    ...(options.runtimeUpgrade ? { upgrade: options.runtimeUpgrade } : {}),
  })

  async function disposeInstances(directory?: string) {
    const matches = (value: string) => !directory || canonicalDir(value) === directory
    // An orchestrator would immediately recreate its actors. Require it to be stopped explicitly first.
    if (loops.list().some((loop) => matches(loop.directory) && ["active", "running", "needs_input", "verifying"].includes(loop.state)) || store.workflows.all().some((run) => matches(run.directory) && ["running", "needs_input", "verifying"].includes(run.state)) || store.dreamRuns.list(directory).some((run) => run.status === "running")) return false
    if (directory) disposingDirectories.add(directory)
    else disposingGlobal = true
    try {
      const selected = [...actors].filter(([id]) => matches(store.sessionDirectory(id) ?? ""))
      const sessions = new Set([...selected.map(([id]) => id), ...background.listAll().map((entry) => entry.sessionId as SessionId)])
      for (const id of sessions) if (matches(store.sessionDirectory(id) ?? "")) { background.killSession(id); interactive.killSession(id) }
      if (!directory) memoryAssistant.stop()
      else if (memoryAssistant.get(directory).busy) memoryAssistant.cancel(directory)
      await Promise.all(selected.map(([, actor]) => actor.interrupt("restart")))
      const deadline = Date.now() + (options.cancelGraceMs ?? 5_000) + 250
      while (selected.some(([, actor]) => actor.snapshot().turnId)) {
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      for (const [id, actor] of selected) if (actors.get(id) === actor) {
        actors.delete(id)
        sessionScopes.get(id)?.dispose()
        sessionScopes.delete(id)
        scheduler.setForegroundBusy(id, false)
        activity.forget(id)
      }
      extensions.invalidateAll()
      options.mcp?.invalidate?.(directory)
      pty.dispose(directory)
      globalSink.append({ type: "server.lifecycle", change: "disposed", ...(directory ? { directory } : {}) })
      return true
    } finally {
      if (directory) disposingDirectories.delete(directory)
      else disposingGlobal = false
    }
  }

  async function handle(connection: Connection, command: Command) {
    if (command.type === "hello") {
      if (!isCompatibleVersion(command.protocolVersion)) {
        send(connection, { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "protocol_version", message: "[DAEMON]: unsupported protocol version", supported: [PROTOCOL_VERSION] } })
        return connection.socket.end()
      }
      connection.clientId = command.clientId
      // What the client says of itself can add the agent-origin restriction, never lift the one the socket's peer earned.
      connection.agent ??= peerOrigin.declared(command.capabilities)
      connection.dialogs = !connection.remoteAddress && !connection.peer && command.capabilities.includes(DIALOGS_CAPABILITY)
      reply(connection, command.id, { ok: true, result: { protocolVersion: PROTOCOL_VERSION, buildId: options.buildId ?? "unknown", directory: connection.directory ?? options.defaultDirectory ?? process.cwd(), ...(connection.peer ? { remote: { address: connection.remoteAddress, tokenName: connection.peer.name, readOnly: connection.peer.readOnly } } : {}) } })
      // A new terminal shows the last known quota immediately instead of waiting for the next response.
      for (const quota of store.latestQuota()) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: quota })
      // The code graph's last counts per project (a local terminal's footer); none is computed here.
      if (!connection.remoteAddress && !connection.peer) for (const status of options.codegraphStatus?.snapshot() ?? []) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: codegraphEvent(status) })
      // Whether the graph indexes this terminal's folder, so its footer can say a skip before the first turn; measured once, in the background.
      if (!connection.remoteAddress && !connection.peer && connection.directory) void publishGraphGate(connection.directory)
      send(connection, { v: PROTOCOL_VERSION, kind: "global", body: usageToday.snapshot() })
      const update = releases.notice()
      if (update) send(connection, { v: PROTOCOL_VERSION, kind: "global", body: { type: "release.available", gseq: 0, at: clock.now(), ...update } })
      return
    }
    const cached = recentCommands.get(cacheKey(connection, command.id))
    if (cached && command.type !== "trace.configure") return send(connection, cached)
    if (!connection.clientId) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: hello required first" })
    switch (command.type) {
      case "tui.control.register":
      case "tui.control.send":
      case "tui.control.next":
      case "tui.control.response": {
        if (connection.remoteAddress && connection.remoteAddress !== "http" && !isLoopbackHost(connection.remoteAddress)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "TUI control is loopback only" })
        const directory = canonicalDir(command.directory)
        const key = connection.signal && connection.peer ? `http:${connection.peer.hash}` : connection
        if (command.type === "tui.control.register") {
          if (connection.signal) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "TUI registration requires a persistent client" })
          return reply(connection, command.id, tuiRequests.register(directory, connection, command.enabled, (request) => send(connection, { v: PROTOCOL_VERSION, kind: "global", body: { type: "tui.control.request", directory, ...request, gseq: 0, at: clock.now() } })))
        }
        if (command.type === "tui.control.next") return reply(connection, command.id, await tuiRequests.next(directory, key, command.timeoutMs, connection.signal, connection.peer ? () => activePeer(connection) : undefined))
        if (command.type === "tui.control.response") {
          if (!command.requestID && typeof key !== "string") return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Native TUI responses require requestID" })
          return reply(connection, command.id, tuiRequests.respond(directory, key, command.requestID, command.response))
        }
        const request = command.request
        const selected = request.path === "/tui/select-session" ? request.body.sessionID : request.path === "/tui/publish" && request.body.type === "tui.session.select" ? request.body.properties.sessionID : undefined
        if (selected) {
          const target = store.sessionDirectory(selected)
          if (!target) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "Unknown session" })
          if (canonicalDir(target) !== directory) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "Session outside selected TUI project" })
        }
        return reply(connection, command.id, await tuiRequests.send(directory, command.id, request, connection.signal))
      }
      case "session.message.delete":
      case "session.part.delete":
      case "session.part.update":
        return reply(connection, command.id, messageMutations.apply(command))
      case "trace.configure":
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: trace configuration is local-only" })
        connection.trace = command.enabled
        return reply(connection, command.id, { ok: true, result: trace.report() })
      case "trace.query":
        return reply(connection, command.id, { ok: true, result: trace.report(command.sessionId, command.limit) })
      case "trace.record":
        if (connection.remoteAddress || !connection.trace) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: trace recording requires a local opted-in client" })
        trace.sample(command.sample)
        return reply(connection, command.id, { ok: true })
      case "mflow.query":
      case "mflow.change":
      case "mflow.lease": {
        try {
          const result = command.type === "mflow.query" ? await mflow.query(command.directory, command.query)
            : command.type === "mflow.change" ? await mflow.change(command.directory, command.change)
            : await mflow.lease(command.directory, `client:${connection.peer?.name ?? "unix"}:${command.clientId}`, command.lease)
          return reply(connection, command.id, { ok: true, result })
        } catch { return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Mflow request failed; check configuration, relay and lease ownership" }) }
      }
      case "prompt.status":
      case "prompt.sources":
      case "prompt.set":
      case "prompt.cycle":
      case "prompt.build":
        try {
          if (command.type === "prompt.status") return reply(connection, command.id, { ok: true, result: promptModes.status(command.directory, command.modelID) })
          if (command.type === "prompt.sources") return reply(connection, command.id, { ok: true, result: promptModes.sources(command.directory, command.modelID) })
          if (command.type === "prompt.set") return reply(connection, command.id, { ok: true, result: promptModes.set(command.directory, { ...(command.mode ? { mode: command.mode } : {}), ...(command.focusID ? { focusID: command.focusID } : {}) }) })
          if (command.type === "prompt.cycle") return reply(connection, command.id, { ok: true, result: promptModes.cycle(command.directory) })
          const packaged = await (promptPackaged ??= loadSystemPrompt())
          const directory = promptModes.status(command.directory).directory
          const mode = command.mode ?? "focus"
          const skillBlock = skills.block(directory)
          const parts = systemPartsWith({ root: directory, packaged, files: promptFilesFor(mode, extensions.prompts.read(directory)), rest: [{ id: "instructions", label: "project instructions", text: promptInstructions(directory) }, { id: "skills", label: "skills", text: skillBlock }] })
          const composed = composePromptParts(options.dir, directory, parts, { mode, fallbackModelID: promptModel(directory), ...(command.focusID ? { focusID: command.focusID } : {}), ...(command.modelID ? { modelID: command.modelID } : {}), ...(command.role ? { role: command.role } : {}), ...(command.workflow ? { workflow: command.workflow } : {}) })
          return reply(connection, command.id, { ok: true, result: promptBuildReport(composed, command) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) })
        }
      case "tui.query":
      case "tui.change":
        try {
          // The probe spends the user's quota: only a local terminal may add providers to `quotaRefresh` (a remote peer may still turn it off or leave it alone).
          if (command.type === "tui.change" && (connection.remoteAddress || connection.peer) && ["apply", "apply-preset", "rollback"].includes(command.input.operation)) {
            const planned = tuiControl.run({ ...command.input, dryRun: true }).profile.quotaRefresh
            const current = JSON.stringify(normalizeQuotaRefresh(tuiControl.run({ operation: "profile" }).profile.quotaRefresh))
            if (normalizeQuotaRefresh(planned).length && JSON.stringify(normalizeQuotaRefresh(planned)) !== current) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: quota refresh spends this machine's quota: turn it on from a local terminal" })
          }
          const result = tuiControl.run(command.type === "tui.query" ? { operation: command.operation } : command.input)
          if (result.backupId) globalSink.append({ type: "tui.changed", profile: result.profile as Record<string, never> })
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) })
        }
      case "session.create": {
        if (!connection.remoteAddress && !connection.peer) void publishGraphGate(command.directory)
        if ((connection.remoteAddress || connection.peer) && command.choice && ["opencode", "cursor"].includes(command.choice.model.split(":")[0]!)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: this engine runs local tools and is local only" })
        let selectedAgent = command.agent
        if (!selectedAgent) {
          const settings = store.settings.get()
          const agent = settings.projectConfig?.[canonicalDir(command.directory)]?.defaultAgent ?? settings.defaultAgent
          if (agent && !agents.selectable(command.directory, agent)) selectedAgent = agent
        }
        if (command.parentId && !store.hasSession(command.parentId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown parent session" })
        const problem = (command.choice ? invalidChoice(command.choice, options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }) : undefined) ?? (selectedAgent ? agents.selectable(command.directory, selectedAgent) : undefined)
        if (problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` })
        try { selectedAgent ??= agents.defaultName(command.directory) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${error instanceof Error ? error.message : String(error)}` }) }
        if (command.reuseEmpty && !command.parentId && !command.title && !command.choice && !command.agent) {
          const spare = takeEmptySession(command.directory)
          if (spare) return reply(connection, command.id, { ok: true, result: { sessionId: spare, reused: true } })
        }
        const id = ids("session")
        store.createSession({ id, directory: command.directory, title: command.title ?? "", ...(command.parentId ? { parentId: command.parentId } : {}) })
        // Made on purpose by an API client: never reused, hidden or removed as an empty chat.
        if (!command.reuseEmpty && !command.title) store.emptySessions.markExplicit(id)
        if (command.reuseEmpty && !command.title && !command.choice && !command.agent && !command.parentId) quietEmpties.add(id)
        sessionSharing.created(id)
        if (command.title) store.meta.set(`session.title.manual:${id}`, "true")
        if (command.choice) store.setSessionModel(id, command.choice)
        if (selectedAgent && selectedAgent !== "plan" && selectedAgent !== "build") store.setSessionAgent(id, selectedAgent)
        announceSession(id, command.directory, command.parentId)
        const actor = actorFor(id)
        publishActivity(id, "idle", true)
        // New sessions start in the user's default permission mode, recorded as a normal event.
        const usual = selectedAgent === "plan" ? "plan" : defaultPermissionFor(store.settings.get(), command.directory)
        // A session started from a session's shell never begins with more authority than the session that started it.
        const mode = connection.agent ? agentGate.cap(connection.agent, usual ?? "ask") : usual
        if (connection.agent) agentGate.started(connection.agent, id)
        if (actor && mode && mode !== "ask") await actor.handle({ id: command.id, clientId: command.clientId, type: "session.permission.set", sessionId: id, mode })
        return reply(connection, command.id, { ok: true, result: { sessionId: id } })
      }
      case "session.fork": {
        const source = store.sessionInfo(command.sessionId)
        if (!source) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (command.handoffGoal !== undefined) {
          if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Handoff context is local only" })
          if (!featureOn(store.settings.get(), "handoff")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Enable handoff with /tier handoff on (balanced tier)" })
          if (command.atItemId || command.beforeItemId || command.transcript || command.readOnly) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Handoff cannot select a fork point or side chat" })
          if (actors.get(command.sessionId)?.snapshot().foreground !== undefined && actors.get(command.sessionId)?.snapshot().foreground !== "idle") return reply(connection, command.id, { ok: false, code: "busy", message: "Wait for the current turn before handing off" })
          const safeGoal = captured(command.sessionId, command.handoffGoal)
          if ("ok" in safeGoal) return reply(connection, command.id, safeGoal)
          const recent = history.portableTurns({ sessionId: command.sessionId, turns: store.turns.list(command.sessionId).filter((turn) => !turn.reverted), maxChars: 16_000, keepFirst: true })
          const context = planHandoff({ turns: recent.turns, skipped: recent.skipped, capTokens: 3000, fromStart: true, sessionId: command.sessionId }).body
          const first = store.engineMessages.first(command.sessionId, "native") as import("@mendcode/engine-native").ModelMessage | undefined
          const seed = focusedHandoff(first ? [first] : [], safeGoal.text, context, store.limitCheckpoints.get(command.sessionId)?.summary)
          const id = ids("session")
          store.createSession({ id, directory: source.directory, title: `handoff: ${safeGoal.text}`.slice(0, 200) })
          store.handoff.queueContext({ sessionId: id, fromSessionId: command.sessionId, title: "Focused handoff", text: seed })
          store.sessionTree.recordFork({ sessionId: id, parentId: command.sessionId })
          store.setSessionModel(id, store.sessionModel(command.sessionId))
          store.setSessionAgent(id, store.sessionAgent(command.sessionId))
          announceSession(id, source.directory)
          const actor = actorFor(id)
          const mode = store.permissionModeOf(command.sessionId)
          if (actor && mode !== "ask") await actor.handle({ id: command.id, clientId: command.clientId, type: "session.permission.set", sessionId: id, mode })
          return reply(connection, command.id, { ok: true, result: { sessionId: id, tokens: estimateTokens(seed.length) } })
        }
        // A fork at a message is checked before anything is created: a refused one leaves no empty session behind.
        if (command.atItemId && command.beforeItemId) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: use atItemId or beforeItemId" })
        const entries = command.transcript ? history.timeline(command.sessionId) : undefined
        const target = command.atItemId ?? (command.transcript && entries?.ok ? entries.result.entries.filter((entry) => !entry.reverted).at(-1)?.itemId : undefined)
        const point = command.beforeItemId ? history.forkBefore({ sessionId: command.sessionId, itemId: command.beforeItemId }) : target ? history.forkPoint({ sessionId: command.sessionId, itemId: target }) : undefined
        if (point && !point.ok) return reply(connection, command.id, point)
        const id = ids("session")
        const title = command.title ?? (command.readOnly ? `side: ${source.title || "untitled"}` : `fork: ${source.title || "untitled"}`)
        store.createSession({ id, directory: source.directory, title: title.slice(0, 200) })
        store.meta.set(`session.title.manual:${id}`, "true")
        let branch: ReturnType<typeof store.forkConversation> | undefined
        try {
          branch = point?.ok && point.result.turnId ? store.forkConversation(command.sessionId, id, { throughTurnId: point.result.turnId, cuts: point.result.cuts, ...("beforeSeq" in point.result && point.result.beforeSeq !== undefined ? { beforeSeq: point.result.beforeSeq } : {}) }) : undefined
        } catch (error) {
          // The point was checked above, so this is a store fault: leave no half-made session behind.
          store.deleteSession(id)
          return reply(connection, command.id, { ok: false, code: "internal", message: `[DAEMON]: fork failed: ${error instanceof Error ? error.message : String(error)}` })
        }
        const copied = branch ? branch.messages : command.beforeItemId ? 0 : store.copyConversation(command.sessionId, id)
        store.sessionTree.recordFork({ sessionId: id, parentId: command.sessionId, ...(target ? { atItemId: target, atPreview: store.turns.byItem(command.sessionId, target)?.preview ?? "" } : {}) })
        const carried = history.timeline(id)
        if (carried.ok) store.sessionTree.copyLabels(command.sessionId, id, new Set(carried.result.entries.map((entry) => entry.itemId)))
        if (command.transcript || command.beforeItemId) {
          store.setSessionModel(id, store.sessionModel(command.sessionId))
          store.setSessionAgent(id, store.sessionAgent(command.sessionId))
        }
        // Claude Code and ACP agents keep their conversation themselves and it is not forked: the fork's first turn on one hands over the copied transcript, within the handoff cap.
        portable.inherit({ parent: command.sessionId, fork: id })
        announceSession(id, source.directory)
        const actor = actorFor(id)
        publishActivity(id, "idle", true)
        // A side chat reads and answers only; a plain fork keeps the source's permission mode.
        const kept = command.readOnly ? "plan" : store.permissionModeOf(command.sessionId)
        const mode = connection.agent ? agentGate.cap(connection.agent, kept) : kept
        if (connection.agent) agentGate.started(connection.agent, id)
        if (actor && mode !== "ask") await actor.handle({ id: command.id, clientId: command.clientId, type: "session.permission.set", sessionId: id, mode })
        return reply(connection, command.id, { ok: true, result: { sessionId: id, copied, ...(branch ? { events: branch.events } : {}) } })
      }
      case "session.undo": {
        if (command.cancelRunning) {
          const actor = actors.get(command.sessionId)
          const turnId = actor?.snapshot().turnId
          if (actor && turnId) {
            await actor.handle({ id: ids("command"), clientId: command.clientId, type: "turn.cancel", sessionId: command.sessionId, turnId })
            const deadline = Date.now() + (options.cancelGraceMs ?? 5000) + 250
            while (actor.snapshot().turnId === turnId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        const undone = history.undo({ sessionId: command.sessionId, force: command.force, clientId: command.clientId, atItemId: command.atItemId, atPartId: command.atPartId })
        // Claude Code keeps its own conversation: it is cut before the undone message too, so the model forgets it as MendCode does.
        if (undone.ok && !undone.result.history.tracked && store.engineBindings.get(command.sessionId, "claude") !== undefined && engine.rewind) {
          const first = undone.result.itemId ? store.turns.byItem(command.sessionId, undone.result.itemId)?.turnId : undone.result.turnIds.length === 1 ? undone.result.turnIds[0] : undefined
          if (first && await engine.rewind({ sessionId: command.sessionId, turnId: first as Parameters<NonNullable<typeof engine.rewind>>[0]["turnId"] }).catch(() => false)) {
            const notes = undone.result.notes.filter((note) => !note.startsWith("The model's history lives in an external engine"))
            if (store.engineBindings.get(command.sessionId, "codex") === undefined) return reply(connection, command.id, { ok: true, result: { ...undone.result, notes, history: { ...undone.result.history, tracked: true } } })
          }
        }
        return reply(connection, command.id, undone)
      }
      case "session.redo":
        return reply(connection, command.id, history.redo({ sessionId: command.sessionId, force: command.force, clientId: command.clientId, all: command.all }))
      case "session.history":
        return reply(connection, command.id, readSessionHistory(store, command))
      case "session.timeline":
        return reply(connection, command.id, history.timeline(command.sessionId))
      case "session.tree": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        // The tree of a sub-agent starts at the session that started it, so its siblings and parent show.
        let anchor: SessionId = command.sessionId
        for (let hops = 0; hops < 12; hops++) {
          const parent = store.sessionInfo(anchor)?.parentId as SessionId | undefined
          if (!parent || !store.hasSession(parent)) break
          anchor = parent
        }
        const modelOf = (id: SessionId) => resolveModel({ role: "main", session: store.sessionModel(id), roles: rolesFor(store.settings.get(), store.sessionDirectory(id)), catalog }).model
        const stateOf = (id: SessionId) => ((actors.get(id)?.snapshot().foreground ?? "idle") === "idle" ? "idle" : "running")
        const family = store.sessionTree.family(anchor)
        const nodes: Array<Record<string, unknown>> = family.map((node, index) => ({
          ...node,
          current: node.sessionId === command.sessionId,
          labels: store.sessionTree.labels(node.sessionId).slice(0, 200).map((label) => ({ itemId: label.itemId, label: label.label, preview: store.turns.byItem(node.sessionId, label.itemId)?.preview ?? "" })),
          kind: "fork",
          model: modelOf(node.sessionId),
          state: stateOf(node.sessionId),
          ...(node.parentId && index < TREE_MERGE_COUNTS ? { unmerged: portable.unmerged(node.sessionId) } : {}),
        }))
        // Daemon-owned tasks and bridge-created sessions share one bounded lineage. A peer sees no result text.
        const known = new Set(family.map((node) => node.sessionId as string))
        const local = !connection.remoteAddress && !connection.peer
        const addTasks = (parent: SessionId, depth: number) => {
          if (depth > TREE_TASK_DEPTH) return
          const childTasks = new Map(tasks.list(parent).map((task) => [task.taskId, task]))
          for (const id of store.sessionChildren(parent).slice(0, TREE_NODES)) {
            if (nodes.length >= TREE_NODES) break
            if (!known.has(id)) {
              known.add(id)
              const info = store.sessionSummary(id)!
              const task = childTasks.get(id)
              const bridgeChild = Boolean(store.meta.get(`orchestration.lineage:${id}`))
              const last = store.lastTurnStatus(id)
              const state = task?.state ?? (store.pendingRequestsOf(id).length ? "needs_input" : stateOf(id) === "running" ? "running" : last ?? "idle")
              let result = task?.result ?? ""
              if (local && bridgeChild && !task) {
                const events = store.readAfter(id, Math.max(0, (store.lastSeq(id) ?? 0) - 200), 200)
                const answer = events.findLast((event) => event.type === "item.completed" && store.itemStart(id, event.itemId)?.kind === "agent_message")
                if (answer?.type === "item.completed") result = answer.text ?? ""
              }
              const headline = local ? oneLine(secrets.mask(id, result).split("\n").find((line) => line.trim()) ?? "", 160) : ""
              nodes.push({
                sessionId: id, parentId: parent, title: task?.description ?? info.title, directory: info.directory, createdAt: info.createdAt, updatedAt: info.updatedAt, archived: info.archivedAt !== undefined,
                current: id === command.sessionId, labels: [], kind: task || bridgeChild ? "task" : "fork", model: modelOf(id), state,
                ...(task ? { agent: task.agent, description: task.description } : {}),
                ...(headline ? { headline } : {}),
              })
              addTasks(id, depth + 1)
            }
          }
        }
        for (const node of family) addTasks(node.sessionId, 1)
        return reply(connection, command.id, { ok: true, result: { current: command.sessionId, nodes } })
      }
      case "session.merge": {
        // Merge-back reads one session's transcript and writes context into another: this machine's user only.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: merge reads local sessions and is local only" })
        const merged = portable.merge({ fork: command.sessionId, ...(command.intoSessionId ? { into: command.intoSessionId } : {}) })
        return reply(connection, command.id, merged.ok ? { ok: true, result: merged.result } : merged)
      }
      case "session.label": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const turn = store.turns.byItem(command.sessionId, command.itemId)
        if (!turn || turn.notice) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: that item is not a user message of this session" })
        const label = store.sessionTree.setLabel(command.sessionId, command.itemId, redactSecrets(command.label ?? "").text)
        return reply(connection, command.id, { ok: true, result: { itemId: command.itemId, ...(label ? { label } : {}) } })
      }
      case "session.recap": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const last = store.lastSeq(command.sessionId) ?? 0
        const cached = command.refresh ? undefined : store.sessionTree.recap(command.sessionId, last)
        if (cached) return reply(connection, command.id, { ok: true, result: { text: cached.text, at: cached.updatedAt, cached: true } })
        if (!options.complete) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: recap needs the native engine" })
        const prompt = recapPrompt(visibleEvents(store.readAfter(command.sessionId, Math.max(0, last - 4_000), 4_000)))
        if (!prompt) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: nothing to recap yet" })
        const roles = rolesFor(store.settings.get(), store.sessionInfo(command.sessionId)?.directory)
        const model = options.models?.selectable ? resolveModel({ role: "aside", session: store.sessionModel(command.sessionId), roles, catalog: options.models }) : undefined
        try {
          const text = recapText(redactSecrets(await completeBudgeted!({ system: RECAP_SYSTEM, prompt, signal: AbortSignal.timeout(RECAP_TIMEOUT_MS), ...(model ? { model } : {}) })).text)
          if (!text) return reply(connection, command.id, { ok: false, code: "internal", message: "[DAEMON]: the model returned an empty recap" })
          store.sessionTree.putRecap(command.sessionId, last, text)
          return reply(connection, command.id, { ok: true, result: { text, at: clock.now(), cached: false } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "internal", message: `[DAEMON]: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}` })
        }
      }
      case "session.export":
        return reply(connection, command.id, history.export(command))
      case "console.get": case "console.listOrgs": case "console.configure": case "console.login": case "console.poll": case "console.cancel": case "console.logout": case "console.switchOrg": case "console.open": case "console.accounts":
      case "session.share.get": case "session.share": case "session.share.sync": case "session.unshare": {
        const consoleHttp = connection.remoteAddress === "http" && ["console.get", "console.listOrgs", "console.switchOrg"].includes(command.type)
        if (connection.remoteAddress && command.type !== "session.share.get" && !consoleHttp) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Console and sharing control is local only" })
        try {
          let result: unknown
          switch (command.type) {
            case "console.get": result = await consoleService.get(); break
            case "console.accounts": result = await consoleService.snapshot(); break
            case "console.listOrgs": result = await consoleService.listOrgs(); break
            case "console.configure": result = await consoleService.configure({ enabled: command.enabled, ...(command.url ? { url: command.url } : {}), ...(command.tokenFile ? { tokenFile: command.tokenFile } : {}) }); break
            case "console.login": result = await consoleService.login(command.url); break
            case "console.poll": result = await consoleService.poll(command.loginID); break
            case "console.cancel": result = await consoleService.cancel(command.loginID); break
            case "console.logout": result = await consoleService.logout(command.accountID); break
            case "console.switchOrg": result = await consoleService.switchOrg(command.accountID, command.orgID); break
            case "console.open": result = await consoleService.open(command.target, command.loginID); break
            case "session.share.get": result = sessionSharing.status(command.sessionId); break
            case "session.share": result = await sessionSharing.create(command.sessionId); break
            case "session.share.sync": result = await sessionSharing.sync(command.sessionId); break
            case "session.unshare": result = await sessionSharing.remove(command.sessionId); break
          }
          return reply(connection, command.id, { ok: true, result: result as Record<string, unknown> })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error && !error.name.startsWith("Zod") ? error.message.slice(0, 500) : "Console operation failed" }) }
      }
      case "session.share.static": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Sharing control is local only" })
        try { return reply(connection, command.id, { ok: true, result: await staticShare.handle(command) as Record<string, unknown> }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[SHARE]: ${redactSecrets(error instanceof Error ? error.message : "Share operation failed").text.slice(0, 500)}` }) }
      }
      case "session.cd": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: changing a session directory is local only" })
        try { return reply(connection, command.id, { ok: true, result: projectRestService().cd(command.sessionId, command.path) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: error instanceof ProjectRestError ? error.code : "invalid_command", message: error instanceof ProjectRestError ? `[DAEMON]: ${error.message}` : "[DAEMON]: directory change failed" }) }
      }
      case "session.import": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[IMPORT]: import reads local files and is local only" })
        const imported = await transfers.import(command)
        if (imported.ok) announceSession(imported.result.sessionId, command.directory)
        return reply(connection, command.id, imported)
      }
      case "setup.import": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[IMPORT]: setup import reads local files and is local only" })
        try {
          const report = await setupImport.run({ directory: command.directory, from: command.from ?? "auto", apply: command.apply === true, ...(command.only ? { only: command.only } : {}) })
          const servers = report.items.filter((item) => item.kind === "mcp" && item.status === "imported")
          if (servers.length) {
            options.mcp?.invalidate?.(undefined)
            options.mcp?.invalidate?.(command.directory)
            for (const server of servers.slice(0, 50)) globalSink.append({ type: "mcp.changed", directory: command.directory, server: server.name })
          }
          return reply(connection, command.id, { ok: true, result: report })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[IMPORT]: ${redactSecrets(error instanceof Error ? error.message : "setup import failed").text.slice(0, 300)}` }) }
      }
      case "client.subscribe": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        subscribe(connection, command.sessionId, command.afterSeq)
        reply(connection, command.id, { ok: true, result: { lastSeq: store.lastSeq(command.sessionId) ?? 0 } })
        // A goal that was active when the daemon stopped goes on once someone opens its session.
        goals.opened(command.sessionId)
        return
      }
      case "client.unsubscribe":
        connection.subscriptions.delete(command.sessionId)
        maybeEvict(command.sessionId)
        return reply(connection, command.id, { ok: true })
      case "user.submit":
      case "user.shell":
      case "queue.promote":
      case "queue.remove":
      case "queue.reorder":
      case "queue.edit":
      case "queue.steer":
      case "queue.list":
      case "turn.cancel":
      case "request.resolve":
      case "session.permission.set":
      case "session.compaction.set":
      case "session.compact": {
        const peer = Boolean(connection.remoteAddress || connection.peer)
        if (peer && ["queue.list", "queue.edit", "queue.reorder", "queue.steer"].includes(command.type)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: queue inspection and editing are local only" })
        if (peer && (command.type === "user.submit" || command.type === "session.compact")) {
          const model = command.type === "user.submit" ? command.selection?.model : command.model
          const selected = model ?? resolveModel({ role: "main", session: store.sessionModel(command.sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(command.sessionId)), catalog })
          if (["pi", "opencode", "cursor"].includes(modelEngine(selected, catalog) ?? "")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: this engine runs local tools and is local only" })
          if (selected.model.startsWith("acp:")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: ACP agents run local tools and are local only" })
        }
        // A retry with the same `clientRequestId` (another command id, e.g. after a reconnect) gets the first answer, never a second queued message.
        const requestKey = command.type === "user.submit" && command.clientRequestId ? `${command.sessionId}:${command.clientRequestId}` : undefined
        const earlier = requestKey ? submitRequests.get(requestKey) : undefined
        if (earlier) return reply(connection, command.id, earlier)
        if (command.type === "request.resolve" && command.decision.kind === "plan_review" && command.decision.action === "apply") {
          const record = readPlanReviews(store, command.sessionId).find((review) => review.requestId === command.requestId)
          const destination = command.decision.destination ?? record?.destination
          const directory = store.sessionDirectory(command.sessionId) ?? ""
          const hidden = destination && agents.report({ directory }).agents.some((agent) => agent.name === destination && agent.trusted && agent.hidden)
          const problem = destination === "plan" ? "plan is not an implementation destination" : hidden ? `agent ${destination} is hidden` : destination ? agents.selectable(directory, destination) : undefined
          if (problem) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${problem}` })
        }
        if (command.type === "request.resolve") {
          const result = extensionDialogs.resolve(command) ?? continuity.resolve(command)
          if (result) return reply(connection, command.id, result)
        }
        const actor = actorFor(command.sessionId)
        if (!actor) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if ((command.type === "user.shell" || command.type === "user.submit") && command.messageId && (store.messages.has(command.sessionId, command.messageId) || store.queueOf(command.sessionId).some((entry) => entry.messageId === command.messageId))) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: message id already exists" })
        // What the user typed or pasted becomes markers before anything sees it: the queue, the log, history, extensions, the model.
        let safe: typeof command = command
        if (command.type === "request.resolve" && command.decision.kind === "approve" && (command.decision.memoryText !== undefined || command.decision.memoryAlways !== undefined)) {
          const pending = interactions.get(command.requestId)
          if (connection.remoteAddress || connection.peer || pending?.sessionId !== command.sessionId || pending.title !== "Save to memory?" || !["memory", "memory_graph", "remember"].includes(pending.tool ?? "")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: memory decisions require a local memory approval" })
          if (command.decision.memoryText !== undefined) {
            const swapped = captured(command.sessionId, command.decision.memoryText)
            if ("ok" in swapped) return reply(connection, command.id, swapped)
            safe = { ...command, decision: { ...command.decision, memoryText: swapped.text } }
          }
        }
        // A settings change the model proposed that names a key only a local terminal sets is answered there, as `settings.set` would be.
        if (command.type === "request.resolve" && command.decision.kind === "answer" && (connection.remoteAddress || connection.peer)) {
          const pending = interactions.get(command.requestId)
          if (pending?.kind === "question" && pending.title === SETTINGS_PROPOSAL_LOCAL) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: this settings change names a key only the machine that runs MendCode sets; answer it there" })
        }
        // "Always allow": the rule comes from the pending request itself and is saved only after this answer is accepted.
        let remembered: { level: "project" | "user"; offer: NonNullable<ReturnType<typeof offerFor>> } | undefined
        if (command.type === "request.resolve" && command.decision.kind === "approve" && command.decision.remember) {
          if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: permission rules are saved on the machine that runs the commands" })
          const pending = interactions.get(command.requestId)
          const offer = pending?.sessionId === command.sessionId ? offerFor(pending) : undefined
          if (!offer) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: this request cannot save a rule" })
          remembered = { level: command.decision.remember.level, offer }
          safe = { ...command, decision: { kind: "approve", scope: command.decision.scope } }
        }
        if (command.type === "request.resolve" && command.decision.kind === "deny" && command.decision.reason !== undefined) {
          const swapped = captured(command.sessionId, command.decision.reason)
          if ("ok" in swapped) return reply(connection, command.id, swapped)
          safe = { ...command, decision: { ...command.decision, reason: swapped.text } }
        }
        if (command.type === "request.resolve" && command.decision.kind === "answer") {
          const swapped = captured(command.sessionId, command.decision.text)
          if ("ok" in swapped) return reply(connection, command.id, swapped)
          const answers: string[][] | undefined = command.decision.answers?.map((answer) => answer.map((text) => redactSecrets(text).text))
          safe = { ...command, decision: { ...command.decision, text: swapped.text, ...(answers ? { answers } : {}) } }
        }
        if (command.type === "queue.edit") {
          // The new text is typed by the user like any prompt: pasted secrets become markers.
          const swapped = captured(command.sessionId, command.text)
          if ("ok" in swapped) return reply(connection, command.id, swapped)
          if (swapped.text !== command.text) safe = { ...command, text: swapped.text }
        }
        if (command.type === "request.resolve" && command.decision.kind === "plan_review") {
          const decision = { ...command.decision }
          for (const field of ["markdown", "comments", "reason"] as const) {
            const value = decision[field]
            if (value === undefined) continue
            const swapped = captured(command.sessionId, value)
            if ("ok" in swapped) return reply(connection, command.id, swapped)
            decision[field] = swapped.text
          }
          safe = { ...command, decision }
        }
        if (command.type === "user.submit" || command.type === "user.shell" || command.type === "session.compaction.set") {
          if (command.type === "user.submit") {
            const directory = store.sessionDirectory(command.sessionId)!
            const selected = command.selection?.agent ?? (livePermission(command.sessionId) === "plan" ? "plan" : store.sessionAgent(command.sessionId) ?? "build")
            if (agents.report({ directory }).agents.some((agent) => agent.name === selected && agent.trusted && agent.disable)) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: agent ${selected} is disabled` })
            if (command.attachments?.some((attachment) => attachment.mime.startsWith("image/")) && options.models?.selectable) {
              const catalog = options.models
              const refusal = imageRefusal(command.selection?.model ?? resolveModel({ role: "main", session: store.sessionModel(command.sessionId), roles: rolesFor(store.settings.get(), directory), catalog }), catalog)
              if (refusal) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${refusal}` })
            }
            if (command.turnOptions && Object.keys(command.turnOptions).length) {
              // No model call, tool removal and a required answer shape are only honoured by the native engine: Claude Code, ACP and Codex turns would silently ignore them.
              const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }
              const model = command.selection?.model ?? resolveModel({ role: "main", session: store.sessionModel(command.sessionId), roles: rolesFor(store.settings.get(), directory), catalog })
              if (options.info?.engine !== "native" || modelEngine(model, catalog) || model.model.startsWith("acp:")) return reply(connection, command.id, { ok: false, code: "unsupported", message: "[DAEMON]: per-prompt noReply, tool exclusions and output format need the native engine; this session's model runs on another engine" })
              if (command.turnOptions.format && !structuredValidator(command.turnOptions.format.schema).ok) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: output format is not a supported JSON Schema" })
            }
          }
          if (command.type === "user.submit" && command.selection) {
            const selection = command.selection
            const directory = store.sessionDirectory(command.sessionId)!
            const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }
            const problem = selection.model ? invalidChoice(selection.model, catalog) : undefined
            const agentProblem = selection.agent ? agents.selectable(directory, selection.agent, true) : undefined
            if (problem || agentProblem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem ?? agentProblem}` })
            // Claude Code and ACP sessions and models take per-turn selections too (see external-turn.ts); only an engine that fixes its own model refuses.
            if (options.info?.engine && options.info.engine !== "native") return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: per-turn selection requires the native engine; this engine chooses its own model" })
            if (selection.model) safe = { ...command, selection: { ...selection, model: usableEffort(selection.model, catalog) } }
          }
          const typed = command.type === "user.shell" ? command.command : command.text
          const swapped = captured(command.sessionId, typed)
          if ("ok" in swapped) return reply(connection, command.id, swapped)
          if (swapped.text !== typed) {
            if (safe.type === "user.submit" || safe.type === "session.compaction.set") safe = { ...safe, text: swapped.text }
            else if (safe.type === "user.shell") safe = { ...safe, command: swapped.text }
          }
          if (safe.type === "user.submit" && safe.displayText !== undefined) {
            const display = captured(safe.sessionId, safe.displayText)
            if ("ok" in display) return reply(connection, command.id, display)
            safe = { ...safe, displayText: display.text }
          }
        }
        if (safe.type === "session.compact" && (safe.instructions !== undefined || safe.model)) {
          if (options.info?.engine && options.info.engine !== "native") return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: compaction options require the native engine" })
          const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }
          const problem = safe.model ? invalidChoice(safe.model, catalog) : undefined
          if (problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` })
          if (safe.instructions !== undefined) {
            const swapped = captured(safe.sessionId, safe.instructions)
            if ("ok" in swapped) return reply(connection, command.id, swapped)
            safe = { ...safe, instructions: swapped.text }
          }
        }
        if (peer && safe.type === "user.submit") {
          const model = safe.selection?.model ?? resolveModel({ role: "main", session: store.sessionModel(safe.sessionId), roles: rolesFor(store.settings.get(), store.sessionDirectory(safe.sessionId)), catalog })
          const key = modelEngine(model, catalog) ?? options.info?.engine
          if (key === "opencode" || key === "cursor" || (key === "claude" || key === "codex") && threadMcpEnabled(store.settings.get(), key, options.safeMode)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: local tool engines are local only" })
          safe = { ...safe, turnOptions: remoteTurnOptions(safe.turnOptions) }
        }
        // Only the submitted text grants resource reads; attached thread/PR/agent context does not.
        const mentionSource = safe.type === "user.submit" ? safe.text : ""
        if (safe.type === "user.submit" && safe.text.includes("@thread:") && threadMentions(safe.text).length) {
          // `@thread:<id>` attaches a bounded read-only snapshot of another local session of this project: local data, never for a remote or peer client.
          if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: @thread reads local sessions and is local only" })
          const attached = threads.expand(safe.sessionId, safe.text)
          if (!attached.ok) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${attached.message}` })
          if (attached.attached.length) safe = { ...safe, displayText: safe.displayText ?? attached.displayText, text: attached.text }
        }
        if (safe.type === "user.submit" && !peer && featureOn(store.settings.get(), "session_meta", { safeMode: options.safeMode })) {
          const attached = attachPrReference(safe.text, lifecycleOf(store, safe.sessionId).pr)
          if (attached !== safe.text) safe = { ...safe, displayText: safe.displayText ?? safe.text, text: attached }
        }
        if (safe.type === "user.submit" && safe.text.includes("@") && featureOn(store.settings.get(), "subagents", { safeMode: options.safeMode })) {
          // `@agent` names a sub-agent: the model is told to delegate to it. A broken agent file never blocks a prompt.
          const directory = store.sessionDirectory(safe.sessionId)
          const known = directory ? (() => { try { return agents.port().subagents(directory).map((agent) => agent.name) } catch { return [] } })() : []
          // A prompt that opens with `@name` speaks to the child of that agent this session already has, when there is one.
          const addressed = store.settings.get().agentMentions !== "delegate" ? leadingMention(safe.text, known) : undefined
          if (addressed) {
            try {
              const sent = await mentionRouting.send(safe.sessionId, addressed.name, addressed.message)
              if (sent) {
                const notice = sent.delivery === "delivered" ? `@${addressed.name} · delivered: its task resumes in the background and reports back` : `@${addressed.name} · queued: its task gets it when its current step ends`
                const answer = { ok: true as const, result: { handled: true, notice, mention: { agent: addressed.name, taskId: sent.task.taskId, delivery: sent.delivery } } }
                if (requestKey) rememberRequest(requestKey, answer)
                return reply(connection, command.id, answer)
              }
            } catch (error) {
              return reply(connection, command.id, { ok: false, code: "busy", message: `[DAEMON]: ${error instanceof Error ? error.message : String(error)}` })
            }
          }
          const expanded = expandAgentMentions({ text: safe.text, known })
          if (expanded !== safe.text) safe = { ...safe, displayText: safe.displayText ?? safe.text, text: expanded }
        }
        if (safe.type === "user.submit" && options.mcp) {
          try {
            const expanded = await expandMcpMentions(options.mcp, store.sessionDirectory(safe.sessionId) ?? "", safe.text, mentionSource)
            const swapped = captured(safe.sessionId, expanded)
            if ("ok" in swapped) return reply(connection, command.id, swapped)
            safe = { ...safe, text: swapped.text }
          } catch (error) {
            return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` })
          }
        }
        if (safe.type === "user.submit" && shellHooks.enabled) {
          // `UserPromptSubmit` shell hooks: exit 2 keeps the prompt from the model (the reason is shown to the user); stdout of the others is added to the prompt.
          const hooked = await shellHooks.prompt({ sessionId: safe.sessionId, cwd: store.sessionInfo(safe.sessionId)?.directory ?? process.cwd(), text: safe.text })
          if (hooked.blocked !== undefined) return reply(connection, command.id, { ok: true, result: { handled: true, notice: `blocked by a UserPromptSubmit hook: ${hooked.blocked}` } })
          if (hooked.text !== safe.text) safe = { ...safe, text: hooked.text }
        }
        if (safe.type === "user.submit" && extensionsEnabled) {
          // Extensions see the text first: `input` hooks rewrite or swallow it, `/name args` of an extension command runs here.
          const routed = await extensions.routeInput({ sessionId: safe.sessionId, cwd: store.sessionInfo(safe.sessionId)?.directory ?? process.cwd() }, safe.text)
          if (routed.kind === "handled") return reply(connection, command.id, { ok: true, result: { handled: true, ...(routed.notice ? { notice: routed.notice } : {}) } })
          // An extension may add text of its own (a file, an environment value): secrets in that are markers too.
          const rewritten = captured(safe.sessionId, routed.text)
          if ("ok" in rewritten) return reply(connection, command.id, rewritten)
          const result = await actor.handle(rewritten.text === safe.text ? safe : { ...safe, text: rewritten.text }, safe.displayText ?? safe.text)
          const answer = result.ok && routed.notice ? { ok: true as const, result: { ...result.result, notice: routed.notice } } : result
          if (requestKey && answer.ok) rememberRequest(requestKey, answer)
          return reply(connection, command.id, answer)
        }
        const result = await actor.handle(safe, safe.type === "user.submit" ? safe.displayText : undefined)
        if (requestKey && result.ok) rememberRequest(requestKey, result)
        if (result.ok && remembered) {
          const settings = store.settings.set(approvalRulePatch({ settings: store.settings.get(), level: remembered.level, directory: canonicalDir(store.sessionDirectory(command.sessionId) ?? process.cwd()), rules: remembered.offer.rules }))
          globalSink.append({ type: "settings.changed", settings })
          return reply(connection, command.id, { ok: true, result: { ...result.result, remembered: { level: remembered.level, label: remembered.offer.label } } })
        }
        if (result.ok && safe.type === "turn.cancel") {
          continuity.cancelSession(safe.sessionId)
          await withdrawAsyncNotices(safe.sessionId)
        }
        return reply(connection, command.id, result)
      }
      case "goal.get":
      case "goal.set":
      case "goal.update":
      case "goal.clear": {
        // The objective is text the user typed: pasted secrets become markers before it is stored, shown or sent to the model.
        let safe: typeof command = command
        if ((command.type === "goal.set" || command.type === "goal.update") && command.objective !== undefined) {
          const swapped = captured(command.sessionId, command.objective)
          if ("ok" in swapped) return reply(connection, command.id, swapped)
          if (swapped.text !== command.objective) safe = { ...command, objective: swapped.text }
        }
        return reply(connection, command.id, goals.handle(safe))
      }
      case "usage.limit":
        if ((connection.remoteAddress || connection.peer) && (command.action === "resume" || command.action === "schedule")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: usage-limit resumes are armed on the machine that runs the turn" })
        return reply(connection, command.id, await usageLimit.handle(command))
      case "pr.watch": {
        // Runs gh here and reads this machine's checkout: never for a remote or peer client.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: PR watch runs gh on this machine and is local only" })
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const done = await prWatch.control({ sessionId: command.sessionId, action: command.action, pr: command.pr })
        return reply(connection, command.id, done.ok ? { ok: true, result: { text: done.text, watches: done.watches } } : { ok: false, code: "invalid_command", message: `[DAEMON]: ${done.message}` })
      }
      case "pr.review": {
        // Runs gh and git here and posts with the user's own login: never for a remote or peer client.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: the PR reviewer runs gh on this machine and is local only" })
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (!prReviewOn()) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: The PR reviewer is off: it reaches the network through gh and spends model calls, so turn it on with /experimental pr_review on (balanced tier or above)" })
        const done = await (await prReviewService()).control({ sessionId: command.sessionId, action: command.action, directory: command.directory, pr: command.pr, role: command.role })
        return reply(connection, command.id, done.ok ? { ok: true, result: { text: done.text, watches: done.watches } } : { ok: false, code: "invalid_command", message: `[DAEMON]: ${done.message}` })
      }
      case "git.push":
      case "git.publish":
      case "git.pr.view":
      case "git.pr.create": {
        // Runs git and gh on this machine and reaches the network with the user's own logins: never for a remote or peer client, and only while the switch is on.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[GIT]: push, publish and pull requests run on this machine and are local only" })
        if (!gitActionsOn()) return reply(connection, command.id, { ok: false, code: "forbidden", message: GIT_ACTIONS_OFF })
        const denied = denyingRule({ settings: store.settings.get(), directory: command.directory, session: command.sessionId ? sessionPermissions.effective(command.sessionId) : undefined })
        try {
          if (command.type === "git.push") {
            const done = await gitPush({ directory: command.directory, denied, ...(command.confirm !== undefined ? { confirm: command.confirm } : {}), ...(command.preview ? { preview: true } : {}) })
            if (done.pushed) gitNote(command.sessionId, command.id, `Git page: pushed ${done.plan.branch} to ${done.plan.remote} (${done.plan.commitsTotal} ${done.plan.commitsTotal === 1 ? "commit" : "commits"}).`)
            return reply(connection, command.id, { ok: true, result: done })
          }
          if (command.type === "git.publish") {
            const done = await gitPublish({ directory: command.directory, denied, ...(command.name !== undefined ? { name: command.name } : {}), ...(command.owner !== undefined ? { owner: command.owner } : {}), ...(command.description !== undefined ? { description: command.description } : {}), ...(command.preview ? { preview: true } : {}) })
            if (done.published) gitNote(command.sessionId, command.id, `Git page: published ${done.plan.repo} as a private repository and added origin (nothing pushed).`)
            return reply(connection, command.id, { ok: true, result: done })
          }
          if (command.type === "git.pr.view") return reply(connection, command.id, { ok: true, result: await gitPrView({ directory: command.directory, denied }) })
          const done = await gitPrCreate({ directory: command.directory, denied, ...(command.title !== undefined ? { title: command.title } : {}), ...(command.body !== undefined ? { body: command.body } : {}), ...(command.base !== undefined ? { base: command.base } : {}), ...(command.draft ? { draft: true } : {}), ...(command.preview ? { preview: true } : {}) })
          if (done.created) gitNote(command.sessionId, command.id, `Git page: opened a pull request from ${done.plan.branch} into ${done.plan.base}${done.url ? `: ${done.url}` : ""}.`)
          return reply(connection, command.id, { ok: true, result: done })
        } catch (error) {
          if (error instanceof GitActionRefusal) return reply(connection, command.id, { ok: false, code: error.code, message: error.message })
          throw error
        }
      }
      case "git.init": {
        // Makes a repository on this machine: never for a remote or peer client, not a read-only command, and only in the project folder of the session.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[GIT]: initializing a repository runs git on this machine and is local only" })
        const project = store.sessionDirectory(command.sessionId)
        if (!project) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[GIT]: unknown session" })
        try {
          const done = await gitInit({ directory: command.directory, project, ...(command.preview ? { preview: true } : {}) })
          if (done.initialized) gitNote(command.sessionId, command.id, `Git page: initialized a git repository in ${done.plan.directory} (branch ${done.plan.branch}, nothing committed).`)
          return reply(connection, command.id, { ok: true, result: done })
        } catch (error) {
          if (error instanceof GitActionRefusal) return reply(connection, command.id, { ok: false, code: error.code, message: error.message })
          throw error
        }
      }
      case "git.commit": {
        // Runs git and the repository's hooks on this machine: never for a remote or peer client, and not a read-only command.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[GIT]: commits run on this machine and are local only" })
        try {
          return reply(connection, command.id, { ok: true, result: await gitCommit({ directory: command.directory, message: command.message, paths: command.paths, ...(command.preview ? { preview: true } : {}) }) })
        } catch (error) {
          if (error instanceof GitCommitRefusal) return reply(connection, command.id, { ok: false, code: error.code, message: error.message })
          throw error
        }
      }
      case "privacy.get":
      case "privacy.set": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[PRIVACY]: local owner only" })
        try {
          if (command.type === "privacy.set") {
            if ([...actors.values()].some(actorWorking) || scheduler.snapshot().length) return reply(connection, command.id, { ok: false, code: "busy", message: "[PRIVACY]: wait for active turns and jobs to finish" })
            store.privacy.set(command.enabled)
          }
          return reply(connection, command.id, { ok: true, result: store.privacy.status() })
        } catch { return reply(connection, command.id, { ok: false, code: "internal", message: "[PRIVACY]: conversion failed; check disk space and restore the chats key if missing" }) }
      }
      case "env.list":
      case "env.set":
      case "env.remove":
      case "env.import": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[ENV]: local owner only" })
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[ENV]: unknown session" })
        try {
          const directory = store.sessionDirectory(command.sessionId) ?? ""
          if (command.type === "env.import") {
            const imported = readEnvironmentImport(directory, command.path)
            if (!command.digest) return reply(connection, command.id, { ok: true, result: { names: Object.keys(imported.values).sort(), digest: imported.digest } })
            if (command.digest !== imported.digest) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[ENV]: file changed; preview the import again" })
            store.environment.setMany(imported.values, { ...command, directory })
          }
          if (command.type === "env.set") store.environment.set({ ...command, directory })
          if (command.type === "env.remove") store.environment.remove(command.name, command.scope, command.sessionId, directory)
          return reply(connection, command.id, { ok: true, result: { entries: store.environment.list(command.sessionId, directory), native: options.info?.engine === "native", engines: store.settings.get().engineEnvironment !== false } })
        } catch { return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[ENV]: unable to save credentials; check the name, value, disk space and environment key" }) }
      }
      case "secrets.list":
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        return reply(connection, command.id, { ok: true, result: { secrets: store.secrets.list(command.sessionId) } })
      case "secrets.reveal": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const revealed = secrets.reveal(command.sessionId, command.n)
        if (!revealed) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: the session has no such secret" })
        if ("error" in revealed) return reply(connection, command.id, { ok: false, code: "internal", message: revealed.error })
        // Sent straight to the asking client; a retry is answered again from the store, never from the reply cache.
        return send(connection, { v: PROTOCOL_VERSION, kind: "ack", id: command.id, result: { value: revealed.value } })
      }
      case "secrets.forget":
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (!secrets.forget(command.sessionId, command.n)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: the session has no such secret" })
        return reply(connection, command.id, { ok: true })
      case "sidebar.get":
        return reply(connection, command.id, { ok: true, result: { widgets: readSidebar(options.dir, command.directory), scope: sidebarScope(options.dir, command.directory) } })
      case "sidebar.update": {
        try {
          const widgets = updateSidebar(options.dir, command.directory, command.change)
          globalSink.append({ type: "sidebar.changed", ...(command.change.scope === "project" ? { directory: command.directory } : {}), widgets })
          return reply(connection, command.id, { ok: true, result: { widgets } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) }) }
      }
      case "session.aside.get":
      case "session.aside.clear": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (command.type === "session.aside.clear") {
          // The side session goes with its history; the next question starts a new one.
          await asideSessions.clear(command.sessionId, true)
          asides.set(command.sessionId, { messages: [], busy: false })
          publishAside(command.sessionId, asides.get(command.sessionId))
        }
        return reply(connection, command.id, { ok: true, result: { thread: asides.get(command.sessionId) } })
      }
      case "session.aside": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (!options.complete) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: side questions need the native engine" })
        // The question may carry a pasted secret; the model sees its marker, like in the transcript (which is marker text already).
        const question = captured(command.sessionId, command.text)
        if ("ok" in question) return reply(connection, command.id, question)
        if (asideSessions.busy(command.sessionId)) return reply(connection, command.id, { ok: false, code: "busy", message: "Side chat is answering" })
        try {
          const thread = await asideSessions.ask(command.sessionId, question.text)
          if (thread.error) return reply(connection, command.id, { ok: false, code: "internal", message: `[DAEMON]: ${thread.error}` })
          return reply(connection, command.id, { ok: true, result: { text: thread.messages.findLast((message) => message.role === "assistant")?.text ?? "", thread } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return reply(connection, command.id, { ok: false, code: "internal", message: `[DAEMON]: ${message.slice(0, 500)}` })
        }
      }
      case "dream.list": {
        if (command.runId !== undefined) {
          const run = store.dreamRuns.get(command.runId)
          return reply(connection, command.id, { ok: true, result: { runs: run && (!command.directory || run.directory === command.directory) ? [run] : [] } })
        }
        return reply(connection, command.id, { ok: true, result: { runs: store.dreamRuns.list(command.directory) } })
      }
      case "dream.run": {
        const started = startDream(command.directory)
        if ("error" in started) return reply(connection, command.id, { ok: false, code: started.code, message: started.error })
        return reply(connection, command.id, { ok: true, result: { runId: started.runId } })
      }
      case "memory.control":
        try { return reply(connection, command.id, { ok: true, result: await cliMemory.run(command.directory, command.input) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 500) }) }
      case "dream.control": {
        if (command.input.operation === "status") {
          const at = store.settings.get().dreamAt
          return reply(connection, command.id, { ok: true, result: { schedule: { enabled: Boolean(at), at: at ?? null, handled: store.meta.get(DREAM_WINDOW_KEY) ?? null, next: at ? windows(clock.now(), at).next : null }, runs: store.dreamRuns.list(command.directory).slice(0, 5), service: { kind: "integrated", configured: Boolean(options.dream) }, consolidator: { mode: options.models?.selectable && rolesFor(store.settings.get(), command.directory).memoryConsolidator ? "semantic" : "deterministic", model: rolesFor(store.settings.get(), command.directory).memoryConsolidator?.model ?? null }, callsProviders: false, readsSecrets: false } })
        }
        if (command.input.operation === "tick") return reply(connection, command.id, { ok: true, result: armDreamSchedule() })
        const started = startDream(command.directory, "manual", command.input.policy ?? memorySettings(store.settings.get(), command.directory).dreamConsolidationPolicy ?? "auto-consolidate", command.input.deterministic === true)
        if ("error" in started) return reply(connection, command.id, { ok: false, code: started.code, message: started.error })
        const run = await started.completion
        return reply(connection, command.id, { ok: true, result: { run, consolidation: run.report?.consolidation ?? null, callsProviders: (run.report?.model.calls ?? 0) + (run.report?.consolidation?.semantic?.calls ?? 0) > 0, readsSecrets: false } })
      }
      case "loop.create": {
        const { name, directory, objective, criteria, trigger, budget, runNow, checks, audit, template, reportOnly, workspace, costBudget, rubric, approvalPolicy } = command
        const created = await createLoop({
          name,
          directory,
          ...(objective ? { objective } : {}),
          ...(trigger ? { trigger } : {}),
          ...(budget ? { budget } : {}),
          ...(criteria ? { criteria } : {}),
          ...(runNow ? { runNow } : {}),
          ...(checks?.length ? { checks } : {}),
          ...(audit ? { audit } : {}),
          ...(template ? { template } : {}),
          ...(reportOnly !== undefined ? { reportOnly } : {}),
          ...(workspace ? { workspace } : {}),
          ...(costBudget ? { costBudget } : {}),
          ...(rubric ? { rubric } : {}),
          ...(approvalPolicy ? { approvalPolicy } : {}),
        })
        if (!created.ok) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${created.message}` })
        return reply(connection, command.id, { ok: true, result: { loop: created.loop } })
      }
      case "loop.update": {
        const { loopId, type: _type, id: _id, clientId: _client, ...patch } = command
        const before = loops.get(loopId)
        if (!before) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: unknown loop" })
        const problem = await loopProblem(loopUpdateInput(before, patch))
        if (problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` })
        // Validation can await git: re-read before changing anything, so a scheduled run is never edited mid-flight.
        const current = loops.get(loopId)
        if (!current) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: unknown loop" })
        if (current !== before) return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: the loop changed; retry the edit" })
        if (current.state === "running" || current.state === "needs_input" || current.state === "verifying") return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: the loop is running; edit it after the run" })
        const loop = loops.update(loopId, patch)!
        if (!!loop.reportOnly !== !!before.reportOnly) {
          const mode = loop.reportOnly ? "plan" : defaultPermissionFor(store.settings.get(), loop.directory) ?? "ask"
          await actorFor(loop.sessionId)?.handle({ id: command.id, clientId: command.clientId, type: "session.permission.set", sessionId: loop.sessionId, mode })
        }
        return reply(connection, command.id, { ok: true, result: { loop } })
      }
      case "loop.templates":
        return reply(connection, command.id, { ok: true, result: { templates: LOOP_TEMPLATES.map(describeTemplate) } })
      case "loop.fire": {
        const fired = loops.fire(command.loopId, command.note)
        if (!fired.ok) return reply(connection, command.id, { ok: false, code: fired.reason === "unknown" ? "target_mismatch" : fired.reason === "inactive" ? "busy" : "invalid_command", message: `[DAEMON]: ${fired.message}` })
        return reply(connection, command.id, { ok: true, result: { loop: fired.loop, queued: fired.queued } })
      }
      case "permissions.status":
        return reply(connection, command.id, { ok: true, result: permissionsStatus(store.settings.get()) })
      case "permissions.set-default":
      case "permissions.set-reviewer-role": {
        const patch = command.type === "permissions.set-default"
          ? { defaultPermission: command.mode === "approval" ? "ask" : command.mode === "full_access" ? "full" : command.mode }
          : { permissionReviewerRole: command.role }
        const settings = store.settings.set(patch)
        globalSink.append({ type: "settings.changed", settings })
        return reply(connection, command.id, { ok: true, result: permissionsStatus(settings) })
      }
      case "session.run.configure": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (command.addDirs && connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: extra directories are set on the machine that runs the commands" })
        const { id: _id, clientId: _client, type: _type, sessionId: _session, ...patch } = command
        return reply(connection, command.id, { ok: true, result: { limits: runLimits.configure(command.sessionId, patch) } })
      }
      case "permissions.list":
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        return reply(connection, command.id, { ok: true, result: { grants: grants.list(command.sessionId) } })
      case "permissions.history":
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        return reply(connection, command.id, { ok: true, result: grants.history(command.sessionId, command.limit) })
      case "permissions.revoke": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const revoked = grants.revoke(command.sessionId, command.grantId)
        if (revoked === 0 && command.grantId !== "all") return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: the session has no such grant" })
        return reply(connection, command.id, { ok: true, result: { revoked } })
      }
      case "permissions.retry": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: a retry is approved on the machine that runs the commands" })
        const denial = grants.approveRetry(command.sessionId)
        if (!denial) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: the permission reviewer has not denied a call in this session recently" })
        return reply(connection, command.id, { ok: true, result: { tool: denial.tool, summary: denial.summary, reason: denial.reason } })
      }
      case "loop.list":
        return reply(connection, command.id, { ok: true, result: { loops: loops.list(command.directory) } })
      case "loop.draft":
      case "loop.snapshot":
      case "loop.activate":
      case "loop.tick":
        return reply(connection, command.id, await loopControl(command))
      case "loop.review": {
        const { loopId, type: _type, id: _id, clientId: _client, ...review } = command
        const result = loops.review(loopId, review)
        return result.ok ? reply(connection, command.id, { ok: true, result: { loop: result.loop } }) : reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${result.message}` })
      }
      case "loop.control": {
        const { loopId, action } = command
        if (!loops.get(loopId)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: unknown loop" })
        if (action === "delete") {
          const loop = loops.get(loopId)!
          if (!loops.remove(loopId)) return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: the loop is running; stop it first" })
          globalSink.append({ type: "loop.changed", loop, deleted: true })
          return reply(connection, command.id, { ok: true })
        }
        if (action === "run" && !loops.runNow(loopId)) return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: the loop is running or finished" })
        if (action === "accept") {
          if (!command.reason?.trim()) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: accepting a loop needs a reason" })
          const accepted = loops.accept(loopId, command.reason.trim())
          if (accepted?.state !== "completed") return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: accept refused; configured gates need loop.review with the current run and checkpoint hash" })
          return reply(connection, command.id, { ok: true, result: { loop: accepted } })
        }
        const loop = action === "pause" ? loops.pause(loopId) : action === "resume" ? loops.resume(loopId) : action === "stop" ? loops.stop(loopId) : loops.get(loopId)
        return reply(connection, command.id, { ok: true, result: { loop } })
      }
      case "memory.model":
        try { return reply(connection, command.id, { ok: true, result: modelMemory.request(command.directory, command.input) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : String(error) }) }
      case "memory.assistant.get":
      case "memory.assistant.send":
      case "memory.assistant.clear":
      case "memory.assistant.cancel":
        try {
          const thread = command.type === "memory.assistant.send" ? await memoryAssistant.send(command.directory, command.text, command.selection)
            : command.type === "memory.assistant.clear" ? memoryAssistant.clear(command.directory)
            : command.type === "memory.assistant.cancel" ? memoryAssistant.cancel(command.directory)
            : memoryAssistant.get(command.directory)
          return reply(connection, command.id, { ok: true, result: { thread } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : String(error) }) }
      case "memory.assistant.archive":
        try {
          const { directory, action, archiveId } = command
          if (action === "delete") memoryAssistant.forget(directory, archiveId!)
          const thread = action === "archive" ? memoryAssistant.archive(directory) : action === "restore" ? memoryAssistant.restore(directory, archiveId!) : memoryAssistant.get(directory)
          return reply(connection, command.id, { ok: true, result: { thread, archives: memoryAssistant.archives(directory) } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : String(error) }) }
      case "memory.extraction.list":
        return reply(connection, command.id, { ok: true, result: { jobs: extraction.list(command.directory), status: extraction.status(command.directory), configured: extraction.configured, maintenance: memoryMaintenance(store.memories.list({ ...(command.directory ? { directory: command.directory } : {}), profile: profileOf(store.settings.get(), command.directory) }), memorySettings(store.settings.get(), command.directory).memoryMaintenance) } })
      case "memory.extraction.retry":
        try { extraction.retry(command.jobId); return reply(connection, command.id, { ok: true }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error) }) }
      case "memory.workspaces":
        return reply(connection, command.id, { ok: true, result: workspaceMemory.list(command.directory) })
      case "memory.browse":
        try { return reply(connection, command.id, { ok: true, result: workspaceMemory.browse(command.directory, command.view, command.root) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) }) }
      case "memory.sharing.status":
      case "memory.sharing.configure":
      case "memory.sharing.export":
      case "memory.sharing.import":
        try {
          const result = command.type === "memory.sharing.status" ? await sharingMemory.status(command.scope, command.directory)
            : command.type === "memory.sharing.configure" ? await sharingMemory.configure(command.scope, command.directory, command.enabled, command.confirmation)
            : await sharingMemory.run(command.scope, command.directory, command.type === "memory.sharing.export" ? "export" : "import")
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "Sharing failed" }) }
      case "memory.list":
        return reply(connection, command.id, {
          ok: true,
          result: { memories: store.memories.list({ ...(command.directory ? { directory: command.directory, profile: profileOf(store.settings.get(), command.directory) } : {}), ...(command.status ? { status: command.status } : {}), ...(command.session ? { session: command.session } : {}) }) },
        })
      case "memory.search":
        return reply(connection, command.id, {
          ok: true,
          result: {
            memories: store.memories.search({
              query: command.query,
              ...(command.directory ? { directory: command.directory, profile: profileOf(store.settings.get(), command.directory) } : {}),
              ...(command.session ? { session: command.session } : {}),
              ...(command.limit ? { limit: command.limit } : {}),
            }),
          },
        })
      case "memory.categories":
        return reply(connection, command.id, { ok: true, result: { categories: categoriesReport() } })
      case "memory.policy": {
        const policies = { ...store.settings.get().memoryPolicies }
        const builtIn = MEMORY_CATEGORIES.find((category) => category.id === command.category)!.policy
        if (command.policy === builtIn) delete policies[command.category]
        else policies[command.category] = command.policy
        const settings = store.settings.set({ memoryPolicies: Object.keys(policies).length ? policies : null })
        globalSink.append({ type: "settings.changed", settings })
        return reply(connection, command.id, { ok: true, result: { categories: categoriesReport() } })
      }
      case "evolution.list": {
        const mode = store.settings.get().evolution ?? "off"
        const suggestions = store.evolution.suggestions(command.directory, command.status)
        return reply(connection, command.id, { ok: true, result: { mode, ...(mode !== "off" || suggestions.length ? { workflows: store.settings.get().evolutionWorkflows === true, policyRevision: store.evolution.policyRevision() } : {}), suggestions, observed: store.evolution.observed(command.directory) } })
      }
      case "evolution.resolve": {
        const suggestion = store.evolution.suggestion(command.suggestionId)
        if (!suggestion) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: unknown suggestion" })
        if (command.expectedHash && suggestion.hash !== command.expectedHash) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: candidate changed; review again" })
        if (suggestion.status !== "pending") return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: the suggestion was already ${suggestion.status}` })
        if (command.decision === "accept" && suggestion.kind !== "instruction") {
          try {
            const promoted = evolutionPromotions.promote(suggestion.suggestionId, suggestion.hash!, store.evolution.policyRevision())
            return reply(connection, command.id, { ok: true, result: promoted })
          } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 200) : "could not promote the candidate"
            return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${message}` })
          }
        }
        const resolved = store.evolution.resolve(command.suggestionId, command.decision === "accept" ? "accepted" : "rejected")
        return reply(connection, command.id, { ok: true, result: { suggestion: resolved } })
      }
      case "evolution.promote":
      case "evolution.rollback": {
        try {
          const result = command.type === "evolution.promote" ? evolutionPromotions.promote(command.suggestionId, command.expectedHash, command.policyRevision) : evolutionPromotions.rollback(command.suggestionId, command.expectedHash, command.expectedRevision)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${error instanceof Error ? error.message.slice(0, 200) : "promotion failed"}` })
        }
      }
      case "memory.graph":
        return reply(connection, command.id, { ok: true, result: graphFor(command.directory) })
      case "memory.link": {
        const link = linkMemories(command)
        if (!link) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: both memories must be saved and different, each with fewer than 16 links" })
        return reply(connection, command.id, { ok: true, result: { link } })
      }
      case "memory.unlink": {
        const removed = store.memories.unlink(command.from, command.to)
        if (removed) globalSink.append({ type: "memory.changed", memoryId: command.from, change: "linked" })
        return reply(connection, command.id, { ok: true, result: { removed } })
      }
      case "memory.add": {
        if (command.scope === "project" && !command.directory) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: project memory needs a directory" })
        if (command.scope === "session" && !(command.sessionId && store.hasSession(command.sessionId))) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: session memory needs the id of an existing session" })
        const directory = command.scope === "session" ? store.sessionInfo(command.sessionId!)?.directory : command.directory
        if (command.pinned && store.memories.pinnedIn({ scope: command.scope, ...(directory ? { directory } : {}), profile: profileOf(store.settings.get(), directory), ...(command.sessionId ? { sessionId: command.sessionId } : {}) }) >= MAX_PINNED_MEMORIES)
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: at most ${MAX_PINNED_MEMORIES} memories can be pinned for a profile, project or session` })
        const memoryId = addMemory({
          scope: command.scope,
          ...(command.directory ? { directory: command.directory } : {}),
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          text: command.text,
          category: command.category ?? "",
          source: "user",
          status: "saved",
          ...(command.pinned ? { pinned: true } : {}),
        })
        return reply(connection, command.id, { ok: true, result: { memoryId } })
      }
      case "memory.update": {
        const draft = store.memories.get(command.memoryId)
        const details = draft?.details?.action ? { ...draft.details, action: { ...draft.details.action, ...(command.text ? { text: redactSecrets(command.text).text } : {}), ...(command.category !== undefined ? { categoryID: command.category, categoryIDs: command.category ? [command.category] : [] } : {}), ...(command.scope === "user" || command.scope === "project" ? { scope: command.scope } : {}) } } : undefined
        if (draft?.details?.action && (command.status === "saved" || command.status === "archived")) {
          try { return reply(connection, command.id, { ok: true, result: modelMemory.resolve({ ...draft, details }, command.status === "saved") ?? {} }) }
          catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : String(error) }) }
        }
        // A pending Dream revision (update/archive) is decided here: saved = apply to its target, archived = drop it.
        if (!command.text && !command.category && (command.status === "saved" || command.status === "archived")) {
          const resolved = store.memories.resolveRevision(command.memoryId, command.status === "saved")
          if (resolved.result !== "not_a_revision") {
            globalSink.append({ type: "memory.changed", memoryId: command.memoryId, change: "deleted" })
            if (resolved.result === "applied") globalSink.append({ type: "memory.changed", memoryId: resolved.targetId, change: "updated" })
            return resolved.result === "stale"
              ? reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: the memory changed since this proposal; it was dropped" })
              : reply(connection, command.id, { ok: true, result: { revision: resolved.result, targetId: resolved.targetId } })
          }
        }
        const { text, category, status, pinned } = command
        const current = store.memories.get(command.memoryId)
        if (!current) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: memory not found" })
        // A scope change keeps the memory (id, text, links); it is checked completely before anything is written.
        const destination = command.scope ? memoryDestination(command, current) : undefined
        if (destination && "error" in destination) return reply(connection, command.id, { ok: false, code: destination.code, message: `[DAEMON]: ${destination.error}` })
        const pinnedAfter = pinned === undefined ? current.pinned === true : pinned
        if (pinned === true) {
          if ((status ?? current.status) !== "saved" || current.kind === "update" || current.kind === "archive") return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: only saved memories can be pinned" })
          if (store.memories.pinnedIn(destination?.place ?? current, current.memoryId) >= MAX_PINNED_MEMORIES) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: at most ${MAX_PINNED_MEMORIES} memories can be pinned for a profile, project or session` })
        } else if (destination && pinnedAfter && (status ?? current.status) === "saved" && store.memories.pinnedIn(destination.place, current.memoryId) >= MAX_PINNED_MEMORIES)
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: the pinned memory does not fit: at most ${MAX_PINNED_MEMORIES} memories can be pinned for a profile, project or session` })
        if (destination && !store.memories.move(command.memoryId, destination.place)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: memory not found" })
        if (!store.memories.update(command.memoryId, { ...(text ? { text: details ? redactSecrets(text).text : text } : {}), ...(category !== undefined ? { category } : {}), ...(status ? { status } : {}), ...(pinned !== undefined ? { pinned } : {}), ...(details ? { details } : {}) }))
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: memory not found" })
        announceMemory(command.memoryId, "updated")
        return reply(connection, command.id, { ok: true })
      }
      case "memory.delete": {
        const removed = store.memories.get(command.memoryId)
        if (!store.memories.delete(command.memoryId)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: memory not found" })
        announceMemory(command.memoryId, "deleted", removed)
        return reply(connection, command.id, { ok: true })
      }
      case "git.status":
        return reply(connection, command.id, { ok: true, result: await readGitStatus(command.directory) })
      case "git.branch":
        return reply(connection, command.id, { ok: true, result: readGitBranch(command.directory) })
      case "codegraph.overview": {
        // The user's own switches win over the key: with the graph tools off, nothing is indexed for the panel either.
        const gate = options.codeOverview && featureOn(store.settings.get(), "codegraph") ? await options.codeGate?.check({ cwd: command.directory, mode: graphIndexMode(store.settings.get(), command.directory) }).catch(() => undefined) : undefined
        const result: import("@mendcode/protocol").CodegraphOverview = !options.codeOverview ? { state: "off", reason: "disabled by MENDCODE_CODEGRAPH=0" }
          : !featureOn(store.settings.get(), "codegraph") ? { state: "off", reason: "the codegraph feature is off" }
          : gate && !gate.index ? { state: "off", reason: gate.reason === "off" ? "/graph off" : gate.reason }
          : await options.codeOverview({ directory: command.directory, limit: command.limit, signal: connection.signal ?? new AbortController().signal })
        return reply(connection, command.id, { ok: true, result })
      }
      case "files.search":
        return reply(connection, command.id, { ok: true, result: await searchFiles({ directory: command.directory, ignore: store.settings.get().watcher?.ignore, query: command.query, ...(command.limit ? { limit: command.limit } : {}) }) })
      case "file.rest.read": {
        try {
          const result = await readFileApi({ directory: command.directory, input: command.input, signal: connection.signal, symbols: options.lsp?.workspaceSymbols?.bind(options.lsp), frecency: fileFrecency })
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof FileApiError && error.code === "forbidden" ? "forbidden" : "invalid_command", message: error instanceof FileApiError ? error.message : "File request failed or cancelled" })
        }
      }
      case "file.view": {
        try {
          return reply(connection, command.id, { ok: true, result: await viewFile({ directory: command.directory, path: command.path, from: command.from, count: command.count, search: command.search, known: command.known, lang: command.lang }) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof FileApiError ? error.message : "File view failed" })
        }
      }
      case "file.edit": {
        if (!serverConfig.edit) return reply(connection, command.id, { ok: false, code: "unsupported", message: "File editing disabled; start the server with --edit" })
        try {
          return reply(connection, command.id, { ok: true, result: await editFile({ directory: command.directory, input: command.input }) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof FileApiError && error.code === "forbidden" ? "forbidden" : "invalid_command", message: error instanceof FileApiError ? error.message : "File edit failed" })
        }
      }
      case "storage.report":
        return reply(connection, command.id, { ok: true, result: { ...store.storageReport(), trashBytes: await projectRestService().storage.trashBytes() } })
      case "storage.worktrees":
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: worktree storage is local only" })
        return reply(connection, command.id, { ok: true, result: await projectRestService().storage.report(command.idleDays) })
      case "storage.clean":
        if (command.worktrees && (connection.remoteAddress || connection.peer)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: cleaning worktrees is local only" })
        return reply(connection, command.id, {
          ok: true,
          result: await cleanStorage({
            olderThanDays: command.olderThanDays ?? store.settings.get().retentionDays ?? DEFAULT_RETENTION_DAYS,
            ...(command.dryRun ? { dryRun: true } : {}),
            ...(command.vacuum ? { vacuum: true } : {}),
            ...(command.compact ? { compact: true } : {}),
            ...(command.deltaIdleDays === undefined ? {} : { deltaIdleDays: command.deltaIdleDays }),
            ...(command.worktrees ? { worktrees: true } : {}),
            ...(command.worktreeIdleDays === undefined ? {} : { worktreeIdleDays: command.worktreeIdleDays }),
          }),
        })
      case "scratchpad.get":
        return reply(connection, command.id, { ok: true, result: { text: readScratchpad(options.dir, command.directory) } })
      case "scratchpad.set":
        writeScratchpad(options.dir, command.directory, command.text)
        return reply(connection, command.id, { ok: true })
      case "backlog.get":
      case "backlog.change": {
        if (!featureOn(store.settings.get(), "backlog", { safeMode: options.safeMode })) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: the project backlog is off (/tier backlog on)" })
        try {
          const result = command.type === "backlog.get" ? readBacklog(options.dir, command.directory) : changeBacklog({ dir: options.dir, directory: command.directory, change: command.change, now: clock.now() })
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000)}` })
        }
      }
      case "continuity.list":
      case "continuity.get":
      case "continuity.cancel":
      case "continuity.wait": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "Unknown session" })
        try {
          const port = continuity.forSession(command.sessionId)
          const result = command.type === "continuity.list" ? { records: continuity.list(command.sessionId).filter((record) => !command.kind || record.kind === command.kind).map(({ output, answers, questions, error, ...record }) => record) }
            : command.type === "continuity.get" ? { record: port.get(command.recordId, command.offset, command.limit) }
            : command.type === "continuity.cancel" ? { record: port.cancel(command.recordId) }
            : { records: (await port.wait(command.recordIds, command.timeoutMs ?? 10000, new AbortController().signal)).map(({ id, status }) => ({ id, status })) }
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: error instanceof Error ? error.message : "Continuity operation failed" }) }
      }
      case "settings.get":
        return reply(connection, command.id, { ok: true, result: { settings: store.settings.get() } })
      case "acp.registry": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "ACP registry reads local configuration and PATH; local only" })
        if (!featureOn(store.settings.get(), "acp_registry", { safeMode: options.safeMode })) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Enable ACP registry with /tier acp_registry on (full tier)" })
        const { createAcpRegistry } = await import("./acp-registry")
        const registry = createAcpRegistry({ settings: () => store.settings.get(), save: (patch) => store.settings.set(patch) })
        try {
          const settings = command.operation === "add" ? registry.add(command.agentId!) : undefined
          if (settings) globalSink.append({ type: "settings.changed", settings })
          return reply(connection, command.id, { ok: true, result: { ...registry.list(), ...(settings ? { settings } : {}) } })
        } catch {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Cannot add ACP agent: unknown, already configured or config needs repair" })
        }
      }
      case "cache.status":
        return reply(connection, command.id, { ok: true, result: createCacheControl(store).status(command) })
      case "cache.set": {
        try {
          const { settings, report } = createCacheControl(store).set(command.input)
          globalSink.append({ type: "settings.changed", settings })
          return reply(connection, command.id, { ok: true, result: report })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}` })
        }
      }
      case "ai.config": {
        try {
          return reply(connection, command.id, { ok: true, result: aiConfig.run(command.directory, command.input) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof AIConfigError ? error.code : "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 500)}` })
        }
      }
      case "settings.set": {
        if ("additionalDirectories" in command.patch && connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: extra directories are set on the machine that runs the commands" })
        if ("worktreeGcDays" in command.patch && (connection.remoteAddress || connection.peer)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: worktree cleanup is set on the machine that holds the worktrees" })
        if (connection.remoteAddress && REMOTE_HOST_SETTINGS.some((key) => key in command.patch)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: proxy, shell and web policy are set on the machine that runs the commands" })
        if ((connection.remoteAddress || connection.peer) && remoteExecutionSettings(command.patch)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: execution policy and feature switches are set on the machine that runs the commands" })
        if (connection.remoteAddress && ["sandbox", "trustedToolDirs", "allowedHttpHookUrls", "permission", "permissionAllow", "smartSandboxTrust", "engineSafetyPrompts", "engineEnvironment", "projectConfig"].some((key) => key in command.patch)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: sandbox, trust and saved permission rules are set on the machine that runs the commands" })
        let settings: Settings
        const before = store.settings.get()
        try {
          settings = store.settings.set(command.patch)
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: invalid settings: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}` })
        }
        await settingsSaved(before, settings, command.patch)
        if ("instructions" in command.patch) void remoteInstructions(options.dir).prefetch(settings.instructions ?? [])
        return reply(connection, command.id, { ok: true, result: { settings } })
      }
      case "tools.list":
      case "tools.trust": {
        const directory = canonicalDir(command.directory)
        if (command.type === "tools.trust") {
          if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: project trust is granted on the machine that runs the commands" })
          const current = store.settings.get().trustedToolDirs ?? []
          const next = command.trusted ? [...new Set([...current, directory])].slice(-200) : current.filter((dir) => dir !== directory)
          const settings = store.settings.set({ trustedToolDirs: next.length ? next : null })
          globalSink.append({ type: "settings.changed", settings })
          // Project extensions follow the same trust: they load (or stop applying) for the next use. So do project MCP servers.
          extensions.invalidateProject()
          await options.mcp?.invalidate?.(undefined)
          uiReload.sync()
        }
        const { tools, issues } = await customTools.list(directory)
        return reply(connection, command.id, { ok: true, result: { directory, tools, issues } })
      }
      case "packages.list":
      case "packages.install":
      case "packages.capture":
      case "packages.remove":
      case "packages.restore":
      case "packages.enable": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[PACKAGES]: package context reads local files; local only" })
        try { return reply(connection, command.id, { ok: true, result: await managePackages(command) }) }
        catch (error) {
          if (error instanceof PackageNotInstalledError) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: error.message })
          if (error instanceof PackageError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      }
      case "packages.search":
      case "packages.show":
      case "packages.preview":
      case "packages.sources":
      case "packages.add-source":
      case "packages.remove-source":
      case "packages.refresh":
      case "packages.config":
      case "packages.resource":
      case "packages.install-catalog":
      case "packages.install-source":
      case "packages.disable-all":
      case "packages.assets": {
        try { return reply(connection, command.id, { ok: true, result: await packageCatalog(command) }) }
        catch (error) {
          if (error instanceof PackageError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      }
      case "packages.create":
      case "packages.update":
      case "packages.delete-local": {
        try { return reply(connection, command.id, { ok: true, result: await packageAuthoring(command) }) }
        catch (error) {
          if (error instanceof PackageError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      }
      case "recipes.list":
      case "recipes.apply": {
        const recipes = readRecipes(layersFor(command.directory))
        if (command.type === "recipes.apply") {
          const recipe = recipes.find((entry) => entry.name === command.name)
          if (!recipe) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: no recipe named ${command.name}` })
          if (recipe.problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: recipe ${recipe.name}: ${recipe.problem}` })
          const catalog = options.models
          if (!catalog?.selectable) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: this engine chooses its own model" })
          for (const [role, choice] of Object.entries(recipe.roles)) {
            const problem = choice ? invalidChoice(choice, catalog, role as ModelRole) : undefined
            if (problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: recipe ${recipe.name}, ${role}: ${problem}` })
          }
          const settings = store.settings.set(rolesPatch(store.settings.get(), command.directory, recipe.roles) as never)
          globalSink.append({ type: "settings.changed", settings })
        }
        const active = activeRecipe(recipes, rolesFor(store.settings.get(), command.directory))
        return reply(connection, command.id, { ok: true, result: { recipes, ...(active ? { active } : {}) } })
      }
      case "compound.get":
      case "compound.configure":
      case "compound.start":
      case "compound.cancel": {
        if (connection.remoteAddress && !isLoopbackHost(connection.remoteAddress)) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Compound control requires a local or authenticated loopback client" })
        try {
          if (command.type === "compound.start") {
            const origin = command.input.originSessionId
            if (origin && (!store.hasSession(origin) || canonicalDir(store.sessionDirectory(origin)!) !== canonicalDir(command.input.directory))) throw new Error("Origin session must belong to the compound project")
            return reply(connection, command.id, { ok: true, result: { run: compound.start({ ...command.input, directory: canonicalDir(command.input.directory) }) } })
          }
          const result = command.type === "compound.configure" ? compound.configure(command.config, command.expectedHash) : command.type === "compound.cancel" ? compound.cancel(command.runId) : compound.report(command.directory ? canonicalDir(command.directory) : undefined, command.runId)
          return reply(connection, command.id, { ok: true, result: { report: result } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[COMPOUND]: ${error instanceof Error ? error.message : String(error)}` }) }
      }
      case "providers.list":
      case "providers.set":
      case "providers.remove":
      case "providers.test":
      case "providers.refresh": {
        const providers = options.providers
        if (!providers) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: API-key providers need the native engine" })
        // Keys only ever go in (providers.set); every reply carries ProviderInfo, which has no key field.
        if (command.type === "providers.list") {
          // A read-only peer neither changes the provider file's mode nor sees any part of a key.
          const readOnly = connection.peer?.readOnly === true
          const listed = providers.list(readOnly)
          return reply(connection, command.id, { ok: true, result: { providers: readOnly ? listed.map(({ keyTail: _keyTail, ...provider }) => provider) : listed } })
        }
        if (command.type === "providers.set") {
          const { id: _id, clientId: _clientId, type: _type, provider, providerType, ...fields } = command
          const done = providers.set({ id: provider, providerType, ...fields })
          return reply(connection, command.id, done.ok ? { ok: true, result: { provider: done.provider } } : done)
        }
        if (command.type === "providers.remove") {
          const done = providers.remove(command.provider)
          return reply(connection, command.id, done.ok ? { ok: true, result: { providers: done.providers } } : done)
        }
        if (command.type === "providers.test") {
          const result = await providers.test(command.provider, command.model)
          if (!result) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: no provider named ${command.provider}` })
          return reply(connection, command.id, { ok: true, result })
        }
        const refreshed = await providers.refresh(command.provider)
        return reply(connection, command.id, refreshed.ok ? { ok: true, result: { provider: refreshed.provider } } : refreshed)
      }
      case "providers.auth.methods":
      case "providers.auth.status":
      case "providers.auth.plan":
      case "providers.auth.authorize":
      case "providers.auth.action":
      case "providers.auth.metadata": {
        try {
          if (connection.remoteAddress && ["providers.auth.authorize", "providers.auth.action", "providers.auth.metadata"].includes(command.type)) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Provider credential changes are local only" })
          const result = command.type === "providers.auth.methods" ? { methods: providerAuth.methods(command.provider) }
            : command.type === "providers.auth.status" ? { statuses: providerAuth.status(command.provider) }
            : command.type === "providers.auth.plan" ? { plan: providerAuth.plan(command.provider, command.method) }
            : command.type === "providers.auth.authorize" ? { authorization: await providerAuth.authorize(command.provider, command.method, command.open) }
            : command.type === "providers.auth.metadata" ? { metadata: await providerAuth.metadata.login(command) }
            : { status: await providerAuth.action(command.provider, command.action) }
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${error instanceof Error ? error.message : "Provider authentication failed"}` })
        }
      }
      case "models.config.get":
        return reply(connection, command.id, { ok: true, result: { ...catalogConfig(options.info?.engine ?? "unknown", catalog, rolesFor(store.settings.get(), command.directory)) } })
      case "models.default.set": {
        try {
          const preset = command.preset ? catalogPresets(catalog).find((preset) => preset.name === command.preset) : undefined
          if (command.preset && !preset) throw new Error(`unknown model preset ${command.preset}`)
          const choice = catalogChoice(preset ?? { provider: command.provider!, model: command.model!, authMode: command.authMode }, catalog)
          const roles = { ...rolesFor(store.settings.get(), command.directory), main: choice }
          if (!command.dryRun) {
            const settings = store.settings.set(rolesPatch(store.settings.get(), command.directory, roles) as never)
            globalSink.append({ type: "settings.changed", settings })
          }
          return reply(connection, command.id, { ok: true, result: { ...catalogConfig(options.info?.engine ?? "unknown", catalog, roles), mode: command.dryRun ? "dry-run" : "write", writesConfig: !command.dryRun, writesSecrets: false } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${(error as Error).message}` })
        }
      }
      case "providers.catalog": {
        const login = options.info?.login ? await options.info.login().catch(() => ({ ok: false })) : undefined
        const api = options.providers?.inventory?.() ?? []
        const ownAuth = providerAuth.chatgpt.status()
        return reply(connection, command.id, { ok: true, result: { providers: [...api, { id: "chatgpt", name: "ChatGPT", type: options.info?.engine ?? "unknown", configured: ownAuth.source === "v2" || Boolean(login), enabled: ["native", "codex"].includes(options.info?.engine ?? ""), authReady: ownAuth.source === "v2" ? ownAuth.state === "authorized" : login?.ok ?? null, authMode: "chatgpt-subscription-oauth", models: catalog.list().filter((entry) => !entry.provider && !entry.engine).length, requiredEnv: [], presentEnv: [], credentialStored: ownAuth.source === "v2" }], callsProviders: false, secretsPrinted: false } })
      }
      case "providers.logout": {
        if (command.provider === "chatgpt" || command.provider === "github-copilot") {
          if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "OAuth credential changes are local only" })
          const status = await providerAuth.action(command.provider, "logout")
          if (command.provider === "github-copilot") options.providers?.logout?.(command.provider)
          return reply(connection, command.id, { ok: true, result: { status } })
        }
        const done = options.providers?.logout?.(command.provider)
        if (!done) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: stored API credentials unavailable; subscription login is managed by its adapter" })
        return reply(connection, command.id, done.ok ? { ok: true, result: { provider: done.provider } } : done)
      }
      case "mcp.add": {
        try {
          const result = addMcpConfig({ ...command, dir: options.dir, pending: Boolean(connection.remoteAddress || connection.peer) })
          if (!command.dryRun) {
            options.mcp?.invalidate?.(command.scope === "project" ? command.directory : undefined)
            if (connection.remoteAddress || connection.peer) {
              try { await options.mcp?.suspend?.({ ...(command.scope === "project" ? { directory: command.directory } : {}), server: command.name }) }
              catch { throw new Error("MCP request saved as pending; could not suspend the previous client") }
            }
            globalSink.append({ type: "mcp.changed", directory: command.directory, server: command.name })
          }
          const { path: _path, ...publicResult } = result
          return reply(connection, command.id, { ok: true, result: connection.remoteAddress || connection.peer ? publicResult : result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${(error as Error).message}` })
        }
      }
      case "mcp.decide": {
        try {
          const result = decideMcpConfig({ ...command, dir: options.dir })
          options.mcp?.invalidate?.(command.scope === "project" ? command.directory : undefined)
          globalSink.append({ type: "mcp.changed", directory: command.directory, server: command.server })
          return reply(connection, command.id, { ok: true, result })
        } catch {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "MCP request expired or changed; refresh before approving" })
        }
      }
      case "mcp.debug": {
        if (!options.mcp?.debug) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: MCP debug unavailable" })
        try {
          return reply(connection, command.id, { ok: true, result: { ...await options.mcp.debug({ directory: command.directory, server: command.server }) } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` })
        }
      }
      case "status.watch": {
        const directory = path.resolve(command.directory)
        const current = connection.statusWatches.get(directory)
        if (command.watching && !current) connection.statusWatches.set(directory, statusLines.watch(directory))
        if (!command.watching && current) {
          current()
          connection.statusWatches.delete(directory)
        }
        return reply(connection, command.id, { ok: true })
      }
      case "themes.list":
        return reply(connection, command.id, { ok: true, result: { themes: readLayerThemes(layersFor(command.directory)) } })
      case "theme.validate":
      case "theme.install":
      case "theme.select": {
        try {
          const themes = createThemes({ dir: options.dir, settings: store.settings, applyProfile: (theme) => {
            const result = tuiControl.run({ operation: "apply", profile: { theme } })
            globalSink.append({ type: "tui.changed", profile: result.profile as Record<string, never> })
          }, changed: (settings) => { globalSink.append({ type: "settings.changed", settings }) } })
          return reply(connection, command.id, { ok: true, result: themes.run(command) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[THEME]: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      case "commands.list": {
        try {
          const commands = await loadCustomCommands({ directory: command.directory, userDir: options.dir, layers: resourceLayersFor(command.directory), prompts: connection.peer?.readOnly ? [] : mcpCommands(options.mcp?.cachedPrompts?.(command.directory) ?? []), extra: connection.peer?.readOnly ? [] : await extensions.commandEntries(command.directory) })
          if (!connection.peer?.readOnly && options.mcp?.catalog) {
            const catalog = await options.mcp.catalog(command.directory)
            for (const prompt of catalog.prompts) {
              if (commands.some((entry) => entry.name.toLowerCase() === prompt.id.toLowerCase())) continue
              commands.push(mcpCatalogCommands([prompt])[0]!)
            }
          }
          return reply(connection, command.id, { ok: true, result: { commands: commands.map(({ body: _body, mcp: _mcp, ...summary }) => summary) } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) }) }
      }
      case "commands.discover": {
        const discovered = await options.mcp?.listPrompts?.(command.directory) ?? { prompts: [], issues: [] }
        const commands = mcpCommands(discovered.prompts).map(({ body: _body, mcp: _mcp, ...summary }) => summary)
        return reply(connection, command.id, { ok: true, result: { commands, issues: discovered.issues } })
      }
      case "commands.execute": {
        const directory = store.sessionDirectory(command.sessionId)
        if (!directory) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "unknown session" })
        const displayText = `/${command.name.toLowerCase()}${command.args.trim() ? ` ${command.args.trim()}` : ""}`
        try {
          if (await extensions.hasCommand(directory, command.name)) return handle(connection, { ...command, type: "user.submit", text: displayText, attachments: command.attachments ?? [] })
          let definition = (await loadCustomCommands({ directory, userDir: options.dir, layers: resourceLayersFor(directory), prompts: mcpCommands(options.mcp?.cachedPrompts?.(directory) ?? []) })).find((entry) => entry.name === command.name.toLowerCase())
          if (!definition && command.name.includes(":")) definition = mcpCommands((await options.mcp?.listPrompts?.(directory))?.prompts ?? []).find((entry) => entry.name === command.name.toLowerCase())
          let fromCatalog = false
          if ((!definition || definition.source === "mcp") && command.name.includes(":") && options.mcp?.catalog) {
            const matches = (await options.mcp.catalog(directory)).prompts.filter((entry) => entry.id.toLowerCase() === command.name.toLowerCase())
            if (matches.length > 1) throw new Error(`ambiguous MCP prompt /${command.name}`)
            const prompt = matches[0]
            if (prompt) {
              definition = mcpCatalogCommands([prompt])[0]!
              fromCatalog = true
            }
          }
          if (!definition) throw new Error(`unknown command /${command.name}`)
          const sessionModel = resolveModel({ role: "main", session: store.sessionModel(command.sessionId), roles: rolesFor(store.settings.get(), directory), catalog })
          let invocation = { command: definition, args: command.args }
          const skillText = skillInvocation(directory, definition, command.args)
          if (skillText !== undefined) invocation = { command: { ...definition, body: "$ARGUMENTS" }, args: skillText }
          if (fromCatalog) {
            const prompt = await expandMcpPrompt(options.mcp!, directory, command.name, command.args)
            if (prompt === undefined) throw new Error(`unknown MCP prompt /${command.name}`)
            const { mcp: _mcp, ...summary } = definition
            // Insert MCP content as an argument so template syntax in its text stays inert.
            invocation = { command: { ...summary, body: "$ARGUMENTS" }, args: prompt }
          }
          const prepared = await commandExecution.prepare({
            ...invocation, directory,
            current: command.selection?.model ?? sessionModel, sessionModel, hasSelection: command.selection !== undefined,
            currentAgent: command.selection?.agent ?? (livePermission(command.sessionId) === "plan" ? "plan" : store.sessionAgent(command.sessionId) ?? "build"),
            agents: agents.report({ directory }).agents, permission: livePermission(command.sessionId),
            trusted: (store.settings.get().trustedToolDirs ?? []).some((entry) => canonicalDir(entry) === canonicalDir(directory)),
          })
          if (prepared.subtask) {
            const task = await tasks.start(command.sessionId, { description: `/${command.name}`, prompt: prepared.text + (command.contextText ?? ""), agent: prepared.agent }, { displayText, attachments: command.attachments ?? [], ...(prepared.model ? { model: prepared.model } : {}) })
            announceSession(task.taskId, directory, command.sessionId)
            const queued = store.readAfter(task.taskId, 0, 10).find((event) => event.type === "queue.added")
            return reply(connection, command.id, { ok: true, result: { task, ...(queued?.type === "queue.added" ? { queueId: queued.queueId } : {}) } })
          }
          return handle(connection, { id: command.id, clientId: command.clientId, type: "user.submit", sessionId: command.sessionId, text: prepared.text + (command.contextText ?? ""), displayText, attachments: command.attachments ?? [], ...(prepared.model || definition.agent || command.selection?.agent ? { selection: { ...(prepared.model ? { model: prepared.model } : {}), ...(definition.agent || command.selection?.agent ? { agent: prepared.agent } : {}) } } : {}) })
        } catch (error) {
          const message = captured(command.sessionId, error instanceof Error ? error.message : String(error))
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "ok" in message ? "command failed" : message.text })
        }
      }
      case "extensions.list":
        return reply(connection, command.id, { ok: true, result: await extensions.report(command.directory) })
      case "extensions.disable": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: extensions are turned on and off on the machine that runs them" })
        const current = store.settings.get().disabledExtensions ?? []
        const next = command.disabled ? [...new Set([...current, command.name])].slice(-200) : current.filter((name) => name !== command.name)
        globalSink.append({ type: "settings.changed", settings: store.settings.set({ disabledExtensions: next.length ? next : null }) })
        // Reloads the registrations (the extension's module is not run again) and tells every terminal to do the same.
        return reply(connection, command.id, { ok: true, result: await uiReload.reload(command.directory) })
      }
      case "extensions.flags": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: extension flags come from a command line on this machine" })
        const directory = store.hasSession(command.sessionId) ? store.sessionDirectory(command.sessionId) : undefined
        if (!directory) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const checked = await extensions.checkFlags(directory, command.flags)
        if (!checked.ok) return reply(connection, command.id, { ok: false, code: "invalid_command", message: checked.error })
        const text = JSON.stringify(checked.values)
        // The meta store keeps 500 characters a value: a longer set would be cut into invalid JSON, so it is refused instead.
        if (text.length > 480) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "extension flag values are too long together (480 characters)" })
        store.meta.set(`session.extension-flags:${command.sessionId}`, text)
        return reply(connection, command.id, { ok: true, result: { flags: checked.values } })
      }
      case "hooks.list": {
        // Shell hooks, their recent runs, and everything project-local that still waits for `tools.trust` (what the startup trust prompt names).
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: hook status is local only" })
        const directory = canonicalDir(command.directory)
        const report = shellHooks.report(directory)
        const [tools, listed] = await Promise.all([customTools.list(directory), extensions.list(directory)])
        const mcpHeld = options.mcp ? (await options.mcp.status(directory).catch(() => ({ servers: [] }))).servers.filter((server) => server.needsTrust).length : 0
        const pending = { hooks: report.pending.hooks, tools: tools.tools.filter((tool) => tool.source === "project" && !tool.trusted).length, extensions: listed.filter((entry) => entry.source !== "user" && !entry.trusted).length, ...(mcpHeld ? { mcp: mcpHeld } : {}) }
        return reply(connection, command.id, { ok: true, result: { ...report, pending } })
      }
      case "plugins.install":
      case "plugins.auth-methods":
      case "plugins.auth-start":
      case "plugins.auth-complete": {
        try {
          const result = command.type === "plugins.install" ? await installPlugin({ dataDir: options.dir, directory: path.resolve(command.directory), spec: command.spec, ...(command.global !== undefined ? { global: command.global } : {}), ...(command.force !== undefined ? { force: command.force } : {}) })
            : command.type === "plugins.auth-methods" ? { providers: await extensions.authMethods(command.directory) }
            : command.type === "plugins.auth-start" ? await extensions.authStart(command.directory, command.provider, command.method, command.inputs ?? {})
            : await extensions.authComplete(command.directory, command.flowId, command.code)
          if (command.type === "plugins.install") await uiReload.reload(command.directory)
          return reply(connection, command.id, { ok: true, result })
        } catch {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: plugin operation failed; check selection, offline cache and /extensions" })
        }
      }
      case "plugins.metadata": {
        if (command.operation === "list") return reply(connection, command.id, { ok: true, result: { entries: pluginMetadata.list(command.plugin, store.listSessions({ directory: command.directory, limit: 500 }).map((session) => session.sessionId)) } })
        if (!command.sessionId || !store.hasSession(command.sessionId) || path.resolve(store.sessionDirectory(command.sessionId) ?? "") !== path.resolve(command.directory)) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: plugin metadata session does not belong to this directory" })
        try {
          const metadata = command.operation === "patch" ? pluginMetadata.patch(command.plugin, command.sessionId, command.patch ?? {}) : pluginMetadata.get(command.plugin, command.sessionId)
          return reply(connection, command.id, { ok: true, result: { metadata } })
        } catch {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: invalid plugin metadata patch" })
        }
      }
      case "extensions.report":
        uiReload.report(connection, command.revision, command.errors)
        return reply(connection, command.id, { ok: true })
      case "extensions.reload":
        return reply(connection, command.id, { ok: true, result: await uiReload.reload(command.directory) })
      case "extensions.export":
        return reply(connection, command.id, { ok: true, result: await uiReload.exportLook(command.directory) })
      case "commands.expand": {
        // An extension command runs in the daemon when its text is submitted: expanding keeps `/name args` so `user.submit` runs it.
        if (!connection.peer?.readOnly && await extensions.hasCommand(command.directory, command.name)) return reply(connection, command.id, { ok: true, result: { prompt: `/${command.name.toLowerCase()}${command.args.trim() ? ` ${command.args.trim()}` : ""}` } })
        const found = (await loadCustomCommands({ directory: command.directory, userDir: options.dir, layers: resourceLayersFor(command.directory) })).find((c) => c.name === command.name.toLowerCase())
        if (!found) {
          try {
            const prompt = !connection.peer?.readOnly && options.mcp ? await expandMcpPrompt(options.mcp, command.directory, command.name, command.args) : undefined
            if (prompt !== undefined) return reply(connection, command.id, { ok: true, result: { prompt } })
          } catch (error) {
            return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` })
          }
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: unknown command /${command.name}` })
        }
        let skillText: string | undefined
        try { skillText = skillInvocation(command.directory, found, command.args) } catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` }) }
        return reply(connection, command.id, { ok: true, result: { prompt: skillText ?? expandCommand(found.body, command.args), ...(found.agent ? { agent: found.agent } : {}), ...(found.model ? { model: found.model } : {}), ...(found.subtask !== undefined ? { subtask: found.subtask } : {}) } })
      }
      case "mcp.catalog":
      case "mcp.resources.list":
      case "mcp.prompts.list": {
        if (!options.mcp?.catalog) return reply(connection, command.id, { ok: true, result: { resources: [], templates: [], prompts: [], issues: [] } })
        try {
          const catalog = await options.mcp.catalog(command.directory)
          const result = command.type === "mcp.resources.list" ? { resources: catalog.resources, templates: catalog.templates, issues: catalog.issues } : command.type === "mcp.prompts.list" ? { prompts: catalog.prompts, issues: catalog.issues } : { ...catalog }
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` })
        }
      }
      case "mcp.resource.read":
      case "mcp.prompt.get": {
        try {
          if (command.type === "mcp.resource.read" && options.mcp?.readResource) return reply(connection, command.id, { ok: true, result: { contents: await options.mcp.readResource(command) } })
          if (command.type === "mcp.prompt.get" && (options.mcp?.getPromptResult || options.mcp?.getPrompt)) {
            const result = await (options.mcp.getPromptResult?.(command) ?? options.mcp.getPrompt!(command))
            return reply(connection, command.id, { ok: true, result: typeof result === "string" ? { messages: [{ role: "user", content: { type: "text", text: result } }] } : { ...result } })
          }
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: MCP content unavailable" })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${(error as Error).message}` })
        }
      }
      case "attachment.add":
        try {
          const { bytes, mime, name } = await readAttachment(command.path, { home: homedir() })
          return reply(connection, command.id, { ok: true, result: { attachment: store.putBlob(bytes, mime), name } })
        } catch (error) {
          if (error instanceof AttachmentError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      case "attachment.put":
        try {
          // A piece of a larger file: kept per connection until its last piece, which is checked and stored as a whole.
          let whole: string | Uint8Array = command.data
          if (command.part) {
            const key = `${connection.id}:${command.part.upload}`
            const piece = new Uint8Array(Buffer.from(command.data, "base64"))
            const upload = command.part.index === 0 ? { pieces: [] as Uint8Array[], bytes: 0 } : partialUploads.get(key)
            if (!upload || upload.pieces.length !== command.part.index) {
              partialUploads.delete(key)
              throw new AttachmentError("attachment pieces must arrive in order from index 0")
            }
            upload.pieces.push(piece)
            upload.bytes += piece.length
            if (upload.bytes > TEXT_PUT_MAX_BYTES) {
              partialUploads.delete(key)
              throw new AttachmentError(`${command.name} exceeds the ${TEXT_PUT_MAX_BYTES / 1_048_576} MiB text limit`)
            }
            if (!command.part.last) {
              partialUploads.delete(key)
              // At most a few uploads per connection are open at once; the oldest goes first.
              if ([...partialUploads.keys()].filter((each) => each.startsWith(`${connection.id}:`)).length >= 4) partialUploads.delete([...partialUploads.keys()].find((each) => each.startsWith(`${connection.id}:`))!)
              partialUploads.set(key, upload)
              return reply(connection, command.id, { ok: true, result: { received: upload.bytes } })
            }
            partialUploads.delete(key)
            whole = Buffer.concat(upload.pieces)
          }
          const { bytes, mime, name } = decodeAttachment(whole, command.name)
          return reply(connection, command.id, { ok: true, result: { attachment: store.putBlob(bytes, mime), name } })
        } catch (error) {
          if (error instanceof AttachmentError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      case "attachment.clipboard":
        // The clipboard belongs to the machine the daemon runs on, never to a remote or peer client.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: clipboard access is local only" })
        try {
          if (command.text && clipboard.readText) {
            const text = await clipboard.readText()
            if (text) return reply(connection, command.id, { ok: true, result: { kind: "text", text } })
          }
          const { bytes, mime } = await clipboard.read()
          return reply(connection, command.id, { ok: true, result: { attachment: store.putBlob(bytes, mime), name: "clipboard.png", ...imageDimensions(bytes) } })
        } catch (error) {
          if (error instanceof AttachmentError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      case "attachment.read": {
        // Session blobs are served to local clients only, and only by hash: no path ever reaches the filesystem from the wire.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: attachment reads are local only" })
        const info = store.sessionBlob(command.sessionId, command.sha256)
        if (!info) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: no such attachment in this session" })
        const offset = command.offset ?? 0
        if (offset > info.bytes) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: offset is past the end of the attachment" })
        const length = Math.min(ATTACHMENT_READ_CHUNK, info.bytes - offset)
        const chunk = store.readBlob(command.sha256).subarray(offset, offset + length)
        return reply(connection, command.id, { ok: true, result: { sha256: command.sha256, mime: info.mime, bytes: info.bytes, offset, data: chunk.toString("base64"), done: offset + length >= info.bytes } })
      }
      case "attachment.paste":
        try {
          const resolved = await resolvePastedPath(command.path, { home: homedir(), ...(command.directory ? { directory: command.directory } : {}), ...(command.allowDirectory ? { allowDirectory: true } : {}) })
          if (resolved.kind === "image" || resolved.kind === "document") return reply(connection, command.id, { ok: true, result: { kind: resolved.kind, attachment: store.putBlob(resolved.bytes, resolved.mime), name: resolved.name, ...(resolved.kind === "image" ? imageDimensions(resolved.bytes) : {}) } })
          if (resolved.kind === "mention") return reply(connection, command.id, { ok: true, result: { kind: "mention", path: resolved.path } })
          return reply(connection, command.id, { ok: true, result: { kind: "text", name: resolved.name, content: resolved.content, ...(resolved.directory ? { directory: true } : {}) } })
        } catch (error) {
          if (error instanceof AttachmentError) return reply(connection, command.id, { ok: false, code: "invalid_command", message: error.message })
          throw error
        }
      case "review.query":
      case "review.update":
        if (!store.sessionDirectory(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[REVIEW]: session not found" })
        try {
          const result = command.type === "review.query" ? await reviews.read(command.sessionId, command.query) : await reviews.update(command.sessionId, command.change)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof NotGitError ? "not_git" : "invalid_command", message: error instanceof Error ? error.message : String(error) })
        }
      case "changes.query":
      case "changes.file":
        try {
          const loaded = await readChanges(command.directory, command.type === "changes.file" ? { only: command.path } : {})
          // A read-only peer sees which files changed and by how much, never their content (a diff can hold credentials).
          const report = connection.peer?.readOnly ? { ...loaded, files: loaded.files.map((file) => ({ ...file, diff: "", truncated: file.truncated || file.diff !== "" })) } : loaded
          if (command.type === "changes.file") return reply(connection, command.id, { ok: true, result: report.files[0] ?? {} })
          return reply(connection, command.id, { ok: true, result: report })
        } catch (error) {
          if (error instanceof NotGitError) return reply(connection, command.id, { ok: false, code: "not_git", message: error.message })
          throw error
        }
      case "ide.query":
      case "ide.configure":
      case "ide.open": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "IDE bridge is local only" })
        try {
          const result = command.type === "ide.query" ? await ide.query(command.directory)
            : command.type === "ide.configure" ? await ide.configure(command.directory, command.enabled, command.dbPath, command.editor)
            : await ide.open(command.directory, command.filePath, command.line, command.character)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "IDE bridge failed" }) }
      }
      case "url.open": {
        // A click on a link in a terminal: the browser opens on this machine, so a remote client never gets to do it.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Opening links is local only" })
        try {
          await (options.openUrl ?? (await import("./open-url")).openUrl)(command.url)
          return reply(connection, command.id, { ok: true, result: { opened: true } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "Could not open the browser" }) }
      }
      case "image.open": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Opening images is local only" })
        try {
          await (options.openImage ?? (await import("./open-url")).openImage)({ path: command.path, ...(command.reveal ? { reveal: true } : {}) })
          return reply(connection, command.id, { ok: true, result: { opened: true } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "Could not open the image" }) }
      }
      case "session.changes":
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Session file snapshots are local only" })
        return reply(connection, command.id, history.changes(command))
      case "session.savings":
        return reply(connection, command.id, sessionPanelSavings(store, command.sessionId, connection))
      case "mcp.status": {
        const report = options.mcp ? await options.mcp.status(command.directory) : { servers: [], issues: [] }
        const pending = pendingMcpServers({ dir: options.dir, directory: command.directory })
        report.servers = [...report.servers.filter((server) => !pending.some((entry) => entry.name === server.name)), ...pending]
        if (!connection.remoteAddress && !connection.peer) return reply(connection, command.id, { ok: true, result: report })
        // A server's command line, error and stderr tail can carry its credentials: a remote peer gets them masked.
        const mask = (text: string) => redactSecrets(text).text
        return reply(connection, command.id, { ok: true, result: { servers: report.servers.map((server) => ({ ...server, ...(server.pending ? { pending: { ...server.pending, details: [] } } : {}), command: mask(server.command), stderr: server.stderr.map(mask), ...(server.lastError !== undefined ? { lastError: mask(server.lastError) } : {}) })), issues: report.issues.map((issue) => ({ ...issue, message: mask(issue.message) })) } })
      }
      case "catalog.rest": {
        try { return reply(connection, command.id, { ok: true, result: await catalogRest.run(command.directory, command.input, connection.signal ?? new AbortController().signal) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: error instanceof CatalogRestError ? error.code : "invalid_command", message: error instanceof CatalogRestError ? error.message : "Catalog operation failed" }) }
      }
      case "lsp.query": {
        if (!options.lsp) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: LSP is not available" })
        const { operation, filePath, line, character, query } = command
        const report = await options.lsp.query({ operation, filePath, line, character, query, cwd: command.directory })
        return reply(connection, command.id, { ok: true, result: report })
      }
      case "lsp.install": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: language servers are installed on the machine that runs them" })
        if (!options.lspInstall) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: LSP is not available" })
        const result = await options.lspInstall({ server: command.server, cwd: command.directory })
        if (result.reason) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[LSP]: ${command.server} was not installed: ${result.reason}` })
        return reply(connection, command.id, { ok: true, result })
      }
      case "formatter.status":
      case "formatter.file": {
        if (!options.formatter) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: Formatter is not available" })
        const report = command.type === "formatter.status" ? await options.formatter.status({ cwd: command.directory }) : await options.formatter.file({ cwd: command.directory, path: command.path })
        return reply(connection, command.id, { ok: true, result: report })
      }
      case "mcp.auth": {
        const action = command.action ?? "start"
        const mcp = options.mcp
        if (!mcp?.startAuth || !mcp.cancelAuth || !mcp.forgetAuth) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: MCP OAuth is not available" })
        const target = { directory: command.directory, server: command.server }
        const changed = () => {
          if (!stopped) globalSink.append({ type: "mcp.changed", ...target })
        }
        try {
          if (action === "cancel") {
            await mcp.cancelAuth(target)
            changed()
            return reply(connection, command.id, { ok: true })
          }
          if (action === "forget") {
            const server = await mcp.forgetAuth(target)
            changed()
            return reply(connection, command.id, { ok: true, result: { server } })
          }
          const started = await mcp.startAuth(target)
          // Both authorization and denial/cancellation change the status; never wait for the browser in the ack.
          void started.completion.then(changed, changed)
          changed()
          return reply(connection, command.id, { ok: true, result: { url: started.url } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      case "mcp.restart":
        if (!options.mcp) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: MCP is not available" })
        try {
          return reply(connection, command.id, { ok: true, result: { server: await options.mcp.restart({ directory: command.directory, server: command.server }) } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${error instanceof Error ? error.message : String(error)}` })
        }
      case "prompt.history":
      case "prompt.record":
      case "prompt.history.delete": {
        // What the user typed on this machine (commands, shell lines, drafts) is not for peers or remote clients to read or change.
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: prompt history is local only" })
        if (command.type === "prompt.history") {
          const entries = store.promptEntries(command.directory, command.limit)
          return reply(connection, command.id, { ok: true, result: { prompts: entries.map((entry) => entry.text), entries } })
        }
        if (command.type === "prompt.history.delete") {
          const removed = command.entryId !== undefined ? Number(store.removePrompt(command.directory, command.entryId)) : store.clearPromptDrafts(command.directory)
          return reply(connection, command.id, { ok: true, result: { removed } })
        }
        // Typed text may hold a pasted secret: it is stored as its marker, like a draft.
        const typed = captured(command.sessionId, command.text)
        if ("ok" in typed) return reply(connection, command.id, typed)
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const kept = store.recordPrompt(command.sessionId, typed.text, command.kind)
        return reply(connection, command.id, { ok: true, ...(kept ? { result: { kept } } : {}) })
      }
      case "resource.mode.set":
        scheduler.setMode(command.mode)
        return reply(connection, command.id, { ok: true })
      case "diagnostics.resources":
        Bun.gc(true)
        return reply(connection, command.id, {
          ok: true,
          result: { ...registry.snapshot(), connections: connections.size, actors: actors.size, jobs: scheduler.snapshot().length, rssBytes: process.memoryUsage().rss, memory: process.memoryUsage(), pid: process.pid, uptime: process.uptime() },
        })
      case "diagnostics.snapshot":
        return reply(connection, command.id, { ok: true, result: { path: await writeDiagnosticsSnapshot(options.dir) } })
      case "job.schedule":
      case "job.cancel":
        return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: no job types are registered in F1" })
      case "session.list": {
        if (!connection.remoteAddress && !connection.peer && featureOn(store.settings.get(), "session_meta", { safeMode: options.safeMode })) {
          for (const session of store.listSessions({ directory: command.directory, limit: 500 })) lifecycle.evaluate(session.sessionId)
        }
        const listed = sessionAutomation.list(command)
        // The unsent drafts, in one query, so a list can label an untitled session; whoever may not call `draft.get` (a read-only token) does not get them here.
        const heads = connection.peer?.readOnly ? new Map() : store.drafts.heads(listed.map((summary) => summary.sessionId))
        const sessions = listed.map((summary) => ({ ...summary, ...liveInfo(summary.sessionId), ...(heads.has(summary.sessionId) ? { draft: heads.get(summary.sessionId) } : {}) }))
        return reply(connection, command.id, { ok: true, result: { sessions } })
      }
      case "session.get":
      case "session.inspect": {
        const result = command.type === "session.get" ? sessionAutomation.detail(command.sessionId) : sessionAutomation.inspect(command.sessionId, command.limit)
        return reply(connection, command.id, result ? { ok: true, result: command.type === "session.get" ? { session: result } : result } : { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
      }
      case "session.stats": {
        const stats = store.sessionStats.get(command.sessionId, clock.now())
        return reply(connection, command.id, stats ? { ok: true, result: { stats, text: sessionStatsText(stats) } } : { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
      }
      case "session.detach": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "Unknown session" })
        store.detached.set(command.sessionId)
        const child = tasks.get(command.sessionId)
        if (child) tasks.detach(child.parentId, child.taskId)
        sessionBackground.register(command.sessionId, { state: store.pendingRequestsOf(command.sessionId).length ? "needs_input" : actors.get(command.sessionId)?.snapshot().turnId ? "working" : "completed" })
        return reply(connection, command.id, { ok: true })
      }
      case "session.control": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        try { return reply(connection, command.id, { ok: true, result: await controlSession(command.sessionId, command.action) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error).slice(0, 500) }) }
      }
      case "task.list":
        return reply(connection, command.id, { ok: true, result: { tasks: tasks.list(command.sessionId) } })
      case "task.run":
      case "task.status": {
        try {
          if (command.type === "task.run") {
            if (command.input.engine && (connection.remoteAddress || connection.peer)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: cross-engine delegation is local only" })
            const task = await tasks.port.run(command.sessionId, command.input, new AbortController().signal)
            return reply(connection, command.id, { ok: true, result: { task } })
          }
          if (command.action === "detach") return reply(connection, command.id, { ok: true, result: { task: tasks.detach(command.sessionId, command.taskId) } })
          const text = await tasks.port.status(command.sessionId, { task_id: command.taskId, action: command.action ?? "get", timeout_ms: command.timeoutMs }, new AbortController().signal)
          return reply(connection, command.id, { ok: true, result: { task: tasks.get(command.taskId), text } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error) }) }
      }
      case "background.stop": {
        // The user stops what runs in the background of a session (`/ps`): one item by its listed id, or all of them.
        const shells = background.listAll(command.sessionId).filter((task) => task.status === "running" && (!command.taskId || task.id === command.taskId))
        const engine = (engineTasks.get(command.sessionId) ?? []).filter((task) => !command.taskId || `engine:${task.id}` === command.taskId)
        if (command.taskId && !shells.length && !engine.length) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: nothing with that id runs in the background of this session" })
        for (const task of shells) background.stopByUser(command.sessionId, task.id)
        const stop = engineTaskStops.get(command.sessionId)
        const failed: string[] = []
        for (const task of engine) {
          try {
            if (!stop) throw new Error("no stop")
            await stop(task.id)
          } catch { failed.push(secrets.mask(command.sessionId, task.description || task.kind)) }
        }
        if (shells.length) globalSink.append({ type: "session.background.changed", sessionId: command.sessionId })
        return reply(connection, command.id, { ok: true, result: { stopped: shells.length + engine.length - failed.length, failed } })
      }
      case "background.list":
        return reply(connection, command.id, { ok: true, result: { tasks: [
          ...[...engineTasks].filter(([sessionId]) => !command.sessionId || sessionId === command.sessionId).flatMap(([sessionId, tasks]) => tasks.map((task) => ({ id: `engine:${task.id}`, sessionId, command: secrets.mask(sessionId, task.description || task.kind), startedAt: task.startedAt, status: "running" as const, kind: /agent/i.test(task.kind) ? "agent" as const : "command" as const }))),
          ...background.listAll(command.sessionId).map((task) => ({ ...task, command: secrets.mask(task.sessionId as SessionId, task.command) })),
        ].slice(0, 40) } })
      case "draft.set": {
        // An unsent prompt is stored too: a pasted secret in it is kept as its marker, never as text.
        const draftText = captured(command.sessionId, command.text)
        if ("ok" in draftText) return reply(connection, command.id, draftText)
        const before = store.drafts.heads([command.sessionId]).get(command.sessionId)
        if (!store.drafts.set(command.sessionId, draftText.text, command.attachments ?? [])) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        // Other terminals label an untitled session by its draft: they hear when it appears, changes its first line or goes (not on every keystroke).
        const after = store.drafts.heads([command.sessionId]).get(command.sessionId)
        if (before?.preview !== after?.preview || before?.attachments !== after?.attachments || before?.images !== after?.images || (before === undefined) !== (after === undefined)) {
          publishActivity(command.sessionId, actors.get(command.sessionId)?.snapshot().foreground ?? "idle", true, after ?? null)
        }
        return reply(connection, command.id, { ok: true })
      }
      case "draft.get": {
        const draft = store.drafts.get(command.sessionId)
        return reply(connection, command.id, { ok: true, result: draft ? { draft } : {} })
      }
      case "draft.list": {
        if (command.maxAgeDays !== undefined) store.drafts.prune(clock.now() - command.maxAgeDays * 86_400_000)
        return reply(connection, command.id, { ok: true, result: { drafts: store.drafts.list({ ...(command.directory ? { directory: command.directory } : {}), ...(command.excludeSessionId ? { excludeSessionId: command.excludeSessionId } : {}), ...(command.limit ? { limit: command.limit } : {}) }) } })
      }
      case "session.agent-command.policy":
        return reply(connection, command.id, { ok: true, result: agentCommands.policy() })
      case "session.agent-command.list":
      case "session.agent-command.list-by-session":
      case "session.agent-command.create":
      case "session.agent-command.update": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Peer command authority is local only; remote policy is pending" })
        if (command.type === "session.agent-command.update" && !connection.subscriptions.has(command.sessionId)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "Subscribe to the target session before reviewing its command" })
        try {
          if (command.type !== "session.agent-command.create" && command.sessionId && !store.hasSession(command.sessionId)) throw new Error("Unknown session")
          const result = command.type === "session.agent-command.list" ? command.sessionId && !command.incoming ? agentCommands.list(command.sessionId) : { commands: store.agentCommands.all(command.directory, command.incoming ? command.sessionId : undefined, clock.now()), metadata: store.agentCommands.metadata(command.directory) }
            : command.type === "session.agent-command.list-by-session" ? { commands: store.agentCommands.all(undefined, command.sessionId, clock.now()), metadata: store.agentCommands.metadata(store.sessionDirectory(command.sessionId)) }
            : { command: command.type === "session.agent-command.create" ? await agentCommands.create(command.sessionId, command.targetSessionId, command.request, command.expiresAt) : await agentCommands.review(command.sessionId, command.commandId, command.state) }
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error).slice(0, 4000) }) }
      }
      case "session.agent-command.patch": {
        if (connection.remoteAddress || !connection.subscriptions.has(command.sessionId)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "Subscribe locally to the target session before updating its command" })
        try { return reply(connection, command.id, { ok: true, result: { command: await agentCommands.patch(command.sessionId, command.commandId, command) } }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error).slice(0, 4000) }) }
      }
      case "session.fanout": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Fan-out worktrees are local only" })
        if (!featureOn(store.settings.get(), "fanout", { safeMode: options.safeMode })) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Enable /tier fanout on (full)" })
        try {
          if (command.action === "start" && (!command.prompt || !command.models)) throw new Error("Fan-out needs prompt and models")
          const result = command.action === "compare" ? fanout.compare(command.sessionId) : await fanout.start(command.sessionId, command.prompt!, command.models!)
          if (command.action === "start") fanoutSummary(command.sessionId)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets(error instanceof Error ? error.message : "Fan-out failed").text.slice(0, 400) }) }
      }
      case "session.meta": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Session metadata is local only" })
        if (!featureOn(store.settings.get(), "session_meta", { safeMode: options.safeMode })) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Enable /tier session_meta on (balanced)" })
        try { return reply(connection, command.id, { ok: true, result: await lifecycle.run(command.sessionId, command.input) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets(error instanceof Error ? error.message : "Metadata operation failed").text.slice(0, 400) }) }
      }
      case "session.rename": {
        const title = command.title.trim()
        if (!title) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: title is empty" })
        if (!store.renameSession(command.sessionId, title)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        sessionSharing.changed(command.sessionId)
        store.meta.set(`session.title.manual:${command.sessionId}`, "true")
        publishActivity(command.sessionId, actors.get(command.sessionId)?.snapshot().foreground ?? "idle", true)
        return reply(connection, command.id, { ok: true })
      }
      case "session.children": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "Unknown session" })
        return reply(connection, command.id, { ok: true, result: { sessions: store.sessionChildren(command.sessionId).slice(0, 100).map((id) => sessionAutomation.detail(id)) } })
      }
      case "session.background.list":
      case "session.background.register":
      case "session.background.remove":
      case "session.background.writer.acquire":
      case "session.background.writer.release":
      case "session.agent-view.metadata.list":
      case "session.agent-view.metadata.get":
      case "session.agent-view.metadata.patch": {
        if (connection.remoteAddress && command.type !== "session.background.list" && command.type !== "session.agent-view.metadata.list" && command.type !== "session.agent-view.metadata.get") return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Background and metadata control is local only" })
        try { return reply(connection, command.id, { ok: true, result: sessionBackground.handle(command)! }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "target_mismatch", message: String(error).slice(0, 4000) }) }
      }
      case "session.delete": {
        if (store.hasSession(command.sessionId) && !actors.get(command.sessionId)?.snapshot().turnId) {
          try { await sessionSharing.beforeDelete(command.sessionId) }
          catch { return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Could not unshare session; retry before deleting" }) }
        }
        const endedIn = store.sessionDirectory(command.sessionId)
        const removed = removeSession(command.sessionId)
        if (removed === "removed") staticShare.forget(command.sessionId)
        if (removed === "unknown") return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        if (removed === "busy") return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: a turn is running in that session" })
        if (endedIn) void shellHooks.sessionEnd({ sessionId: command.sessionId, cwd: endedIn, reason: "deleted" }).catch(() => {})
        return reply(connection, command.id, { ok: true })
      }
      case "session.archive": {
        if (!store.setSessionArchived(command.sessionId, !command.restore)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const archivedIn = store.sessionDirectory(command.sessionId)
        if (!command.restore && archivedIn) void shellHooks.sessionEnd({ sessionId: command.sessionId, cwd: archivedIn, reason: "archived" }).catch(() => {})
        publishActivity(command.sessionId, actors.get(command.sessionId)?.snapshot().foreground ?? "idle", true)
        return reply(connection, command.id, { ok: true, result: { session: sessionAutomation.detail(command.sessionId) } })
      }
      case "session.search": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: searching message text is local only" })
        try {
          const hits = store.sessionSearch.search({ text: command.text, ...(command.regex ? { regex: true } : {}), ...(command.sessionIds ? { sessionIds: command.sessionIds } : {}), ...(command.directory ? { directory: command.directory } : {}), ...(command.limit ? { limit: command.limit } : {}) })
          return reply(connection, command.id, { ok: true, result: { hits: hits.map((hit) => ({ sessionId: hit.sessionId, snippet: redactSecrets(hit.snippet).text })) } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error instanceof Error ? error.message : error).slice(0, 300) })
        }
      }
      case "session.context-window": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const choice = options.models ? resolveModel({ role: "main", session: store.sessionModel(command.sessionId), roles: rolesFor(store.settings.get(), store.sessionInfo(command.sessionId)?.directory), catalog: options.models }) : undefined
        const outcome = sessionContextWindow({ meta: store.meta, settings: store.settings, sessionId: command.sessionId, tokens: command.tokens, always: command.always === true, model: options.models && choice ? catalogModel(options.models, choice.model) : undefined, modelId: choice?.model })
        if (!outcome.ok) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${outcome.message}` })
        if (outcome.settings) globalSink.append({ type: "settings.changed", settings: outcome.settings })
        return reply(connection, command.id, { ok: true, result: outcome.result })
      }
      case "workflow.start":
      case "workflow.list":
      case "workflow.get":
      case "workflow.control":
      case "workflow.preview":
      case "workflow.save":
      case "workflow.definitions":
      case "workflow.revision.get":
      case "workflow.permissions":
      case "workflow.retry-phase":
      case "workflow.script":
        // Script workflows run code: a remote address or an authenticated peer cannot start, save or change one.
        return reply(connection, command.id, await workflows.handle(command, { local: !connection.remoteAddress && !connection.peer }))
      case "workflow.events":
      case "workflow.artifacts":
      case "workflow.receipt":
      case "workflow.export":
      case "loop.artifacts":
      case "loop.receipt":
      case "loop.export":
        return reply(connection, command.id, automationLedger.handle(command))
      case "loop.events": {
        const journal = await loopControl(command)
        const ledger = automationLedger.handle({ ...command, limit: Math.min(command.limit, 100) })
        return reply(connection, command.id, ledger.ok ? { ...ledger, result: { ...ledger.result, ...(journal.ok ? journal.result : {}) } } : journal)
      }
      case "context.query": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const harness = harnessOf(command.sessionId)
        if (harness) return reply(connection, command.id, { ok: true, result: { ...harnessReport(command.sessionId, harness), sessionId: command.sessionId } })
        if (!engine.contextReport) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: context report is not available for this engine" })
        const baseReport = await engine.contextReport(command.sessionId)
        // Which extension owns how much of the tool schemas: already inside `tools`, shown beside it so a heavy one can be turned off.
        const owned = extensionsEnabled && store.sessionDirectory(command.sessionId) ? await extensions.costs(store.sessionDirectory(command.sessionId)!).catch(() => []) : []
        const withExtensions = owned.length ? { ...baseReport, extensions: owned.slice(0, 64).map((entry) => ({ id: `extension:${entry.name}`, label: entry.name, chars: entry.tokens * 4, tokens: entry.tokens, count: entry.tools })) } : baseReport
        // Extension tools are named in the rent table by their extension, so a heavy and unused one is easy to find.
        const toolOwners = owned.length && baseReport.rent ? await extensions.toolOwners(store.sessionDirectory(command.sessionId)!).catch(() => new Map<string, string>()) : undefined
        const report = toolOwners?.size ? { ...withExtensions, rent: baseReport.rent!.map((entry) => toolOwners.has(entry.tool) ? { ...entry, owner: `extension:${toolOwners.get(entry.tool)}` } : entry) } : withExtensions
        const info = options.models ? catalogModel(options.models, report.model) : undefined
        const override = windowOverride({ meta: store.meta, sessionId: command.sessionId, model: info, settings: store.settings.get() })
        if (override) return reply(connection, command.id, { ok: true, result: { ...report, sessionId: command.sessionId, contextWindow: override.tokens, ...(override.source === "session" ? { contextWindowOverride: true } : { contextWindowModelSetting: true }) } })
        return reply(connection, command.id, { ok: true, result: { ...report, sessionId: command.sessionId, ...(report.contextWindow === undefined && info?.contextWindow ? { contextWindow: info.contextWindow } : {}) } })
      }
      case "usage.query": {
        if (command.from > command.to) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: usage range is reversed" })
        const profile = options.usageProfile ? await options.usageProfile().catch(() => ({})) : {}
        return reply(connection, command.id, {
          ok: true,
          result: {
            ...createUsageQuery(store, options.defaultDirectory)(command, localDay(clock.now())),
            quotas: store.latestQuota(),
            ...(Object.keys(profile).length ? { profile } : {}),
          },
        })
      }
      case "usage.waste": {
        if (command.from > command.to) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: usage range is reversed" })
        return reply(connection, command.id, { ok: true, result: usageWaste(command) })
      }
      case "usage.weather.query":
        return reply(connection, command.id, { ok: true, result: await usageWeather(command) })
      case "session.events": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        return reply(connection, command.id, { ok: true, result: readEventsWindow({ store, sessionId: command.sessionId, before: command.before, after: command.after, limit: command.limit, includeReverted: command.includeReverted }) })
      }
      case "plan.review.list": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        return reply(connection, command.id, { ok: true, result: { reviews: readPlanReviews(store, command.sessionId) } })
      }
      case "interaction.list": {
        try { return reply(connection, command.id, { ok: true, result: interactions.list(canonicalDir(command.directory), command.kind) }) }
        catch { return reply(connection, command.id, { ok: false, code: "internal", message: "Pending requests exceed the response limit" }) }
      }
      case "memory.side-chat": {
        const directory = canonicalDir(command.directory)
        const payload = command.payload
        if (payload.root && canonicalDir(payload.root) !== directory) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "Memory root outside selected workspace" })
        return reply(connection, command.id, { ok: true, result: await memoryAssistant.sideChat(directory, payload, connection.signal) })
      }
      case "agent.create": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Agent creation is local only" })
        try {
          const listed = agents.report({ directory: canonicalDir(command.directory) }).agents
          let outcome: Parameters<typeof createAgentFile>[2]
          if (command.generate) {
            const model = command.model ? { model: command.model } : options.models?.selectable ? resolveModel({ role: "main", roles: rolesFor(store.settings.get(), command.directory), catalog: options.models }) : undefined
            const result = model && options.models?.allows?.(model.model) === false ? { fallback: `Model ${model.model} is not available`, calledProvider: false } : await generateAgentContent({ complete: completeBudgeted, description: command.description, name: command.name, model, taken: new Set([...listed.map((agent) => agent.name), ...RESERVED_AGENTS]), signal: connection.signal })
            outcome = { ...(result.content ? { generated: result.content } : {}), ...(result.fallback ? { fallback: result.fallback } : {}), calledProvider: result.calledProvider }
          }
          const created = await createAgentFile(options.dir, command, outcome)
          const loaded = agents.report({ directory: canonicalDir(command.directory) }).agents.find((agent) => agent.file === created.file)
          return reply(connection, command.id, { ok: true, result: { ...created, ...(loaded ? { agent: loaded } : {}) } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error) }) }
      }
      case "agent.debug": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Agent debug is local only" })
        const directory = canonicalDir(command.directory)
        const agent = agents.inspect(directory, command.name)
        if (!agent) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `Agent ${command.name} not found or untrusted; run agent list` })
        if (!engine.debugAgent) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Agent debug needs the native engine" })
        try {
          const sessionId = ids("session")
          const inspected = await engine.debugAgent({ directory, sessionId, agent })
          if (!command.tool) return reply(connection, command.id, { ok: true, result: { agent, ...inspected, callsProviders: false } })
          if (!inspected.tools[command.tool]) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `Tool ${command.tool} is disabled or unavailable for agent ${agent.name}` })
          store.createSession({ id: sessionId, directory, title: `Debug tool run (${agent.name})` })
          if (agent.name !== "build" && agent.name !== "plan") store.setSessionAgent(sessionId, agent.name)
          if (agent.model) store.setSessionModel(sessionId, { model: agent.model })
          const turnId = ids("turn")
          const permission = defaultPermissionFor(store.settings.get(), directory) ?? "ask"
          const result = await engine.debugAgent({ directory, sessionId, agent, run: { tool: command.tool, params: command.params ?? {}, turn: {
            sessionId, turnId, text: `Debug ${command.tool}`, attachments: [], signal: new AbortController().signal,
            newItemId: () => ids("item"), emit: (event) => {
              if (event.type === "item.started") sessionSink.append({ ...event, sessionId, turnId })
              else if (event.type === "item.delta" || event.type === "item.completed") sessionSink.append({ ...event, sessionId })
            },
            // The explicit tool command supplies approval, while runCall still enforces tool/path denies and the agent's cap.
            ask: async (request) => request.kind === "approval" ? { kind: "approve", scope: "once" } : { kind: "deny", reason: "Debug tools cannot ask interactive questions" },
            permissionMode: () => permission, setPermissionMode: () => {},
          } } })
          return reply(connection, command.id, { ok: true, result: { agent, ...result, sessionId, tool: command.tool, input: command.params ?? {}, callsProviders: command.tool === "task" } })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: String(error).slice(0, 4000) }) }
      }
      case "agents.list":
      case "session.agent.set": {
        const sessionId = command.sessionId
        if (sessionId && !store.hasSession(sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const directory = (command.type === "agents.list" ? command.directory : undefined) ?? (sessionId ? store.sessionDirectory(sessionId) : undefined)
        if (!directory) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: agents.list needs a directory or a session" })
        if (command.type === "session.agent.set") {
          const name = command.agent === null || command.agent === "build" ? undefined : command.agent
          const problem = agents.selectable(directory, name ?? "build")
          if (problem) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: `[DAEMON]: ${problem}` })
          // `plan` is plan mode itself; any other agent leaves it (like an approved plan does), so the picker never shows one while the session runs as another.
          const mode = livePermission(command.sessionId)
          const target = name === "plan" ? "plan" : mode === "plan" ? "ask" : undefined
          store.setSessionAgent(command.sessionId, name === "plan" ? undefined : name)
          const actor = target && target !== mode ? actorFor(command.sessionId) : undefined
          if (actor && target) await actor.handle({ id: command.id, clientId: command.clientId, type: "session.permission.set", sessionId: command.sessionId, mode: target })
        }
        return reply(connection, command.id, { ok: true, result: agents.report({ directory, ...(sessionId ? { sessionId, permission: livePermission(sessionId) } : {}) }) })
      }
      case "skills.list":
      case "skills.set":
      case "skills.load": {
        const directory = canonicalDir(command.directory)
        const skill = command.type !== "skills.list" ? skills.list(directory).find((entry) => entry.name === command.name) : undefined
        if (command.type !== "skills.list" && !skill) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: unknown skill" })
        if (command.type === "skills.load") {
          const loaded = skills.load(directory, command.name, { user: true })
          return reply(connection, command.id, loaded ? { ok: true, result: { ...loaded, body: redactSecrets(loaded.body).text } } : { ok: false, code: "target_mismatch", message: "[DAEMON]: skill disabled for this project" })
        }
        if (command.type === "skills.set") {
          const disabledSkills = { ...store.settings.get().disabledSkills }
          const names = disabledSkills[directory] ?? []
          disabledSkills[directory] = command.enabled ? names.filter((name) => name !== command.name) : [...new Set([...names, command.name])]
          if (!disabledSkills[directory].length) delete disabledSkills[directory]
          store.settings.set({ disabledSkills })
        }
        const inspected = skills.inspect(directory)
        return reply(connection, command.id, { ok: true, result: { skills: inspected.skills.map((entry) => ({ ...entry, enabled: skills.enabled(directory, entry.name) })), findings: inspected.diagnostics } })
      }
      case "models.list":
      case "session.model.set": {
        const sessionId = command.sessionId
        if (sessionId && !store.hasSession(sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        const baseCatalog = options.models ?? { selectable: false, list: () => [], defaults: { model: options.info?.model ?? "engine default" } }
        // The list is whole or says so: a first request that arrives while the daemon still asks whether Claude Code is installed waits for the answer.
        await baseCatalog.refresh?.()
        const extra = baseCatalog.selectable && !connection.peer?.readOnly ? await extensions.providerModels(sessionId ? store.sessionDirectory(sessionId)! : process.cwd()) : []
        const catalog = extra.length ? { ...baseCatalog, list: () => [...baseCatalog.list().filter((model) => !extra.some((item) => item.id === model.id)), ...extra] } : baseCatalog
        if (command.type === "session.model.set") {
          if ((connection.remoteAddress || connection.peer) && command.choice && ["pi", "opencode", "cursor"].includes(modelEngine(command.choice, catalog) ?? "")) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: this engine runs local tools and is local only" })
          const problem = command.choice ? invalidChoice(command.choice, catalog) : undefined
          if (problem) return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` })
          // A new model keeps the session's own `/fast` unless the choice says otherwise.
          const fast = store.sessionModel(command.sessionId)?.fast
          store.setSessionModel(command.sessionId, command.choice && command.choice.fast === undefined && fast !== undefined ? { ...command.choice, fast } : command.choice ?? undefined)
          usageLimit.revalidate(command.sessionId)
          reasoning.port.manual(command.sessionId)
        }
        const roles = rolesFor(store.settings.get(), sessionId ? store.sessionInfo(sessionId)?.directory : undefined)
        const session = sessionId ? store.sessionModel(sessionId) : undefined
        // A switch to another engine tells what will be handed over with the next message (the transcript's turns, within the cap); a remote client is not told.
        const switchedTo = command.type === "session.model.set" && !connection.remoteAddress && !connection.peer ? engineKeyOf(resolveModel({ role: "main", session, roles, catalog }), catalog) : undefined
        const idle = command.type === "session.model.set" && !store.turns.list(command.sessionId).some((turn) => turn.status === "running")
        const rebuilt = switchedTo === "native" && idle ? importForeign(command.sessionId!, resolveModel({ role: "main", session, roles, catalog })) : undefined
        const handoff = rebuilt ? { from: rebuilt.from, to: resolveModel({ role: "main", session, roles, catalog }).model, turns: rebuilt.turns, omitted: rebuilt.omitted, tokens: rebuilt.tokens, rebuilt: true as const } : switchedTo ? portable.preview({ sessionId: command.sessionId!, key: switchedTo }) : undefined
        const listed = modelsReport({ engine: options.info?.engine ?? "unknown", catalog, roles, session, sessionKnown: sessionId !== undefined, resolve: modelResolutions.apply })
        // Where the native engine packs a session on each model under the settings in force; a model another engine runs has none.
        const compactProviders = catalog.selectable ? options.providers?.list(true) ?? [] : []
        const compactSettings = store.settings.get()
        // A model's `modelContext` (a window or compaction point made permanent for it) is listed beside the catalog's window.
        const withSetting = (model: ModelInfo) => { const contextSetting = modelContextOf(compactSettings, model); return contextSetting ? { ...model, contextSetting } : model }
        const models = catalog.selectable ? listed.models.map((model) => { const compactAtTokens = modelCompactAt({ model, providers: compactProviders, settings: compactSettings }); return withSetting(compactAtTokens ? { ...model, compactAtTokens } : model) }) : listed.models.map(withSetting)
        return reply(connection, command.id, { ok: true, result: { ...listed, models, ...(sessionId ? { reasoning: reasoning.report(store.sessionInfo(sessionId)!.directory, sessionId) } : {}), ...(handoff ? { handoff } : {}) } })
      }
      case "reasoning.status": {
        const directory = canonicalDir(command.directory)
        const sessionDirectory = command.sessionId ? store.sessionDirectory(command.sessionId) : undefined
        if (command.sessionId && (!sessionDirectory || canonicalDir(sessionDirectory) !== directory)) return reply(connection, command.id, { ok: false, code: "target_mismatch", message: "[DAEMON]: reasoning session belongs to another project" })
        return reply(connection, command.id, { ok: true, result: reasoning.report(directory, command.sessionId) })
      }
      case "reasoning.configure": {
        try { return reply(connection, command.id, { ok: true, result: reasoning.configure(canonicalDir(command.directory), command.config, command.expectedRevision) }) }
        catch { return reply(connection, command.id, { ok: false, code: "invalid_command", message: "[DAEMON]: reasoning policy invalid, unsafe or changed; reload before saving" }) }
      }
      case "session.recall.search":
      case "session.recall.read":
      case "session.notes": {
        try {
          const port = recall.port(command.sessionId)
          const result = command.type === "session.recall.search" ? port.search(command.input)
            : command.type === "session.recall.read" ? port.read(command.input) : port.notes(command.input)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof SessionRecallError ? error.code : "invalid_command", message: error instanceof Error ? error.message : String(error) })
        }
      }
      case "computer.capture":
      case "computer.key":
      case "computer.session":
      case "computer.observe":
      case "computer.code": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Native computer operations are local only" })
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "Unknown session" })
        const port = computer.port(command.sessionId)
        const signal = AbortSignal.timeout(60_000)
        // Direct local commands are owner actions. Model tools use the engine's exact-target approval instead.
        const result = command.type === "computer.capture" ? await port.capture(command.input, signal)
          : command.type === "computer.key" ? await port.key(command.input, signal)
          : command.type === "computer.session" ? await port.session!(command.input, signal, { sourceId: command.id, text: "Local owner ComputerSession command", approve: async () => true })
          : command.type === "computer.observe" ? await port.observe!(command.input, signal)
          : await port.code!(command.input, signal)
        if (result.isError && command.type !== "computer.code") return reply(connection, command.id, { ok: false, code: "invalid_command", message: result.output })
        if (result.isError && command.type === "computer.code" && !result.output.startsWith("{")) return reply(connection, command.id, { ok: false, code: "invalid_command", message: result.output })
        const data = JSON.parse(result.output)
        const image = result.images?.[0]
        if (image) {
          const ref = store.putBlob(image.bytes, image.mime)
          store.refBlob(ref, command.sessionId)
          data.image = ref
        }
        return reply(connection, command.id, { ok: true, result: data })
      }
      case "sandbox.status":
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[SANDBOX]: sandbox status is local only" })
        return reply(connection, command.id, { ok: true, result: sandboxStatus({ settings: store.settings.get() }) })
      case "channels.status":
      case "channels.change": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[CHANNELS]: chat bridge control is local only" })
        try {
          if (command.type === "channels.status") return reply(connection, command.id, { ok: true, result: channels.status() })
          const changed = await channels.change(command.change)
          return reply(connection, command.id, { ok: true, result: { ...changed.report, ...(changed.pairing ? { pairing: changed.pairing } : {}) } })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "[CHANNELS]: failed" })
        }
      }
      case "daemon.info": {
        const info = options.info
        const login = info?.login ? await info.login().catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) })) : undefined
        return reply(connection, command.id, {
          ok: true,
          result: {
            engine: info?.engine ?? "unknown",
            ...(info?.model ? { model: info.model } : {}),
            ...(info?.effort ? { effort: info.effort } : {}),
            dataDir: options.dir,
            ...(!extensionsEnabled ? { extensionsEnabled: false } : {}),
            ...(options.safeMode ? { safeMode: true } : {}),
            pid: process.pid,
            ...(options.buildId ? { buildId: options.buildId } : {}),
            ...(login ? { login: { ok: login.ok, ...(login.message ? { message: login.message.slice(0, 300) } : {}) } } : {}),
            // Only when the user listed a provider: the `usage` card's live lines show it. Absent means off and nothing was ever sent.
            ...(quotaRefresh.status().length ? { quotaRefresh: quotaRefresh.status() } : {}),
          },
        })
      }
      case "audio.play": {
        if (connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Activity sound is local only" })
        return reply(connection, command.id, { ok: true, result: await audio.control(connection, command.action, command.scale) })
      }
      case "voice.control": {
        if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[VOICE]: dictation is local only" })
        const result = command.action === "start" ? await voice.start(connection) : command.action === "stop" ? await voice.stop(connection) : command.action === "cancel" ? voice.cancel(connection) : voice.status()
        return reply(connection, command.id, result.ok ? { ok: true, result: result.value } : { ok: false, code: result.code, message: result.message })
      }
      case "pet.manage": {
        if (connection.remoteAddress || connection.peer || options.safeMode) return reply(connection, command.id, { ok: false, code: "forbidden", message: "Pet management is local only and unavailable in safe mode" })
        try {
          if (!petGenerator) {
            const { createPetGenerator } = await import("./pet-generator")
            const { createPetImageApi, validatePetImageModel } = await import("./image-generation")
            petGenerator = createPetGenerator({ dir: options.dir, settings: () => store.settings.get(), budgets, now: () => clock.now(), validateModel: () => validatePetImageModel(store.settings.get(), options.providers?.imageTransport?.bind(options.providers)), image: () => options.petImages ?? createPetImageApi({ settings: store.settings.get(), ...(options.providers?.imageTransport ? { credentials: (provider) => options.providers!.imageTransport!(provider) } : {}) }) })
          }
          return reply(connection, command.id, { ok: true, result: await petGenerator.manage(command.clientId, command.input) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: error instanceof Error ? error.message : "Pet operation failed" })
        }
      }
      case "daemon.shutdown": {
        const busy = () => [...actors.values()].some(actorWorking) || scheduler.snapshot().length > 0 || engineJobs() > 0 || loops.list().some((loop) => loop.state === "verifying")
        if (busy() && !command.force && command.whenIdle) {
          restartWhenIdle ??= setInterval(() => {
            if (stopped || busy()) return
            clearInterval(restartWhenIdle)
            logLine("info", "[DAEMON]: the running work ended; stopping for the restart that waited for it")
            void stop().then(() => options.onShutdown?.())
          }, 1000)
          restartWhenIdle.unref?.()
          return reply(connection, command.id, { ok: true, result: { pending: true } })
        }
        if (busy() && !command.force) return reply(connection, command.id, { ok: false, code: "busy", message: "[DAEMON]: work is active; retry with force" })
        logLine("info", `[DAEMON]: stopping: a client asked${command.force ? " (forced)" : ""}${busy() ? "; running turns end as interrupted" : ""}`)
        reply(connection, command.id, { ok: true })
        setTimeout(() => void stop().then(() => options.onShutdown?.()), 10)
        return
      }
      case "daemon.status": {
        const entries = loops.list()
        const at = store.settings.get().dreamAt
        return reply(connection, command.id, { ok: true, result: {
          running: true, pid: process.pid, dataDir: options.dir, engine: options.info?.engine ?? "unknown",
          ...(options.buildId ? { buildId: options.buildId } : {}),
          clients: [...connections].filter((peer) => peer.clientId).length,
          activeTurns: [...actors.values()].filter(actorWorking).length,
          backgroundJobs: scheduler.snapshot().length + engineJobs(),
          loops: { total: entries.length, active: entries.filter((loop) => loop.state === "active").length, running: entries.filter((loop) => ["running", "needs_input", "verifying"].includes(loop.state)).length },
          dream: { configured: Boolean(options.dream), enabled: Boolean(at), at: at ?? null, handled: store.meta.get(DREAM_WINDOW_KEY) ?? null },
          /** What a process hosting this daemon must not drop when its terminal closes (apps/cli/src/solo.ts). `standing` features restart from durable state in a separate daemon; `running` work would lose its in-flight step. */
          keepAlive: keepAliveReport(),
          ...(restartWhenIdle ? { restartPending: true } : {}),
        } })
      }
      case "daemon.logs": {
        try { return reply(connection, command.id, { ok: true, result: await daemonLogs(options.dir, command.lines) }) }
        catch { return reply(connection, command.id, { ok: false, code: "internal", message: "Cannot read daemon logs" }) }
      }
      case "daemon.tick": {
        if (command.scheduler === "dream") {
          if (!command.execute) return reply(connection, command.id, { ok: true, result: { scheduler: "dream", execute: false, enabled: Boolean(store.settings.get().dreamAt), handled: store.meta.get(DREAM_WINDOW_KEY) ?? null } })
          return reply(connection, command.id, { ok: true, result: armDreamSchedule() })
        }
        const due = loops.list().filter((loop) => loop.state === "active" && loop.nextWakeAt !== undefined && loop.nextWakeAt <= clock.now()).slice(0, command.limit ?? 10)
        const started = command.execute ? due.filter((loop) => loops.runNow(loop.loopId)).map((loop) => loop.loopId) : []
        return reply(connection, command.id, { ok: true, result: { scheduler: "loops", execute: command.execute ?? false, due: due.map((loop) => loop.loopId), started } })
      }
      case "system.query": {
        if (command.operation === "config-layers" && connection.remoteAddress) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: the config layer view reads local files and is local only" })
        if (command.operation === "precedence") {
          if (connection.remoteAddress || connection.peer) return reply(connection, command.id, { ok: false, code: "forbidden", message: "[DAEMON]: the precedence report reads local files and is local only" })
          const directory = canonicalDir(command.directory)
          const facts = await fileClaims({ layers: resourceLayersFor(directory), directory, userDir: options.dir, projectTrusted: (store.settings.get().trustedToolDirs ?? []).includes(directory) })
          return reply(connection, command.id, { ok: true, result: { operation: "precedence", ok: true, checks: [], failures: [], facts } })
        }
        let login: { ok: boolean; message?: string } | undefined
        if (command.operation === "ai-env" || command.operation === "ai-status") {
          const checked = options.info?.login ? await options.info.login().catch(() => ({ ok: false, message: "login check failed" })) : undefined
          login = checked ? { ok: checked.ok, ...(checked.message ? { message: redactSecrets(checked.message).text.slice(0, 300) } : {}) } : undefined
        }
        const report = systemReport(command.operation, { entry: command.entry, page: command.page, index: command.index, dir: options.dir, directory: canonicalDir(command.directory), socketPath: options.socketPath, transport: localSecret ? "tcp" : "unix", buildId: options.buildId, engine: options.info?.engine ?? "unknown", settings: { ...store.settings.get(), ...(options.logLevel ? { logLevel: options.logLevel } : {}) }, catalog, providers: options.providers, login, ...(command.operation === "config-layers" ? { invalidSettings: store.settings.invalid() } : {}) })
        if (command.operation === "ai-env" || command.operation === "ai-status") report.facts.login = login ?? null
        if (command.operation === "doctor") report.checks.push(...await resourceChecks(canonicalDir(command.directory)))
        return reply(connection, command.id, { ok: true, result: report })
      }
      case "worktree.query":
      case "worktree.change": {
        try {
          const directory = canonicalDir(command.directory)
          const result = command.type === "worktree.query" ? await worktrees.query(directory, command.query) : await worktrees.change(directory, command.change)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000)}` })
        }
      }
      case "tsm.query":
      case "tsm.change": {
        try {
          const directory = canonicalDir(command.directory)
          const result = command.type === "tsm.query" ? await tsm.query(directory, command.query) : await tsm.change(directory, command.change)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000)}` })
        }
      }
      case "context.recent": {
        if (!store.hasSession(command.sessionId)) return reply(connection, command.id, { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" })
        // The engine answers where it will pack (current settings, model and window override); one that runs the whole session itself has no report.
        const report = engine.contextReport ? await engine.contextReport(command.sessionId).catch(() => undefined) : undefined
        const lastUsage = store.recentUsage(command.sessionId, 1)[0]
        const limits = contextLimits({
          report,
          override: readContextWindow(store.meta, command.sessionId),
          catalog: options.models?.list() ?? [],
          providers: options.providers?.list(true) ?? [],
          settings: store.settings.get(),
          lastUsage,
          packedSince: lastUsage ? store.readAfter(command.sessionId, lastUsage.seq, 500).some((event) => event.type === "compaction.updated" && event.state === "packed") : false,
          fallbackModel: store.sessionModel(command.sessionId)?.model,
          recentUsage: store.recentUsage(command.sessionId, 101),
          notice: store.settings.get(),
        })
        return reply(connection, command.id, { ok: true, result: { ...recentContext(store, command.sessionId, command.limit), limits: { ...limits, idleCompaction: idleCompaction.status(command.sessionId) } } })
      }
      case "debug.query":
      case "db.query": {
        try {
          const result = command.type === "debug.query" ? await debug(canonicalDir(command.directory), command.input) : await queryDatabase(options.dir, command.operation, command.sql)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000)}` })
        }
      }
      case "files.query": {
        try {
          return reply(connection, command.id, { ok: true, result: await queryFiles({ ...command, ignore: store.settings.get().watcher?.ignore, directory: canonicalDir(command.directory) }) })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000)}` })
        }
      }
      case "project.control": {
        try { return reply(connection, command.id, { ok: true, result: await projectControl.run(command.directory, command.input) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000) }) }
      }
      case "project.rest": {
        try { return reply(connection, command.id, { ok: true, result: await projectRestService().run(command.directory, command.input, connection.signal ?? new AbortController().signal) }) }
        catch (error) { return reply(connection, command.id, { ok: false, code: error instanceof ProjectRestError ? error.code : "invalid_command", message: error instanceof ProjectRestError ? error.message : "Project operation failed" }) }
      }
      case "workspace.query": {
        const workspaces = workspaceCatalog()
        return reply(connection, command.id, { ok: true, result: command.operation === "adapters" ? { adapters: workspaces.adapters() } : command.operation === "status" ? { statuses: workspaces.status() } : { workspaces: workspaces.list() } })
      }
      case "workspace.create":
      case "workspace.remove": {
        try {
          const workspaces = workspaceCatalog()
          const workspace = command.type === "workspace.create" ? workspaces.create(command.name, command.directory) : workspaces.remove(command.workspaceId)
          return reply(connection, command.id, { ok: true, result: { workspace } })
        } catch {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: "workspace registration failed (existing directory and unique name required)" })
        }
      }
      case "session.rest.read":
        return reply(connection, command.id, restSessions.read(command.directory, command.input))
      case "session.rest.update": {
        const result = restSessions.update(command)
        if (result.ok) publishActivity(command.sessionId, actors.get(command.sessionId)?.snapshot().foreground ?? "idle", true)
        return reply(connection, command.id, result)
      }
      case "session.rest.control":
        return reply(connection, command.id, await restSessions.control(command, connection.signal))
      case "session.rest.mutate":
        return reply(connection, command.id, restMutations.mutate(command))
      case "server.health":
        return reply(connection, command.id, { ok: true, result: { healthy: true, version: options.runtimeInfo?.version ?? DEV_VERSION, channel: options.runtimeInfo?.channel ?? "dev", protocolVersion: PROTOCOL_VERSION, buildId: options.buildId ?? "unknown", mdns: { requested: serverConfig.mdns, published: false, domain: serverConfig.mdnsDomain, reason: "loopback listener" } } })
      case "server.memory":
        return reply(connection, command.id, { ok: true, result: processMemory(options.memoryUsage?.()) })
      case "server.config.get":
        return reply(connection, command.id, { ok: true, result: { config: serverControl.get(command.directory ? canonicalDir(command.directory) : undefined) } })
      case "server.config.update":
        try {
          const remote = Boolean(connection.remoteAddress || connection.peer)
          const directory = command.directory ? canonicalDir(command.directory) : undefined
          let config
          try { config = await serverControl.update(command.patch, directory, remote) }
          finally { if (remote && command.patch.mcp) for (const server of Object.keys(command.patch.mcp)) await options.mcp?.suspend?.({ ...(directory ? { directory } : {}), server }) }
          return reply(connection, command.id, { ok: true, result: { config } })
        }
        catch { return reply(connection, command.id, { ok: false, code: "invalid_command", message: "Invalid or unsupported configuration" }) }
      case "app.log":
        serverControl.log(command.input)
        return reply(connection, command.id, { ok: true })
      case "server.dispose":
        return reply(connection, command.id, await disposeInstances(command.directory ? canonicalDir(command.directory) : undefined) ? { ok: true, result: { disposed: true } } : { ok: false, code: "busy", message: "Stop active loops/workflows or wait for Dream/turns before disposal" })
      case "server.upgrade":
        return reply(connection, command.id, { ok: true, result: { upgrade: await serverControl.upgrade(command.input, connection.signal ?? new AbortController().signal) } })
      case "budget.status":
      case "budget.doctor": {
        const model = resolveModel({ role: "main", roles: rolesFor(store.settings.get(), command.directory), catalog }).model
        return reply(connection, command.id, { ok: true, result: command.type === "budget.doctor" ? budgets.doctor(model) : { ...budgets.report(model) } })
      }
      case "budget.set": {
        const settings = store.settings.set({ budgets: command.policy })
        globalSink.append({ type: "settings.changed", settings })
        return reply(connection, command.id, { ok: true, result: { settings } })
      }
      case "setup.status":
      case "setup.plan":
      case "setup.doctor": {
        const result = command.type === "setup.plan" ? await setup.plan(command.directory) : command.type === "setup.doctor" ? await setup.doctor(command.directory) : await setup.readiness(command.directory)
        return reply(connection, command.id, { ok: true, result: { ...result } })
      }
      case "setup.preset": {
        const patch = setup.presetPatch(command.preset)
        const full = command.preset === "full"
        const profile = command.preset === "minimal" || full ? tuiControl.run({ operation: "apply", profile: { density: full ? "spacious" : "compact", presentation: full ? "full" : "minimal", messageRenderer: full ? "full" : "markdown", sidebar: full ? "auto" : "hidden", promptChrome: full ? "box" : "minimal" } }).profile : undefined
        const settings = store.settings.set(patch)
        const prompt = command.preset === "minimal" || full ? promptModes.set(command.directory, { mode: full ? "full" : "minimal" }) : promptModes.status(command.directory)
        globalSink.append({ type: "settings.changed", settings })
        extraction.wake()
        return reply(connection, command.id, { ok: true, result: { settings, prompt, ...(profile ? { profile } : {}) } })
      }
      case "setup.ask": {
        const status = await setup.readiness(command.directory)
        if (!status.helper.ready) return reply(connection, command.id, { ok: false, code: "invalid_command", message: status.helper.reason ?? "Setup helper unavailable" })
        const model = resolveModel({ role: "small", roles: rolesFor(store.settings.get(), command.directory), catalog })
        const controller = new AbortController()
        setupCalls.add(controller)
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.setupTimeoutMs ?? 30_000)])
        let attempted = false
        try {
          await budgets.guard({ model: model.model, signal })
          const request = { model, signal, system: "You are the MendCode setup helper. Explain the observed setup state and suggest exact commands. You have no tools. Do not claim to change settings, run commands or connect providers. Never request or print credentials.", prompt: redactSecrets(JSON.stringify({ setup: status, history: command.history, question: command.text })).text }
          attempted = true
          const completion = options.setupComplete ? options.setupComplete(request) : options.complete!(request).then((text) => ({ text }))
          const answer = await new Promise<{ text: string; usage?: BudgetUsage | undefined }>((resolve, reject) => {
            const abort = () => reject(new Error("Setup helper interrupted or timed out"))
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
            completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
          })
          budgets.record(answer.usage)
          attempted = false
          return reply(connection, command.id, { ok: true, result: { text: redactSecrets(answer.text).text.slice(0, 8000), model: model.model, callsProviders: true, writesConfig: false } })
        } catch (error) {
          if (attempted) budgets.record()
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets((error as Error).message).text.slice(0, 500) })
        } finally { setupCalls.delete(controller) }
      }

      case "release.inspect":
      case "release.set":
      case "release.check": {
        try {
          const report = command.type === "release.set" ? await releases.set(command.channel) : command.type === "release.check" ? await releases.check() : await releases.inspect()
          return reply(connection, command.id, { ok: true, result: report })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: "invalid_command", message: `[DAEMON]: ${redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 500)}` })
        }
      }
      case "github.install":
      case "github.run":
      case "github.finish":
      case "pr.checkout": {
        if (!githubLocalOnly(connection.remoteAddress)) return reply(connection, command.id, { ok: false, code: "forbidden", message: "GitHub commands require the local Unix socket" })
        try {
          if (command.type === "github.install") {
            // A hosted runner runs exactly the model the workflow names: an id the catalog does not know fails there, so it fails here with the near ones.
            const catalog = options.models
            if (command.input.hosted && catalog?.selectable && !catalogModel(catalog, command.input.model) && !catalogModel(catalog, command.input.model.replace("/", ":"))) {
              const near = nearModels(catalog, command.input.model)
              throw new Error(`unknown model ${command.input.model}${near.length ? `; did you mean ${near.join(", ")}` : ""}`)
            }
            return reply(connection, command.id, { ok: true, result: await github.install(command.directory, command.input) })
          }
          if (command.type === "pr.checkout") return reply(connection, command.id, { ok: true, result: await github.checkout(command.directory, command.number, command.token) })
          if (command.type === "github.run" && command.input.review) {
            const problem = command.choice ? invalidChoice(command.choice, options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }) : undefined
            if (problem) throw new Error(problem)
            const { hostedReview } = await import("./pr-review/hosted")
            const execute = options.prReview?.hosted ?? options.githubProcess ?? githubProcess
            const token = command.input.token
            const gh: import("./pr-review/publish").GhCall = async ({ argv, stdin }) => {
              try { return await execute({ argv: ["gh", ...argv], cwd: command.directory, token, ...(stdin === undefined ? {} : { stdin }) }) } catch (error) { return { code: 1, out: "", err: error instanceof Error ? error.message : String(error) } }
            }
            const report = await hostedReview({
              directory: command.directory, event: command.input.event, gh, publish: command.input.publish ?? false, mentions: command.input.mentions,
              sessionFactory: options.prReview?.sessions?.(connection.clientId, command.directory) ?? reviewSessions.factory({ directory: command.directory, model: command.choice }),
              ...(!options.prReview?.noGraph && featureOn(store.settings.get(), "codegraph", { safeMode: options.safeMode }) ? { graph: async () => (await import("@mendcode/codegraph")).createIndexer({ cacheDir: path.join(options.dir, "pr-review", "graph"), now: Date.now }).graph({ cwd: command.directory, signal: AbortSignal.timeout(120_000) }) } : {}),
            })
            return reply(connection, command.id, { ok: true, result: { ...report, text: redactSecrets(report.text).text } })
          }
          if (command.type === "github.run") {
            const problem = command.choice ? invalidChoice(command.choice, options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }) : undefined
            if (problem) throw new Error(problem)
            const agent = agents.defaultName(command.directory)
            const prepared = await github.prepare(command.directory, command.input, connection.clientId)
            try {
              const sessionId = ids("session")
              store.createSession({ id: sessionId, directory: prepared.directory, title: `GitHub ${prepared.eventName}${prepared.number ? ` #${prepared.number}` : ""}` })
              if (command.choice) store.setSessionModel(sessionId, command.choice)
              if (agent !== "plan" && agent !== "build") store.setSessionAgent(sessionId, agent)
              github.bind(prepared.runId, connection.clientId, sessionId)
              announceSession(sessionId, prepared.directory)
              await actorFor(sessionId)?.handle({ id: ids("command"), clientId: command.clientId, type: "session.permission.set", sessionId, mode: agent === "plan" ? "plan" : "ask" })
              const prompt = captured(sessionId, prepared.prompt)
              if ("ok" in prompt) throw new Error(prompt.message)
              return reply(connection, command.id, { ok: true, result: { ...prepared, sessionId, prompt: prompt.text } })
            } catch (error) { await github.finish(prepared.runId, connection.clientId, "failed", "").catch(() => undefined); throw error }
          }
          const sessionId = github.session(command.runId, connection.clientId) as SessionId | undefined
          if (sessionId && actors.get(sessionId)?.snapshot().turnId) throw new Error("GitHub turn is still active; cancel it before finishing the run")
          const events = sessionId ? store.readAfter(sessionId, 0, 100_000) : []
          const start = events.findLastIndex((event) => event.type === "turn.started")
          const current = events.slice(Math.max(0, start))
          const terminal = current.findLast((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted")
          if (command.status === "completed" && terminal?.type !== "turn.completed") throw new Error("GitHub publication requires a completed agent turn")
          const answer = current.findLast((event) => event.type === "item.completed" && event.status === "ok" && current.some((begin) => begin.type === "item.started" && begin.itemId === event.itemId && begin.kind === "agent_message"))
          const response = answer?.type === "item.completed" ? answer.text ?? "" : ""
          const result = await github.finish(command.runId, connection.clientId, command.status, redactSecrets(response || githubToolSummary(current)).text)
          return reply(connection, command.id, { ok: true, result })
        } catch (error) { return reply(connection, command.id, { ok: false, code: "invalid_command", message: redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 1000) }) }
      }
      case "pty.shells":
      case "pty.list":
      case "pty.create":
      case "pty.get":
      case "pty.update":
      case "pty.remove":
      case "pty.connect-token": {
        try {
          const directory = workspaceCatalog().resolve({ directory: command.directory })
          const scope = { directory, peer: connection.peer }
          const result = command.type === "pty.shells" ? { shells: pty.shells(scope) }
            : command.type === "pty.list" ? { ptys: pty.list(scope) }
            : command.type === "pty.create" ? { pty: await pty.createWithEnvironment(scope, command.input, async ({ id, cwd }) => {
              await extensions.ensure(directory)
              return extensions.bus.transform(extensions.syncScope(directory)?.records ?? [], "shell.env", { sessionId: id, cwd, env: {} }, {}, (value) => !!value && typeof value === "object" && Object.entries(value).every(([key, text]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof text === "string" && !text.includes("\0")))
            }, connection.signal) }
            : command.type === "pty.get" ? { pty: pty.get(scope, command.ptyId) }
            : command.type === "pty.update" ? { pty: pty.update(scope, command.ptyId, command.input) }
            : command.type === "pty.remove" ? { removed: pty.remove(scope, command.ptyId) }
            : { token: pty.ticket(scope, command.ptyId) }
          return reply(connection, command.id, { ok: true, result })
        } catch (error) {
          return reply(connection, command.id, { ok: false, code: error instanceof PtyError ? error.code : "invalid_command", message: error instanceof PtyError ? error.message : "PTY operation failed" })
        }
      }
    }
  }

  const releases = createReleaseControl({ dir: options.dir, settings: () => store.settings.get(), idle: () => ![...actors.values()].some(actorWorking), notify: (version, channel, installed) => globalSink.append({ type: "release.available", version, channel, installed }), ...(options.release ? { options: options.release } : {}) })
  if (existsSync(options.socketPath)) rmSync(options.socketPath)
  /** Local loopback TCP: only the process that read the secret from `<dir>/mendd.endpoint` is served, and it is local (no peer, no remote address). */
  const localSecret = (options.localTransport ?? defaultLocalTransport()) === "tcp" ? randomBytes(32).toString("base64url") : undefined
  const localAuthenticates = (token: string) => {
    const given = Buffer.from(token)
    const wanted = Buffer.from(localSecret ?? "")
    return localSecret !== undefined && given.length === wanted.length && timingSafeEqual(given, wanted)
  }
  function socketHandlers(remote: boolean, local = false): Bun.SocketHandler<Connection> {
    function open(socket: Bun.Socket<Connection>) {
      if (socket.data) return
      const connection: Connection = { id: nextConnection++, socket, pending: [], backlog: 0, decoder: new TextDecoder(), buffer: "", subscriptions: new Map(), statusWatches: new Map() }
      socket.data = connection
      connections.add(connection)
      // Unix socket: the kernel says which process connected. Loopback TCP carries no such fact; there only the client's own word is left.
      if (!remote && !local) connection.agent = peerOrigin.resolve((socket as { fd?: number }).fd)
      if (local) {
        connection.authTimer = setTimeout(() => {
          connection.rejected = true
          socket.end()
        }, 5_000)
      }
      if (remote) {
        connection.remoteAddress = socket.remoteAddress ?? "unknown"
        if (backoff.blocked(connection.remoteAddress)) return rejectRemote(connection, "rate_limited")
        connection.authTimer = setTimeout(() => {
          backoff.fail(connection.remoteAddress!)
          rejectRemote(connection, "unauthorized")
        }, 5_000)
      }
    }
    return {
      open,
      data(socket, data) {
        // Bun TLS can deliver data before open; initialize once for either callback order.
        if (!socket.data) open(socket)
        const connection = socket.data
        if (connection.rejected) return
        connection.buffer += connection.decoder.decode(data, { stream: true })
        if (connection.buffer.length > MAX_FRAME_BYTES && !connection.buffer.includes("\n")) {
          socket.end()
          return
        }
        let newline = connection.buffer.indexOf("\n")
        while (newline >= 0) {
          const line = connection.buffer.slice(0, newline)
          connection.buffer = connection.buffer.slice(newline + 1)
          const decoded = decodeFrame(line)
          if (remote && !connection.peer) {
            // Never echo validation details for an auth frame: they may contain the supplied token.
            if (backoff.blocked(connection.remoteAddress!)) return rejectRemote(connection, "rate_limited")
            if (!decoded.ok || decoded.frame.kind !== "auth") {
              backoff.fail(connection.remoteAddress!)
              return rejectRemote(connection, "unauthorized")
            }
            let peer: Connection["peer"]
            try { peer = tokens.authenticate(decoded.frame.token) } catch {}
            if (!peer) {
              backoff.fail(connection.remoteAddress!)
              return rejectRemote(connection, "unauthorized", decoded.frame.id)
            }
            connection.peer = peer
            clearTimeout(connection.authTimer)
            send(connection, { v: PROTOCOL_VERSION, kind: "ack", id: decoded.frame.id, result: { readOnly: peer.readOnly, tokenName: peer.name } })
          } else if (local && !connection.localAuthed) {
            if (!decoded.ok || decoded.frame.kind !== "auth" || !localAuthenticates(decoded.frame.token)) {
              // Never echo the frame: it may carry the supplied secret.
              connection.rejected = true
              clearTimeout(connection.authTimer)
              send(connection, { v: PROTOCOL_VERSION, kind: "error", error: { code: "unauthorized", message: "local auth failed" } })
              socket.end()
              return
            }
            connection.localAuthed = true
            clearTimeout(connection.authTimer)
            send(connection, { v: PROTOCOL_VERSION, kind: "ack", id: decoded.frame.id, result: { local: true } })
          } else if (!decoded.ok || decoded.frame.kind !== "command") {
            // The command's own id, when it can be read, lets the client fail that request now instead of timing out.
            const id = decoded.ok ? undefined : rawCommandId(line)
            send(connection, { v: PROTOCOL_VERSION, kind: "error", ...(id ? { id: id as CommandId } : {}), error: { code: "invalid_command", message: connection.remoteAddress ? "invalid remote command frame" : decoded.ok ? "[DAEMON]: expected a command frame" : decoded.error.slice(0, 4000) } })
          } else {
            // A command that throws is that command's error, never an unhandled rejection that ends the daemon for every client.
            const command = decoded.frame.body
            void handleOnce(connection, command).catch((error) => reply(connection, command.id, { ok: false, code: "internal", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) }))
          }
          newline = connection.buffer.indexOf("\n")
        }
      },
      drain(socket) {
        if (socket.data) flush(socket.data)
      },
      close(socket) {
        if (!socket.data) return
        clearTimeout(socket.data.authTimer)
        audio.forget(socket.data)
        voice.forget(socket.data)
        connections.delete(socket.data)
        forgetUploads(socket.data)
        uiReload.forget(socket.data)
        tuiRequests.forget(socket.data)
        for (const sessionId of socket.data.subscriptions.keys()) maybeEvict(sessionId)
        for (const unwatch of socket.data.statusWatches.values()) unwatch()
      },
    }
  }
  function executeHttp(command: Command, peer: NonNullable<Connection["peer"]>): Promise<import("./session-history").Outcome<Record<string, unknown>>> {
    return new Promise((resolve) => {
      const connection: Connection = {
        id: nextConnection++, clientId: command.clientId, peer, remoteAddress: "127.0.0.1",
        socket: { write: () => 0, end() {} }, pending: [], backlog: 0, decoder: new TextDecoder(), buffer: "", subscriptions: new Map(), statusWatches: new Map(),
        response(frame) {
          if (frame.kind === "ack" && frame.id === command.id) resolve({ ok: true, result: frame.result ?? {} })
          else if (frame.kind === "error") resolve({ ok: false, code: frame.error.code, message: frame.error.message })
        },
      }
      void handleOnce(connection, command).catch(() => resolve({ ok: false, code: "internal", message: "[DAEMON]: session command failed" }))
    })
  }
  const sessionHttp = createSessionHttpApi({
    authenticate: (token) => tokens.authenticate(token),
    execute: executeHttp,
    async shell(sessionId, payload, peer, signal) {
      if (!store.hasSession(sessionId)) return { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" }
      if (signal.aborted) return { ok: false, code: "target_mismatch", message: "[DAEMON]: request aborted" }
      if (live.has(sessionId) || actors.get(sessionId)?.snapshot().turnId || store.queueOf(sessionId).length) return { ok: false, code: "busy", message: "[DAEMON]: session is busy" }
      const problem = agents.selectable(store.sessionDirectory(sessionId)!, payload.agent)
      if (problem) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` }
      if (payload.model) {
        const model = `${payload.model.providerID}:${payload.model.modelID}`
        const catalog = options.models ?? { selectable: false, list: () => [], defaults: { model: "engine default" } }
        const error = invalidChoice({ model }, catalog)
        if (error) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${error}` }
      }
      const clientId = ids("client")
      let turnId: import("@mendcode/protocol").TurnId | undefined
      const parts = new Map<string, { id: string; type: "text"; text: string }>()
      let settle!: (result: import("./session-history").Outcome<Record<string, unknown>>) => void
      const done = new Promise<import("./session-history").Outcome<Record<string, unknown>>>((resolve) => { settle = resolve })
      const observer = (event: SessionEvent) => {
        if (event.sessionId !== sessionId) return
        if (event.type === "turn.started" && !turnId) turnId = event.turnId
        if (event.type === "item.started" && event.turnId === turnId && event.kind !== "user_message" && parts.size < 32) parts.set(event.itemId, { id: event.itemId, type: "text", text: "" })
        if ((event.type === "item.delta" || event.type === "item.completed") && parts.has(event.itemId)) {
          const part = parts.get(event.itemId)!
          part.text = secrets.mask(sessionId, (event.type === "item.delta" ? part.text + event.text : event.text ?? part.text).slice(0, 16000))
        }
        if ("turnId" in event && event.turnId === turnId && ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) {
          settle({ ok: true, result: { info: { id: turnId, sessionID: sessionId, role: "assistant", agent: payload.agent, ...(payload.model ? { model: payload.model } : {}) }, parts: [...parts.values()].map((part) => ({ ...part, sessionID: sessionId, messageID: turnId })) } })
        }
      }
      const cancel = () => {
        if (turnId) void executeHttp({ type: "turn.cancel", sessionId, turnId, id: ids("command"), clientId }, peer)
        settle({ ok: false, code: "target_mismatch", message: "[DAEMON]: shell request aborted or timed out" })
      }
      sessionObservers.push(observer)
      signal.addEventListener("abort", cancel, { once: true })
      const timer = setTimeout(cancel, 120000)
      timer.unref()
      try {
        const accepted = await executeHttp({ type: "user.shell", sessionId, command: payload.command, id: ids("command"), clientId, ...(payload.messageID ? { messageId: payload.messageID } : {}) }, peer)
        return accepted.ok ? await done : accepted
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        const index = sessionObservers.indexOf(observer)
        if (index >= 0) sessionObservers.splice(index, 1)
      }
    },
  })
  const tcpListener = localSecret ? Bun.listen<Connection>({ hostname: "127.0.0.1", port: 0, socket: socketHandlers(false, true) }) : undefined
  const listener = tcpListener ?? Bun.listen<Connection>({ unix: options.socketPath, socket: socketHandlers(false) })
  // The store's writer lock makes this the only daemon of the directory: an endpoint file from an earlier tcp run is stale.
  if (!localSecret) rmSync(localEndpointPath(options.dir), { force: true })
  if (localSecret && tcpListener) writeLocalEndpoint(options.dir, { transport: "tcp", hostname: "127.0.0.1", port: tcpListener.port, token: localSecret, pid: process.pid })
  if (extensionsEnabled) uiReload.start()
  void channels.start().catch((error: unknown) => logLine("warn", `[CHANNELS]: ${error instanceof Error ? error.message : "start failed"}`))
  let remoteListener: Bun.TCPSocketListener<Connection> | undefined
  let sessionHttpListener: ReturnType<typeof Bun.serve> | undefined
  let httpListener: ReturnType<typeof Bun.serve> | undefined
  let httpAdapter: ReturnType<typeof createHttpAdapter> | undefined
  let workspaces: ReturnType<typeof createWorkspaces> | undefined
  function workspaceCatalog() { return workspaces ??= createWorkspaces(options.dir, options.defaultDirectory ?? process.cwd()) }
  function httpConnection(peer: HttpPeer, directory: string, write: (data: Uint8Array) => number, end: () => void): Connection {
    const connection: Connection = { id: nextConnection++, directory, remoteAddress: "http", peer, socket: { write, end }, pending: [], backlog: 0, decoder: new TextDecoder(), buffer: "", subscriptions: new Map(), statusWatches: new Map() }
    connections.add(connection)
    return connection
  }
  /** A connection that goes away takes its unfinished uploads with it, whatever its transport. */
  function forgetUploads(connection: Connection) {
    for (const key of [...partialUploads.keys()]) if (key.startsWith(`${connection.id}:`)) partialUploads.delete(key)
  }
  function closeHttp(connection: Connection) {
    connections.delete(connection)
    forgetUploads(connection)
    uiReload.forget(connection)
    tuiRequests.forget(connection)
    for (const sessionId of connection.subscriptions.keys()) maybeEvict(sessionId)
    for (const unwatch of connection.statusWatches.values()) unwatch()
  }
  /**
   * An in-process client (the terminal that hosts this daemon: solo mode). Same frames, same handlers and same
   * connection bookkeeping as a socket client, minus the kernel: `write` carries the daemon's frames to the client
   * and the returned `receive` takes the client's. The caller delivers asynchronously, so a command never runs
   * inside the event append that triggered it.
   */
  function attachLoopback(write: (data: Uint8Array) => number, end: () => void) {
    const connection: Connection = { id: nextConnection++, socket: { write, end }, pending: [], backlog: 0, decoder: new TextDecoder(), buffer: "", subscriptions: new Map(), statusWatches: new Map() }
    connections.add(connection)
    const socket = { data: connection, end } as Bun.Socket<Connection>
    const handlers = socketHandlers(false)
    return { receive: (data: Uint8Array) => void handlers.data?.(socket, Buffer.from(data)), close: () => void handlers.close?.(socket, undefined) }
  }
  let stopped = false
  let remoteWatch: ReturnType<typeof setInterval> | undefined
  try {
    if (remoteConfig) remoteListener = Bun.listen<Connection>({ ...remoteConfig, socket: socketHandlers(true) })
    if (sessionHttpConfig) sessionHttpListener = Bun.serve({ ...sessionHttpConfig, fetch: sessionHttp, maxRequestBodySize: 80 * 1024, idleTimeout: 0 })
    if (serverConfig.enabled) {
      httpAdapter = createHttpAdapter({ dir: options.dir, directory: options.defaultDirectory ?? process.cwd(), config: serverConfig, workspaces: workspaceCatalog(), buildId: options.buildId, web: options.web, bridge: {
        pty: { consume: pty.consume, connect: (peer, directory, id, socket, cursor) => pty.connect({ peer, directory }, id, socket, cursor) },
        events: (_peer, directory, write) => {
          const observe = (event: import("@mendcode/protocol").RestServerEvent) => { if (!directory || event.directory === directory || event.directory === "global") write(event) }
          serverEventObservers.add(observe)
          return () => { serverEventObservers.delete(observe) }
        },
        request: (command, peer, directory, signal) => new Promise<Frame>((resolve) => {
          let done = false
          const finish = (frame: Frame) => {
            if (done) return
            done = true
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
            closeHttp(connection)
            resolve(frame)
          }
          const abort = () => finish({ v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "internal", message: "HTTP request ended" } })
          const timer = setTimeout(abort, 60_000)
          const connection = httpConnection(peer, directory, (data) => {
            for (const line of new TextDecoder().decode(data).split("\n").filter(Boolean)) {
              const frame = JSON.parse(line) as Frame
              if ((frame.kind === "ack" || frame.kind === "error") && frame.id === command.id) finish(frame)
            }
            return data.byteLength
          }, abort)
          connection.signal = signal
          connection.clientId = command.clientId
          if (signal.aborted) return abort()
          signal.addEventListener("abort", abort, { once: true })
          void handleOnce(connection, command).catch(() => finish({ v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: "internal", message: "HTTP command failed" } }))
        }),
        stream: (peer, directory, write, end) => {
          const connection = httpConnection(peer, directory, write, end)
          const socket = { data: connection, end } as Bun.Socket<Connection>
          const handlers = socketHandlers(false)
          return { receive: (data) => handlers.data?.(socket, Buffer.from(data)), close: () => closeHttp(connection) }
        },
      } })
      if (options.httpListen !== false) httpListener = Bun.serve({ hostname: serverConfig.hostname, port: serverConfig.port, idleTimeout: 60, maxRequestBodySize: MAX_FRAME_BYTES, fetch: httpAdapter.fetch, websocket: httpAdapter.websocket })
    }
    if (options.mflowListen) {
      const address = mflowListenerAddress(options.mflowListen)
      const backoff = remoteBackoff()
      const handle = createMflowHttp({ service: mflow, directory: options.defaultDirectory ?? process.cwd(), authenticate: (token) => tokens.authenticate(token), allowed: () => !backoff.blocked("loopback"), failed: () => backoff.fail("loopback") })
      mflowListener = Bun.serve({ ...address, maxRequestBodySize: 32_768, fetch: handle })
    }
  } catch (error) {
    await stop()
    throw error
  }
  remoteWatch = remoteListener || httpAdapter ? setInterval(() => {
    tuiRequests.sweep()
    httpAdapter?.sweep()
    pty.sweep()
    for (const connection of connections) if (connection.peer && !activePeer(connection)) rejectRemote(connection, "unauthorized")
  }, 1_000) : undefined
  remoteWatch?.unref()
  releases.wake()

  /**
   * What a process hosting this daemon must not drop when its terminal closes (apps/cli/src/solo.ts), and what keeps a detached
   * daemon from stopping itself (`idleExitMs`). `standing` features restart from durable state in a separate daemon; `running`
   * work would lose its in-flight step. The loopback HTTP listener is not standing: the web client reaches a daemon while a
   * terminal runs one, and nobody pays a resident process for a listener nobody is using.
   */
  function keepAliveReport() {
    const entries = loops.list()
    return {
      running: [
        ...([...actors.values()].some(actorWorking) ? ["turns"] : []),
        ...(scheduler.snapshot().length > 0 ? ["jobs"] : []),
        ...(engineJobs() > 0 ? ["background agents"] : []),
        ...(entries.some((loop) => loop.state === "verifying") ? ["loops"] : []),
        // Programs the model started (a dev server, a long test run) are children of this process: they cannot move to another one.
        ...(background.listAll().some((task) => task.status === "running") ? ["background processes"] : []),
        ...(interactive.runningCount() > 0 ? ["terminals"] : []),
      ],
      standing: [
        ...(entries.some((loop) => loop.state === "active" || loop.state === "running" || loop.state === "needs_input") ? ["loops"] : []),
        ...(store.workflows.hasLive() ? ["workflows"] : []),
        ...(store.settings.get().dreamAt ? ["dream"] : []),
        ...(usageLimit.scheduled() > 0 ? ["usage resume"] : []),
        ...(channels.status().telegram.enabled ? ["channels"] : []),
        ...(remoteConfig ? ["remote"] : []),
      ],
    }
  }
  /** Since when nothing has needed this daemon: no client, no work, nothing standing. */
  let unneededSince: number | undefined
  /** A restart asked while work ran (`daemon.shutdown` with `whenIdle`): it stops the daemon once that work ends. */
  let restartWhenIdle: ReturnType<typeof setInterval> | undefined
  const idleWatch = options.idleExitMs ? setInterval(() => {
    const keep = keepAliveReport()
    if (stopped || connections.size > 0 || keep.running.length > 0 || keep.standing.length > 0) { unneededSince = undefined; return }
    unneededSince ??= Date.now()
    if (Date.now() - unneededSince < options.idleExitMs!) return
    logLine("info", `[DAEMON]: nothing needed this daemon for ${Math.round((Date.now() - unneededSince) / 60_000)} min; stopping`)
    void stop().then(() => options.onShutdown?.())
  }, Math.min(options.idleExitMs, 30_000)) : undefined
  idleWatch?.unref()

  /** Graceful stop: running turns end as interrupted(restart), resources are released, the lock is freed. */
  async function stop() {
    threadBridge?.stop()
    hostBridge.stop()
    idleGc.stop()
    if (stopped) return
    stopped = true
    audio.dispose()
    voice.dispose()
    await releases.stop()
    await github.dispose()
    computer.stop()
    await browser.stop()
    uiReload.stop()
    tuiRequests.stop()
    reasoning.port.dispose()
    await sessionSharing.stop()
    // Before the turns are interrupted: their time is counted now, and the interruptions are not read as failures.
    goals.dispose()
    usageLimit.dispose()
    loops.dispose()
    providerAuth.stop()
    workflows.dispose()
    await compound.dispose()
    dreamTimer?.cancel()
    retentionTimer?.cancel()
    idleCompaction.dispose()
    memoryAssistant.stop()
    metadata.stop()
    cliMemory.stop()
    for (const controller of setupCalls) controller.abort()
    usageToday.stop()
    ownerWake.stop()
    await extraction.stop()
    continuity.stop()
    extensionDialogs.stop()
    background.stop()
    interactive.stop()
    statusLines.stop()
    shellHooks.halt()
    mflowListener?.stop(true)
    await channels.stop()
    clearInterval(remoteWatch)
    clearInterval(idleWatch)
    httpAdapter?.close()
    pty.dispose()
    serverEventObservers.clear()
    restSessions.close()
    await httpListener?.stop(true)
    remoteListener?.stop(true)
    await sessionHttpListener?.stop(true)
    listener.stop(true)
    for (const connection of connections) connection.socket.end()
    await Promise.all([...actors.values()].map((actor) => actor.interrupt("restart")))
    for (let i = 0; i < 20 && [...actors.values()].some((actor) => actor.snapshot().turnId); i++) await new Promise((r) => setTimeout(r, 10))
    engine.stop?.()
    for (const active of tracedTurns.values()) active.span.end("cancelled")
    tracedTurns.clear()
    await trace.stop()
    await mflowHooks.stop()
    mflow.stop()
    root.dispose()
    await projectRest?.close()
    store.close()
    rmSync(options.socketPath, { force: true })
    if (localSecret) removeLocalEndpoint(options.dir, localSecret)
  }

  return {
    socketPath: options.socketPath,
    /** Set when the local transport is loopback TCP: where and with which secret a local client connects. */
    localEndpoint: localSecret && tcpListener ? { hostname: "127.0.0.1" as const, port: tcpListener.port, token: localSecret } : undefined,
    sessionHttp,
    httpPort: httpListener?.port ?? sessionHttpListener?.port,
    sessionHttpPort: sessionHttpListener?.port,
    store,
    registry,
    /** The `worktree` tool's port for one session (what the native engine hands the tool); exposed for tests. */
    worktreePort,
    /** The PR watch service (docs/pr-watch.md); exposed for tests, which drive `tick()` with a fake `gh`. */
    prWatch,
    /** The quota refresh schedule (docs/usage-limit.md); exposed for tests, which drive `tick()` with fake probes. */
    quotaRefresh,
    remotePort: remoteListener?.port,
    httpUrl: httpListener?.url.toString(),
    httpAdapter,
    mflowPort: mflowListener?.port,
    remotePeers: () => [...connections].filter((c) => c.peer).map((c) => ({ address: c.remoteAddress, tokenName: c.peer!.name, readOnly: c.peer!.readOnly })),
    connections: () => connections.size,
    attachLoopback,
    serverEventSubscriptions: () => serverEventObservers.size,
    /** Whether the workflow service was built (P6: false on a daemon that never saw a workflow). */
    workflowsLoaded: workflows.loaded,
    stop,
  }
}
export type Daemon = Awaited<ReturnType<typeof startDaemon>>
