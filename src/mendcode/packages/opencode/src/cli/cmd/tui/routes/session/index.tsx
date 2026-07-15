import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { COMPACTED_TOOL_CALLS_KV_KEY, useSync } from "@tui/context/sync"
import { latestTerminalOutputPreview, renderTerminalOutput, selectShellOutput } from "@tui/context/shell-output"
import { useEvent } from "@tui/context/event"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  TextAttributes,
  RGBA,
  type ParsedKey,
  type TextareaRenderable,
} from "@opentui/core"
import { latestPendingAssistantID, Prompt, type PromptRef, type PromptSubmitInfo } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Part,
  PermissionRequest,
  Provider,
  Message,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@mendcode/sdk/v2"
import { useLocal } from "@tui/context/local"
import * as Log from "@mendcode/core/util/log"
import { Locale } from "@/util/locale"
import { Process } from "@/util/process"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { ShellTool } from "@/tool/shell"
import { ShellID } from "@/tool/shell/id"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { WebSearchTool } from "@/tool/websearch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import type { LoopTool } from "@/tool/loop"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useEditorContext } from "@tui/context/editor"
import { useCommandDialog } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogContextUsage } from "./dialog-context-usage"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { StyledPlanMarkdown } from "../../component/styled-plan-markdown"
import { Flag } from "@mendcode/core/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { errorMessage } from "@/util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import { usePromptRef } from "../../context/prompt"
import {
  blurMendWidget,
  focusMendWidget,
  listMendWidgets,
  mendWidgetRenderContext,
  notifyMendWidgetVisible,
  readFocusedMendWidgetID,
  type MendWidgetEntry,
} from "@/mend/tui/widgets"
import { renderMendEditor } from "@/mend/tui/editor-host"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@mendcode/core/global"
import { PermissionPrompt } from "./permission"
import { PlanReviewPrompt } from "./plan-review"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatAssistantLiveUsage, formatAssistantUsage, formatLatestAssistantContextUsage } from "../../util/usage"
import { formatTranscript } from "../../util/transcript"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration, isScrollboxAtBottom, isScrollboxAtTop } from "../../util/scroll"
import {
  sessionContentWidth,
  sessionDiffStatsLabel,
  sessionTaskContinuation,
  sessionPendingInputSessionIDs,
  sessionPromptVisible,
  sessionLoopReceipt,
  sessionHeaderTitleAlign,
  sessionHeaderTitleJustify,
  sessionTopMetricsWidth,
  sessionTopbarLeftLabel,
  sessionTopbarLayout,
  sessionUsageBarLabels,
} from "../../util/session-layout"
import {
  sessionBottomDockLayout,
  sessionTodoIcon,
  sessionTodoPanelWidth,
  type SessionTodo,
} from "../../util/session-bottom-dock"
import { renderSessionExitSummary } from "../../util/session-exit-summary"
import { sessionMessageVirtualWindow, stickyUserIDFromVirtualWindow } from "../../util/session-virtual-window"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { restorePromptFromSubmittedParts } from "../../component/prompt/submit-parts"
import { useMendTuiProfile } from "../../context/mend"
import { subagentTaskColorIndex, type SubagentTaskColorEntry } from "../../util/subagent-color"
import {
  presentationReasoningVisible,
  compactPreviewLine,
  compactionSummaryPreview,
  rawReasoningDisplay,
  reasoningSummary,
  shouldDisplayReasoning,
  unavailableReasoningLabel,
} from "@/mend/tui/presentation"
import { CompactionPanel } from "../../component/compaction-panel"
import {
  agentViewCommandStateRank,
  agentViewCommandTouchesSession,
  formatAgentViewCommandSummary,
  formatAgentViewCommandType,
  isAgentViewCommandActionable,
  type AgentViewCommand,
} from "../../util/agent-view"
import { promptChromeUsesFullSessionWidth } from "@/mend/tui/prompt-chrome"
import { formatDuration } from "@/util/format"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import { reviewPermissionRequestWithModel, shouldTriggerSmartApproval } from "@/mend/permission/smart-approval"
import { readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import {
  normalizeToolEvent,
  shouldRenderCompactTool,
  toolPresentationIcon,
  toolPresentationIconForProfile,
  webSearchUrlLines,
  wrapTimelineLine,
} from "@/mend/tui/timeline/normalize"
import { groupTimelineParts, isTimelineStackStart, timelineCollapseLabel } from "@/mend/tui/timeline/group"
import type { TimelineCollapse, TimelineRow } from "@/mend/tui/timeline/types"
import { TimelineDiff } from "./renderers/diff"
import { diffStatsFromFile, diffStatsFromPatch, patchFilePath, type TimelineDiffStats } from "./renderers/diff-label"
import { MemoryGraphCanvasRows, memoryGraphMiniMap } from "../memory"
import {
  expandedUserMessageOffset,
  expandPastedContentPlaceholders,
  isPastedContentPart,
  userMessageDisplayText,
  visibleUserMessageText,
  type PastedContentDisplayPart,
} from "./user-message-display"
import {
  hasMermaidFence,
  planReviewInlineTitle,
  renderPlanMarkdown,
  renderPlanMarkdownStatic,
  renderPlanMarkdownStreaming,
  renderStreamingMarkdownTail,
  type StreamingPlanMarkdownState,
  visibleStreamingMarkdownPreview,
} from "../../util/plan-markdown"

addDefaultParsers(parsers.parsers)
const trace = Log.create({ service: "tui.session" })

// Core message/part/status events are reconciled incrementally by SyncProvider.
// Poll only for lifecycle events that do not carry their canonical store update.
const SESSION_IMMEDIATE_FOLLOW_EVENTS = new Set([
  "session.idle",
  "session.next.prompted",
  "session.next.synthetic",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.compaction.started",
  "agent_command.created",
  "agent_command.updated",
  "loop.workflow.updated",
  "loop.run.updated",
  "loop.event.created",
  "loop.thread.updated",
])
const SESSION_LIVE_FOLLOW_EVENTS = new Set([
  "session.next.text.delta",
  "session.next.reasoning.delta",
  "session.next.tool.input.delta",
  "session.next.tool.progress",
  "session.next.compaction.delta",
])

export function sessionFollowSyncKind(type: string) {
  if (SESSION_IMMEDIATE_FOLLOW_EVENTS.has(type)) return "immediate" as const
  if (SESSION_LIVE_FOLLOW_EVENTS.has(type)) return "live" as const
}

export function queuedPromptWaitLabel(mode: string | undefined) {
  if (mode === "after-tools") return "Waiting for the current tool iteration to finish"
  return "Waiting for the current response to finish"
}

export function sessionUserMessageQueued(input: {
  messageID: string
  pendingAssistantID?: string
  messages: ReadonlyArray<{
    id: string
    role: string
    parentID?: string
    time?: { created?: number; completed?: number }
  }>
}) {
  if (!input.pendingAssistantID) return false
  const pending = input.messages.find(
    (message) => message.role === "assistant" && message.id === input.pendingAssistantID,
  )
  if (!pending || pending.time?.completed !== undefined || !pending.parentID) return false
  const activeParentIndex = input.messages.findIndex((message) => message.id === pending.parentID)
  const messageIndex = input.messages.findIndex((message) => message.id === input.messageID)
  if (activeParentIndex < 0 || messageIndex <= activeParentIndex) return false
  return !input.messages.some((message) => message.role === "assistant" && message.parentID === input.messageID)
}

export function sessionPinnedUserMessageID(input: {
  messages: ReadonlyArray<{
    id: string
    role: string
    parentID?: string
    finish?: string
    time: { created?: number; completed?: number }
  }>
  pendingAssistantID?: string
  submittedUserMessageID?: string
  isVisibleUser?: (messageID: string) => boolean
}) {
  const visible = (messageID: string) => input.isVisibleUser?.(messageID) ?? true
  const pending = input.messages.find(
    (message) => message.role === "assistant" && message.id === input.pendingAssistantID,
  )
  const activeParentID = pending && pending.time.completed === undefined ? pending.parentID : undefined
  const submitted = input.submittedUserMessageID
  if (submitted && visible(submitted)) {
    const latestChild = input.messages.findLast(
      (message) => message.role === "assistant" && message.parentID === submitted,
    )
    const finished =
      latestChild?.time.completed !== undefined &&
      Boolean(latestChild.finish && !["tool-calls", "unknown"].includes(latestChild.finish))
    if (!finished && (!activeParentID || activeParentID === submitted)) return submitted
  }

  return activeParentID && visible(activeParentID) ? activeParentID : undefined
}

export function sessionFollowSyncIsStale(input: {
  now: number
  lastSyncAt: number
  lastEventAt: number
  intervalMs: number
}) {
  return input.now - Math.max(input.lastSyncAt, input.lastEventAt) >= input.intervalMs
}

export function shouldDeferSessionFollowSync(input: {
  hasMoreNewer: boolean
  loadingOlder: boolean
  loadingNewer: boolean
}) {
  return input.hasMoreNewer || input.loadingOlder || input.loadingNewer
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  loopWorkflows: () => readonly SessionLoopWorkflow[]
  refreshLoopWorkflows: () => Promise<readonly SessionLoopWorkflow[]>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

function parseGitNumstat(text: string) {
  let added = 0
  let removed = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [rawAdded, rawRemoved] = line.split("\t")
    if (/^\d+$/.test(rawAdded)) added += Number(rawAdded)
    if (/^\d+$/.test(rawRemoved)) removed += Number(rawRemoved)
  }
  return { added, removed }
}

type GitDiffStats = ReturnType<typeof parseGitNumstat>

type SessionMemoryMetadata = {
  input?: { references?: unknown[]; lines?: number }
  callsProviders?: boolean
  output?: {
    generate?: boolean
    proposals?: unknown[]
    saved?: unknown[]
    queued?: boolean
    skipped?: boolean
    reason?: string | null
    candidates?: number
  }
}

type BackgroundWriterInfo = {
  sessionID: string
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  summary?: string
  error?: string
  pinned?: boolean
  time?: {
    created: number
    updated: number
  }
  writer?: {
    clientID: string
    acquired: number
    expires: number
  } | null
}

type SessionLoopWorkflow = {
  id: string
  ownerSessionID?: string
  rootSessionID?: string
  state: string
  phase?: string
  name?: string
  objective?: string
  nextWakeup?: number
  evaluatorReason?: string
  metrics?: {
    turns?: number
  }
  policy?: {
    maxTurns?: number
  }
  time?: {
    created?: number
    updated?: number
    activated?: number
  }
}

type SessionLoopSnapshot = {
  workflow?: SessionLoopWorkflow
  runs?: Array<{
    state?: string
    phase?: string
    evaluatorReason?: string
    checkpoint?: {
      status?: string
      summary?: string
      evidence?: string[]
      nextAction?: string
      confidence?: string
    }
    time?: { created?: number; updated?: number; started?: number; ended?: number }
  }>
  rootSession?: { id: string; title?: string }
}

function formatLoopWorkflowState(state: string, phase?: string) {
  if (!phase || phase === state) return state
  return `${state}: ${phase}`
}

function activeLoopIteration(workflow: SessionLoopWorkflow) {
  const turns = workflow.metrics?.turns ?? 0
  const state = workflow.state.toLowerCase()
  const phase = workflow.phase?.toLowerCase()
  const running = state === "working" || phase === "executing"
  const visible = running ? turns + 1 : turns
  const maxTurns = workflow.policy?.maxTurns
  return typeof maxTurns === "number" ? Math.min(visible, maxTurns) : visible
}

function loopProgressLabel(workflow: SessionLoopWorkflow) {
  const maxTurns = workflow.policy?.maxTurns
  return maxTurns ? `${activeLoopIteration(workflow)}/${maxTurns}` : `${activeLoopIteration(workflow)}/unlimited`
}

function loopWorkflowSignature(items: readonly SessionLoopWorkflow[]) {
  return items
    .map((item) =>
      [
        item.id,
        item.ownerSessionID ?? "",
        item.rootSessionID ?? "",
        item.state,
        item.phase ?? "",
        item.name ?? "",
        item.nextWakeup ?? "",
        item.metrics?.turns ?? "",
        item.policy?.maxTurns ?? "",
        item.time?.created ?? "",
        item.time?.updated ?? "",
        item.time?.activated ?? "",
      ].join("|"),
    )
    .join("\n")
}

function sessionMatchesLoopWorkflow(
  workflow: Pick<SessionLoopWorkflow, "rootSessionID" | "ownerSessionID">,
  sessionID: string,
) {
  return workflow.rootSessionID === sessionID || workflow.ownerSessionID === sessionID
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const promptEdgeToEdge = createMemo(() => {
    return promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)
  })
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const [permissionModeSetting, setPermissionModeSetting] = createSignal<PermissionMode>("approval")
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const sessionPromptHistory = createMemo(() =>
    sessionUserPromptHistory({ messages: messages(), partsByMessage: sync.data.part }),
  )
  const fullHistoryStartID = createMemo(() => latestFullSessionHistoryStartID(messages()))
  const transcriptRenderKey = createMemo(() => sessionTranscriptRenderKey(route.sessionID))
  const pendingInputSessionIDs = createMemo(() =>
    sessionPendingInputSessionIDs({
      sessionID: route.sessionID,
      parentID: session()?.parentID,
      visibleSessionIDs: children().map((x) => x.id),
    }),
  )
  const pendingPermissions = createMemo(() => {
    return pendingInputSessionIDs().flatMap((sessionID) => sync.data.permission[sessionID] ?? [])
  })
  const permissions = createMemo(() => {
    if (permissionModeSetting() === "full_access") return []
    return pendingPermissions()
  })
  const questions = createMemo(() => {
    return pendingInputSessionIDs().flatMap((sessionID) => sync.data.question[sessionID] ?? [])
  })
  const planReviews = createMemo(() => {
    return pendingInputSessionIDs().flatMap((sessionID) => sync.data.plan_review[sessionID] ?? [])
  })
  const visible = createMemo(() =>
    sessionPromptVisible({
      isChildSession: Boolean(session()?.parentID),
      permissionCount: permissions().length,
      questionCount: questions().length,
      planReviewCount: planReviews().length,
    }),
  )
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0 || planReviews().length > 0)

  const [submittedUserMessageID, setSubmittedUserMessageID] = createSignal<string>()
  const pending = createMemo(() => latestPendingAssistantID(messages()))
  const activeTurnAssistantID = createMemo(() => {
    const unfinished = pending()
    if (unfinished) return unfinished
    const status = sync.data.session_status?.[route.sessionID]?.type
    if (status !== "busy" && status !== "retry") return
    return messages().findLast((message) => message.role === "assistant")?.id
  })
  const pinnedTurnUserMessageID = createMemo(() =>
    sessionPinnedUserMessageID({
      messages: messages(),
      pendingAssistantID: activeTurnAssistantID(),
      submittedUserMessageID: submittedUserMessageID(),
      isVisibleUser: (messageID) =>
        (sync.data.part[messageID] ?? []).some(
          (part) => part.type === "text" && !part.synthetic && part.text.trim().length > 0,
        ),
    }),
  )
  const hasLocalActiveTurn = createMemo(() => {
    return sessionHasLocalQueuedTurn({ messages: messages(), pendingAssistantID: pending() })
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", presentationReasoningVisible(mend.profile))
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "show")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [showCompactedToolCalls, setShowCompactedToolCalls] = kv.signal(COMPACTED_TOOL_CALLS_KV_KEY, false)
  const [showTodos, setShowTodos] = kv.signal("session_todos_visible", false)
  const [followSessionOutput, setFollowSessionOutput] = createSignal(true)
  let submitFollowSyncTimer: ReturnType<typeof setTimeout> | undefined
  let submitFollowSyncToken = 0

  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentInset = createMemo(() => (promptEdgeToEdge() ? 0 : 4))
  const contentWidth = createMemo(() => sessionContentWidth(dimensions().width, promptEdgeToEdge()))
  const insetRowWidth = createMemo(() => Math.max(1, contentWidth() - contentInset() * 2))
  const providers = createMemo(() => Model.index(sync.data.provider))
  const rootSessionID = createMemo(() => session()?.parentID ?? route.sessionID)
  const rootMessages = createMemo(() => sync.data.message[rootSessionID()] ?? [])
  const rootFullHistoryStartID = createMemo(() => latestFullSessionHistoryStartID(rootMessages()))
  const rootLatestAssistant = createMemo(
    () =>
      sync.data.session_latest_assistant[rootSessionID()] ??
      rootMessages().findLast((message): message is AssistantMessage => message.role === "assistant"),
  )
  const mainAgentNames = createMemo(
    () => new Set(sync.data.agent.filter((agent) => agent.mode !== "subagent").map((agent) => agent.name)),
  )
  const topUsageLatest = createMemo(() => {
    const stableLatest = rootLatestAssistant()
    const stableMainUsage =
      stableLatest && mainAgentNames().has(stableLatest.agent)
        ? formatAssistantUsage(stableLatest, providers(), { config: sync.data.config })
        : undefined
    return (
      stableMainUsage ??
      (stableLatest ? formatAssistantUsage(stableLatest, providers(), { config: sync.data.config }) : undefined)
    )
  })
  const topUsageFromLoadedHistory = createMemo(() => {
    const stableLatest = rootLatestAssistant()
    const assistantMessages = rootMessages().filter(
      (message): message is AssistantMessage => message.role === "assistant",
    )
    const usageMessages =
      stableLatest && !assistantMessages.some((message) => message.id === stableLatest.id)
        ? [...assistantMessages, stableLatest]
        : assistantMessages
    const mainUsage = formatLatestAssistantContextUsage(usageMessages, providers(), {
      include: (message) => mainAgentNames().has(message.agent),
      config: sync.data.config,
    })
    return mainUsage ?? formatLatestAssistantContextUsage(usageMessages, providers(), { config: sync.data.config })
  })
  const [stableTopUsage, setStableTopUsage] = createSignal<ReturnType<typeof formatAssistantUsage>>()
  createEffect(on(rootSessionID, () => setStableTopUsage(undefined)))
  createEffect(() => {
    const usage =
      topUsageLatest() ??
      (!sync.session.history(rootSessionID()).hasMoreNewer ? topUsageFromLoadedHistory() : undefined)
    if (usage) setStableTopUsage(usage)
  })
  const topUsage = createMemo(() => {
    const latestUsage = topUsageLatest()
    if (latestUsage) return latestUsage
    if (sync.session.history(rootSessionID()).hasMoreNewer) return stableTopUsage()
    return topUsageFromLoadedHistory()
  })
  const configuredStickyUserHeaderEnabled = createMemo(() => {
    const sessionLayout = mend.profile.layout.zones.session
    return Boolean((sessionLayout as { stickyUserHeader?: unknown }).stickyUserHeader)
  })
  const stickyUserHeaderEnabled = createMemo(
    () => configuredStickyUserHeaderEnabled() || Boolean(pinnedTurnUserMessageID()),
  )
  const [stickyUserMessageID, setStickyUserMessageID] = createSignal<string>()
  const stickyUserMessage = createMemo(() => {
    const id = stickyUserMessageID()
    if (!id) return undefined
    return messages().find((message): message is UserMessage => message.id === id && message.role === "user")
  })
  const latestLoadedSessionDirectory = createMemo(() => {
    for (const message of messages().toReversed()) {
      const cwd = (message as { path?: { cwd?: string } }).path?.cwd
      if (cwd) return cwd
    }
    return session()?.directory || project.instance.path().directory || process.cwd()
  })
  const sessionDirectory = createMemo(() => {
    const directory = latestLoadedSessionDirectory() || session()?.directory || project.instance.path().directory
    if (typeof directory === "string" && directory.length > 0) return directory
    return typeof process.cwd === "function" ? process.cwd() : ""
  })
  const [topStatsTick, setTopStatsTick] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setTopStatsTick((tick) => tick + 1), 1500)
    onCleanup(() => clearInterval(timer))
  })
  const topPathLabel = createMemo(() => {
    const directory = sessionDirectory()
    return directory ? directory.replace(Global.Path.home, "~") : ""
  })
  const [topStats] = createResource(
    () => ({ directory: sessionDirectory(), tick: topStatsTick() }),
    async ({ directory }) => {
      if (!directory) return { added: undefined, removed: undefined, branch: "" }
      const diff = await Process.text(["git", "diff", "--numstat", "HEAD", "--"], { cwd: directory, nothrow: true })
      const branch = await Process.text(["git", "branch", "--show-current"], { cwd: directory, nothrow: true })
      const lineStats = diff.code === 0 ? parseGitNumstat(diff.text) : undefined
      return {
        added: lineStats?.added,
        removed: lineStats?.removed,
        branch: branch.code === 0 ? branch.text.trim() : "",
      }
    },
  )
  const topDiffStats = createMemo(() => {
    const stats = topStats()
    if (!stats || (!stats.added && !stats.removed)) return
    return {
      added: stats.added ?? 0,
      removed: stats.removed ?? 0,
    }
  })
  const topBranchLabel = createMemo(() => Locale.truncate(topStats()?.branch || "no branch", 24))
  const topMetricsWidth = createMemo(() =>
    sessionTopMetricsWidth({
      diff: topDiffStats(),
      usage: topUsage(),
    }),
  )
  const [loopSessionWorkflows, setLoopSessionWorkflows] = createSignal<SessionLoopWorkflow[]>([])
  const setLoopSessionWorkflowsIfChanged = (items: SessionLoopWorkflow[]) => {
    const next = items
      .slice()
      .toSorted((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0) || a.id.localeCompare(b.id))
    if (loopWorkflowSignature(next) === loopWorkflowSignature(loopSessionWorkflows())) return
    setLoopSessionWorkflows(next)
  }
  const currentLoopWorkflow = createMemo(() =>
    loopSessionWorkflows().find((workflow) => workflow.rootSessionID === route.sessionID),
  )
  const loopRootWorkflows = createMemo(() =>
    loopSessionWorkflows()
      .filter((workflow) => workflow.rootSessionID)
      .toSorted((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0) || a.id.localeCompare(b.id)),
  )
  const sessionTopNavLabel = createMemo(() => {
    if (session()?.parentID) {
      return `↖ Parent ${keybind.print("session_parent")}  ← Prev ${keybind.print("session_child_cycle_reverse")}  → Next ${keybind.print("session_child_cycle")}`
    }
    if (!currentLoopWorkflow()) return ""
    const parent = currentLoopWorkflow()?.ownerSessionID ? "Parent" : "Agent View"
    if (loopRootWorkflows().length <= 1) return `↖ ${parent} ${keybind.print("session_parent")}`
    return `↖ ${parent} ${keybind.print("session_parent")}  ← Prev loop ${keybind.print("session_child_cycle_reverse")}  → Next loop ${keybind.print("session_child_cycle")}`
  })
  const topbarNavVisible = createMemo(() => Boolean(session()?.parentID || currentLoopWorkflow()))
  const topbarNavWidth = createMemo(() => (topbarNavVisible() ? Bun.stringWidth(sessionTopNavLabel()) : 0))
  const headerTitleConfig = createMemo(() => {
    const header = mend.profile.layout.zones.header as { title?: { visible?: unknown; align?: unknown } }
    return header.title ?? {}
  })
  const headerTitleVisible = createMemo(() => headerTitleConfig().visible === true)
  const headerTitleAlign = createMemo(() => sessionHeaderTitleAlign(headerTitleConfig().align))
  const headerTitleJustify = createMemo(() => sessionHeaderTitleJustify(headerTitleAlign()))
  const headerTitleText = createMemo(() => session()?.title || route.sessionID)
  const topbarLayout = createMemo(() =>
    sessionTopbarLayout({
      contentWidth: contentWidth(),
      metricsWidth: topMetricsWidth(),
      navWidth: topbarNavWidth(),
      titleVisible: headerTitleVisible(),
    }),
  )
  const topbarLeftLabel = createMemo(() =>
    sessionTopbarLeftLabel({
      branch: sync.data.vcs?.branch || "git",
      path: topPathLabel(),
      maxWidth: topbarLayout().pathWidth,
      isChildSession: Boolean(session()?.parentID),
    }),
  )
  const todos = createMemo(() => sync.data.todo[route.sessionID] ?? [])
  const taskSubagentBySession = createMemo(() => {
    const result = new Map<string, { description?: string; subagentType?: string }>()
    const fullStartID = rootFullHistoryStartID()
    for (const message of rootMessages()) {
      if (shouldUseSimpleSessionHistory({ messageID: message.id, fullStartID })) continue
      for (const part of sync.data.part[message.id] ?? []) {
        if (part.type !== "tool" || part.tool !== "task") continue
        const state = part.state as {
          input?: Record<string, unknown>
          metadata?: Record<string, unknown>
          title?: string
          time?: { compacted?: boolean }
        }
        if (state.time?.compacted) continue
        const sessionId = typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined
        if (!sessionId) continue
        result.set(sessionId, {
          description:
            typeof state.input?.description === "string"
              ? state.input.description
              : typeof state.title === "string"
                ? state.title
                : undefined,
          subagentType: typeof state.input?.subagent_type === "string" ? state.input.subagent_type : undefined,
        })
      }
    }
    return result
  })
  const subagents = createMemo<SessionSubagentInfo[]>(() => {
    return children()
      .filter((child) => !!child.parentID)
      .flatMap((child) => {
        const task = taskSubagentBySession().get(child.id)
        if (!task) return []
        const childMessages = sync.data.message[child.id] ?? []
        const latestAssistant = childMessages.findLast(
          (message): message is AssistantMessage => message.role === "assistant",
        )
        const latestAgent = (latestAssistant ?? childMessages.findLast((message) => message.role === "user"))?.agent
        const label = normalizeSubagentLabel(task?.subagentType ?? child.agent ?? latestAgent ?? "subagent")
        const status = sessionLiveStateLabel({
          status: sync.data.session_status?.[child.id],
          messages: childMessages,
          pendingInputCount:
            (sync.data.permission[child.id]?.length ?? 0) +
            (sync.data.question[child.id]?.length ?? 0) +
            (sync.data.plan_review[child.id]?.length ?? 0),
        })
        const usage = latestAssistant
          ? (formatAssistantLiveUsage(latestAssistant, providers(), { config: sync.data.config }) ??
            formatAssistantUsage(latestAssistant, providers(), { config: sync.data.config }))
          : undefined
        return [
          {
            id: child.id,
            label: Locale.titlecase(label),
            description: task?.description ?? child.title ?? child.path ?? child.directory ?? child.id,
            status,
            meta: usage?.compact,
            detail: usage?.detail,
            updated: Locale.time(child.time.updated),
            updatedAt: child.time.updated,
            active: child.id === route.sessionID,
          },
        ]
      })
      .toSorted((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        const aRelevant = sessionSubagentIsActive(a.status)
        const bRelevant = sessionSubagentIsActive(b.status)
        if (aRelevant !== bRelevant) return aRelevant ? -1 : 1
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const [sendNowMessageID, setSendNowMessageID] = createSignal<string>()
  const sendQueuedNow = async (messageID: string) => {
    if (sendNowMessageID()) return
    setSendNowMessageID(messageID)
    try {
      await sdk.client.session.interrupt({ sessionID: route.sessionID }, { throwOnError: true })
      toast.show({ message: "Queued prompt sent now", variant: "success", duration: 2500 })
    } catch (error) {
      toast.show({
        title: "Could not send queued prompt",
        message: error instanceof Error ? error.message : "The active turn was not interrupted.",
        variant: "error",
        duration: 5000,
      })
    } finally {
      setSendNowMessageID(undefined)
    }
  }
  const [agentCommands, setAgentCommands] = createSignal<AgentViewCommand[]>([])
  const [agentCommandBusyID, setAgentCommandBusyID] = createSignal<string>()
  let agentCommandRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const editor = useEditorContext()
  const [loopBackgroundSummary, setLoopBackgroundSummary] = createSignal<string>()
  const loopStatusLabel = createMemo(() => {
    const workflow = currentLoopWorkflow()
    const summary = loopBackgroundSummary()
    if (!workflow && !summary) return undefined
    const progress = workflow ? loopProgressLabel(workflow) : undefined
    const state = workflow
      ? formatLoopWorkflowState(workflow.state, workflow.phase ?? "ready")
      : summary?.replace(/^Loop\s+/i, "")
    const name = workflow?.name ? `${workflow.name} · ` : ""
    return Locale.truncate(`${name}${state}${progress ? ` · ${progress}` : ""}`, Math.max(12, contentWidth() - 16))
  })
  const showSessionBottomDock = createMemo(() => showTodos() && !disabled())
  const promptDisabled = createMemo(() => disabled())

  const agentCommandURL = (path: string, query?: Record<string, string | undefined>) => {
    const url = new URL(path, sdk.url)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  const agentCommandJSON = async <T,>(path: string, init?: RequestInit, query?: Record<string, string | undefined>) => {
    const headers = new Headers(sdk.headers)
    if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
    if (init?.body) headers.set("content-type", "application/json")
    const response = await sdk.fetch(agentCommandURL(path, query), { ...init, headers })
    if (!response.ok)
      throw new Error((await response.text().catch(() => "")) || `Agent command request failed: ${response.status}`)
    return (await response.json()) as T
  }

  const setAgentCommandsMerged = (items: readonly AgentViewCommand[]) => {
    const byID = new Map<string, AgentViewCommand>()
    for (const item of items) byID.set(item.id, item)
    setAgentCommands(
      Array.from(byID.values()).toSorted(
        (a, b) =>
          agentViewCommandStateRank(a) - agentViewCommandStateRank(b) ||
          b.time.updated - a.time.updated ||
          b.id.localeCompare(a.id),
      ),
    )
  }

  const refreshAgentCommands = async (sessionID = route.sessionID) => {
    const [incoming, outgoing] = await Promise.all([
      agentCommandJSON<AgentViewCommand[]>(`/session/${sessionID}/agent-command`).catch(() => []),
      agentCommandJSON<AgentViewCommand[]>("/session/agent-command", undefined, { sourceSessionID: sessionID }).catch(
        () => [],
      ),
    ])
    if (route.sessionID !== sessionID) return
    setAgentCommandsMerged([...incoming, ...outgoing])
  }

  const scheduleAgentCommandRefresh = (delay = 50) => {
    if (agentCommandRefreshTimer) clearTimeout(agentCommandRefreshTimer)
    agentCommandRefreshTimer = setTimeout(() => {
      agentCommandRefreshTimer = undefined
      void refreshAgentCommands().catch(() => undefined)
    }, delay)
  }

  const updateAgentCommand = async (command: AgentViewCommand, state: "accepted" | "rejected") => {
    if (agentCommandBusyID() === command.id || !isAgentViewCommandActionable(command)) return
    setAgentCommandBusyID(command.id)
    try {
      const updated = await agentCommandJSON<AgentViewCommand>(
        `/session/${route.sessionID}/agent-command/${command.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state }),
        },
      )
      setAgentCommandsMerged(agentCommands().map((item) => (item.id === updated.id ? updated : item)))
      toast.show({ variant: state === "accepted" ? "success" : "info", message: `Command ${state}`, duration: 2500 })
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 4000 })
    } finally {
      setAgentCommandBusyID((current) => (current === command.id ? undefined : current))
    }
  }

  const incomingAgentCommands = createMemo(() =>
    agentCommands().filter((command) => command.targetSessionID === route.sessionID),
  )
  const sentAgentCommands = createMemo(() =>
    agentCommands().filter(
      (command) => command.sourceSessionID === route.sessionID && command.targetSessionID !== route.sessionID,
    ),
  )
  const visibleAgentCommands = createMemo(() => [
    ...incomingAgentCommands().slice(0, 4),
    ...sentAgentCommands().slice(0, 2),
  ])

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        setAgentCommands([])
        void refreshAgentCommands(sessionID).catch(() => undefined)
      },
    ),
  )

  onCleanup(() => {
    if (agentCommandRefreshTimer) clearTimeout(agentCommandRefreshTimer)
  })
  const [permissionsConfig, { refetch: refetchPermissionsConfig }] = createResource(
    () => route.sessionID,
    async () => readPermissionsConfig(),
  )
  const [smartPermissionStatus, setSmartPermissionStatus] = createSignal<string | null>(null)
  const autoAcceptedPermissionIDs = new Set<string>()
  const smartReviewedPermissionIDs = new Set<string>()
  const sessionPermissionModesKey = "session_permission_modes"
  const permissionSessionID = createMemo(() => session()?.parentID ?? route.sessionID)

  function normalizePermissionModeValue(value: unknown): PermissionMode | undefined {
    if (value === "approval" || value === "smart" || value === "full_access") return value
    return undefined
  }

  function permissionModeTitle(mode: PermissionMode) {
    if (mode === "full_access") return "Full Access"
    if (mode === "smart") return "Smart Approval"
    return "Require approval"
  }

  function sessionPermissionOverrides() {
    const value = kv.get(sessionPermissionModesKey, {})
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  }

  function sessionPermissionModeOverride() {
    return normalizePermissionModeValue(sessionPermissionOverrides()[permissionSessionID()])
  }

  createEffect(() => {
    const config = permissionsConfig()
    const sessionMode = sessionPermissionModeOverride()
    if (sessionMode) {
      setPermissionModeSetting(sessionMode)
      return
    }
    if (config) setPermissionModeSetting(config.mode)
  })

  const permissionConfigSummary = createMemo(() => {
    const permission = sync.data.config.permission
    if (permission === undefined) return "No explicit project permission config loaded. Runtime defaults still apply."
    if (typeof permission === "string") return `permission: ${permission}`
    return JSON.stringify(permission, null, 2)
  })

  async function replyPermissionOnce(request: PermissionRequest) {
    if (autoAcceptedPermissionIDs.has(request.id)) return false
    autoAcceptedPermissionIDs.add(request.id)
    await sdk.client.permission.reply({
      reply: "once",
      requestID: request.id,
      workspace: project.workspace.current(),
    })
    return true
  }

  async function autoAcceptPendingPermissions() {
    let accepted = 0
    for (const request of pendingPermissions()) {
      if (await replyPermissionOnce(request)) accepted++
    }
    return accepted
  }

  async function smartReviewPendingPermissions() {
    let reviewed = 0
    for (const request of permissions()) {
      if (smartReviewedPermissionIDs.has(request.id)) continue
      if (!shouldTriggerSmartApproval(request)) continue
      smartReviewedPermissionIDs.add(request.id)
      setSmartPermissionStatus(`Smart reviewing ${request.permission}`)
      const decision = await reviewPermissionRequestWithModel(request, mend.root)
      if (!decision.triggered || decision.decision === "ask") {
        setSmartPermissionStatus(`Smart needs approval`)
        toast.show({ message: `Smart Approval needs you: ${decision.reason}`, variant: "info", duration: 5000 })
        continue
      }
      reviewed++
      await sdk.client.permission.reply({
        reply: decision.decision === "allow" ? "once" : "reject",
        requestID: request.id,
        workspace: project.workspace.current(),
      })
      toast.show({
        message: `Smart Approval ${decision.decision === "allow" ? "allowed" : "rejected"}: ${decision.reason}`,
        variant: decision.decision === "allow" ? "success" : "warning",
        duration: 5000,
      })
      setSmartPermissionStatus(`Smart ${decision.decision === "allow" ? "approved" : "rejected"}`)
      setTimeout(() => {
        setSmartPermissionStatus((current) => (current?.startsWith("Smart ") ? null : current))
      }, 5000)
    }
    return reviewed
  }

  createEffect(
    on(
      () => route.sessionID,
      () => {
        autoAcceptedPermissionIDs.clear()
        smartReviewedPermissionIDs.clear()
      },
      { defer: true },
    ),
  )

  async function setPermissionModeForSession(mode: PermissionMode) {
    const overrides = { ...sessionPermissionOverrides(), [permissionSessionID()]: mode }
    kv.set(sessionPermissionModesKey, overrides)
    setPermissionModeSetting(mode)
  }

  async function clearPermissionModeForSession() {
    const overrides = { ...sessionPermissionOverrides() }
    delete overrides[permissionSessionID()]
    kv.set(sessionPermissionModesKey, overrides)
    const globalMode = (await readPermissionsConfig()).mode
    setPermissionModeSetting(globalMode)
    await refetchPermissionsConfig()
  }

  async function setPermissionModeAsDefault(mode: PermissionMode) {
    await writePermissionsConfig({ mode })
    setPermissionModeSetting(sessionPermissionModeOverride() || mode)
    await refetchPermissionsConfig()
  }

  createEffect(() => {
    if (permissionModeSetting() !== "full_access") return
    void autoAcceptPendingPermissions().catch((error) => {
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
    })
  })

  createEffect(() => {
    if (permissionModeSetting() !== "smart") return
    void smartReviewPendingPermissions().catch((error) => {
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
    })
  })

  function permissionModeDescription() {
    const scope = sessionPermissionModeOverride() ? "session" : "default"
    return `Current: ${permissionModeTitle(permissionModeSetting())} (${scope})`
  }

  async function toggleStickyUserHeader() {
    const current = await readActiveTuiProfile(mend.root)
    const enabled = Boolean((current.layout.zones.session as { stickyUserHeader?: unknown }).stickyUserHeader)
    await writeActiveTuiProfile(
      {
        ...current,
        layout: {
          ...current.layout,
          zones: {
            ...current.layout.zones,
            session: {
              ...current.layout.zones.session,
              stickyUserHeader: !enabled,
            },
          },
        },
      },
      mend.root,
    )
    await mend.reload()
    toast.show({
      variant: "info",
      message: `Sticky user header ${enabled ? "disabled" : "enabled"}.`,
      duration: 4000,
    })
  }

  const permissionMode = createMemo(() => permissionModeSetting())
  const permissionModeLabel = createMemo(() => {
    const smartStatus = smartPermissionStatus()
    if (smartStatus) return smartStatus
    const label = permissionModeSetting() === "approval" ? "approval" : permissionModeTitle(permissionModeSetting())
    return sessionPermissionModeOverride() ? `${label} session` : label
  })
  const permissionPendingCount = createMemo(() => permissions().length)

  function showPermissionMode() {
    const pending = permissions()
    const pendingLines = pending.length
      ? pending.map((request) => `- ${request.permission}: ${request.patterns.join(", ")}`).join("\n")
      : "- none"

    dialog.replace(() => (
      <DialogSelect
        title="Permission mode"
        current={permissionModeSetting()}
        options={[
          {
            title: "Require approval",
            value: "approval",
            description: "Use Require approval for this session",
          },
          {
            title: "Smart Approval",
            value: "smart",
            description: "Use Smart Approval for this session",
          },
          {
            title: "Full Access",
            value: "full_access",
            description: "Use Full Access for this session",
          },
          {
            title: "Use global default",
            value: "global_default",
            description: `Clear this session override; default is ${permissionModeTitle(permissionsConfig()?.mode || "approval")}`,
          },
          {
            title: "Set global default",
            value: "set_default",
            description: "Choose the default mode for future sessions",
          },
          {
            title: "View permission details",
            value: "details",
            description: `Pending: ${pending.length}; config: ${typeof sync.data.config.permission === "string" ? sync.data.config.permission : "custom"}`,
          },
        ]}
        onSelect={(option) => {
          if (option.value === "approval") {
            void setPermissionModeForSession("approval").then(() =>
              toast.show({
                message: "This session will require approval.",
                variant: "info",
                duration: 4000,
              }),
            )
            dialog.clear()
            return
          }

          if (option.value === "smart") {
            void setPermissionModeForSession("smart")
            void smartReviewPendingPermissions()
              .then((reviewed) => {
                toast.show({
                  message: reviewed
                    ? `Smart Approval enabled for this session; reviewed ${reviewed} risky permission${reviewed === 1 ? "" : "s"}.`
                    : "Smart Approval enabled for this session.",
                  variant: "success",
                  duration: 4000,
                })
              })
              .catch((error) => {
                toast.show({
                  message: errorMessage(error),
                  variant: "error",
                  duration: 5000,
                })
              })
            dialog.clear()
            return
          }

          if (option.value === "full_access") {
            void setPermissionModeForSession("full_access")
            void autoAcceptPendingPermissions()
              .then((accepted) => {
                toast.show({
                  message: accepted
                    ? `Full Access enabled for this session; accepted ${accepted} pending permission${accepted === 1 ? "" : "s"}.`
                    : "Full Access enabled for this session.",
                  variant: "success",
                  duration: 4000,
                })
              })
              .catch((error) => {
                toast.show({
                  message: errorMessage(error),
                  variant: "error",
                  duration: 5000,
                })
              })
            dialog.clear()
            return
          }

          if (option.value === "global_default") {
            void clearPermissionModeForSession().then(() => {
              toast.show({
                message: `This session now follows the global default: ${permissionModeTitle(permissionModeSetting())}.`,
                variant: "info",
                duration: 4000,
              })
            })
            dialog.clear()
            return
          }

          if (option.value === "set_default") {
            dialog.replace(() => (
              <DialogSelect
                title="Default permission mode"
                current={permissionsConfig()?.mode || "approval"}
                options={[
                  {
                    title: "Require approval",
                    value: "approval",
                    description: "Default future sessions to manual permission prompts.",
                  },
                  {
                    title: "Smart Approval",
                    value: "smart",
                    description: "Default future sessions to model-reviewed risky shell prompts.",
                  },
                  {
                    title: "Full Access",
                    value: "full_access",
                    description: "Default future sessions to automatically approve permission prompts.",
                  },
                ]}
                onSelect={(selected) => {
                  const mode = normalizePermissionModeValue(selected.value)
                  if (!mode) return
                  void setPermissionModeAsDefault(mode).then(() => {
                    toast.show({
                      message: `Global permission default saved: ${permissionModeTitle(mode)}.`,
                      variant: "success",
                      duration: 4000,
                    })
                    dialog.clear()
                  })
                }}
              />
            ))
            return
          }

          void DialogAlert.show(
            dialog,
            "Permission mode",
            [
              permissionModeDescription(),
              `Smart status: ${smartPermissionStatus() || "idle"}`,
              `Global default: ${permissionModeTitle(permissionsConfig()?.mode || "approval")}`,
              `Session override: ${sessionPermissionModeOverride() ? permissionModeTitle(sessionPermissionModeOverride()!) : "none"}`,
              `Pending permission requests: ${pending.length}`,
              "",
              "Pending:",
              pendingLines,
              "",
              "Config permission:",
              permissionConfigSummary(),
              "",
              "--dangerously-skip-permissions only applies to `mendcode run`. This TUI mode only affects the current interactive session and does not override explicit deny rules.",
            ].join("\n"),
          )
        }}
      />
    ))
    dialog.setSize("large")
  }

  function showContextUsage(dialog: DialogContext) {
    dialog.replace(() => (
      <DialogContextUsage
        messages={rootMessages()}
        partsByMessageID={sync.data.part}
        providers={providers()}
        mainAgentNames={mainAgentNames()}
        config={sync.data.config}
      />
    ))
    dialog.setSize("large")
  }

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = project.workspace.current()
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll && followSessionOutput()) toBottom({ sync: false })
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  createEffect(
    on(
      () => sdk.connection.status,
      (status) => {
        if (status !== "connected") return
        void sync.session.sync(route.sessionID, { force: true })
      },
      { defer: true },
    ),
  )

  let followSyncTimer: ReturnType<typeof setTimeout> | undefined
  let eventlessFollowTimer: ReturnType<typeof setInterval> | undefined
  let followSyncInFlight = false
  let followSyncQueued = false
  let lastFollowSyncAt = 0
  let lastSessionEventAt = Date.now()

  const runFollowSync = () => {
    if (shouldDeferSessionFollowSync(sync.session.history(route.sessionID))) return
    if (followSyncInFlight) {
      followSyncQueued = true
      return
    }
    followSyncInFlight = true
    lastFollowSyncAt = Date.now()
    void sync.session
      .sync(route.sessionID, { force: true })
      .catch(() => undefined)
      .finally(() => {
        followSyncInFlight = false
        if (!followSyncQueued) return
        followSyncQueued = false
        scheduleFollowSync(100)
      })
  }

  const scheduleFollowSync = (delay: number) => {
    if (followSyncTimer) clearTimeout(followSyncTimer)
    followSyncTimer = setTimeout(() => {
      followSyncTimer = undefined
      runFollowSync()
    }, delay)
  }

  const scheduleLiveFollowSync = () => {
    const elapsed = Date.now() - lastFollowSyncAt
    scheduleFollowSync(elapsed >= 900 ? 0 : 900 - elapsed)
  }

  createEffect(
    on(
      () => ({
        sessionID: route.sessionID,
        status: sync.data.session_status?.[route.sessionID]?.type,
        localActive: hasLocalActiveTurn(),
        loopState: currentLoopWorkflow()?.state,
        title: session()?.title ?? "",
      }),
      ({ status, localActive, loopState, title }) => {
        const isLoopSession = Boolean(loopState) || title.startsWith("Loop:")
        if (eventlessFollowTimer) clearInterval(eventlessFollowTimer)
        eventlessFollowTimer = undefined
        if (!isLoopSession && status !== "busy" && status !== "retry" && !localActive) return
        const intervalMs =
          status === "busy" || status === "retry" || localActive || loopState === "working"
            ? 600
            : isLoopSession
              ? 900
              : 600
        eventlessFollowTimer = setInterval(() => {
          if (
            !sessionFollowSyncIsStale({
              now: Date.now(),
              lastSyncAt: lastFollowSyncAt,
              lastEventAt: lastSessionEventAt,
              intervalMs,
            })
          )
            return
          scheduleFollowSync(0)
        }, intervalMs)
      },
    ),
  )

  const eventSessionProperties = (evt: { properties?: unknown }) =>
    evt.properties as
      | {
          sessionID?: string
          info?: { sessionID?: string; rootSessionID?: string }
          part?: { sessionID?: string }
          run?: { rootSessionID?: string }
          thread?: { sessionID?: string }
          event?: { sessionID?: string }
          targetSessionID?: string
          sourceSessionID?: string
        }
      | undefined

  const eventSessionID = (evt: { properties?: unknown }) => {
    const properties = eventSessionProperties(evt)
    return (
      properties?.sessionID ??
      properties?.targetSessionID ??
      properties?.sourceSessionID ??
      properties?.info?.sessionID ??
      properties?.info?.rootSessionID ??
      properties?.run?.rootSessionID ??
      properties?.thread?.sessionID ??
      properties?.event?.sessionID ??
      properties?.part?.sessionID
    )
  }

  const unsubscribeFollowSync = sdk.event.on("event", (event) => {
    if (event.payload.type === "sync") return
    const evt = event.payload
    const evtType = evt.type as string
    const evtProperties = eventSessionProperties(evt)
    const agentCommandTouchesCurrentSession =
      (evtType === "agent_command.created" || evtType === "agent_command.updated") &&
      evtProperties?.sourceSessionID &&
      evtProperties?.targetSessionID &&
      agentViewCommandTouchesSession({
        sourceSessionID: evtProperties.sourceSessionID,
        targetSessionID: evtProperties.targetSessionID,
        sessionID: route.sessionID,
        direction: "either",
      })
    if (agentCommandTouchesCurrentSession) scheduleAgentCommandRefresh()
    const evtSessionID = eventSessionID(evt)
    if (evtSessionID !== route.sessionID && !agentCommandTouchesCurrentSession) return
    lastSessionEventAt = Date.now()
    if (evt.type === "message.part.updated") {
      const part = (evt.properties as { part?: Part } | undefined)?.part
      const memory =
        part?.type === "step-finish"
          ? (part.metadata as { mendMemory?: SessionMemoryMetadata } | undefined)?.mendMemory
          : undefined
      if (memoryToastMessage(memory)) return
    }
    const followSyncKind = sessionFollowSyncKind(evt.type)
    if (followSyncKind === "immediate") {
      scheduleFollowSync(50)
      return
    }
    if (followSyncKind === "live") scheduleLiveFollowSync()
  })

  onCleanup(() => {
    unsubscribeFollowSync()
    if (followSyncTimer) clearTimeout(followSyncTimer)
    if (eventlessFollowTimer) clearInterval(eventlessFollowTimer)
  })

  const shownMemoryToastParts = new Set<string>()
  const pendingMemoryToastParts = new Map<string, string>()
  const [memoryToastQueueVersion, setMemoryToastQueueVersion] = createSignal(0)
  let memoryToastSettleTimer: ReturnType<typeof setTimeout> | undefined
  const memoryToastSettled = createMemo(() => {
    const status = sync.data.session_status?.[route.sessionID]?.type
    if (status && status !== "idle") return false
    if (pending()) return false
    if (disabled()) return false
    return children().every((child) => {
      const childStatus = sync.data.session_status?.[child.id]?.type
      return !childStatus || childStatus === "idle"
    })
  })
  const flushMemoryToasts = () => {
    if (!memoryToastSettled()) return
    for (const [id, message] of pendingMemoryToastParts) {
      pendingMemoryToastParts.delete(id)
      toast.show({
        variant: "info",
        message,
        duration: 4000,
      })
    }
  }
  createEffect(
    on(
      () => ({ settled: memoryToastSettled(), version: memoryToastQueueVersion() }),
      ({ settled }) => {
        if (memoryToastSettleTimer) clearTimeout(memoryToastSettleTimer)
        memoryToastSettleTimer = undefined
        if (!settled || pendingMemoryToastParts.size === 0) return
        memoryToastSettleTimer = setTimeout(() => {
          memoryToastSettleTimer = undefined
          flushMemoryToasts()
        }, 250)
      },
    ),
  )
  onCleanup(() => {
    if (memoryToastSettleTimer) clearTimeout(memoryToastSettleTimer)
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.sessionID !== route.sessionID) return
    if (part.type === "step-finish") {
      const message = memoryToastMessage(
        (part.metadata as { mendMemory?: SessionMemoryMetadata } | undefined)?.mendMemory,
      )
      if (!message) return
      const toastKey = `${part.id}:${message}`
      if (shownMemoryToastParts.has(toastKey)) return
      shownMemoryToastParts.add(toastKey)
      pendingMemoryToastParts.set(part.id, message)
      setMemoryToastQueueVersion((version) => version + 1)
      return
    }
    if (part.type !== "tool") return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set((part.state.metadata as { planExitAgent?: string } | undefined)?.planExitAgent || "build")
      local.model.pinAgentCurrent()
      lastSwitch = part.id
    } else if (part.tool === "plan_review" && part.state.title === "Plan approved") {
      local.agent.set((part.state.metadata as { planExitAgent?: string } | undefined)?.planExitAgent || "build")
      local.model.pinAgentCurrent()
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      local.model.pinAgentCurrent()
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let scrollAnchor: { id: string; offset: number } | undefined
  let lastObservedScrollTop = 0
  let lastObservedScrollHeight = 0
  let manualScrollGraceUntil = 0
  let bottomScrollToken = 0
  let routeBottomScrollToken = 0
  let submitBottomScrollTimer: ReturnType<typeof setTimeout> | undefined
  let submitBottomScrollSessionID: string | undefined
  let scrollPagingInFlight = false
  let scrollPagingToken = 0
  let suppressedPagingBoundary: "top" | "bottom" | undefined
  const [sessionScrollTop, setSessionScrollTop] = createSignal(0)
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keybind = useKeybind()
  const dialog = useDialog()
  const renderer = useRenderer()

  // Keep the child-session exit shortcut for states where the prompt is not mounted.
  const exit = useExit()

  const captureScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed) {
      scrollAnchor = undefined
      return undefined
    }

    const top = scroll.y
    const child = scroll
      .getChildren()
      .filter((item) => item.id && item.y >= top)
      .sort((a, b) => a.y - b.y)[0]
    scrollAnchor = child?.id ? { id: child.id, offset: child.y - top } : undefined
    return scrollAnchor
  }

  const restoreScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed || !scrollAnchor) return false
    const child = scroll.getChildren().find((item) => item.id === scrollAnchor?.id)
    if (!child) {
      captureScrollAnchor()
      return false
    }

    const delta = child.y - scroll.y - scrollAnchor.offset
    if (delta !== 0) scroll.scrollBy(delta)
    return true
  }

  const restoreScrollAfterPaging = (boundary: "top" | "bottom", anchor?: { id: string; offset: number }) => {
    const pagingToken = scrollPagingToken
    const sessionID = route.sessionID
    scrollAnchor = anchor
    suppressedPagingBoundary = boundary
    setTimeout(() => {
      if (pagingToken !== scrollPagingToken || route.sessionID !== sessionID) return
      if (!scroll || scroll.isDestroyed) return
      const restored = Boolean(anchor && restoreScrollAnchor())
      if (!restored) scroll.scrollTo(boundary === "top" ? 0 : scroll.scrollHeight)
      lastObservedScrollTop = scroll.scrollTop
      lastObservedScrollHeight = scroll.scrollHeight
      setSessionScrollTop(scroll.scrollTop)
    }, 0)
  }

  const cancelBottomScrollTimers = () => {
    bottomScrollToken += 1
    routeBottomScrollToken += 1
    if (submitBottomScrollTimer) clearTimeout(submitBottomScrollTimer)
    submitBottomScrollTimer = undefined
    submitBottomScrollSessionID = undefined
  }

  const syncScrollFollowMode = () => {
    if (!scroll || scroll.isDestroyed) return
    const scrollTop = scroll.scrollTop
    const scrollHeight = scroll.scrollHeight
    setSessionScrollTop(scrollTop)
    const currentSessionID = route.sessionID
    const history = sync.session.history(currentSessionID)
    const atTop = isScrollboxAtTop(scroll)
    const atBottom = isScrollboxAtBottom(scroll)
    const userMovedViewport =
      Math.abs(scrollTop - lastObservedScrollTop) > 1 && Math.abs(scrollHeight - lastObservedScrollHeight) <= 1

    if (userMovedViewport) cancelBottomScrollTimers()

    if (
      suppressedPagingBoundary &&
      shouldReleaseSessionPagingBoundarySuppression({
        boundary: suppressedPagingBoundary,
        scrollTop,
        scrollHeight,
        viewportHeight: scroll.viewport.height,
      })
    ) {
      suppressedPagingBoundary = undefined
    }

    if (atTop && history.hasMoreOlder && !history.loadingOlder && !scrollPagingInFlight) {
      if (suppressedPagingBoundary) {
        setFollowSessionOutput(false)
        return
      }
      const pagingToken = scrollPagingToken
      const pagingAnchor = captureScrollAnchor()
      setFollowSessionOutput(false)
      scrollPagingInFlight = true
      void sync.session
        .loadOlder(currentSessionID)
        .then((loaded) => {
          if (!loaded) return
          if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return
          restoreScrollAfterPaging("top", pagingAnchor)
        })
        .catch(() => undefined)
        .finally(() => {
          if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return
          scrollPagingInFlight = false
        })
      return
    }

    if (atBottom) {
      const pagingAnchor =
        history.hasMoreNewer && !history.loadingNewer && !scrollPagingInFlight && !suppressedPagingBoundary
          ? captureScrollAnchor()
          : undefined
      scrollAnchor = undefined
      lastObservedScrollTop = scrollTop
      lastObservedScrollHeight = scrollHeight
      if (history.hasMoreNewer && !history.loadingNewer && !scrollPagingInFlight) {
        if (suppressedPagingBoundary) {
          setFollowSessionOutput(false)
          return
        }
        const pagingToken = scrollPagingToken
        setFollowSessionOutput(false)
        scrollPagingInFlight = true
        void sync.session
          .loadNewer(currentSessionID)
          .then((loaded) => {
            if (!loaded) return
            if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return
            restoreScrollAfterPaging("bottom", pagingAnchor)
          })
          .catch(() => undefined)
          .finally(() => {
            if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return
            scrollPagingInFlight = false
          })
        return
      }
      if (suppressedPagingBoundary) {
        setFollowSessionOutput(false)
        return
      }
      setFollowSessionOutput(true)
      return
    }

    setFollowSessionOutput(false)
    if (
      shouldRestoreSessionScrollAnchor({
        now: Date.now(),
        manualScrollGraceUntil,
        userMovedViewport,
        hasAnchor: Boolean(scrollAnchor),
      })
    ) {
      restoreScrollAnchor()
    }
    captureScrollAnchor()

    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
  }

  const markScrollDetached = () => {
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    setFollowSessionOutput(false)
    setTimeout(captureScrollAnchor, 0)
  }

  const scrollToBottomIfAllowed = (options?: { force?: boolean }) => {
    if (!scroll || scroll.isDestroyed) return
    if (!options?.force && !followSessionOutput()) return
    scrollAnchor = undefined
    scroll.scrollTo(scroll.scrollHeight)
    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
    setSessionScrollTop(scroll.scrollTop)
  }

  const scrollToBottomForToken = (token: number, options?: { force?: boolean }) => {
    if (token !== bottomScrollToken) return
    scrollToBottomIfAllowed(options)
  }

  const scrollToBottomForRouteToken = (token: number, sessionID: string, options?: { force?: boolean }) => {
    if (token !== routeBottomScrollToken || route.sessionID !== sessionID) return
    scrollToBottomIfAllowed(options)
  }

  const scheduleBottomScroll = (delay = 0, options?: { force?: boolean }) => {
    const token = ++bottomScrollToken
    setTimeout(() => scrollToBottomForToken(token, options), delay)
  }

  createEffect(
    on(
      transcriptRenderKey,
      () => {
        queueMicrotask(() => {
          renderer.requestRender()
          scheduleBottomScroll(0, { force: true })
        })
      },
      { defer: true },
    ),
  )

  const scheduleRouteBottomScrollPasses = (sessionID: string, delays: number[], options?: { force?: boolean }) => {
    const token = ++routeBottomScrollToken
    delays.forEach((delay) => setTimeout(() => scrollToBottomForRouteToken(token, sessionID, options), delay))
  }

  const scheduleSubmitBottomScroll = (sessionID: string) => {
    if (submitBottomScrollTimer) clearTimeout(submitBottomScrollTimer)
    submitBottomScrollSessionID = sessionID
    submitBottomScrollTimer = setTimeout(() => {
      submitBottomScrollTimer = undefined
      submitBottomScrollSessionID = undefined
      if (route.sessionID !== sessionID) return
      renderer.requestRender()
      scrollToBottomIfAllowed({ force: true })
    }, 50)
  }

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        scrollPagingToken += 1
        scrollPagingInFlight = false
        suppressedPagingBoundary = undefined
        scrollAnchor = undefined
        lastObservedScrollTop = 0
        lastObservedScrollHeight = 0
        manualScrollGraceUntil = 0
        cancelBottomScrollTimers()
        cancelSubmitFollowSync()
        setSubmittedUserMessageID(undefined)
        setSessionScrollTop(0)
        setFollowSessionOutput(true)
        lastSessionEventAt = Date.now()
        if (scroll && !scroll.isDestroyed) {
          scroll.scrollTo(0)
          lastObservedScrollTop = scroll.scrollTop
          lastObservedScrollHeight = scroll.scrollHeight
          setSessionScrollTop(scroll.scrollTop)
        }
        scheduleRouteBottomScrollPasses(sessionID, [0, 16, 50, 120], { force: true })
      },
    ),
  )

  const scrollBySession = (delta: number) => {
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    scroll.scrollBy(delta)
    setTimeout(syncScrollFollowMode, 0)
  }
  const scrollToSession = (position: number) => {
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    scroll.scrollTo(position)
    setTimeout(syncScrollFollowMode, 0)
  }
  const [validatedExitSessionID, setValidatedExitSessionID] = createSignal<string>()
  let exitSessionValidationToken = 0

  onMount(() => {
    const timer = setInterval(syncScrollFollowMode, 80)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const current = session()
    const sessionID = current?.id
    const token = ++exitSessionValidationToken
    setValidatedExitSessionID(undefined)
    if (!sessionID) return
    void sdk.client.session
      .get({ sessionID })
      .then((result) => {
        if (token !== exitSessionValidationToken) return
        setValidatedExitSessionID(result.data?.id === sessionID ? sessionID : undefined)
      })
      .catch(() => {
        if (token !== exitSessionValidationToken) return
        setValidatedExitSessionID(undefined)
      })
  })

  createEffect(() => {
    const firstUser = messages().find((message) => message.role === "user")?.time.created
    const lastRootAssistant = rootLatestAssistant()
    const lastCompletedAssistant =
      rootMessages().findLast((message) => message.role === "assistant")?.time.completed ??
      lastRootAssistant?.time.completed
    const usage = topUsage()
    const continueID = validatedExitSessionID()
    return exit.message.set(
      renderSessionExitSummary({
        profile: mend.profile,
        width: dimensions().width,
        sessionTitle: session()?.title,
        sessionID: continueID,
        usage: {
          usage: usage?.tokens,
          compaction: usage?.contextLabel,
          model: usage?.model,
          provider: lastRootAssistant
            ? (providers().get(lastRootAssistant.providerID)?.name ?? lastRootAssistant.providerID)
            : undefined,
          agent: lastRootAssistant?.agent,
          elapsed:
            firstUser && lastCompletedAssistant
              ? formatDuration(Math.max(0, Math.round((lastCompletedAssistant - firstUser) / 1000)))
              : undefined,
        },
      }),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID || visible()) return
    if (keybind.match("app_exit", evt)) {
      void exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      if (direction === "prev") markScrollDetached()
      scrollBySession(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) {
      if (direction === "prev") markScrollDetached()
      scrollBySession(child.y - scroll.y - 1)
    }
    dialog.clear()
  }

  function toBottom(options?: { sync?: boolean; submitSessionID?: string }) {
    setFollowSessionOutput(true)
    scrollAnchor = undefined
    if (options?.sync !== false) void sync.session.sync(route.sessionID, { force: true }).catch(() => undefined)
    if (options?.submitSessionID) {
      scheduleSubmitBottomScroll(options.submitSessionID)
      return
    }
    scheduleBottomScroll(50, { force: true })
  }

  function cancelSubmitFollowSync() {
    submitFollowSyncToken += 1
    if (!submitFollowSyncTimer) return
    clearTimeout(submitFollowSyncTimer)
    submitFollowSyncTimer = undefined
  }

  function scheduleSubmitFollowSync(info: PromptSubmitInfo, delay = 160) {
    if (submitFollowSyncTimer) clearTimeout(submitFollowSyncTimer)
    const token = ++submitFollowSyncToken
    submitFollowSyncTimer = setTimeout(() => {
      submitFollowSyncTimer = undefined
      if (token !== submitFollowSyncToken) return
      if (route.sessionID !== info.sessionID) return
      if (messages().some((message) => message.id === info.messageID)) return
      void sync.session.sync(info.sessionID, { force: true }).finally(() => {
        if (token !== submitFollowSyncToken) return
        if (route.sessionID !== info.sessionID) return
        scheduleBottomScroll(0)
        if (messages().some((message) => message.id === info.messageID)) return
        if (delay < 900) scheduleSubmitFollowSync(info, 900)
      })
    }, delay)
  }

  function handlePromptSubmit(info?: PromptSubmitInfo) {
    trace.trace("prompt-submit", {
      sessionID: info?.sessionID,
      messageID: info?.messageID,
      inputRows: info?.inputRows,
      loadedIDs: messages().map((message) => message.id),
      follow: followSessionOutput(),
    })
    if (info && info.sessionID === route.sessionID) {
      setSubmittedUserMessageID(info.messageID)
      scheduleSubmitFollowSync(info)
    }
    toBottom({
      sync: false,
      submitSessionID: info?.sessionID === route.sessionID ? info.sessionID : undefined,
    })
  }

  onCleanup(() => {
    cancelSubmitFollowSync()
  })

  const virtualWindow = createMemo(() =>
    sessionMessageVirtualWindow({
      total: messages().length,
      scrollTop: sessionScrollTop(),
      viewportHeight: scroll && !scroll.isDestroyed ? scroll.height : dimensions().height,
      followOutput: followSessionOutput(),
    }),
  )
  const visibleMessages = createMemo(() => {
    const window = virtualWindow()
    return messages().slice(window.start, window.end)
  })

  createEffect(
    on(
      () =>
        [
          route.sessionID,
          messages().length,
          visibleMessages().length,
          virtualWindow().start,
          virtualWindow().end,
      ] as const,
      () => {
        trace.trace("virtual-window", {
          sessionID: route.sessionID,
          messageCount: messages().length,
          visibleCount: visibleMessages().length,
          start: virtualWindow().start,
          end: virtualWindow().end,
          scrollTop: sessionScrollTop(),
          follow: followSessionOutput(),
        })
        if (submitBottomScrollSessionID === route.sessionID) return
        if (followSessionOutput()) scheduleBottomScroll(0)
      },
      { defer: true },
    ),
  )

  const updateStickyUserHeader = () => {
    if (!stickyUserHeaderEnabled() || !scroll || scroll.isDestroyed) {
      setStickyUserMessageID(undefined)
      return
    }

    const byID = new Map(messages().map((message) => [message.id, message]))
    const top = scroll.y
    const userAnchors = scroll
      .getChildren()
      .map((child) => {
        const message = child.id ? byID.get(child.id) : undefined
        if (message?.role !== "user") return
        return { id: message.id, y: child.y }
      })
      .filter((item): item is { id: string; y: number } => Boolean(item))
      .sort((a, b) => a.y - b.y)

    const pinnedID = pinnedTurnUserMessageID()
    if (pinnedID) {
      const pinnedAnchor = userAnchors.find((item) => item.id === pinnedID)
      const pinnedIndex = messages().findIndex((message) => message.id === pinnedID)
      if (
        (typeof pinnedAnchor?.y === "number" && pinnedAnchor.y <= top) ||
        (pinnedIndex >= 0 && pinnedIndex < virtualWindow().start) ||
        (!pinnedAnchor && pinnedIndex >= 0 && followSessionOutput())
      ) {
        setStickyUserMessageID(pinnedID)
        return
      }
    }
    if (!configuredStickyUserHeaderEnabled()) {
      setStickyUserMessageID(undefined)
      return
    }
    setStickyUserMessageID(
      stickyUserIDFromVirtualWindow({
        messages: messages(),
        window: virtualWindow(),
        mountedUserAnchors: userAnchors,
        top,
        isUser: (message) => message.role === "user",
      }),
    )
  }

  createEffect(() => {
    if (!stickyUserHeaderEnabled()) {
      setStickyUserMessageID(undefined)
      return
    }
    const interval = setInterval(updateStickyUserHeader, 100)
    queueMicrotask(updateStickyUserHeader)
    onCleanup(() => clearInterval(interval))
  })

  const local = useLocal()

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
  }

  function moveLoop(direction: number) {
    const workflows = loopRootWorkflows()
    if (workflows.length <= 1) return
    let next = workflows.findIndex((workflow) => workflow.rootSessionID === route.sessionID) - direction
    if (next >= workflows.length) next = 0
    if (next < 0) next = workflows.length - 1
    const sessionID = workflows[next]?.rootSessionID
    if (sessionID) {
      navigate({
        type: "session",
        sessionID,
      })
    }
  }

  function navigateToLoopOwner(dialog: DialogContext) {
    const ownerSessionID = currentLoopWorkflow()?.ownerSessionID
    if (ownerSessionID) navigate({ type: "session", sessionID: ownerSessionID })
    else navigate({ type: "home" })
    dialog.clear()
  }

  function childSessionHandler(func: (dialog: DialogContext) => void) {
    return (dialog: DialogContext) => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func(dialog)
    }
  }

  const backgroundJSON = async <T,>(path: string, init?: RequestInit) => {
    const headers = new Headers(sdk.headers)
    if (init?.body) headers.set("content-type", "application/json")
    const response = await sdk.fetch(`${sdk.url}${path}`, {
      ...init,
      headers,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(text || `Background request failed: ${response.status}`)
    }
    return (await response.json()) as T
  }

  const currentBackgroundSession = async (sessionID: string) => {
    const items = await backgroundJSON<BackgroundWriterInfo[]>("/session/background")
    return items.find((item) => item.sessionID === sessionID)
  }

  const refreshLoopWorkflows = async () => {
    const loopItems = await backgroundJSON<SessionLoopWorkflow[]>("/loop").catch(() => [])
    setLoopSessionWorkflowsIfChanged(loopItems)
    return loopItems
  }

  const refreshLoopBackgroundSummary = async (sessionID: string) => {
    const info = await currentBackgroundSession(sessionID)
    if (route.sessionID !== sessionID) return
    const title = session()?.title
    const loopItems = await refreshLoopWorkflows()
    const workflow = loopItems.find((item) => item.rootSessionID === sessionID)
    if (workflow) {
      setLoopBackgroundSummary(`Loop ${formatLoopWorkflowState(workflow.state, workflow.phase ?? "ready")}`)
      return
    }
    const summary = info?.summary
    const isLoop = summary?.startsWith("Loop ") || title?.startsWith("Loop:")
    setLoopBackgroundSummary(isLoop ? (summary ?? title) : undefined)
  }

  const refreshBackgroundSessionState = async (sessionID: string) => {
    if (route.sessionID !== sessionID) return
    await refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
  }

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        setLoopBackgroundSummary(undefined)
        setLoopSessionWorkflows([])
        void refreshBackgroundSessionState(sessionID).catch(() => {
          if (route.sessionID !== sessionID) return
          void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
        })
        const loopPoll = setInterval(() => {
          void refreshLoopWorkflows()
            .then((items) => {
              if (route.sessionID !== sessionID) return
              const workflow = items.find((item) => item.rootSessionID === sessionID)
              if (workflow) {
                setLoopBackgroundSummary(`Loop ${formatLoopWorkflowState(workflow.state, workflow.phase ?? "ready")}`)
              }
            })
            .catch(() => undefined)
        }, 2_000)
        const unsubscribe = sdk.event.on("event", (event) => {
          const payload = event.payload as { type?: string; properties?: { sessionID?: string } }
          const type = payload.type
          if (type === "background_session.updated" || type === "background_session.deleted") {
            if (payload.properties?.sessionID && payload.properties.sessionID !== sessionID) return
            void refreshBackgroundSessionState(sessionID).catch(() => undefined)
            void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
            return
          }
          if (type?.startsWith("loop.")) {
            void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
          }
        })
        onCleanup(() => {
          clearInterval(loopPoll)
          unsubscribe()
        })
      },
    ),
  )

  async function backgroundCurrentSession(dialog?: DialogContext) {
    const status = sync.data.session_status?.[route.sessionID]
    const hasInput = permissions().length > 0 || questions().length > 0 || planReviews().length > 0
    const state =
      hasInput || status?.type === "retry" ? "needs_input" : status?.type === "busy" ? "working" : "completed"
    const headers = new Headers(sdk.headers)
    headers.set("content-type", "application/json")
    const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/background`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(text || `Background failed: ${response.status}`)
    }
    dialog?.clear()
    toast.show({
      variant: "info",
      message: "Session moved to Agent View.",
      duration: 3000,
    })
    navigate({ type: "home" })
  }

  const command = useCommandDialog()
  function fillSessionPrompt(value: string) {
    setTimeout(() => {
      prompt?.set({ input: value, parts: [] })
      prompt?.focus()
    }, 0)
  }

  function submitGeneratedSessionPrompt(value: string) {
    setTimeout(() => {
      prompt?.set({ input: value, parts: [] })
      setTimeout(() => void prompt?.submit(), 0)
    }, 0)
  }

  function submitLoopSlashPrompt(args: string) {
    const request = args.trim()
    submitGeneratedSessionPrompt(
      [
        request
          ? `Create or control a MendCode Loop Workflow for this request:\n${request}`
          : "Start a guided MendCode Loop Workflow setup for this session.",
        "",
        "Use exactly the `loop` tool, not shell commands. If the request already includes the objective, cadence, iteration limit, permission mode, and stop conditions, your first loop tool call must be action `activate`. Do not call `show` or `list` before creating the loop.",
        "If the request is to stop, remove, delete, pause, resume, or run the current loop and no loop id is visible, call the matching `loop` action without `workflowID`; the tool resolves the current session's contextual loop.",
        "Ask with the `question` tool only when a critical setting is missing: objective, iteration limit or unbounded mode, cadence, model/provider, max wall-clock runtime, permission mode, or stop condition.",
        'Default to report-only unless I explicitly allow edits. Spanish/English requests such as codear, implementar, fixear, editar, hacer cambios, probar, compilar, run tests, or build are explicit edit permission for the loop; use permissionMode `normal` or `custom`, set `reportOnly: false`, and keep safety gates for push/merge/release/destructive shell. If I choose a model and reasoning effort/variant, pass `model` as provider/model and pass the effort as `variant` (for example `variant: "medium"`), or use provider/model#variant. For interval cadence, set `triggerMode: "interval"` and convert the interval to `intervalMs`. Preserve the current session model by omitting `model` unless I choose one.',
        "Do not hand-render Markdown tables or duplicate status cards after the tool call. Let the Loop Workflow card render from tool metadata, then give a one-line confirmation.",
      ].join("\n"),
    )
  }

  command.register(() => [
    {
      title: "Permission mode",
      value: "session.permission.status",
      category: "Permissions",
      description: permissionModeDescription(),
      slash: {
        name: "permission",
        aliases: ["permissions", "approval"],
      },
      onSelect: () => {
        showPermissionMode()
      },
    },
    {
      title: configuredStickyUserHeaderEnabled() ? "Disable sticky user header" : "Enable sticky user header",
      value: "session.toggle.sticky_user_header",
      category: "Session",
      description: "Pin the latest user message below the top navbar.",
      onSelect: (dialog) => {
        void toggleStickyUserHeader().catch((error) => {
          toast.show({
            variant: "error",
            message: errorMessage(error),
            duration: 5000,
          })
        })
        dialog.clear()
      },
    },
    {
      title: showTodos() ? "Hide todos" : "Show todos",
      value: "session.toggle.todos",
      keybind: "todo_toggle",
      category: "Session",
      description: todos().length
        ? `${todos().filter((todo) => todo.status !== "completed").length} open todos`
        : "No todos in this session.",
      onSelect: (dialog) => {
        setShowTodos((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Create Loop Workflow",
      value: "session.loop.create",
      category: "Session",
      description: "Create or configure a monitored loop for this session.",
      slash: {
        name: "loop",
      },
      onSlash: (dialog, input) => {
        dialog.clear()
        submitLoopSlashPrompt(input.arguments)
      },
      onSelect: (dialog) => {
        dialog.clear()
        submitLoopSlashPrompt("")
      },
    },
    {
      title: "Detach to Agent View (/bg)",
      value: "session.background",
      category: "Session",
      description: "Send this session to Home Agent View as a worker and return home.",
      slash: {
        name: "bg",
        aliases: ["background", "detach"],
      },
      onSelect: (dialog) => {
        void backgroundCurrentSession(dialog).catch((error) => {
          toast.show({
            variant: "error",
            message: errorMessage(error),
            duration: 5000,
          })
        })
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) {
                markScrollDetached()
                scrollBySession(child.y - scroll.y - 1)
              }
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) {
                markScrollDetached()
                scrollBySession(child.y - scroll.y - 1)
              }
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Context usage",
      value: "session.context",
      category: "Context",
      description: topUsage()?.contextLabel ?? "Show token usage for this chat.",
      slash: {
        name: "context",
      },
      onSelect: (dialog) => {
        showContextUsage(dialog)
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const fullMessage = await sdk.client.session
          .message({ sessionID: route.sessionID, messageID: message.id })
          .catch(() => undefined)
        prompt?.set(restorePromptFromSubmittedParts(fullMessage?.data?.parts ?? sync.data.part[message.id] ?? []))
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showCompactedToolCalls()
        ? "Hide all tool calls in compacted history"
        : "Show all tool calls in compacted history",
      value: "session.toggle.compacted_tool_calls",
      category: "Session",
      description: showCompactedToolCalls()
        ? "Return to the lightweight compacted history view."
        : "Loads every historical tool call before compaction. Warning: this can use substantially more RAM.",
      onSelect: async (dialog) => {
        const enable = !showCompactedToolCalls()
        if (enable) {
          const confirmed = await DialogConfirm.show(
            dialog,
            "Show all compacted tool calls?",
            "This loads many additional historical messages and can substantially increase RAM usage. You can disable it again from Ctrl+P.",
          )
          if (!confirmed) return
        }
        setShowCompactedToolCalls(() => enable)
        dialog.clear()
        try {
          await sync.session.reloadMessages(route.sessionID)
        } catch (error) {
          setShowCompactedToolCalls(() => !enable)
          toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
          return
        }
        toBottom({ sync: false })
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        markScrollDetached()
        scrollBySession(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scrollBySession(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        markScrollDetached()
        scrollBySession(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scrollBySession(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        markScrollDetached()
        scrollBySession(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scrollBySession(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        markScrollDetached()
        scrollToSession(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        toBottom()
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) {
              markScrollDetached()
              scrollBySession(child.y - scroll.y - 1)
            }
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      keybind: "session_child_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || !!currentLoopWorkflow(),
      onSelect: (dialog) => {
        if (dialog.stack.length > 0) return
        if (!session()?.parentID && currentLoopWorkflow()) {
          navigateToLoopOwner(dialog)
          return
        }
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || loopRootWorkflows().length > 1,
      onSelect: (dialog) => {
        if (!session()?.parentID && currentLoopWorkflow()) {
          moveLoop(1)
          dialog.clear()
          return
        }
        if (!session()?.parentID || dialog.stack.length > 0) return
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID || loopRootWorkflows().length > 1,
      onSelect: (dialog) => {
        if (!session()?.parentID && currentLoopWorkflow()) {
          moveLoop(-1)
          dialog.clear()
          return
        }
        if (!session()?.parentID || dialog.stack.length > 0) return
        moveChild(-1)
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const agentCommandPanel = () => (
    <Show when={visibleAgentCommands().length > 0}>
      <box
        paddingLeft={contentInset()}
        paddingRight={contentInset()}
        width={insetRowWidth()}
        flexDirection="column"
        gap={0}
        flexShrink={0}
      >
        <text fg={theme.accent} wrapMode="none">
          ⟡ Commands
        </text>
        <For each={visibleAgentCommands()}>
          {(command) => {
            const incoming = command.targetSessionID === route.sessionID
            const actionable = incoming && isAgentViewCommandActionable(command)
            const busy = agentCommandBusyID() === command.id
            const compact = insetRowWidth() < 76
            const statusLine = () =>
              actionable ? (
                <box flexDirection="row" flexShrink={0}>
                  <text fg={theme.textMuted} wrapMode="none">
                    mouse:{" "}
                  </text>
                  <text
                    fg={busy ? theme.textMuted : theme.accent}
                    wrapMode="none"
                    onMouseUp={() => void updateAgentCommand(command, "accepted")}
                  >
                    [accept]
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {" "}
                  </text>
                  <text
                    fg={busy ? theme.textMuted : theme.error}
                    wrapMode="none"
                    onMouseUp={() => void updateAgentCommand(command, "rejected")}
                  >
                    [reject]
                  </text>
                </box>
              ) : (
                <text fg={theme.textMuted} wrapMode="none">
                  {command.state}
                </text>
              )
            return (
              <box
                width="100%"
                flexDirection="column"
                border={["left"]}
                customBorderChars={SplitBorder.customBorderChars}
                borderColor={actionable ? theme.accent : theme.backgroundPanel}
                paddingLeft={1}
                paddingTop={0}
                paddingBottom={0}
              >
                <box width="100%" flexDirection="row" overflow="hidden">
                  <text fg={incoming ? theme.text : theme.textMuted} wrapMode="none">
                    {incoming ? "in" : "sent"} · {formatAgentViewCommandSummary(command)}
                  </text>
                </box>
                <box width="100%" flexDirection={compact ? "column" : "row"} overflow="hidden">
                  <box width={compact ? "100%" : undefined} overflow="hidden">
                    <text fg={theme.textMuted} wrapMode="none">
                      {formatAgentViewCommandType(command)} ·{" "}
                      {incoming
                        ? `from ${Locale.truncate(command.sourceSessionID, compact ? 14 : 18)}`
                        : `to ${Locale.truncate(command.targetSessionID, compact ? 14 : 18)}`}
                    </text>
                  </box>
                  <Show when={!compact}>
                    <box flexGrow={1} minWidth={1} />
                  </Show>
                  {statusLine()}
                </box>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        providers,
        loopWorkflows: loopSessionWorkflows,
        refreshLoopWorkflows,
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexDirection="row" position="relative" width="100%">
        <Show when={planReviews().length > 0}>
          <PlanReviewPrompt request={planReviews()[0]} />
        </Show>
        <box
          width={contentWidth()}
          flexGrow={0}
          flexShrink={0}
          paddingBottom={1}
          paddingLeft={promptEdgeToEdge() ? 0 : 2}
          paddingRight={promptEdgeToEdge() ? 0 : 2}
          gap={1}
        >
          <Show when={session()}>
            <box width="100%" height={1} flexDirection="row" flexShrink={0}>
              <box width={topbarLayout().leftWidth} overflow="hidden" flexShrink={0} flexDirection="row" gap={1}>
                <box width={topbarLayout().pathWidth} overflow="hidden" flexShrink={0}>
                  <text fg={theme.textMuted} wrapMode="none">
                    {topbarLeftLabel()}
                  </text>
                </box>
                <Show when={topbarNavVisible() && topbarLayout().navWidth > 0}>
                  <box width={topbarLayout().navWidth} overflow="hidden" flexShrink={0}>
                    <SessionTopNav
                      mode={session()?.parentID ? "subagent" : "loop"}
                      canCycle={session()?.parentID ? true : loopRootWorkflows().length > 1}
                      hasParent={!!currentLoopWorkflow()?.ownerSessionID}
                    />
                  </box>
                </Show>
              </box>
              <Show when={headerTitleVisible()}>
                <box
                  width={topbarLayout().titleWidth}
                  flexShrink={0}
                  overflow="hidden"
                  justifyContent={headerTitleJustify()}
                >
                  <text fg={theme.textMuted} wrapMode="none">
                    {Locale.truncate(headerTitleText(), topbarLayout().titleWidth)}
                  </text>
                </box>
              </Show>
              <box flexGrow={1} minWidth={0} />
              <box width={topbarLayout().metricsWidth} overflow="hidden" flexShrink={0} justifyContent="flex-end">
                <SessionTopMetrics diff={topDiffStats()} usage={topUsage()} />
              </box>
            </box>
            <Show when={loopStatusLabel()}>
              {(label) => (
                <box
                  width="100%"
                  height={1}
                  flexDirection="row"
                  flexShrink={0}
                  paddingLeft={contentInset()}
                  paddingRight={contentInset()}
                  overflow="hidden"
                >
                  <text fg={theme.accent} wrapMode="none">
                    ↻ Loop
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {" "}
                    {label()}
                  </text>
                </box>
              )}
            </Show>
            {agentCommandPanel()}
            <box position="relative" flexGrow={1} width="100%">
              <For each={[transcriptRenderKey()]}>
                {() => (
                  <scrollbox
                    ref={(r) => (scroll = r)}
                    viewportOptions={{
                      paddingRight: showScrollbar() ? 1 : 0,
                    }}
                    verticalScrollbarOptions={{
                      paddingLeft: 1,
                      visible: showScrollbar(),
                      trackOptions: {
                        backgroundColor: theme.backgroundElement,
                        foregroundColor: theme.border,
                      },
                    }}
                    stickyScroll={followSessionOutput()}
                    stickyStart="bottom"
                    flexGrow={1}
                    width="100%"
                    scrollAcceleration={scrollAcceleration()}
                    onMouseScroll={() => markScrollDetached()}
                  >
                    <box height={1} />
                    <Show when={virtualWindow().topSpacer > 0}>
                      <box height={virtualWindow().topSpacer} flexShrink={0} />
                    </Show>
                    <For each={visibleMessages()}>
                      {(message, index) => (
                        <Switch>
                          <Match when={message.id === revert()?.messageID}>
                            {(function () {
                              const command = useCommandDialog()
                              const [hover, setHover] = createSignal(false)
                              const dialog = useDialog()

                              const handleUnrevert = async () => {
                                const confirmed = await DialogConfirm.show(
                                  dialog,
                                  "Confirm Redo",
                                  "Are you sure you want to restore the reverted messages?",
                                )
                                if (confirmed) {
                                  command.trigger("session.redo")
                                }
                              }

                              return (
                                <box
                                  onMouseOver={() => setHover(true)}
                                  onMouseOut={() => setHover(false)}
                                  onMouseUp={handleUnrevert}
                                  marginTop={1}
                                  flexShrink={0}
                                  border={["left"]}
                                  customBorderChars={SplitBorder.customBorderChars}
                                  borderColor={theme.backgroundPanel}
                                >
                                  <box
                                    paddingTop={1}
                                    paddingBottom={1}
                                    paddingLeft={2}
                                    backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                                  >
                                    <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                    <text fg={theme.textMuted}>
                                      <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo
                                      to restore
                                    </text>
                                    <Show when={revert()!.diffFiles?.length}>
                                      <box marginTop={1}>
                                        <For each={revert()!.diffFiles}>
                                          {(file) => (
                                            <text fg={theme.text}>
                                              {file.filename}
                                              <Show when={file.additions > 0}>
                                                <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                              </Show>
                                              <Show when={file.deletions > 0}>
                                                <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                              </Show>
                                            </text>
                                          )}
                                        </For>
                                      </box>
                                    </Show>
                                  </box>
                                </box>
                              )
                            })()}
                          </Match>
                          <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                            <></>
                          </Match>
                          <Match when={message.role === "user"}>
                            <UserMessage
                              index={virtualWindow().start + index()}
                              onMouseUp={() => {
                                if (renderer.getSelection()?.getSelectedText()) return
                                dialog.replace(() => (
                                  <DialogMessage
                                    messageID={message.id}
                                    sessionID={route.sessionID}
                                    setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                                  />
                                ))
                              }}
                              message={message as UserMessage}
                              parts={sync.data.part[message.id] ?? []}
                              pending={pending()}
                              onSendNow={() => void sendQueuedNow(message.id)}
                              sendNowPending={sendNowMessageID() === message.id}
                              simpleHistory={
                                !showCompactedToolCalls() &&
                                shouldUseSimpleSessionHistory({
                                  messageID: message.id,
                                  fullStartID: fullHistoryStartID(),
                                })
                              }
                              compactSubagentPrompt={Boolean(session()?.parentID)}
                            />
                          </Match>
                          <Match when={message.role === "assistant"}>
                            <AssistantMessage
                              last={lastAssistant()?.id === message.id}
                              message={message as AssistantMessage}
                              parts={sync.data.part[message.id] ?? []}
                              simpleHistory={
                                !showCompactedToolCalls() &&
                                shouldUseSimpleSessionHistory({
                                  messageID: message.id,
                                  fullStartID: fullHistoryStartID(),
                                })
                              }
                            />
                          </Match>
                        </Switch>
                      )}
                    </For>
                    <Show when={virtualWindow().bottomSpacer > 0}>
                      <box height={virtualWindow().bottomSpacer} flexShrink={0} />
                    </Show>
                  </scrollbox>
                )}
              </For>
              <Show when={stickyUserHeaderEnabled() && stickyUserMessage()}>
                {(message) => (
                  <box position="absolute" top={0} left={0} right={showScrollbar() ? 1 : 0} zIndex={1000}>
                    <UserMessage
                      index={0}
                      message={message()}
                      parts={sync.data.part[message().id] ?? []}
                      pending={pending()}
                      onSendNow={() => void sendQueuedNow(message().id)}
                      sendNowPending={sendNowMessageID() === message().id}
                      sticky
                      simpleHistory={false}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        dialog.replace(() => (
                          <DialogMessage
                            messageID={message().id}
                            sessionID={route.sessionID}
                            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                          />
                        ))
                      }}
                    />
                  </box>
                )}
              </Show>
            </box>
            <box flexShrink={0} width="100%">
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={showSessionBottomDock()}>
                <SessionBottomDock
                  todos={todos()}
                  subagents={subagents()}
                  width={contentWidth()}
                  sessionID={route.sessionID}
                  onOpenSubagent={(sessionID) => navigate({ type: "session", sessionID })}
                  info={{
                    branch: topBranchLabel(),
                    cwd: topPathLabel(),
                    model: (() => {
                      const model = local.model.current()
                      return model ? Model.name(providers(), model.providerID, model.modelID) : "model unset"
                    })(),
                    context: topUsage()?.contextLabel ?? "context n/a",
                    status:
                      permissionPendingCount() > 0
                        ? `${permissionPendingCount()} permission`
                        : pending()
                          ? "assistant active"
                          : "idle",
                    permission: permissionModeLabel(),
                  }}
                />
              </Show>
              <For each={listMendWidgets("aboveEditor")}>{(item) => <RenderMendWidget item={item} />}</For>
              <Show when={visible()}>
                <box position="relative" zIndex={2500} overflow="visible" width="100%">
                  <TuiPluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={promptDisabled()}
                    on_submit={handlePromptSubmit}
                    ref={bind}
                  >
                    {
                      renderMendEditor({
                        sessionID: route.sessionID,
                        permissionMode: permissionMode(),
                        permissionModeLabel: permissionModeLabel(),
                        permissionPending: permissionPendingCount(),
                        visible: visible(),
                        disabled: promptDisabled(),
                        ref: bind,
                        onSubmit: handlePromptSubmit,
                        right: <TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />,
                        defaultEditor: () => (
                          <Prompt
                            visible={visible()}
                            ref={bind}
                            disabled={promptDisabled()}
                            historyScope={`session:${route.sessionID}`}
                            historyItems={sessionPromptHistory}
                            workspaceID={project.workspace.current()}
                            sessionID={route.sessionID}
                            permissionMode={permissionMode()}
                            permissionModeLabel={permissionModeLabel()}
                            permissionPending={permissionPendingCount()}
                            onSubmit={handlePromptSubmit}
                            right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                          />
                        ),
                      }) as any
                    }
                  </TuiPluginRuntime.Slot>
                </box>
              </Show>
              <For each={listMendWidgets("belowEditor")}>{(item) => <RenderMendWidget item={item} />}</For>
            </box>
          </Show>
          <Toast />
        </box>
      </box>
    </context.Provider>
  )
}

function SessionTopMetrics(props: { diff?: GitDiffStats; usage?: ReturnType<typeof formatAssistantUsage> }) {
  const { theme } = useTheme()
  const hasDiff = createMemo(() => Boolean(props.diff))
  const diffLabel = createMemo(() => (props.diff ? sessionDiffStatsLabel(props.diff) : ""))

  return (
    <box flexDirection="row" flexShrink={0}>
      <Show when={props.diff}>
        <text wrapMode="none">
          <span style={{ fg: theme.diffAdded }}>{diffLabel().split(" ")[0]}</span>
          <span style={{ fg: theme.textMuted }}> </span>
          <span style={{ fg: theme.diffRemoved }}>{diffLabel().split(" ")[1]}</span>
        </text>
      </Show>
      <Show when={props.usage}>
        {(usage) => (
          <box flexDirection="row" flexShrink={0}>
            <Show when={hasDiff()}>
              <text fg={theme.textMuted} wrapMode="none">
                {" | "}
              </text>
            </Show>
            <SessionUsageBar
              context={usage().context}
              contextPercent={usage().contextPercent}
              contextLimit={usage().contextLimit}
            />
          </box>
        )}
      </Show>
    </box>
  )
}

function SessionTopNav(props: { mode: "subagent" | "loop"; canCycle?: boolean; hasParent?: boolean }) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const item = (
    id: "parent" | "prev" | "next",
    icon: string,
    label: string,
    key: string,
    commandID: "session.parent" | "session.child.previous" | "session.child.next",
  ) => (
    <box
      flexShrink={0}
      onMouseOver={() => setHover(id)}
      onMouseOut={() => setHover(null)}
      onMouseUp={() => command.trigger(commandID)}
      backgroundColor={hover() === id ? theme.backgroundElement : theme.background}
    >
      <text fg={theme.text} wrapMode="none">
        {icon} {label} <span style={{ fg: theme.textMuted }}>{keybind.print(key)}</span>
      </text>
    </box>
  )

  return (
    <box flexDirection="row" flexShrink={0} gap={2}>
      {item(
        "parent",
        "↖",
        props.mode === "loop" ? (props.hasParent ? "Parent" : "Agent View") : "Parent",
        "session_parent",
        "session.parent",
      )}
      <Show when={props.mode === "subagent" || props.canCycle}>
        {item(
          "prev",
          "←",
          props.mode === "loop" ? "Prev loop" : "Prev",
          "session_child_cycle_reverse",
          "session.child.previous",
        )}
        {item("next", "→", props.mode === "loop" ? "Next loop" : "Next", "session_child_cycle", "session.child.next")}
      </Show>
    </box>
  )
}

function SessionUsageBar(props: { context: number; contextLimit?: number; contextPercent?: number }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const width = 8
  const labels = createMemo(() => sessionUsageBarLabels(props))
  const percent = createMemo(() => {
    return labels().percent
  })
  const filledCells = createMemo(() => {
    if (percent() === undefined) return 0
    if (percent()! <= 0) return 0
    return Math.max(1, Math.min(width, Math.round((percent()! / 100) * width)))
  })
  const emptyCells = createMemo(() => Math.max(0, width - filledCells()))
  const compactLabel = createMemo(() => labels().compactLabel)
  const displayWidth = createMemo(() => labels().displayWidth)
  const barPad = createMemo(() => " ".repeat(Math.max(0, displayWidth() - labels().barWidth)))
  const hoverLabel = createMemo(() => Locale.truncateMiddle(labels().detailLabel, displayWidth()))
  const hoverText = createMemo(() => {
    const label = hoverLabel()
    const pad = Math.max(0, displayWidth() - label.length)
    const left = Math.floor(pad / 2)
    return `${" ".repeat(left)}${label}${" ".repeat(pad - left)}`
  })

  return (
    <box
      width={displayWidth()}
      justifyContent="flex-start"
      flexDirection="row"
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <Show
        when={!hover()}
        fallback={
          <text wrapMode="none">
            <span style={{ fg: theme.textMuted }}>{hoverText()}</span>
          </text>
        }
      >
        <text wrapMode="none">
          <Show when={percent() !== undefined}>
            <span style={{ fg: theme.textMuted }}>{barPad()}</span>
            <span style={{ bg: theme.text }}>{" ".repeat(filledCells())}</span>
            <span style={{ bg: theme.backgroundElement }}>{" ".repeat(emptyCells())}</span>
            <span style={{ fg: theme.textMuted }}> </span>
          </Show>
          <span style={{ fg: theme.textMuted }}>{compactLabel()}</span>
        </text>
      </Show>
    </box>
  )
}

type SessionBottomInfo = {
  branch: string
  cwd: string
  model: string
  context: string
  status: string
  permission: string
}

type SessionSubagentInfo = {
  id: string
  label: string
  description: string
  status: string
  meta?: string
  detail?: string
  updated: string
  updatedAt: number
  active: boolean
}

function sessionLiveStateLabel(input: {
  status?: { type: string; attempt?: number; message?: string }
  messages: Message[]
  pendingInputCount: number
}) {
  if (input.pendingInputCount > 0) return "needs input"
  if (input.status?.type === "retry")
    return input.status.attempt && input.status.attempt > 1 ? `retry #${input.status.attempt}` : "retrying"
  if (input.status?.type === "busy") return "working"
  const lastUser = input.messages.findLast((message) => message.role === "user")
  const lastAssistant = input.messages.findLast((message) => message.role === "assistant")
  if (lastAssistant && !lastAssistant.time.completed) return "working"
  if (lastUser && (!lastAssistant || lastAssistant.time.created < lastUser.time.created)) return "waiting"
  if (lastAssistant) return "responded"
  return "ready"
}

function sessionSubagentIsActive(status: string) {
  return status === "working" || status === "waiting" || status === "needs input" || status.startsWith("retry")
}

export function sessionHasLocalQueuedTurn(input: {
  messages: Array<Pick<Message, "id">>
  pendingAssistantID?: string
}) {
  const pendingAssistantID = input.pendingAssistantID
  if (!pendingAssistantID) return false
  return input.messages.some((message) => message.id > pendingAssistantID)
}

export function shouldRestoreSessionScrollAnchor(input: {
  now: number
  manualScrollGraceUntil: number
  userMovedViewport: boolean
  hasAnchor: boolean
}) {
  if (!input.hasAnchor) return false
  if (input.now < input.manualScrollGraceUntil) return false
  return !input.userMovedViewport
}

export function shouldReleaseSessionPagingBoundarySuppression(input: {
  boundary: "top" | "bottom"
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  releaseDistance?: number
}) {
  const maxScrollTop = Math.max(0, input.scrollHeight - input.viewportHeight)
  if (maxScrollTop <= 0) return false
  const releaseDistance = Math.min(
    input.releaseDistance ?? Math.max(10, Math.floor(input.viewportHeight / 2)),
    maxScrollTop,
  )
  if (input.boundary === "top") return input.scrollTop >= releaseDistance
  return maxScrollTop - input.scrollTop >= releaseDistance
}

export function sessionUserPromptHistory(input: {
  messages: ReadonlyArray<Pick<Message, "id" | "role">>
  partsByMessage: Record<string, readonly { type: string }[] | undefined>
}) {
  return input.messages.flatMap((message) => {
    if (message.role !== "user") return []
    const prompt = restorePromptFromSubmittedParts(
      (input.partsByMessage[message.id] ?? []).filter(
        (part) => part.type === "text" || part.type === "file" || part.type === "agent",
      ),
    )
    if (prompt.input.length === 0 && prompt.parts.length === 0) return []
    return [prompt]
  })
}

export function latestFullSessionHistoryStartID(
  messages: Array<{
    id: string
    role: string
    parentID?: string
    summary?: unknown
    time: { created?: number; completed?: number }
  }>,
) {
  const latestCompactionSummary = messages.findLast(
    (message) => message.role === "assistant" && message.summary === true && message.time.completed !== undefined,
  )
  return latestCompactionSummary?.id
}

export function sessionTranscriptRenderKey(sessionID: string) {
  return sessionID
}

export function shouldUseSimpleSessionHistory(input: { messageID: string; fullStartID?: string }) {
  return Boolean(input.fullStartID && input.messageID < input.fullStartID)
}

function dockWidgetWidth(item: MendWidgetEntry) {
  if (typeof item.width === "number") return Math.max(1, item.width)
  return undefined
}

function dockWidgetHeight(item: MendWidgetEntry, fallback: number) {
  if (typeof item.height === "number") return Math.max(1, Math.min(fallback, item.height))
  return fallback
}

function dockWidgetsMinWidth(items: MendWidgetEntry[]) {
  if (!items.length) return 0
  return items.reduce((total, item, index) => {
    const width = typeof item.width === "number" ? item.width : (item.minWidth ?? 18)
    return total + Math.max(1, width) + (index > 0 ? 1 : 0)
  }, 0)
}

function fixedWidgetLine(value: string, width: number) {
  const normalized = value.replace(/\t/g, "  ")
  const truncated = Locale.truncate(normalized, width)
  const padding = Math.max(0, width - Bun.stringWidth(truncated))
  return truncated + " ".repeat(padding)
}

function RenderMendWidget(props: { item: MendWidgetEntry }) {
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  let container: BoxRenderable | undefined
  let notifiedVisible = false
  const [widgetError, setWidgetError] = createSignal<string | undefined>()
  const rendered = createMemo(() => {
    try {
      setWidgetError(undefined)
      return props.item.render(mendWidgetRenderContext(props.item)) as unknown
    } catch (err) {
      setWidgetError(errorMessage(err))
      return undefined
    }
  })
  const primitive = createMemo(() => {
    if (widgetError()) return `Widget error · ${widgetError()}`
    const value = rendered()
    if (typeof value === "string" || typeof value === "number") return String(value)
    if (typeof value === "boolean") return value ? "true" : ""
    return undefined
  })
  const primitiveWidth = createMemo(() => {
    if (typeof props.item.width === "number") return Math.max(1, props.item.width)
    return Math.max(1, props.item.maxWidth ?? props.item.minWidth ?? 120)
  })
  const primitiveHeight = createMemo(() => {
    if (typeof props.item.height === "number") return Math.max(1, props.item.height)
    return undefined
  })
  const primitiveLines = createMemo(() => {
    const lines = (primitive() ?? "").split(/\r?\n/)
    const height = primitiveHeight()
    const visible = height ? lines.slice(0, height) : lines
    return visible.map((line) => fixedWidgetLine(line, primitiveWidth()))
  })
  const focused = createMemo(() => readFocusedMendWidgetID() === props.item.id)
  createEffect(() => {
    if (!notifiedVisible) {
      notifiedVisible = true
      notifyMendWidgetVisible(props.item.id)
    }
    if (!focused()) return
    container?.focus()
  })

  function leaveWidget(event?: { preventDefault?: () => void; stopPropagation?: () => void }) {
    blurMendWidget(props.item.id)
    promptRef.current?.focus()
    event?.preventDefault?.()
    event?.stopPropagation?.()
  }

  const fallback = (error: unknown) => {
    const message = errorMessage(error)
    console.error("[tui.widget] render error", {
      id: props.item.id,
      placement: props.item.placement,
      message,
    })
    return (
      <box width="100%" height="100%" paddingLeft={1} paddingRight={1} overflow="hidden">
        <text fg={theme.error} wrapMode="none">
          {fixedWidgetLine(`Widget error · ${message}`, primitiveWidth())}
        </text>
      </box>
    )
  }

  return (
    <box
      width="100%"
      height="100%"
      overflow="hidden"
      border={focused() ? ["left"] : undefined}
      borderColor={focused() ? theme.borderActive : undefined}
      ref={(value: BoxRenderable) => {
        container = value
      }}
      onMouseDown={(event) => {
        if (!props.item.interactive) return
        focusMendWidget(props.item.id)
        event.target?.focus()
      }}
      onKeyDown={(event) => {
        if (!props.item.interactive) return
        if (event.name === "escape") {
          leaveWidget(event)
          return
        }
        let handled = false
        try {
          handled = !!props.item.onKey?.(event)
        } catch {
          leaveWidget(event)
          return
        }
        if (!handled) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <ErrorBoundary fallback={fallback}>
        <Show when={primitive() !== undefined} fallback={rendered() as JSX.Element}>
          <box flexDirection="column" width="100%" height="100%" overflow="hidden">
            <For each={primitiveLines()}>
              {(line) => (
                <box height={1} width="100%" overflow="hidden">
                  <text width="100%" wrapMode="none" selectable={false}>
                    {line}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </ErrorBoundary>
    </box>
  )
}

function SessionBottomDock(props: {
  todos: SessionTodo[]
  subagents: SessionSubagentInfo[]
  width: number
  sessionID: string
  info: SessionBottomInfo
  onOpenSubagent: (sessionID: string) => void
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dockWidgets = createMemo(() => listMendWidgets("sessionBottomDock"))
  const builtinDockWidgetIDs = ["todo", "notes", "subagents", "info"]
  const profileControlsBuiltins = createMemo(() => {
    const widgets = mend.profile.widgets
    return builtinDockWidgetIDs.some(
      (id) =>
        widgets.enabled.includes(id) ||
        widgets.order.includes(id) ||
        widgets.config[id]?.surface === "sessionBottomDock",
    )
  })
  const builtinDockEnabled = (id: string) => {
    if (!profileControlsBuiltins()) return true
    return mend.profile.widgets.enabled.includes(id)
  }
  const layout = createMemo(() =>
    sessionBottomDockLayout({
      todos: props.todos,
      width: props.width,
      subagentCount: props.subagents.length,
      customDockMinWidth: dockWidgetsMinWidth(dockWidgets()),
      enabled: {
        notes: builtinDockEnabled("notes"),
        subagents: builtinDockEnabled("subagents"),
        info: builtinDockEnabled("info"),
      },
    }),
  )

  return (
    <box flexShrink={0} width="100%" paddingBottom={1}>
      <box
        width={layout().dockWidth}
        height={layout().dockHeight}
        flexDirection="row"
        gap={1}
        alignItems="stretch"
        overflow="hidden"
      >
        <SessionTodoPanel todos={props.todos} width={layout().todoWidth} height={layout().dockHeight} />
        <Show when={layout().showNotes}>
          <SessionNotesWidget sessionID={props.sessionID} width={layout().notesWidth} height={layout().dockHeight} />
        </Show>
        <Show when={layout().showSubagents}>
          <SessionSubagentsWidget
            subagents={props.subagents}
            width={layout().subagentsWidth}
            height={layout().dockHeight}
            onOpen={props.onOpenSubagent}
          />
        </Show>
        <Show when={layout().showInfo}>
          <SessionInfoWidget info={props.info} width={layout().infoWidth} height={layout().dockHeight} />
        </Show>
        <For each={dockWidgets()}>
          {(item) => (
            <box
              flexShrink={item.width === "auto" ? 1 : 0}
              width={dockWidgetWidth(item)}
              minWidth={item.minWidth ?? 18}
              maxWidth={item.maxWidth}
              height={dockWidgetHeight(item, layout().dockHeight)}
              overflow="hidden"
              backgroundColor={theme.backgroundPanel}
            >
              <RenderMendWidget item={item} />
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

function SessionDockHeader(props: { title: string; right?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
      <text fg={theme.textMuted} wrapMode="none">
        {props.title}
      </text>
      <Show when={props.right}>
        {(right) => (
          <text fg={theme.textMuted} wrapMode="none">
            {right()}
          </text>
        )}
      </Show>
    </box>
  )
}

function SessionNotesWidget(props: { sessionID: string; width: number; height: number }) {
  const { theme } = useTheme()
  const kv = useKV()
  const promptRef = usePromptRef()
  const textareaKeybindings = useTextareaKeybindings()
  let textarea: TextareaRenderable | undefined
  const key = createMemo(() => `session_notes:${props.sessionID}`)
  const [note, setNote] = createSignal(kv.get(key(), ""))
  const [noteScrollY, setNoteScrollY] = createSignal(0)
  const textareaHeight = createMemo(() => Math.max(1, props.height - 3))
  const noteRows = createMemo(() => {
    const contentWidth = Math.max(1, props.width - 5)
    const lines = note().split("\n")
    return Math.max(
      1,
      lines.reduce((total: number, line: string) => total + Math.max(1, Math.ceil(line.length / contentWidth)), 0),
    )
  })
  const noteVirtualRows = createMemo(() => Math.max(noteRows(), textarea?.virtualLineCount ?? 0))
  const noteOverflow = createMemo(() => noteVirtualRows() > textareaHeight())
  const noteScrollThumb = createMemo(() => {
    const maxScroll = Math.max(1, noteVirtualRows() - textareaHeight())
    return Math.max(0, Math.min(textareaHeight() - 1, Math.round((noteScrollY() / maxScroll) * (textareaHeight() - 1))))
  })
  const noteKeybindings = createMemo(() =>
    textareaKeybindings().map((binding) =>
      binding.action === "submit" ? { ...binding, action: "newline" as const } : binding,
    ),
  )

  function leaveNotes() {
    textarea?.blur()
    promptRef.current?.focus()
  }

  createEffect(
    on(
      key,
      (nextKey) => {
        const next = kv.get(nextKey, "")
        setNote(next)
        textarea?.setText(next)
      },
      { defer: true },
    ),
  )

  return (
    <box
      width={props.width}
      height={props.height}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
      onMouseDown={(event) => event.target?.focus()}
    >
      <SessionDockHeader title="Notes" right={note().trim() ? "saved" : "scratch"} />
      <box flexDirection="row" height={textareaHeight()} width="100%">
        <textarea
          height={textareaHeight()}
          width={noteOverflow() ? Math.max(1, props.width - 5) : "100%"}
          initialValue={note()}
          placeholder="Private note"
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          keyBindings={noteKeybindings()}
          ref={(value: TextareaRenderable) => {
            textarea = value
          }}
          onMouseDown={(event) => event.target?.focus()}
          onCursorChange={() => {
            setNoteScrollY(textarea?.scrollY ?? 0)
          }}
          onKeyDown={(event) => {
            if (event.name !== "escape") return
            event.preventDefault()
            leaveNotes()
          }}
          onContentChange={() => {
            const next = textarea?.plainText ?? ""
            setNote(next)
            setNoteScrollY(textarea?.scrollY ?? 0)
            kv.set(key(), next)
          }}
        />
        <Show when={noteOverflow()}>
          <box width={1} height={textareaHeight()} flexShrink={0}>
            <For each={Array.from({ length: textareaHeight() })}>
              {(_, index) => (
                <text
                  wrapMode="none"
                  renderBefore={() => {
                    setNoteScrollY(textarea?.scrollY ?? 0)
                  }}
                >
                  <span style={{ bg: index() === noteScrollThumb() ? theme.textMuted : theme.backgroundPanel }}> </span>
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}

function SessionInfoWidget(props: { info: SessionBottomInfo; width: number; height: number }) {
  const { theme } = useTheme()
  const row = (label: string, value: string) => (
    <text fg={theme.textMuted} wrapMode="none">
      {label}{" "}
      <span style={{ fg: theme.text }}>
        {Locale.truncateMiddle(value, Math.max(8, props.width - label.length - 5))}
      </span>
    </text>
  )

  return (
    <box
      width={props.width}
      height={props.height}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
    >
      <SessionDockHeader title="Info" right={props.info.status} />
      {row("git", props.info.branch)}
      {row("cwd", props.info.cwd)}
      {row("ctx", props.info.context)}
      {row("perm", props.info.permission)}
      {row("model", props.info.model)}
    </box>
  )
}

function SessionSubagentsWidget(props: {
  subagents: SessionSubagentInfo[]
  width: number
  height: number
  onOpen: (sessionID: string) => void
}) {
  const { theme } = useTheme()
  const spacious = createMemo(() => props.width >= 48 && props.subagents.length <= 2)
  const rowHeight = createMemo(() => (spacious() ? 2 : 1))
  const visibleRows = createMemo(() => Math.max(1, Math.floor((props.height - 3) / rowHeight())))
  const visible = createMemo(() => props.subagents.slice(0, visibleRows()))
  const hidden = createMemo(() => Math.max(0, props.subagents.length - visibleRows()))
  const statusWidth = 11
  const labelWidth = createMemo(() => Math.max(8, props.width - statusWidth - 8))
  const detailWidth = createMemo(() => Math.max(8, props.width - 9))
  const color = (status: string) => {
    if (status === "working" || status.startsWith("retry")) return theme.warning
    if (status === "needs input") return theme.error
    if (status === "waiting") return theme.info
    if (status === "responded") return theme.success
    return theme.textMuted
  }

  return (
    <box
      width={props.width}
      height={props.height}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
    >
      <SessionDockHeader title="Subagents" right={Locale.number(props.subagents.length)} />
      <Show
        when={props.subagents.length > 0}
        fallback={
          <box height={1} paddingLeft={2}>
            <text fg={theme.textMuted} wrapMode="none">
              No subagents.
            </text>
          </box>
        }
      >
        <For each={visible()}>
          {(item) => (
            <box
              flexDirection="column"
              gap={0}
              width="100%"
              backgroundColor={item.active ? theme.backgroundElement : theme.backgroundPanel}
              onMouseUp={() => props.onOpen(item.id)}
            >
              <box flexDirection="row" gap={1} width="100%">
                <text fg={color(item.status)} flexShrink={0} wrapMode="none">
                  {item.active ? ">" : "•"}
                </text>
                <text fg={theme.text} flexGrow={1} wrapMode="none">
                  {Locale.truncateMiddle(`${item.label} ${item.description}`, labelWidth())}
                </text>
                <text fg={color(item.status)} flexShrink={0} wrapMode="none">
                  {Locale.truncateMiddle(item.status, statusWidth)}
                </text>
              </box>
              <Show when={spacious() && (item.detail || item.meta || item.updated)}>
                <text fg={theme.textMuted} wrapMode="none">
                  {Locale.truncateMiddle(`  ${item.detail ?? item.meta ?? item.updated}`, detailWidth())}
                </text>
              </Show>
            </box>
          )}
        </For>
        <Show when={hidden() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            +{Locale.number(hidden())} more
          </text>
        </Show>
      </Show>
    </box>
  )
}

function SessionTodoPanel(props: { todos: SessionTodo[]; width: number; height: number }) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const visibleRows = createMemo(() => Math.max(1, props.height - 3))
  const open = createMemo(() => props.todos.filter((todo) => todo.status !== "completed").length)
  const panelWidth = createMemo(() => {
    return sessionTodoPanelWidth({
      todos: props.todos,
      maxWidth: props.width,
      expanded: false,
      collapsedLimit: visibleRows(),
    })
  })
  const scrollable = createMemo(() => props.todos.length > visibleRows())
  const color = (status: string) => {
    if (status === "completed") return theme.textMuted
    if (status === "in_progress") return theme.warning
    if (status === "cancelled") return theme.error
    return theme.text
  }

  return (
    <box flexShrink={0} width={panelWidth()} height={props.height}>
      <box
        width={panelWidth()}
        height={props.height}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
          <text fg={theme.textMuted} wrapMode="none">
            Todos
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {Locale.number(open())} open
          </text>
        </box>
        <Show
          when={props.todos.length > 0}
          fallback={
            <box height={1} paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                No todo items.
              </text>
            </box>
          }
        >
          <scrollbox
            height={visibleRows()}
            scrollAcceleration={scrollAcceleration()}
            verticalScrollbarOptions={{
              visible: scrollable(),
              trackOptions: {
                backgroundColor: theme.backgroundPanel,
                foregroundColor: theme.textMuted,
              },
            }}
          >
            <For each={props.todos}>
              {(todo) => (
                <box flexDirection="row" gap={1} width="100%" backgroundColor={theme.backgroundPanel}>
                  <text fg={color(todo.status)} flexShrink={0} wrapMode="none">
                    {sessionTodoIcon(todo.status)}
                  </text>
                  <text fg={color(todo.status)} wrapMode="none" flexGrow={1}>
                    {todo.content}
                  </text>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
    </box>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function CompactionCard(props: {
  part: Extract<Part, { type: "compaction" }>
  summaryPreview?: string
  transcriptPreview?: string
  modelOutputText?: string
  modelReasoningText?: string
  modelDetailLabel?: string
  editableScratchpad?: boolean
}) {
  const sdk = useSDK()
  const mend = useMendTuiProfile()
  const scratchpadAllowed = createMemo(
    () => props.editableScratchpad || mend.profile.presentation.compaction.allowScratchpad,
  )
  const summaryPreview = createMemo(() => compactionSummaryPreview(props.summaryPreview, 360))
  const transcriptPreview = createMemo(() => compactPreviewLine(props.transcriptPreview, 180))
  return (
    <CompactionPanel
      reason={props.part.auto ? "auto" : "manual"}
      overflow={props.part.overflow}
      resume={props.part.resume}
      postPrompt={props.part.post_prompt}
      tailStartID={props.part.tail_start_id}
      hasSummaryBody={Boolean(summaryPreview())}
      summaryPreview={summaryPreview()}
      transcriptPreview={transcriptPreview()}
      modelOutputText={props.modelOutputText}
      modelReasoningText={props.modelReasoningText}
      modelDetailLabel={props.modelDetailLabel}
      scratchpad={
        scratchpadAllowed()
          ? {
              key: props.part.id,
              initialValue: props.part.post_prompt ?? "",
              readOnly: !props.editableScratchpad,
              onSave: props.editableScratchpad
                ? async (value) => {
                    await sdk.client.part.update(
                      {
                        sessionID: props.part.sessionID,
                        messageID: props.part.messageID,
                        partID: props.part.id,
                        part: {
                          ...props.part,
                          post_prompt: value.trim() || undefined,
                        },
                      },
                      { throwOnError: true },
                    )
                  }
                : undefined,
              note: "Saved. It will send after compaction.",
            }
          : undefined
      }
    />
  )
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
  onSendNow?: () => void
  sendNowPending?: boolean
  sticky?: boolean
  simpleHistory?: boolean
  compactSubagentPrompt?: boolean
}) {
  const local = useLocal()
  const sync = useSync()
  const [expandedText, setExpandedText] = createSignal(false)
  const [expandedOffset, setExpandedOffset] = createSignal(0)
  const [expandedPaste, setExpandedPaste] = createSignal(false)
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const pastedContentParts = createMemo(() =>
    props.parts.filter((part) => isPastedContentPart(part)).map((part) => part as PastedContentDisplayPart),
  )
  const fullText = createMemo(() => {
    if (!expandedPaste()) return text()
    return expandPastedContentPlaceholders(text(), pastedContentParts())
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() =>
    sessionUserMessageQueued({
      messageID: props.message.id,
      pendingAssistantID: props.pending,
      messages: sync.data.message[props.message.sessionID] ?? [],
    }),
  )
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const sendNowBackground = createMemo(() => (props.sendNowPending ? theme.backgroundElement : theme.accent))
  const sendNowForeground = createMemo(() => selectedForeground(theme, sendNowBackground()))
  const subagentInitialPrompt = createMemo(() => props.compactSubagentPrompt && props.index === 0)
  const collapsedDisplayText = createMemo(() =>
    userMessageDisplayText(
      fullText(),
      props.sticky || props.simpleHistory
        ? { maxLines: 4, maxChars: 600 }
        : subagentInitialPrompt()
          ? { maxLines: 8, maxChars: 1000 }
          : undefined,
    ),
  )
  const effectiveExpandedText = createMemo(() => !props.sticky && !props.simpleHistory && expandedText())
  const expandedViewportRows = createMemo(() => Math.max(6, Math.min(18, Math.floor(dimensions().height * 0.3))))
  const expandedLines = createMemo(() => fullText().split("\n"))
  const expandedMaxOffset = createMemo(() => Math.max(0, expandedLines().length - expandedViewportRows()))
  const expandedWindow = createMemo(() => {
    const max = expandedMaxOffset()
    const offset = Math.min(expandedOffset(), max)
    const rows = expandedViewportRows()
    const lines = expandedLines()
    const visible = lines.slice(offset, offset + rows).join("\n")
    return {
      text: visibleUserMessageText(visible),
      offset,
      rows,
      total: lines.length,
      end: Math.min(lines.length, offset + rows),
      hasBefore: offset > 0,
      hasAfter: offset + rows < lines.length,
    }
  })
  const displayText = createMemo(() => (effectiveExpandedText() ? expandedWindow() : collapsedDisplayText()))
  const expandedRangeLabel = createMemo(() =>
    expandedMaxOffset() > 0
      ? `showing ${Locale.number(expandedWindow().offset + 1)}-${Locale.number(expandedWindow().end)} of ${Locale.number(expandedWindow().total)} message lines`
      : "full message shown",
  )
  const pastedContentChars = createMemo(() => pastedContentParts().reduce((total, part) => total + part.text.length, 0))
  let suppressNextMessageMouseUp = false
  const stopMousePropagation = (event?: unknown) => {
    const maybeEvent = event as { stopPropagation?: () => void } | undefined
    maybeEvent?.stopPropagation?.()
  }
  const stopMouseEvent = (event?: unknown) => {
    const maybeEvent = event as { preventDefault?: () => void; stopPropagation?: () => void } | undefined
    maybeEvent?.preventDefault?.()
    maybeEvent?.stopPropagation?.()
  }
  const consumeMouseEvent = (event?: unknown) => {
    suppressNextMessageMouseUp = true
    stopMouseEvent(event)
  }
  const handleMessageMouseUp = (event?: unknown) => {
    if (suppressNextMessageMouseUp) {
      suppressNextMessageMouseUp = false
      stopMouseEvent(event)
      return
    }
    props.onMouseUp()
  }
  const togglePastedContent = (event: unknown) => {
    consumeMouseEvent(event)
    setExpandedPaste((value) => !value)
  }
  let expandedScroll: ScrollBoxRenderable | undefined
  const toggleExpandedText = (event?: unknown) => {
    consumeMouseEvent(event)
    setExpandedText((value) => {
      const next = !value
      if (!next) setExpandedOffset(0)
      return next
    })
  }
  const scrollExpandedText = (offset: number, event?: unknown) => {
    consumeMouseEvent(event)
    const next = expandedUserMessageOffset({ offset, maxOffset: expandedMaxOffset() })
    setExpandedOffset(next)
    if (expandedScroll && !expandedScroll.isDestroyed) expandedScroll.scrollTo(next)
  }

  createEffect(() => {
    const max = expandedMaxOffset()
    if (expandedOffset() > max) {
      const next = expandedUserMessageOffset({ offset: expandedOffset(), maxOffset: max })
      setExpandedOffset(next)
      if (expandedScroll && !expandedScroll.isDestroyed) expandedScroll.scrollTo(next)
    }
  })

  createEffect(() => {
    if (!effectiveExpandedText() || expandedMaxOffset() <= 0) return
    const timer = setInterval(() => {
      if (!expandedScroll || expandedScroll.isDestroyed) return
      const next = expandedUserMessageOffset({ offset: expandedScroll.scrollTop, maxOffset: expandedMaxOffset() })
      if (next !== expandedOffset()) setExpandedOffset(next)
    }, 80)
    onCleanup(() => clearInterval(timer))
  })

  const compaction = createMemo(() =>
    props.parts.find((x): x is Extract<Part, { type: "compaction" }> => x.type === "compaction"),
  )
  const summaryAssistant = createMemo(() =>
    (sync.data.message[props.message.sessionID] ?? []).find(
      (message): message is AssistantMessage =>
        message.role === "assistant" &&
        message.summary === true &&
        message.parentID === props.message.id &&
        !message.error,
    ),
  )
  const summaryOutputText = createMemo(() => {
    const summary = summaryAssistant()
    if (!summary) return
    const text = (sync.data.part[summary.id] ?? [])
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim()
    return text || undefined
  })
  const summaryReasoningText = createMemo(() => {
    const summary = summaryAssistant()
    if (!summary) return
    const text = (sync.data.part[summary.id] ?? [])
      .filter((part): part is ReasoningPart => part.type === "reasoning")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim()
    return text || undefined
  })
  const summaryPreview = createMemo(() => summaryOutputText())
  const summaryModelDetailLabel = createMemo(() => {
    const summary = summaryAssistant()
    if (!summary) return
    return (
      [
        summary.modelID ? `${summary.providerID}/${summary.modelID}` : undefined,
        summary.tokens?.reasoning ? `${Locale.number(summary.tokens.reasoning)} reasoning` : undefined,
        summary.tokens?.output ? `${Locale.number(summary.tokens.output)} output` : undefined,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" · ") || undefined
    )
  })
  const transcriptPreview = createMemo(() => compaction()?.instructions || text())

  return (
    <>
      <Show when={text()}>
        <box
          id={props.sticky ? undefined : props.message.id}
          marginTop={props.index === 0 ? 0 : 1}
          width="100%"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={handleMessageMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
            width="100%"
          >
            <box flexDirection="row" justifyContent="space-between" width="100%" gap={2}>
              <box flexDirection="row" flexGrow={1} minWidth={0} overflow="hidden">
                <text fg={theme.textMuted} wrapMode="none">
                  <span style={{ fg: color() }}>●</span> {subagentInitialPrompt() ? "Subagent prompt" : "You"}
                  <Show when={queued()}>
                    <span> · {queuedPromptWaitLabel(sync.data.config.queue?.mode)}</span>
                  </Show>
                </text>
              </box>
              <Show
                when={queued()}
                fallback={
                  <text fg={theme.textMuted} wrapMode="none">
                    {Locale.todayTimeOrDateTime(props.message.time.created)}
                  </text>
                }
              >
                <box flexDirection="row" flexShrink={0} gap={1}>
                  <text fg={theme.textMuted} wrapMode="none">
                    <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
                  </text>
                  <Show when={props.onSendNow}>
                    <text
                      onMouseDown={consumeMouseEvent}
                      onMouseUp={(event) => {
                        consumeMouseEvent(event)
                        if (!props.sendNowPending) props.onSendNow?.()
                      }}
                    >
                      <span style={{ bg: sendNowBackground(), fg: sendNowForeground(), bold: true }}>
                        {props.sendNowPending ? " … " : " ↗ SEND "}
                      </span>
                    </text>
                  </Show>
                </box>
              </Show>
            </box>
            <Show when={effectiveExpandedText() && collapsedDisplayText().compacted}>
              <box flexDirection="row" justifyContent="space-between" width="100%" gap={2} paddingBottom={1}>
                <box flexGrow={1} overflow="hidden">
                  <text fg={theme.textMuted} wrapMode="none">
                    Expanded message · {expandedRangeLabel()}
                  </text>
                </box>
                <Show when={expandedMaxOffset() > 0}>
                  <box flexDirection="row" flexShrink={0} gap={2}>
                    <text
                      fg={expandedWindow().hasBefore ? theme.text : theme.textMuted}
                      onMouseDown={(event) => {
                        scrollExpandedText(0, event)
                      }}
                      onMouseUp={stopMouseEvent}
                    >
                      {expandedWindow().hasBefore ? "go to top ↑" : "at top"}
                    </text>
                    <text
                      fg={expandedWindow().hasAfter ? theme.text : theme.textMuted}
                      onMouseDown={(event) => {
                        scrollExpandedText(expandedMaxOffset(), event)
                      }}
                      onMouseUp={stopMouseEvent}
                    >
                      {expandedWindow().hasAfter ? "go to bottom ↓" : "at bottom"}
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            <Show
              when={effectiveExpandedText() && expandedMaxOffset() > 0}
              fallback={<text fg={theme.text}>{displayText().text}</text>}
            >
              <scrollbox
                ref={(ref) => {
                  expandedScroll = ref
                }}
                height={expandedViewportRows()}
                width="100%"
                scrollAcceleration={scrollAcceleration()}
                onMouseScroll={stopMousePropagation}
                verticalScrollbarOptions={{
                  visible: true,
                  trackOptions: {
                    backgroundColor: theme.backgroundPanel,
                    foregroundColor: theme.textMuted,
                  },
                }}
              >
                <text fg={theme.text}>{visibleUserMessageText(fullText())}</text>
              </scrollbox>
            </Show>
            <Show when={!props.sticky && !props.simpleHistory && pastedContentParts().length > 0}>
              <box onMouseDown={consumeMouseEvent} onMouseUp={consumeMouseEvent}>
                <text
                  fg={theme.textMuted}
                  onMouseUp={(event) => {
                    if (pastedContentParts().length > 0) togglePastedContent(event)
                  }}
                >
                  {expandedPaste() ? "▾ hide pasted content" : "▸ show pasted content"} (
                  {Locale.number(pastedContentParts().length)} block{pastedContentParts().length === 1 ? "" : "s"},{" "}
                  {Locale.number(pastedContentChars())} chars)
                </text>
              </box>
            </Show>
            <Show
              when={
                !effectiveExpandedText() && !props.sticky && !props.simpleHistory && collapsedDisplayText().compacted
              }
            >
              <box onMouseDown={consumeMouseEvent} onMouseUp={consumeMouseEvent}>
                <text
                  fg={theme.textMuted}
                  onMouseDown={consumeMouseEvent}
                  onMouseUp={(event) => {
                    toggleExpandedText(event)
                  }}
                >
                  … {Locale.number(collapsedDisplayText().hiddenChars)} chars hidden
                  <Show when={collapsedDisplayText().hiddenLines > 0}>
                    <span style={{ fg: theme.textMuted }}>
                      {" "}
                      · {Locale.number(collapsedDisplayText().hiddenLines)} more lines
                    </span>
                  </Show>
                  <span style={{ fg: theme.textMuted }}>
                    {" "}
                    · click to {effectiveExpandedText() ? "collapse" : "expand"}
                  </span>
                </text>
              </box>
            </Show>
            <Show
              when={
                effectiveExpandedText() && !props.sticky && !props.simpleHistory && collapsedDisplayText().compacted
              }
            >
              <box onMouseDown={consumeMouseEvent} onMouseUp={consumeMouseEvent}>
                <text
                  fg={theme.textMuted}
                  onMouseDown={consumeMouseEvent}
                  onMouseUp={(event) => {
                    toggleExpandedText(event)
                  }}
                >
                  ▴ collapse expanded message
                </text>
              </box>
            </Show>
            <Show when={!props.simpleHistory && files().length}>
              <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        {(part) => (
          <CompactionCard
            part={part()}
            summaryPreview={summaryPreview()}
            transcriptPreview={transcriptPreview()}
            modelOutputText={summaryOutputText()}
            modelReasoningText={summaryReasoningText()}
            modelDetailLabel={summaryModelDetailLabel()}
            editableScratchpad={!summaryAssistant()}
          />
        )}
      </Show>
    </>
  )
}

export function memoryToastMessage(info: SessionMemoryMetadata | undefined) {
  if (!info?.output?.generate) return ""
  const output = info.output
  const saved = output.saved?.length ?? 0
  const proposals = output.proposals?.length ?? 0
  if (saved > 0) return `Memory saved ${saved}`
  if (proposals > 0) return `Memory proposal${proposals === 1 ? "" : "s"} ready: ${proposals}`
  if (output.queued) return ""
  if (output.skipped) {
    return `Memory skipped: ${Locale.truncate(output.reason || "not available", 72)}`
  }
  const reason = output.reason || "no pending update"
  if (reason === "no durable memory candidates" || (output.candidates === 0 && reason === "no pending update"))
    return ""
  return `Memory checked: ${Locale.truncate(reason, 72)}`
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean; simpleHistory?: boolean }) {
  const ctx = use()
  const local = useLocal()
  const mend = useMendTuiProfile()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const parentHasCompaction = createMemo(() => {
    const parentID = props.message.parentID
    if (!parentID) return false
    return (sync.data.part[parentID] ?? []).some((part) => part.type === "compaction")
  })
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))
  const usage = createMemo(() => formatAssistantUsage(props.message, ctx.providers()))
  const modelUsageLabel = createMemo(() => usage()?.compact ?? model())
  const rawReasoningUsageLabel = createMemo(() => {
    if (mend.profile.presentation.profile !== "raw") return
    const reasoning = props.message.tokens.reasoning ?? 0
    if (reasoning <= 0) return
    return `${Locale.number(reasoning)} reasoning tokens`
  })

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })
  const streamingCompactionSummary = createMemo(() => {
    return (
      props.message.summary === true &&
      !parentHasCompaction() &&
      !props.message.time.completed &&
      mend.profile.presentation.profile !== "raw"
    )
  })
  const simpleTextParts = createMemo(() =>
    props.parts.filter((part): part is TextPart => part.type === "text" && part.text.trim().length > 0),
  )

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const firstPlanReviewIndex = createMemo(() =>
    props.parts.findIndex((part) => part.type === "tool" && part.tool === "plan_review"),
  )
  const visibleParts = createMemo(() => {
    if (streamingCompactionSummary()) return []
    const planReviewIndex = firstPlanReviewIndex()
    if (planReviewIndex < 0) return props.parts
    return props.parts.filter((part, index) => !(index < planReviewIndex && part.type === "text"))
  })
  const groupedTimeline = createMemo(() =>
    mend.profile.presentation.profile === "raw"
      ? undefined
      : groupTimelineParts(mend.profile.presentation.profile, visibleParts() as any, {
          completed: !!props.message.time.completed,
          showReasoningRows: mend.profile.presentation.reasoning.defaultVisibility !== "hidden",
        }),
  )

  if (props.message.summary === true && parentHasCompaction()) return null

  return (
    <Switch>
      <Match when={props.simpleHistory}>
        <For each={simpleTextParts()}>{(part) => <TextPart last={false} part={part} message={props.message} />}</For>
      </Match>
      <Match when={true}>
        <>
          <Show
            when={groupedTimeline()}
            fallback={
              <For each={visibleParts()}>
                {(part, index) => {
                  const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
                  return (
                    <Show when={component()}>
                      <Dynamic
                        last={index() === visibleParts().length - 1}
                        component={component()}
                        part={part as any}
                        message={props.message}
                      />
                    </Show>
                  )
                }}
              </For>
            }
          >
            {(nodes) => (
              <For each={nodes()}>
                {(node, index) => {
                  const component = createMemo(() => {
                    if (node.type === "row" || node.type === "collapse") return undefined
                    return PART_MAPPING[node.type as keyof typeof PART_MAPPING]
                  })
                  return (
                    <Switch>
                      <Match when={node.type === "row"}>
                        <TimelineRowView
                          row={node as TimelineRow}
                          stackStart={isTimelineStackStart(nodes(), index())}
                        />
                      </Match>
                      <Match when={node.type === "collapse"}>
                        <TimelineCollapseRow
                          collapse={node as TimelineCollapse}
                          stackStart={isTimelineStackStart(nodes(), index())}
                        />
                      </Match>
                      <Match when={component()}>
                        <Dynamic
                          last={index() === nodes().length - 1}
                          component={component()}
                          part={node as any}
                          message={props.message}
                        />
                      </Match>
                    </Switch>
                  )
                }}
              </For>
            )}
          </Show>
          <Show when={streamingCompactionSummary()}>
            <CompactionPanel reason="auto" hasSummaryBody={false} />
          </Show>
          <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
            <box
              border={["left"]}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              marginTop={1}
              backgroundColor={theme.backgroundPanel}
              customBorderChars={SplitBorder.customBorderChars}
              borderColor={theme.error}
            >
              <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
            </box>
          </Show>
          <Switch>
            <Match when={final() || props.message.error?.name === "MessageAbortedError"}>
              <box paddingLeft={3}>
                <text marginTop={1} wrapMode="none">
                  <span
                    style={{
                      fg:
                        props.message.error?.name === "MessageAbortedError"
                          ? theme.textMuted
                          : local.agent.color(props.message.agent),
                    }}
                  >
                    {mend.profile.presentation.symbols.assistantDone}{" "}
                  </span>{" "}
                  <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
                  <span style={{ fg: theme.textMuted }}> · {modelUsageLabel()}</span>
                  <Show when={rawReasoningUsageLabel()}>
                    {(label) => <span style={{ fg: theme.textMuted }}> · {label()}</span>}
                  </Show>
                  <Show when={duration()}>
                    <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
                  </Show>
                  <Show when={props.message.error?.name === "MessageAbortedError"}>
                    <span style={{ fg: theme.textMuted }}> · interrupted</span>
                  </Show>
                </text>
              </box>
            </Match>
          </Switch>
        </>
      </Match>
    </Switch>
  )
}

function shouldBreakBeforeTool(previous: { id?: string } | undefined) {
  const previousID = previous?.id ?? ""
  return previousID.startsWith("text-")
}

function updateToolBreakMargin(el: BoxRenderable, setMargin: (value: number) => void) {
  const parent = el.parent
  if (!parent) return

  const children = parent.getChildren()
  const index = children.indexOf(el)
  setMargin(shouldBreakBeforeTool(children[index - 1]) ? 1 : 0)
}

function TimelineRowView(props: { row: TimelineRow; stackStart?: boolean }) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const active = createMemo(() => props.row.state === "pending" || props.row.state === "running")
  const failed = createMemo(() => props.row.state === "error" || props.row.class === "failure")
  const planning = createMemo(() => props.row.class === "planning")
  const lines = createMemo(() => props.row.lines ?? [])
  const wrappedLines = createMemo(() => {
    const width = Math.max(
      16,
      sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)) - 12,
    )
    return lines().flatMap((line) => wrapTimelineLine("", line, width))
  })
  const detailed = createMemo(() => wrappedLines().length > 0)
  const cleanDetail = createMemo(() => (props.row.tool === "webfetch" || props.row.tool === "websearch") && detailed())
  const color = createMemo(() => {
    if (failed()) return theme.error
    if (planning()) return theme.warning
    if (active()) return theme.text
    return theme.textMuted
  })
  const icon = createMemo(() =>
    toolPresentationIconForProfile(
      mend.profile.presentation.profile,
      props.row.tool,
      failed() ? "failure" : props.row.class,
    ),
  )
  const marginTop = createMemo(() => {
    if (mend.profile.presentation.profile === "minimal" && planning()) return 0
    return props.stackStart ? 1 : 0
  })
  return (
    <box paddingLeft={3} marginTop={marginTop()} flexShrink={0} flexDirection="column">
      <Show
        when={detailed()}
        fallback={
          <text fg={color()} attributes={active() && !planning() ? TextAttributes.BOLD : undefined}>
            <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
            <span>{props.row.title}</span>
          </text>
        }
      >
        <Show
          when={cleanDetail()}
          fallback={
            <>
              <text fg={failed() ? theme.error : active() ? theme.text : theme.textMuted}>
                ╭─ <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
                {props.row.title}
              </text>
              <For each={wrappedLines()}>
                {(line) => (
                  <text fg={theme.textMuted} wrapMode="none">
                    │ {line}
                  </text>
                )}
              </For>
              <text fg={theme.textMuted}>╰─</text>
            </>
          }
        >
          <text fg={failed() ? theme.error : active() ? theme.text : theme.textMuted}>
            <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
            {props.row.title}
          </text>
          <For each={wrappedLines()}>
            {(line) => (
              <text fg={theme.textMuted} wrapMode="none">
                {" "}
                {line}
              </text>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function TimelineCollapseRow(props: { collapse: TimelineCollapse; stackStart?: boolean }) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const label = createMemo(() => timelineCollapseLabel(props.collapse, { expanded: expanded() }))
  return (
    <box flexDirection="column" flexShrink={0} marginTop={props.stackStart ? 1 : 0}>
      <box
        paddingLeft={3}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => setExpanded((value) => !value)}
      >
        <text fg={hover() || expanded() ? theme.text : theme.textMuted}>
          ◇ {label()}
          <Show when={hover()}>
            <span style={{ fg: theme.textMuted }}> · click to {expanded() ? "collapse" : "expand"}</span>
          </Show>
        </text>
      </box>
      <Show when={expanded()}>
        <For each={props.collapse.rows}>{(row) => <TimelineRowView row={row} stackStart={false} />}</For>
      </Show>
    </box>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const mend = useMendTuiProfile()
  const content = createMemo(() => {
    // Some providers send reasoning metadata while redacting the readable text.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const raw = createMemo(() => mend.profile.presentation.profile === "raw")
  const full = createMemo(() => mend.profile.presentation.profile === "mendcode")
  const encryptedReasoning = createMemo(() =>
    Boolean((props.part.metadata as Record<string, any> | undefined)?.openai?.reasoningEncryptedContent),
  )
  const reasoningTokenCount = createMemo(() => props.message.tokens.reasoning ?? 0)
  const hasReasoningEvidence = createMemo(() =>
    Boolean(content() || (raw() && (encryptedReasoning() || reasoningTokenCount() > 0))),
  )
  const visible = createMemo(() =>
    Boolean(
      hasReasoningEvidence() &&
        shouldDisplayReasoning(mend.profile, {
          completed: !!props.message.time.completed,
          showThinking: ctx.showThinking(),
        }),
    ),
  )
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const reasoningDetail = createMemo(() => {
    return [
      unavailableReasoningLabel({
        hasReadableContent: Boolean(content()),
        encrypted: encryptedReasoning(),
      }),
      reasoningTokenCount() > 0 ? `${Locale.number(reasoningTokenCount())} reasoning tokens` : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  })
  const headerDetail = createMemo(() =>
    [isDone() ? Locale.duration(duration()) : undefined, reasoningDetail()].filter(Boolean).join(" · "),
  )
  const activeReasoningLabel = createMemo(() => "Thinking")
  const display = createMemo(() => rawReasoningDisplay(content()))
  const streaming = createMemo(() => !isDone())
  const rawBottomMargin = createMemo(() => (display().body ? 1 : 0))
  const fullReasoningTitle = createMemo(() => {
    const summary = reasoningSummary(content())
    const line = (summary.title ?? summary.body.split(/\r?\n/).find((item) => item.trim()) ?? "").trim()
    if (!line) return display().title
    return Locale.truncate(line.replace(/^#+\s*/, "").replace(/^\*\*([^*]+)\*\*$/, "$1"), 120)
  })

  return (
    <Show when={visible()}>
      <Switch>
        <Match when={raw()}>
          <box
            id={`reasoning-${props.message.id}-${props.part.id}`}
            paddingLeft={3}
            marginTop={1}
            marginBottom={rawBottomMargin()}
            flexDirection="column"
            flexShrink={0}
          >
            <box>
              <ReasoningHeader
                toggleable={false}
                open={true}
                done={isDone()}
                activeLabel={activeReasoningLabel()}
                title={display().title}
                duration={headerDetail() || undefined}
              />
            </box>
            <Show when={display().body}>
              <box>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={subtleSyntax()}
                  content={display().body}
                  conceal={ctx.conceal()}
                  fg={theme.textMuted}
                />
              </box>
            </Show>
          </box>
        </Match>
        <Match when={full()}>
          <box
            id={`reasoning-${props.message.id}-${props.part.id}`}
            paddingLeft={2}
            marginTop={streaming() ? 0 : 1}
            flexDirection="column"
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.backgroundElement}
            flexShrink={0}
          >
            <ReasoningHeader
              toggleable={false}
              open={true}
              done={isDone()}
              activeLabel={activeReasoningLabel()}
              title={fullReasoningTitle()}
              duration={headerDetail() || undefined}
            />
          </box>
        </Match>
        <Match when={true}>
          <box
            id={`reasoning-${props.message.id}-${props.part.id}`}
            paddingLeft={2}
            marginTop={1}
            flexDirection="column"
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.backgroundElement}
          >
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={subtleSyntax()}
              content={"_Thinking:_ " + content()}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Match>
      </Switch>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  activeLabel?: string
  title: string | null
  duration?: string
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning

  return (
    <Switch>
      <Match when={!props.done}>
        <text fg={fg()} wrapMode="none">
          <span>{props.activeLabel || "Thinking"}</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <Show when={props.toggleable}>
            <span>{props.open ? "- " : "+ "}</span>
          </Show>
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const textPaddingLeft = 3
  const renderer = createMemo(() => mend.profile.presentation.message.renderer)
  const streaming = createMemo(() => props.last && !props.message.time.completed)
  const source = createMemo(() => {
    const text = streaming() ? props.part.text.trimStart() : props.part.text.trim()
    if (streaming() && (renderer() === "markdown" || renderer() === "rich"))
      return visibleStreamingMarkdownPreview(text)
    return text
  })
  const messageWidth = createMemo(() =>
    sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)),
  )
  const markdownWidth = createMemo(() => Math.max(1, messageWidth() - textPaddingLeft))
  const richRenderWidth = createMemo(() => Math.min(markdownWidth(), 100))
  const hasMermaid = createMemo(() => hasMermaidFence(source()))
  let streamingMarkdownState: StreamingPlanMarkdownState | undefined
  const streamingMarkdownContent = createMemo(() => {
    if (!streaming()) {
      streamingMarkdownState = undefined
      return
    }
    if (renderer() !== "markdown" && renderer() !== "rich") {
      streamingMarkdownState = undefined
      return
    }
    const result = renderPlanMarkdownStreaming(
      source(),
      richRenderWidth(),
      { tableMode: "grid", markdownMode: "tables-only" },
      streamingMarkdownState,
    )
    streamingMarkdownState = result.state
    return result
  })
  const markdownStaticContent = createMemo(() => {
    if (renderer() !== "markdown" && renderer() !== "rich") return
    if (streaming()) return
    return renderPlanMarkdownStatic(source(), richRenderWidth(), { tableMode: "grid", markdownMode: "tables-only" })
  })
  const richInput = createMemo(() => {
    if ((renderer() !== "markdown" && renderer() !== "rich") || !hasMermaid()) return
    if (streaming()) return
    return {
      text: source(),
      width: richRenderWidth(),
    }
  })
  const [richContent] = createResource(richInput, async (input) =>
    renderPlanMarkdown(input.text, input.width, { tableMode: "grid", markdownMode: "tables-only" }),
  )
  const markdownContent = createMemo(
    () => streamingMarkdownContent()?.content ?? markdownStaticContent() ?? richContent() ?? source(),
  )
  const markdownTail = createMemo(() => {
    if (streaming()) return ""
    const tail = streamingMarkdownContent()?.tail ?? ""
    return renderStreamingMarkdownTail(
      tail,
      richRenderWidth(),
      { tableMode: "grid", markdownMode: "tables-only" },
      {
        finalized: !streaming(),
        output: streaming() ? "text" : "markdown",
      },
    )
  })
  return (
    <Show when={source().trim().length > 0}>
      <box
        id={`text-${props.message.id}-${props.part.id}`}
        width={messageWidth()}
        paddingLeft={textPaddingLeft}
        marginTop={1}
        flexShrink={0}
      >
        <Switch>
          <Match when={renderer() === "plain"}>
            <box flexDirection="column">
              <For each={source().split("\n")}>{(line) => <text fg={theme.text}>{line || " "}</text>}</For>
            </box>
          </Match>
          <Match when={renderer() === "markdown" || renderer() === "rich"}>
            <StyledPlanMarkdown
              syntaxStyle={syntax()}
              width={markdownWidth()}
              content={markdownContent()}
              tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
              stableTextMode={!streaming()}
              colorizeHex={true}
              streamingTail={markdownTail()}
              streamingTailColorizeHex={true}
              streamingTailMode={streaming() ? "text" : "markdown"}
            />
          </Match>
          <Match when={true}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={false}
              syntaxStyle={syntax()}
              content={markdownContent()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()
  const mend = useMendTuiProfile()
  const rowOnly = createMemo(() => {
    const profile = mend.profile.presentation.profile
    if (props.part.tool === ShellID.ToolID) return false
    if (props.part.tool === "plan_review") return false
    if (props.part.tool === "loop") return false
    if (props.part.tool === "memory_graph") return false
    return shouldRenderCompactTool(profile, props.part.tool)
  })

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.tool === "loop") return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === "plan_review"}>
          <PlanReviewToolRow {...toolprops} />
        </Match>
        <Match when={rowOnly()}>
          <PresentationToolRow
            tool={props.part.tool}
            state={props.part.state.status}
            input={toolprops.input}
            metadata={toolprops.metadata}
            output={toolprops.output}
          />
        </Match>
        <Match when={props.part.tool === ShellID.ToolID}>
          <Shell {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={props.part.tool === "loop"}>
          <Loop {...toolprops} />
        </Match>
        <Match when={props.part.tool === "memory_graph"}>
          <MemoryGraph {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

function PlanReviewToolRow(props: ToolProps<any>) {
  const { theme } = useTheme()
  const title = createMemo(() => {
    const state = props.part.state.status
    if (state === "completed") return props.part.state.title ?? "Plan reviewed"
    if (state === "error") return "Plan review failed"
    return "Plan review"
  })
  const detail = createMemo(() => {
    const input = props.input as { title?: string }
    const inlineTitle = planReviewInlineTitle(input.title)
    return inlineTitle ? ` ${inlineTitle}` : ""
  })
  return (
    <InlineTool
      icon={toolPresentationIcon("plan_review", "planning")}
      iconColor={theme.warning}
      pending="Opening plan review..."
      complete={props.part.state.status !== "pending"}
      spinner={props.part.state.status === "running"}
      part={props.part}
    >
      {title()}
      <span style={{ fg: theme.textMuted }}>{detail()}</span>
    </InlineTool>
  )
}

function PresentationToolRow(props: {
  tool: string
  state: string
  input: Record<string, any>
  metadata?: Record<string, any>
  output?: unknown
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const [margin, setMargin] = createSignal(0)
  const pending = createMemo(() => props.state === "pending" || props.state === "running")
  const errored = createMemo(() => props.state === "error")
  const event = createMemo(() =>
    normalizeToolEvent({
      tool: props.tool,
      state: props.state,
      input: props.input,
      metadata: props.metadata,
      output: props.output,
    }),
  )
  const wrappedLines = createMemo(() => {
    const width = Math.max(
      16,
      sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)) - 12,
    )
    return event().lines.flatMap((line) => wrapTimelineLine("", line, width))
  })
  const icon = createMemo(() =>
    toolPresentationIconForProfile(
      mend.profile.presentation.profile,
      props.tool,
      errored() ? "failure" : event().class,
    ),
  )
  const title = createMemo(() => event().title)
  const cleanDetail = createMemo(
    () => (props.tool === "webfetch" || props.tool === "websearch") && wrappedLines().length > 0,
  )
  const rowColor = createMemo(() => {
    if (errored()) return theme.error
    if (pending()) return theme.text
    return theme.textMuted
  })
  const detail = createMemo(() => {
    if (mend.profile.presentation.profile === "minimal") return title()
    return title()
  })
  return (
    <Show
      when={mend.profile.presentation.profile === "mendcode"}
      fallback={
        <Show
          when={wrappedLines().length > 0}
          fallback={
            <box
              paddingLeft={3}
              marginTop={margin()}
              flexShrink={0}
              renderBefore={function () {
                updateToolBreakMargin(this as BoxRenderable, setMargin)
              }}
            >
              <text fg={rowColor()}>
                <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
                {detail()}
              </text>
            </box>
          }
        >
          <box
            paddingLeft={3}
            marginTop={margin()}
            flexShrink={0}
            flexDirection="column"
            renderBefore={function () {
              updateToolBreakMargin(this as BoxRenderable, setMargin)
            }}
          >
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {detail()}
            </text>
            <For each={wrappedLines()}>
              {(line) => (
                <text fg={theme.textMuted} wrapMode="char">
                  {line}
                </text>
              )}
            </For>
            <Show when={event().result}>{(result) => <text fg={theme.textMuted}>{result()}</text>}</Show>
          </box>
        </Show>
      }
    >
      <Show
        when={wrappedLines().length > 0}
        fallback={
          <box
            paddingLeft={3}
            marginTop={margin()}
            flexShrink={0}
            renderBefore={function () {
              updateToolBreakMargin(this as BoxRenderable, setMargin)
            }}
          >
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {title()}
            </text>
          </box>
        }
      >
        <box
          paddingLeft={3}
          marginTop={margin()}
          flexShrink={0}
          flexDirection="column"
          renderBefore={function () {
            updateToolBreakMargin(this as BoxRenderable, setMargin)
          }}
        >
          <Show
            when={cleanDetail()}
            fallback={
              <>
                <text fg={rowColor()}>
                  ╭─ <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
                  {title()}
                </text>
                <For each={wrappedLines()}>
                  {(line) => (
                    <text fg={theme.textMuted} wrapMode="none">
                      │ {line}
                    </text>
                  )}
                </For>
                <Show when={event().result}>{(result) => <text fg={theme.textMuted}>╰─ {result()}</text>}</Show>
              </>
            }
          >
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {title()}
              <Show when={event().result}>
                {(result) => <span style={{ fg: theme.textMuted }}> · {result()}</span>}
              </Show>
            </text>
            <For each={wrappedLines()}>
              {(line) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {" "}
                  {line}
                </text>
              )}
            </For>
          </Show>
        </box>
      </Show>
    </Show>
  )
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => renderTerminalOutput(props.output ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 8
  const preview = createMemo(() => latestTerminalOutputPreview(output(), maxLines))
  const overflow = createMemo(() => preview().overflow)
  const limited = createMemo(() => (expanded() || !overflow() ? output() : preview().text))

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool
          icon={toolPresentationIcon(props.tool)}
          pending="Writing command..."
          complete={true}
          part={props.part}
        >
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  spinner?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const mend = useMendTuiProfile()
  const [hover, setHover] = createSignal(false)
  const showIcon = createMemo(() => mend.profile.presentation.profile !== "minimal")

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )
  const shouldRender = createMemo(() => Boolean(props.complete || error() || permission()))

  return (
    <Show when={shouldRender()}>
      <box
        marginTop={margin()}
        paddingLeft={3}
        onMouseOver={() => props.onClick && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          props.onClick?.()
        }}
        renderBefore={function () {
          const el = this as BoxRenderable
          updateToolBreakMargin(el, setMargin)
        }}
      >
        <Switch>
          <Match when={props.spinner}>
            <Spinner color={fg()} children={props.children} />
          </Match>
          <Match when={true}>
            <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
              <Show fallback={<>~ {props.pending}</>} when={props.complete}>
                <Show when={showIcon()}>
                  <span style={{ fg: props.iconColor }}>{props.icon}</span>{" "}
                </Show>
                {props.children}
              </Show>
            </text>
          </Match>
        </Switch>
        <Show when={denied() ? undefined : error()}>{(message) => <ToolErrorText message={message()} />}</Show>
      </box>
    </Show>
  )
}

function ToolErrorText(props: { message: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width="100%" overflow="hidden">
      <For each={props.message.split("\n")}>
        {(line) => (
          <text fg={theme.error} wrapMode="word" width="100%">
            {line || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function BlockTool(props: {
  title: JSX.Element
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  icon?: string
  iconColor?: RGBA
  titleColor?: RGBA
  titleAttributes?: typeof TextAttributes.BOLD
  variant?: "plain" | "left-line"
  contentGap?: number
  marginTop?: number
  paddingBottom?: number
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const renderer = useRenderer()
  const [margin, setMargin] = createSignal(0)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const showIcon = createMemo(() => Boolean(props.icon && mend.profile.presentation.profile === "mendcode"))
  const titleText = createMemo(() => (typeof props.title === "string" ? props.title.replace(/^# /, "") : props.title))
  const title = () => (
    <Show
      when={props.spinner}
      fallback={
        <text fg={props.titleColor ?? theme.textMuted} attributes={props.titleAttributes}>
          <Show when={showIcon()}>
            <span style={{ fg: props.iconColor ?? props.titleColor ?? theme.textMuted }}>{props.icon}</span>{" "}
          </Show>
          {props.title}
        </text>
      }
    >
      <Spinner color={props.titleColor ?? theme.textMuted}>{titleText()}</Spinner>
    </Show>
  )
  const content = () => (
    <>
      {title()}
      {props.children}
      <Show when={error()}>{(message) => <ToolErrorText message={message()} />}</Show>
    </>
  )
  return (
    <box
      paddingBottom={props.paddingBottom ?? 1}
      paddingLeft={3}
      gap={props.contentGap ?? 1}
      marginTop={props.marginTop ?? margin()}
      renderBefore={function () {
        updateToolBreakMargin(this as BoxRenderable, setMargin)
      }}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.variant === "left-line"} fallback={content()}>
        <box border={["left"]} borderColor={props.titleColor ?? theme.border} paddingLeft={2} gap={1}>
          {content()}
        </box>
      </Show>
    </box>
  )
}

function CommandOutput(props: {
  command: string
  output?: string
  empty?: JSX.Element
  overflow?: boolean
  expanded?: boolean
  running?: boolean
}) {
  const { theme } = useTheme()
  return (
    <box
      border={["top", "bottom", "left", "right"]}
      borderColor={props.running ? theme.primary : theme.border}
      paddingLeft={1}
      paddingRight={1}
      gap={1}
    >
      <Show when={props.command}>
        <text fg={theme.textMuted} wrapMode="word">
          command: {props.command}
        </text>
      </Show>
      <Show when={props.output}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            {props.output}
          </text>
        </box>
      </Show>
      <Show when={!props.output}>{props.empty}</Show>
      <Show when={props.overflow}>
        <text fg={theme.textMuted}>
          {props.expanded ? "Click to collapse" : props.running ? "Showing latest output" : "Click to expand"}
        </text>
      </Show>
    </box>
  )
}

function DiffStatsText(props: { stats: TimelineDiffStats }) {
  const { theme } = useTheme()
  const hasAdditions = () => props.stats.additions > 0
  const hasDeletions = () => props.stats.deletions > 0
  return (
    <Show when={hasAdditions() || hasDeletions()}>
      <span> (</span>
      <Show when={hasAdditions()}>
        <span style={{ fg: theme.diffHighlightAdded }}>+{props.stats.additions}</span>
      </Show>
      <Show when={hasAdditions() && hasDeletions()}>
        <span> </span>
      </Show>
      <Show when={hasDeletions()}>
        <span style={{ fg: theme.diffHighlightRemoved }}>-{props.stats.deletions}</span>
      </Show>
      <span>)</span>
    </Show>
  )
}

function PatchTitle(props: {
  file: {
    type?: unknown
    filePath?: unknown
    movePath?: unknown
    relativePath?: unknown
    additions?: unknown
    deletions?: unknown
  }
  patch: string
}) {
  const type = typeof props.file.type === "string" ? props.file.type : ""
  const from = typeof props.file.filePath === "string" ? props.file.filePath : undefined
  const pathLabel = patchFilePath(props.file)
  const stats = diffStatsFromFile(props.file, props.patch)
  const action = type === "delete" ? "Deleted" : type === "add" ? "Added" : "Patched"
  return (
    <>
      {action} {type === "move" && from ? `${from} -> ` : ""}
      {pathLabel}
      <DiffStatsText stats={stats} />
    </>
  )
}

function Shell(props: ToolProps<typeof ShellTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const [now, setNow] = createSignal(Date.now())
  const isRunning = createMemo(() => props.part.state.status === "running")
  const liveOutput = createMemo(() => (typeof props.metadata.output === "string" ? props.metadata.output : undefined))
  const output = createMemo(() =>
    renderTerminalOutput(selectShellOutput({ running: isRunning(), live: liveOutput(), final: props.output })),
  )
  const [expanded, setExpanded] = createSignal(false)
  const preview = createMemo(() => latestTerminalOutputPreview(output(), 10))
  const overflow = createMemo(() => preview().overflow)
  const limited = createMemo(() => (expanded() || !overflow() ? output() : preview().text))

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const elapsed = createMemo(() => {
    if (!isRunning()) return
    const start = props.part.state.status === "running" ? props.part.state.time.start : undefined
    if (!start) return
    return formatDuration(Math.max(0, Math.round((now() - start) / 1000)))
  })
  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    const showWorkdir = wd && !desc.includes(wd)
    return (
      <>
        <span>{desc}</span>
        <Show when={showWorkdir}>{(value) => <span style={{ fg: theme.textMuted }}> · {value()}</span>}</Show>
        <Show when={elapsed()}>{(value) => <span style={{ fg: theme.textMuted }}> · {value()}</span>}</Show>
      </>
    )
  })

  const interval = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(interval))

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined || props.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          icon={toolPresentationIcon("bash")}
          spinner={isRunning()}
          titleColor={theme.primary}
          titleAttributes={TextAttributes.BOLD}
          contentGap={0}
          paddingBottom={0}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <CommandOutput
            command={props.input.command ?? ""}
            output={output() ? limited() : undefined}
            empty={
              <text fg={theme.textMuted}>
                No output emitted yet
                <Show when={elapsed()}>{(value) => <span> · running {value()}</span>}</Show>
              </text>
            }
            overflow={overflow()}
            expanded={expanded()}
            running={isRunning()}
          />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("bash")}
          pending="Writing command..."
          complete={props.input.command}
          part={props.part}
        >
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={"Added " + normalizePath(props.input.filePath!)}
          icon={toolPresentationIcon("write")}
          iconColor={theme.diffHighlightAdded}
          titleColor={theme.text}
          part={props.part}
          contentGap={0}
          paddingBottom={0}
        >
          <box backgroundColor={theme.diffAddedBg}>
            <line_number fg={theme.diffHighlightAdded} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(props.input.filePath!)}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("write")}
          pending="Preparing write..."
          complete={props.input.filePath}
          part={props.part}
        >
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool
      icon={toolPresentationIcon("glob")}
      pending="Finding files..."
      complete={props.input.pattern}
      part={props.part}
    >
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon={toolPresentationIcon("read")}
        pending="Reading file..."
        complete={props.input.filePath}
        spinner={isRunning()}
        part={props.part}
      >
        Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool
      icon={toolPresentationIcon("grep")}
      pending="Searching content..."
      complete={props.input.pattern}
      part={props.part}
    >
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const detailLines = createMemo(() => [props.input.url].filter((line): line is string => Boolean(line?.trim())))
  const wrappedLines = createMemo(() => {
    const width = Math.max(
      16,
      sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)) - 8,
    )
    return detailLines().flatMap((line) => wrapTimelineLine("", line, width))
  })
  return (
    <>
      <InlineTool
        icon={toolPresentationIcon("webfetch")}
        pending="Fetching from the web..."
        complete={props.input.url}
        part={props.part}
      >
        WebFetch
      </InlineTool>
      <For each={wrappedLines()}>
        {(line) => (
          <box paddingLeft={6} flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="char">
              {line}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const metadata = props.metadata as { numResults?: number }
  const urls = createMemo(() => webSearchUrlLines(props.metadata as Record<string, unknown>, props.output))
  const wrappedUrls = createMemo(() => {
    const width = Math.max(
      16,
      sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)) - 8,
    )
    return urls().flatMap((url) => wrapTimelineLine("", url, width))
  })
  return (
    <>
      <InlineTool
        icon={toolPresentationIcon("websearch")}
        pending="Searching web..."
        complete={props.input.query}
        part={props.part}
      >
        Web Search "{props.input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
      </InlineTool>
      <For each={wrappedUrls()}>
        {(url) => (
          <box paddingLeft={6} flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="char">
              {url}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function normalizeSubagentLabel(value: string) {
  return value.trim().replace(/^(sub[/-])+/i, "")
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { theme } = useTheme()
  const ctx = use()
  const local = useLocal()
  const { navigate } = useRoute()
  const sync = useSync()
  const sdk = useSDK()

  onMount(() => {
    if (props.metadata.sessionId && !sync.data.message[props.metadata.sessionId]?.length)
      void sync.session.sync(props.metadata.sessionId)
  })

  createEffect(
    on(
      () => sdk.connection.status,
      (status) => {
        if (status !== "connected") return
        if (!props.metadata.sessionId) return
        void sync.session.sync(props.metadata.sessionId, { force: true })
      },
      { defer: true },
    ),
  )

  const messages = createMemo(() => sync.data.message[props.metadata.sessionId ?? ""] ?? [])
  const assistantMessages = createMemo(() =>
    messages().filter((msg): msg is AssistantMessage => msg.role === "assistant"),
  )
  const usage = createMemo(() =>
    formatLatestAssistantContextUsage(assistantMessages(), Model.index(sync.data.provider)),
  )

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const isRunning = createMemo(() => props.part.state.status === "running")
  const continuationEntries = createMemo(() => {
    return (sync.data.message[ctx.sessionID] ?? []).flatMap((message) =>
      (sync.data.part[message.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
        .map((part) => {
          const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
          return {
            callID: part.callID,
            sessionID: typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined,
            taskID: typeof state.input?.task_id === "string" ? state.input.task_id : undefined,
            status: part.state.status,
          }
        }),
    )
  })
  const continuation = createMemo(() =>
    sessionTaskContinuation({
      entries: continuationEntries(),
      callID: props.part.callID,
      sessionID: props.metadata.sessionId,
      taskID: props.input.task_id,
    }),
  )
  const subagentType = createMemo(() => normalizeSubagentLabel(props.input.subagent_type ?? "General"))
  const subagentName = createMemo(() => {
    return Locale.titlecase(subagentType())
  })
  const subagentPalette = createMemo(() => [
    theme.warning,
    theme.success,
    theme.info,
    theme.secondary,
    theme.accent,
    theme.primary,
    theme.error,
  ])
  const subagentColorEntries = createMemo((): SubagentTaskColorEntry[] => {
    return (sync.data.message[ctx.sessionID] ?? []).flatMap((message) =>
      (sync.data.part[message.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
        .map((part) => {
          const input = (part.state as { input?: Record<string, unknown> }).input
          const subagentType = typeof input?.subagent_type === "string" ? input.subagent_type : "General"
          return {
            callID: part.callID,
            subagentType: normalizeSubagentLabel(subagentType),
          }
        }),
    )
  })
  const subagentColor = createMemo(() => {
    const palette = subagentPalette()
    return (
      palette[subagentTaskColorIndex(subagentColorEntries(), props.part.callID, palette.length)] ??
      local.agent.color(subagentType())
    )
  })
  const subagentForeground = createMemo(() => selectedForeground(theme, subagentColor()))
  const model = createMemo((): { providerID: string; modelID: string } | undefined => {
    const metadataModel = props.metadata.model as { providerID?: string; modelID?: string } | undefined
    if (metadataModel?.providerID && metadataModel.modelID) {
      return { providerID: metadataModel.providerID, modelID: metadataModel.modelID }
    }
    const inputModel = typeof props.input.model === "string" ? props.input.model : undefined
    if (!inputModel?.includes("/")) return undefined
    const [providerID, ...modelParts] = inputModel.split("/")
    const modelID = modelParts.join("/")
    return providerID && modelID ? { providerID, modelID } : undefined
  })
  const modelLabel = createMemo(() => {
    const value = model()
    if (!value) return undefined
    return Model.name(sync.data.provider, value.providerID, value.modelID)
  })
  const childStatus = createMemo(() => {
    if (!props.metadata.sessionId) return undefined
    return sync.data.session_status[props.metadata.sessionId]
  })
  const childPendingInputCount = createMemo(() => {
    const sessionId = props.metadata.sessionId
    if (!sessionId) return 0
    return (
      (sync.data.permission[sessionId]?.length ?? 0) +
      (sync.data.question[sessionId]?.length ?? 0) +
      (sync.data.plan_review[sessionId]?.length ?? 0)
    )
  })
  const childLiveState = createMemo(() => {
    if (!props.metadata.sessionId) return undefined
    return sessionLiveStateLabel({
      status: childStatus(),
      messages: messages(),
      pendingInputCount: childPendingInputCount(),
    })
  })
  const backgroundTask = createMemo(() => props.metadata.status === "started")
  const isTaskActive = createMemo(
    () =>
      isRunning() ||
      continuation().activeResume ||
      (backgroundTask() && sessionSubagentIsActive(childLiveState() ?? "")),
  )
  const childStatusLabel = createMemo(() => {
    const state = childLiveState()
    if (!state) return undefined
    if (state === "responded" && props.part.state.status === "completed") return undefined
    return `↳ child ${state}`
  })
  const connectionStatusLabel = createMemo(() => {
    if (!isRunning()) return undefined
    const state = sdk.connection
    if (state.status === "connected") return undefined
    if (state.status === "connecting") return "↳ connecting to MendCode..."
    if (state.status === "reconnecting") {
      const attempt = state.attempt > 1 ? ` #${state.attempt}` : ""
      return `↳ reconnecting${attempt}: local connection lost`
    }
    if (state.status === "failed") return `↳ connection lost: stopped after ${state.attempt} reconnect attempts`
    return "↳ disconnected: waiting for local connection"
  })
  const contentColor = (line: string) => {
    if (line.startsWith("↳ connection lost:")) return theme.error
    return theme.textMuted
  }
  const childErrorLabel = createMemo(() => {
    if (props.part.state.status !== "error") return undefined
    return `↳ error: ${props.part.state.error}`
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const content: string[] = []

    const connection = connectionStatusLabel()
    if (connection) content.push(connection)

    if (continuation().resumed) content.push("↳ resumed in same subagent")

    const child = childStatusLabel()
    if (child) content.push(child)

    const error = childErrorLabel()
    if (error) content.push(error)

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      if (backgroundTask()) {
        const state = childLiveState()
        const active = sessionSubagentIsActive(state ?? "")
        const label = active
          ? "running in background"
          : state === "responded"
            ? "background task finished"
            : `background task ${state ?? "started"}`
        content.push(
          [
            `└ ${label}`,
            tools().length > 0 ? `${tools().length} toolcalls` : undefined,
            !active && duration() > 0 ? Locale.duration(duration()) : undefined,
            modelLabel(),
          ]
            .filter(Boolean)
            .join(" · "),
        )
        return content
      }
      content.push(
        [`└ ${tools().length} toolcalls`, Locale.duration(duration()), usage()?.compact ?? modelLabel()]
          .filter(Boolean)
          .join(" · "),
      )
    }

    return content
  })

  return (
    <Show when={!continuation().duplicate}>
      <InlineTool
        icon={toolPresentationIcon("task")}
        spinner={isTaskActive()}
        complete={props.input.description}
        pending="Delegating..."
        part={props.part}
        onClick={() => {
          if (props.metadata.sessionId) {
            navigate({ type: "session", sessionID: props.metadata.sessionId })
          }
        }}
      >
        <Show when={props.input.description} fallback={content().join("\n")}>
          <span style={{ bg: subagentColor(), fg: subagentForeground(), bold: true }}> {subagentName()} </span>{" "}
          {props.input.description}
          <Show when={modelLabel()}>{(label) => <span style={{ fg: theme.textMuted }}> · {label()}</span>}</Show>
          <For each={content()}>
            {(line) => (
              <>
                {"\n"}
                <span style={{ fg: contentColor(line) }}>{line}</span>
              </>
            )}
          </For>
        </Show>
      </InlineTool>
    </Show>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { syntax, theme } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool
          title={
            <>
              Edited {normalizePath(props.input.filePath!)}
              <DiffStatsText stats={diffStatsFromPatch(diffContent() ?? "")} />
            </>
          }
          icon={toolPresentationIcon("edit")}
          iconColor={theme.textMuted}
          titleColor={theme.text}
          part={props.part}
          contentGap={0}
          paddingBottom={0}
        >
          <box>
            <TimelineDiff
              diff={diffContent() ?? ""}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              wrapMode={ctx.diffWrapMode()}
            />
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("edit")}
          pending="Preparing edit..."
          complete={props.input.filePath}
          part={props.part}
        >
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { syntax, theme } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return "unified" as const
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box>
        <TimelineDiff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          wrapMode={ctx.diffWrapMode()}
        />
      </box>
    )
  }

  function titleColor(file: { type: string }) {
    return theme.text
  }

  function iconColor(file: { type: string }) {
    if (file.type === "delete") return theme.diffHighlightRemoved
    if (file.type === "add") return theme.diffHighlightAdded
    return theme.textMuted
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool
              title={<PatchTitle file={file} patch={file.patch} />}
              icon={file.type === "delete" ? "-" : file.type === "add" ? "+" : toolPresentationIcon("apply_patch")}
              iconColor={iconColor(file)}
              titleColor={titleColor(file)}
              part={props.part}
              contentGap={0}
              paddingBottom={0}
            >
              <Diff diff={file.patch} filePath={file.filePath} />
              <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("apply_patch")}
          pending="Preparing patch..."
          complete={false}
          part={props.part}
        >
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function MarkdownChecklist(props: { content: string }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <markdown
      syntaxStyle={syntax()}
      streaming={false}
      content={props.content}
      conceal={ctx.conceal()}
      fg={theme.markdownText}
      bg={theme.background}
    />
  )
}

function todoMarkdown(status: string, content: string) {
  return `- [${status === "completed" ? "x" : " "}] ${content.replace(/\s+/g, " ").trim()}`
}

function parseTodoOutput(output?: string): Array<{ content: string; status: string }> {
  if (!output) return []
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const todo = item as Record<string, unknown>
      if (typeof todo.content !== "string" || typeof todo.status !== "string") return []
      return [{ content: todo.content, status: todo.status }]
    })
  } catch {
    return []
  }
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  const todos = createMemo(() => props.input.todos ?? props.metadata.todos ?? parseTodoOutput(props.output))
  const content = createMemo(() =>
    todos()
      .map((todo) => todoMarkdown(todo.status, todo.content))
      .join("\n"),
  )
  return (
    <Switch>
      <Match when={todos().length && props.part.state.status === "completed"}>
        <BlockTool title="Todos" part={props.part} variant="left-line">
          <MarkdownChecklist content={content()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("todowrite")}
          pending="Updating todos..."
          complete={false}
          part={props.part}
        >
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const count = createMemo(() => props.input.questions?.length ?? 0)
  const content = createMemo(() =>
    (props.input.questions ?? [])
      .map((question, index) => {
        const answer = format(props.metadata.answers?.[index])
        return `- [${answer === "(no answer)" ? " " : "x"}] ${question.question.replace(/\s+/g, " ").trim()}\n  ${answer}`
      })
      .join("\n"),
  )

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="Questions" part={props.part} variant="left-line">
          <MarkdownChecklist content={content()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={toolPresentationIcon("question")}
          pending="Asking questions..."
          complete={count()}
          part={props.part}
        >
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool
      icon={toolPresentationIcon("skill")}
      pending="Loading skill..."
      complete={props.input.name}
      part={props.part}
    >
      Skill "{props.input.name}"
    </InlineTool>
  )
}

type MemoryGraphSnapshot = {
  action?: string
  query?: string
  health?: { graphHealth?: string; connectedFacts?: number; isolatedFacts?: number; orphanLinks?: number }
  facts: Array<{
    id: string
    text: string
    scope: string
    categoryIDs: string[]
    retrievalPriority?: number
    materialized?: boolean
  }>
  links: Array<{ from: string; to: string; kind: string }>
  categories: Array<{ id: string; label: string; count: number }>
}

function memoryGraphSnapshot(value: unknown): MemoryGraphSnapshot | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Partial<MemoryGraphSnapshot>
  if (!Array.isArray(record.facts) || !Array.isArray(record.links) || !Array.isArray(record.categories)) return
  return record as MemoryGraphSnapshot
}

function MemoryGraph(props: ToolProps<any>) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const route = useRoute()
  const snapshot = createMemo(() => memoryGraphSnapshot(props.metadata.graphSnapshot))
  const panelWidth = createMemo(() => Math.max(40, Math.min(72, dimensions().width - 12)))
  const mapWidth = createMemo(() => Math.max(24, panelWidth() - 4))
  const graph = createMemo(() => {
    const data = snapshot()
    if (!data) return
    return memoryGraphMiniMap({
      facts: data.facts,
      links: data.links,
      categories: data.categories,
      width: mapWidth(),
      height: panelWidth() < 54 ? 5 : 6,
      connectedOnly: true,
    })
  })
  const title = createMemo(() => {
    const data = snapshot()
    const inputRecord = props.input as Record<string, unknown>
    const inputAction = typeof inputRecord.action === "string" ? inputRecord.action : ""
    const inputQuery = typeof inputRecord.query === "string" ? inputRecord.query : ""
    const action = data?.action
      ? data.action.replace(/_/g, " ")
      : inputAction
        ? inputAction.replace(/_/g, " ")
        : "graph"
    const query = data?.query || inputQuery
    return query ? `Memory graph · ${action} · ${Locale.truncateMiddle(query, 32)}` : `Memory graph · ${action}`
  })
  const healthTone = createMemo(() => {
    const state = snapshot()?.health?.graphHealth
    if (state === "connected") return theme.success
    if (state === "empty") return theme.textMuted
    return theme.warning
  })
  const short = (value: string, width = mapWidth()) => Locale.truncate(value, Math.max(8, width))
  const footer = createMemo(() => {
    const data = snapshot()
    const frame = graph()
    if (!data || !frame) return ""
    const state = data.health?.graphHealth ?? (frame.scene.edges.length ? "connected" : "disconnected")
    return `${state} · ${frame.stats} · ${frame.scene.edges.length} links`
  })
  const detailRows = createMemo(() => {
    const frame = graph()
    if (!frame) return []
    if (frame.relationRows.length) return frame.relationRows.slice(0, 2)
    if (frame.isolatedRows.length) return frame.isolatedRows.slice(0, 2)
    return frame.labels.slice(0, 2)
  })
  const openGraph = () => route.navigate({
    type: "memory",
    view: "graph",
    returnTo: route.data.type === "session" ? { type: "session", sessionID: route.data.sessionID } : { type: "home" },
  })

  return (
    <Show when={snapshot()} fallback={<GenericTool {...props} />}>
      <BlockTool
        title={title()}
        icon={toolPresentationIcon("memory_graph")}
        titleColor={healthTone()}
        titleAttributes={TextAttributes.BOLD}
        contentGap={0}
        part={props.part}
        spinner={props.part.state.status === "running"}
        onClick={openGraph}
      >
        <box flexDirection="column" width={panelWidth()} paddingLeft={1} overflow="hidden">
          <Show when={graph()?.rows.length}>
            <box flexDirection="column" overflow="hidden">
              <MemoryGraphCanvasRows cells={graph()!.cells} categories={snapshot()!.categories} />
            </box>
          </Show>
          <text fg={healthTone()} wrapMode="none">{short(footer(), panelWidth() - 2)}</text>
          <For each={detailRows()}>
            {(row) => <text fg={theme.textMuted} wrapMode="none">{short(row, panelWidth() - 2)}</text>}
          </For>
          <text fg={theme.primary} wrapMode="none">Open /memory-graph for the full view</text>
        </box>
      </BlockTool>
    </Show>
  )
}

function Loop(props: ToolProps<typeof LoopTool>) {
  const session = use()
  const sdk = useSDK()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)

  const action = createMemo(() => (typeof props.input.action === "string" ? props.input.action : "loop"))
  const workflowID = createMemo(() =>
    typeof props.metadata.workflowID === "string" ? props.metadata.workflowID : undefined,
  )
  const rootSessionID = createMemo(() => {
    const root = props.metadata.rootSessionID ?? props.metadata.sessionId
    return typeof root === "string" ? root : undefined
  })
  const firstWorkflow = createMemo(() => {
    const workflows = props.metadata.workflows
    if (!Array.isArray(workflows)) return undefined
    return workflows.find((item) => Boolean(item && typeof item === "object"))
  })
  const resolvedWorkflowID = createMemo(() => workflowID() ?? firstWorkflow()?.workflowID)
  async function fetchLoopSnapshot() {
    const id = resolvedWorkflowID()
    if (!id) return undefined
    const response = await sdk.fetch(`${sdk.url}/loop/${id}`, { headers: { accept: "application/json" } })
    if (!response.ok) return undefined
    return response.json().catch(() => undefined) as Promise<SessionLoopSnapshot | undefined>
  }
  const [snapshot] = createResource(() => `${resolvedWorkflowID() ?? ""}:${refresh()}`, fetchLoopSnapshot)
  onMount(() => {
    const unsubscribe = sdk.event.on("event", (evt) => {
      const type = evt.payload?.type as string | undefined
      const id = (evt.payload as { properties?: Record<string, unknown> } | undefined)?.properties?.workflowID
      if (type?.startsWith("loop.") && (!resolvedWorkflowID() || id === resolvedWorkflowID()))
        setRefresh((value) => value + 1)
    })
    onCleanup(() => unsubscribe())
  })
  const liveWorkflow = createMemo(() => snapshot.latest?.workflow)
  const latestRun = createMemo(
    () => snapshot.latest?.runs?.toSorted((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0],
  )
  const latestCheckpoint = createMemo(() => latestRun()?.checkpoint)
  const resolvedRootSessionID = createMemo(
    () => liveWorkflow()?.rootSessionID ?? rootSessionID() ?? firstWorkflow()?.rootSessionID,
  )
  const title = createMemo(() => {
    const name =
      liveWorkflow()?.name ??
      firstWorkflow()?.name ??
      (typeof props.input.name === "string" ? props.input.name : undefined)
    if (name?.trim()) return name.trim()
    if (action() === "list") return "Loop dashboard"
    if (action() === "draft") return "Loop draft"
    return "Loop workflow"
  })
  const objective = createMemo(() => {
    const metadataObjective = typeof props.metadata.objective === "string" ? props.metadata.objective.trim() : ""
    const workflowObjective = liveWorkflow()?.objective?.trim() ?? firstWorkflow()?.objective?.trim() ?? ""
    const inputObjective = typeof props.input.objective === "string" ? props.input.objective.trim() : ""
    const value = metadataObjective || workflowObjective || inputObjective
    return value || undefined
  })
  const triggerLabel = createMemo(() => {
    const mode = props.metadata.triggerMode ?? firstWorkflow()?.triggerMode ?? props.input.triggerMode
    const interval = props.metadata.intervalMs ?? firstWorkflow()?.intervalMs ?? props.input.intervalMs
    if (mode === "interval" && typeof interval === "number" && interval > 0)
      return `interval · every ${Math.round(interval / 60000)}m`
    if (mode) return String(mode)
    return "manual"
  })
  const permissionLabel = createMemo(() => {
    if (props.metadata.permissionMode) return props.metadata.permissionMode
    if (firstWorkflow()?.permissionMode) return firstWorkflow()?.permissionMode
    if (props.input.permissionMode) return props.input.permissionMode
    if (props.input.reportOnly === false) return "normal"
    if (props.input.reportOnly === true) return "report-only"
    return "session default"
  })
  const modelLabel = createMemo(() => {
    const model = props.metadata.model ?? firstWorkflow()?.model
    if (model?.providerID && model.modelID)
      return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
    if (typeof props.input.model === "string" && props.input.model.trim()) return props.input.model.trim()
    return "session default"
  })
  const agentLabel = createMemo(
    () => props.metadata.agent ?? firstWorkflow()?.agent ?? props.input.agent ?? "session default",
  )
  const receipt = createMemo(() =>
    sessionLoopReceipt({
      action: action(),
      toolStatus: props.part.state.status,
      workflowState: liveWorkflow()?.state ?? props.metadata.state ?? firstWorkflow()?.state,
      workflowPhase: liveWorkflow()?.phase ?? props.metadata.phase ?? firstWorkflow()?.phase,
    }),
  )
  const receiptColor = createMemo(() => {
    if (receipt().tone === "success") return theme.success
    if (receipt().tone === "warning") return theme.warning
    if (receipt().tone === "danger") return theme.error
    if (receipt().tone === "active") return theme.primary
    if (receipt().tone === "muted") return theme.textMuted
    return theme.secondary
  })
  const panelWidth = createMemo(() => Math.max(52, Math.min(90, dimensions().width - 12)))
  const compact = (value: string, width = Math.max(16, panelWidth() - 22)) =>
    Locale.truncateMiddle(value.replace(/\s+/g, " ").trim(), width)
  const rows = createMemo(() => [
    {
      label: "workflow",
      value: resolvedWorkflowID() ?? "pending",
      color: resolvedWorkflowID() ? theme.secondary : theme.textMuted,
    },
    {
      label: "chat",
      value: resolvedRootSessionID()
        ? snapshot.latest && !snapshot.latest.rootSession
          ? `${resolvedRootSessionID()} (missing)`
          : resolvedRootSessionID()!
        : "created on activation",
      color: resolvedRootSessionID() ? theme.secondary : theme.textMuted,
    },
    { label: "event", value: triggerLabel(), color: theme.text },
    {
      label: "mode",
      value: permissionLabel() ?? "session default",
      color: permissionLabel() === "report-only" ? theme.warning : theme.text,
    },
    { label: "model", value: modelLabel(), color: theme.text },
    { label: "agent", value: agentLabel(), color: theme.text },
  ])
  const statusSummary = createMemo(() => {
    const summary = latestCheckpoint()?.summary ?? liveWorkflow()?.evaluatorReason ?? latestRun()?.evaluatorReason
    if (!summary) return undefined
    return compact(summary, Math.max(24, panelWidth() - 8))
  })
  const nextAction = createMemo(() => latestCheckpoint()?.nextAction)
  const openTarget = async () => {
    const root = resolvedRootSessionID()
    if (root) {
      const result = await sdk.client.session.get({ sessionID: root }).catch(() => undefined)
      if (result?.data) {
        navigate({ type: "session", sessionID: root })
        return
      }
      toast.show({
        variant: "warning",
        message: `Loop chat session not found: ${root}. Opening loop details.`,
        duration: 3500,
      })
      navigate({
        type: "loops",
        selectedID: resolvedWorkflowID(),
        returnTo: { type: "session", sessionID: session.sessionID },
      })
      return
    }
    navigate({
      type: "loops",
      selectedID: resolvedWorkflowID(),
      returnTo: { type: "session", sessionID: session.sessionID },
    })
  }
  const openLabel = createMemo(() => (resolvedRootSessionID() ? "open loop chat" : "open loops dashboard"))

  return (
    <BlockTool
      title="Loop Workflow"
      icon={toolPresentationIcon("loop")}
      titleColor={receiptColor()}
      contentGap={0}
      part={props.part}
      spinner={props.part.state.status === "running" && !resolvedWorkflowID()}
      onClick={openTarget}
    >
      <box width="100%" alignItems="center">
        <box
          flexDirection="column"
          width={panelWidth()}
          flexShrink={0}
          borderStyle="single"
          borderColor={hover() ? theme.secondary : receiptColor()}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          gap={0}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box flexDirection="row">
            <text fg={receiptColor()} attributes={TextAttributes.BOLD}>
              {toolPresentationIcon("loop")} {compact(title(), Math.max(18, panelWidth() - 24))}
            </text>
            <box flexGrow={1} />
            <text fg={receiptColor()}>{receipt().label}</text>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
            <For each={rows()}>
              {(row) => (
                <box flexDirection="row">
                  <text fg={theme.textMuted} wrapMode="none">
                    {row.label.padEnd(10)}
                  </text>
                  <text fg={row.color} wrapMode="none">
                    {compact(row.value)}
                  </text>
                </box>
              )}
            </For>
            <box marginTop={1} flexDirection="column">
              <text fg={theme.textMuted}>goal</text>
              <text fg={theme.text} wrapMode="word">
                {compact(objective() ?? "configured by loop tool", Math.max(24, panelWidth() - 8))}
              </text>
            </box>
            <Show when={statusSummary()}>
              {(summary) => (
                <box marginTop={1} flexDirection="column">
                  <text fg={theme.textMuted}>status</text>
                  <text fg={receiptColor()} wrapMode="word">
                    {summary()}
                  </text>
                  <Show when={nextAction()}>
                    {(value) => (
                      <text fg={theme.textMuted} wrapMode="word">
                        next: {compact(value(), Math.max(24, panelWidth() - 14))}
                      </text>
                    )}
                  </Show>
                </box>
              )}
            </Show>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="row">
            <text fg={hover() ? theme.secondary : theme.textMuted}>{openLabel()}</text>
            <box flexGrow={1} />
            <text fg={theme.textMuted}>click</text>
          </box>
        </box>
      </box>
    </BlockTool>
  )
}

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use absolute
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
