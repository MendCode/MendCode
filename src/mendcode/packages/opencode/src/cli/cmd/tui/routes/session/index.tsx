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
import open from "open"
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
import {
  cancelPendingPromptDelivery,
  latestPendingAssistantID,
  pendingPromptDeliveryMessageIDs,
  Prompt,
  sessionActivityMessages,
  subscribePendingPromptDeliveries,
  type PromptRef,
  type PromptSubmitInfo,
} from "@tui/component/prompt"
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
import type { OpencodeClient } from "@mendcode/sdk/v2"
import { useLocal } from "@tui/context/local"
import * as Log from "@mendcode/core/util/log"
import { Locale } from "@/util/locale"
import { Process } from "@/util/process"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { ShellTool } from "@/tool/shell"
import { ShellID } from "@/tool/shell/id"
import { Permission } from "@/permission"
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
import type { WorkflowTool } from "@/tool/workflow"
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
import { isTransientPermissionSyncError, syncPermissionModeWithRetry } from "../../util/permission-sync"
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
import {
  isAssistantWorking,
  terminalAssistantSettlesActivity,
  isSubagentStatusActive,
  isToolActivityActive,
  SESSION_AGENT_STATE_UNKNOWN_MESSAGE,
  shouldKeepCompactedSubagent,
  shouldShowAgentStateUnknown,
} from "../../util/session-working"
import { formatTranscript } from "../../util/transcript"
import { useTuiConfig } from "../../context/tui-config"
import {
  workflowReceiptCounts,
  workflowReceiptElapsed,
  workflowReceiptFallbackPhases,
  workflowReceiptNextAction,
  workflowReceiptPhaseDiagram,
  workflowReceiptProgress,
  workflowReceiptStateIsAnimated,
  workflowReceiptStateIsTerminal,
  workflowReceiptStateLabel,
  workflowReceiptStateMarker,
  workflowReceiptUsage,
} from "@tui/util/workflow-receipt"
import { workflowParentSessionID, workflowTaskSessionContext, workflowTaskSiblingSessionID } from "@tui/util/workflow-view"
import {
  getScrollAcceleration,
  isScrollboxAtBottom,
  isScrollboxAtTop,
  sessionScrollTarget,
  type SessionScrollState,
} from "../../util/scroll"
import {
  compactNumber,
  sessionContentWidth,
  sessionTaskContinuation,
  sessionPendingInputSessionIDs,
  sessionPendingInputStatus,
  sessionPromptVisible,
  sessionTranscriptBottomSpacer,
  sessionLoopReceipt,
  shouldRenderSessionLoopCard,
  shouldRenderSessionWorkflowCard,
  sessionHeaderTitleJustify,
  sessionHeaderTitleDisplay,
  sessionTopMetricsWidth,
  sessionTopbarLeftLabel,
  sessionTopbarLayout,
  sessionTopbarNavLayout,
  sessionUsageBarLabels,
  type SessionTopbarNavItem,
} from "../../util/session-layout"
import {
  sessionBottomDockLayout,
  sessionTodoIcon,
  sessionTodoPanelWidth,
  type SessionTodo,
} from "../../util/session-bottom-dock"
import { renderSessionExitSummary } from "../../util/session-exit-summary"
import {
  sessionMeasuredHeight,
  sessionMessageVirtualWindow,
  sessionScrollAnchor,
  stickyUserIDFromVirtualWindow,
} from "../../util/session-virtual-window"
import { sessionTranscriptRows } from "../../util/session-transcript-rows"
import { latestCompletedCompactionSummaryID } from "../../util/session-message-order"
import { sessionHistoryBoundaryVisible } from "../../util/session-history"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { appendPromptInfo, restorePromptFromSubmittedParts } from "../../component/prompt/submit-parts"
import { useMendTuiProfile } from "../../context/mend"
import { subagentTaskColorIndex, type SubagentTaskColorEntry } from "../../util/subagent-color"
import {
  presentationReasoningVisible,
  compactPreviewLine,
  compactionSummaryPreview,
  rawReasoningDisplay,
  reasoningSummary,
  reasoningViewportMaxHeight,
  shouldDisplayReasoning,
  unavailableReasoningLabel,
} from "@/mend/tui/presentation"
import { blurCompactionArcade, CompactionPanel, isCompactionArcadeFocused } from "../../component/compaction-panel"
import {
  agentViewCommandStateRank,
  agentViewCommandTouchesSession,
  formatAgentViewCommandSummary,
  formatAgentViewCommandType,
  isAgentViewCommandActionable,
  type AgentViewCommand,
} from "../../util/agent-view"
import { promptChromeUsesFullSessionWidth } from "@/mend/tui/prompt-chrome"
import {
  imageGenerationCanvasSize,
  imageGenerationWaitFrame,
  imageGenerationWaitFrameCount,
} from "@/mend/tui/image-generation-wait"
import { readMendTuiCustomization, resolveMendSessionAccent } from "@/mend/tui/customization"
import { formatDuration } from "@/util/format"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import {
  reviewPermissionRequestWithModel,
  shouldReviewSmartApproval,
} from "@/mend/permission/smart-approval"
import { readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import {
  memoryToolPresentation,
  normalizeToolEvent,
  shouldRenderCompactTool,
  shouldRenderImageGenerationTool,
  toolPresentationIcon,
  toolPresentationIconForProfile,
  webSearchUrlLines,
  wrapTimelineLine,
} from "@/mend/tui/timeline/normalize"
import {
  groupTimelineParts,
  isTimelineStackStart,
  timelineCollapseLabel,
  timelineNodeKeys,
} from "@/mend/tui/timeline/group"
import type { TimelineCollapse, TimelineRow } from "@/mend/tui/timeline/types"
import { TimelineCode, TimelineDiff } from "./renderers/diff"
import { diffStatsFromFile, diffStatsFromPatch, patchFilePath, type TimelineDiffStats } from "./renderers/diff-label"
import { MemoryGraphCanvasRows, memoryGraphMiniMap } from "../memory"
import { compactMemoryGraphRows, compactMemoryGraphSnapshot } from "../../util/memory-graph"
import {
  expandedUserMessageOffset,
  expandPastedContentPlaceholders,
  hiddenUserMessageAttachmentCount,
  isPastedContentPart,
  shouldCollapseUserMessageAttachments,
  userMessageDisplayText,
  visibleUserMessageAttachments,
  visibleUserMessageText,
  type PastedContentDisplayPart,
} from "./user-message-display"
import {
  hasMermaidFence,
  planReviewInlineTitle,
  renderPlanMarkdown,
  renderPlanMarkdownStatic,
} from "../../util/markdown-render"

addDefaultParsers(parsers.parsers)
const trace = Log.create({ service: "tui.session" })
const LARGE_TOOL_BATCH_THRESHOLD = 80
// Keep the first loaded history page stable until the virtualized older-history
// renderer is fixed. The scrollbox still clamps at scrollTop=0; this prevents
// the top-edge handler from swapping the transcript underneath the viewport.
const SESSION_OLDER_HISTORY_PAGING_ENABLED = false

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

const sessionScrollStates = new Map<string, SessionScrollState>()

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

function assistantTurnNeedsContinuation(message: { time?: { completed?: number }; finish?: string }) {
  if (message.time?.completed === undefined) return true
  return message.finish === "tool-calls" || message.finish === "unknown"
}

export function sessionQueuedUserMessageIDs(input: {
  pendingAssistantID?: string
  working?: boolean
  messages: ReadonlyArray<{
    id: string
    role: string
    parentID?: string
    finish?: string
    time?: { created?: number; completed?: number }
  }>
}) {
  const pendingAssistantID = input.pendingAssistantID
  const pending = pendingAssistantID
    ? input.messages.find((message) => message.role === "assistant" && message.id === pendingAssistantID)
    : undefined
  const latestAssistant = input.messages.findLast((message) => message.role === "assistant")
  const activeParentID =
    (pending?.time?.completed === undefined ? pending?.parentID : undefined) ??
    (input.working && latestAssistant && assistantTurnNeedsContinuation(latestAssistant)
      ? latestAssistant.parentID
      : undefined)
  if (!activeParentID) return []
  const activeParentIndex = input.messages.findIndex((message) => message.id === activeParentID)
  if (activeParentIndex < 0) return []
  const assistantParentIDs = new Set(
    input.messages.flatMap((message) => (message.role === "assistant" && message.parentID ? [message.parentID] : [])),
  )
  return input.messages
    .slice(activeParentIndex + 1)
    .filter((message) => message.role === "user" && !assistantParentIDs.has(message.id))
    .map((message) => message.id)
}

export function sessionQueuedPromptDeliveryIDs(input: {
  deliveryIDs: ReadonlySet<string>
  messages: ReadonlyArray<{ role: string; parentID?: string }>
}) {
  const assistantParentIDs = new Set(
    input.messages.flatMap((message) => (message.role === "assistant" && message.parentID ? [message.parentID] : [])),
  )
  return [...input.deliveryIDs].filter((messageID) => !assistantParentIDs.has(messageID))
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
  working?: boolean
  submittedUserMessageID?: string
  isVisibleUser?: (messageID: string) => boolean
}) {
  const visible = (messageID: string) => input.isVisibleUser?.(messageID) ?? true
  const pending = input.messages.find(
    (message) => message.role === "assistant" && message.id === input.pendingAssistantID,
  )
  const latestAssistant = input.messages.findLast((message) => message.role === "assistant")
  const activeParentID =
    (pending && pending.time.completed === undefined ? pending.parentID : undefined) ??
    (input.working && latestAssistant && assistantTurnNeedsContinuation(latestAssistant)
      ? latestAssistant.parentID
      : undefined)
  const submitted = input.submittedUserMessageID
  if (submitted && visible(submitted)) {
    const latestChild = input.messages.findLast(
      (message) => message.role === "assistant" && message.parentID === submitted,
    )
    const finished =
      latestChild?.time.completed !== undefined &&
      Boolean(latestChild.finish && !["tool-calls", "unknown"].includes(latestChild.finish))
    if ((!finished || input.working) && (!activeParentID || activeParentID === submitted)) return submitted
  }

  return activeParentID && visible(activeParentID) ? activeParentID : undefined
}

export function sessionStickyUserEligible(input: {
  role: string
  parts?: ReadonlyArray<{ type?: string }>
}) {
  return input.role === "user" && input.parts !== undefined && !input.parts.some((part) => part.type === "compaction")
}

export function shouldPinSessionStickyUserHeader(input: {
  pinnedUserID?: string
  pinnedAnchor?: { id: string; y: number }
  top: number
}) {
  const anchor = input.pinnedAnchor
  if (!anchor) return false
  return anchor.id === input.pinnedUserID && anchor.y <= input.top
}

export function sessionFollowSyncIsStale(input: {
  now: number
  lastSyncAt: number
  lastEventAt: number
  intervalMs: number
}) {
  return input.now - Math.max(input.lastSyncAt, input.lastEventAt) >= input.intervalMs
}

export function sessionUserMovedViewport(input: {
  scrollTop: number
  lastScrollTop: number
  scrollHeight: number
  lastScrollHeight: number
  viewportHeight: number
  lastViewportHeight: number
  followOutput?: boolean
}) {
  const scrollDelta = input.scrollTop - input.lastScrollTop
  const scrollMoved = Math.abs(scrollDelta) > 1
  const layoutChanged =
    Math.abs(input.scrollHeight - input.lastScrollHeight) > 1 ||
    Math.abs(input.viewportHeight - input.lastViewportHeight) > 1
  if (!scrollMoved) return false

  // A sticky/following scrollbox can move its scrollTop while layout is
  // settling after a streamed part changes height. A downward movement can
  // be that layout adjustment, but a negative delta is an unmistakable manual
  // scroll-up gesture and must detach follow immediately.
  if (layoutChanged) {
    if (input.followOutput) return scrollDelta < -1
    return false
  }
  return true
}

export function sessionSubmitScrollSettlement(input: {
  intentMessageID?: string
  pinnedMessageID?: string
  assistant?: {
    parentID?: string
    finish?: string
    time?: { completed?: number }
  }
}) {
  const messageID = input.intentMessageID
  if (!messageID) return "none" as const
  const assistant = input.assistant
  if (!assistant || assistant.parentID !== messageID) return "hold" as const
  const terminal =
    assistant.time?.completed !== undefined &&
    Boolean(assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish))
  if (!terminal || input.pinnedMessageID === messageID) return "hold" as const
  return "follow" as const
}

export function sessionTerminalReceiptShouldFollow(input: {
  following: boolean
  submitIntentActive?: boolean
  hasActiveTool?: boolean
  assistant?: { finish?: string; error?: unknown; time?: { completed?: number } }
}) {
  if (!input.following || input.submitIntentActive || input.hasActiveTool) return false
  const assistant = input.assistant
  if (!assistant || assistant.time?.completed === undefined) return false
  return Boolean(assistant.error || (assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish)))
}

export function shouldDeferSessionFollowSync(input: {
  hasMoreNewer: boolean
  loadingOlder: boolean
  loadingNewer: boolean
}) {
  return input.hasMoreNewer || input.loadingOlder || input.loadingNewer
}

export function sessionBottomFollowMode(input: {
  alreadyFollowing: boolean
  hasMoreNewer: boolean
  loadingNewer: boolean
  suppressedBoundary?: "top" | "bottom"
}) {
  if (input.suppressedBoundary === "bottom") return input.alreadyFollowing ? "follow" : "detached"
  if (input.hasMoreNewer && !input.loadingNewer) return input.alreadyFollowing ? "follow" : "page"
  return "follow"
}

export const SESSION_BOTTOM_FOLLOW_REFLOW_DELAYS_MS = [0, 16, 50, 120, 240, 480, 960, 1_600, 2_400, 3_600, 5_200] as const

export function shouldKeepSessionBottomFollow(input: {
  following: boolean
  userMovedViewport: boolean
  contentHeightChanged: boolean
  viewportHeightChanged: boolean
  compactionFocused?: boolean
}) {
  return Boolean(
    input.following &&
      !input.userMovedViewport &&
      !input.compactionFocused &&
      (input.contentHeightChanged || input.viewportHeightChanged),
  )
}

export function shouldHandleGlobalSessionInterrupt(input: {
  eventName: string
  defaultPrevented?: boolean
  activeTurn: boolean
  pendingInput?: boolean
}) {
  return (
    input.eventName === "escape" &&
    !input.defaultPrevented &&
    input.activeTurn &&
    !input.pendingInput
  )
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
  latestTodoWritePartID: () => string | undefined
  latestCompletedTodoWritePartID: () => string | undefined
  interrupted: () => boolean
  now: () => number
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
  let files = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [rawAdded, rawRemoved] = line.split("\t")
    files += 1
    if (/^\d+$/.test(rawAdded)) added += Number(rawAdded)
    if (/^\d+$/.test(rawRemoved)) removed += Number(rawRemoved)
  }
  return { added, removed, files }
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

export function Session() {
  const route = useRouteData("session")
  const { navigate: navigateRoute } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const keybind = useKeybind()
  const sdk = useSDK()
  const [now, setNow] = createSignal(Date.now())
  const [sessionInterruptRequested, setSessionInterruptRequested] = createSignal(false)
  createEffect(
    on(
      () => route.sessionID,
      () => setSessionInterruptRequested(false),
      { defer: true },
    ),
  )
  const promptEdgeToEdge = createMemo(() => {
    return promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)
  })
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const [workflowTaskRuns, { refetch: refetchWorkflowTaskRuns }] = createResource(
    () => (session()?.parentID ? route.sessionID : undefined),
    async () => {
      const response = await sdk.client.workflow.list({ limit: 100 }).catch(() => undefined)
      return response?.data ?? []
    },
  )
  const currentWorkflowTask = createMemo(() =>
    workflowTaskSessionContext({
      sessionID: route.sessionID,
      workflows: workflowTaskRuns.latest ?? workflowTaskRuns() ?? [],
    }),
  )
  const [permissionModeSetting, setPermissionModeSetting] = createSignal<PermissionMode>("approval")
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const [pendingPromptRevision, setPendingPromptRevision] = createSignal(0)
  onMount(() => {
    const unsubscribe = subscribePendingPromptDeliveries(() => setPendingPromptRevision((value) => value + 1))
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(unsubscribe)
    onCleanup(() => clearInterval(timer))
  })
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
  const [submitScrollIntent, setSubmitScrollIntent] = createSignal<{
    sessionID: string
    messageID: string
    offset: number
  }>()
  const activityMessages = createMemo(() =>
    sessionActivityMessages({
      messages: messages(),
      latestAssistant: sync.data.session_latest_assistant[route.sessionID],
    }),
  )
  const pending = createMemo(() => {
    const currentStatus = sync.data.session_status?.[route.sessionID]
    const latestAssistant = activityMessages().findLast((message) => message.role === "assistant")
    const hasActiveTool = latestAssistant
      ? (sync.data.part[latestAssistant.id] ?? []).some((part) => {
          const raw = part as Record<string, any>
          return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
        })
      : false
    return latestPendingAssistantID(activityMessages(), {
      statusType: currentStatus?.type,
      now: now(),
      statusUntil: currentStatus?.type === "busy" ? currentStatus.until : undefined,
      statusNext: currentStatus?.type === "retry" ? currentStatus.next : undefined,
      hasActiveTool,
    })
  })
  const sessionWorking = createMemo(() => {
    const status = sync.data.session_status?.[route.sessionID]?.type
    return status === "busy" || status === "retry"
  })
  const activeTurnAssistantID = createMemo(() => {
    const unfinished = pending()
    if (unfinished) return unfinished
    const status = sync.data.session_status?.[route.sessionID]?.type
    if (status !== "busy" && status !== "retry") return
    return activityMessages().findLast((message) => message.role === "assistant")?.id
  })
  const pendingDeliveryQueuedIDs = createMemo(() => {
    pendingPromptRevision()
    return new Set(
      sessionQueuedPromptDeliveryIDs({
        deliveryIDs: pendingPromptDeliveryMessageIDs(route.sessionID),
        messages: messages(),
      }),
    )
  })
  const queuedMessageIDs = createMemo(() => {
    const queued = new Set(
      sessionQueuedUserMessageIDs({
        messages: messages(),
        pendingAssistantID: activeTurnAssistantID(),
        working: sessionWorking(),
      }),
    )
    for (const messageID of pendingDeliveryQueuedIDs()) queued.add(messageID)
    return queued
  })
  const pendingDeliveryTailIDs = createMemo(() => {
    return pendingDeliveryQueuedIDs()
  })
  const transcriptRows = createMemo(() => {
    const compactionBoundaryIDs = new Set(
      messages().flatMap((message) =>
        message.role === "user" && (sync.data.part[message.id] ?? []).some((part) => part.type === "compaction")
          ? [message.id]
          : [],
      ),
    )
    return sessionTranscriptRows(messages(), queuedMessageIDs(), {
      boundaryIDs: compactionBoundaryIDs,
      tailIDs: pendingDeliveryTailIDs(),
    })
  })
  const transcriptChildIDs = createMemo(() => {
    const ids = new Set<string>()
    for (const message of transcriptRows()) {
      ids.add(message.id)
      ids.add(`queued-${message.id}`)
    }
    return ids
  })
  const queuedMessages = createMemo(() => {
    const queuedIDs = queuedMessageIDs()
    return messages().filter((message): message is UserMessage => message.role === "user" && queuedIDs.has(message.id))
  })
  const messageByID = createMemo(() => new Map(messages().map((message) => [message.id, message] as const)))
  const pinnedTurnUserMessageID = createMemo(() =>
    sessionPinnedUserMessageID({
      messages: messages(),
      pendingAssistantID: activeTurnAssistantID(),
      working: sessionWorking(),
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
  const latestTodoWritePartIDs = createMemo(() => {
    let latest: string | undefined
    let latestCompleted: string | undefined
    for (const message of messages().toReversed()) {
      const parts = sync.data.part[message.id] ?? []
      latest ??= parts.findLast((candidate) => candidate.type === "tool" && candidate.tool === "todowrite")?.id
      latestCompleted ??= parts.findLast(
        (candidate) => candidate.type === "tool" && candidate.tool === "todowrite" && candidate.state.status === "completed",
      )?.id
      if (latest && latestCompleted) break
    }
    return { latest, latestCompleted }
  })
  const latestTodoWritePartID = createMemo(() => latestTodoWritePartIDs().latest)
  const latestCompletedTodoWritePartID = createMemo(() => latestTodoWritePartIDs().latestCompleted)

  const dimensions = useTerminalDimensions()
  const tuiCustomization = createMemo(() => readMendTuiCustomization((key, fallback) => kv.get(key, fallback)))
  const sessionAccent = createMemo(() => {
    const accent = tuiCustomization().sessionAccent
    if (accent === "theme") return theme.textMuted
    return RGBA.fromHex(resolveMendSessionAccent({ sessionID: route.sessionID, accent, fallback: "#7dd3fc" }))
  })
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", presentationReasoningVisible(mend.profile))
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "show")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled] = kv.signal("animations_enabled", true)
  const [headerTitleOffset, setHeaderTitleOffset] = createSignal(0)
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
      if (!directory) return { added: undefined, removed: undefined, files: undefined, branch: "" }
      const diff = await Process.text(["git", "diff", "--numstat", "HEAD", "--"], { cwd: directory, nothrow: true })
      const branch = await Process.text(["git", "branch", "--show-current"], { cwd: directory, nothrow: true })
      const lineStats = diff.code === 0 ? parseGitNumstat(diff.text) : undefined
      return {
        added: lineStats?.added,
        removed: lineStats?.removed,
        files: lineStats?.files,
        branch: branch.code === 0 ? branch.text.trim() : "",
      }
    },
  )
  const topDiffStats = createMemo(() => {
    const stats = topStats()
    if (!stats || (!stats.files && !stats.added && !stats.removed)) return
    return {
      added: stats.added ?? 0,
      removed: stats.removed ?? 0,
      files: stats.files ?? 0,
    }
  })
  const topBranchLabel = createMemo(() => Locale.truncate(topStats()?.branch || "no branch", 24))
  const topbarDiffStats = createMemo(() => {
    const customization = tuiCustomization()
    const diff = topDiffStats()
    if (!diff || (!customization.diffCount && !customization.diffFiles)) return undefined
    return diff
  })
  const topbarUsage = createMemo(() => (tuiCustomization().contextBar ? topUsage() : undefined))
  const topMetricsWidth = createMemo(() =>
    sessionTopMetricsWidth({
      diff: topbarDiffStats(),
      usage: topbarUsage(),
      showDiffCount: tuiCustomization().diffCount,
      showDiffFiles: tuiCustomization().diffFiles,
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
  const sessionTopNavLabel = createMemo(() => {
    const workflowTask = currentWorkflowTask()
    if (workflowTask) {
      const cycle = workflowTask.sessionIDs.length > 1
        ? ` ← Prev task ${keybind.print("session_child_cycle_reverse")} → Next task ${keybind.print("session_child_cycle")}`
        : ""
      return `↑ Workflow ${keybind.print("session_parent")}${cycle}`
    }
    if (session()?.parentID) {
      return `↖ Parent ${keybind.print("session_parent")} ← Prev ${keybind.print("session_child_cycle_reverse")} → Next ${keybind.print("session_child_cycle")}`
    }
    if (!currentLoopWorkflow()) return ""
    const parent = currentLoopWorkflow()?.ownerSessionID ? "Parent" : "Agent View"
    return `↖ ${parent} ${keybind.print("session_parent")}`
  })
  const topbarNavVisible = createMemo(() => Boolean(currentWorkflowTask() || session()?.parentID || currentLoopWorkflow()))
  const topbarNavWidth = createMemo(() => (topbarNavVisible() ? Bun.stringWidth(sessionTopNavLabel()) : 0))
  const headerTitleVisible = createMemo(() => tuiCustomization().sessionTitle)
  const headerTitleJustify = createMemo(() => sessionHeaderTitleJustify("center"))
  const headerTitleText = createMemo(() => {
    const workflowTask = currentWorkflowTask()
    if (!workflowTask) return session()?.title || route.sessionID
    return `${workflowTask.workflowName} · Task ${workflowTask.taskIndex + 1}/${workflowTask.taskCount} · ${workflowTask.taskName}`
  })
  const topbarLayout = createMemo(() =>
    sessionTopbarLayout({
      contentWidth: contentWidth(),
      metricsWidth: topMetricsWidth(),
      navWidth: topbarNavWidth(),
      titleVisible: headerTitleVisible(),
    }),
  )
  const headerTitleDisplay = createMemo(() =>
    sessionHeaderTitleDisplay({
      value: headerTitleText(),
      maxWidth: topbarLayout().titleWidth,
      animated: animationsEnabled(),
      offset: headerTitleOffset(),
    }),
  )
  createEffect(
    on([headerTitleText, () => topbarLayout().titleWidth, animationsEnabled], () => {
      setHeaderTitleOffset(0)
    }),
  )
  onMount(() => {
    const timer = setInterval(() => {
      const width = topbarLayout().titleWidth
      if (!animationsEnabled() || width <= 0 || Bun.stringWidth(headerTitleText()) <= width) {
        if (headerTitleOffset() !== 0) setHeaderTitleOffset(0)
        return
      }
      setHeaderTitleOffset((offset) => offset + 1)
    }, 350)
    onCleanup(() => clearInterval(timer))
  })
  const topbarLeftLabel = createMemo(() => {
    if (!tuiCustomization().projectPath) return ""
    return sessionTopbarLeftLabel({
      branch: sync.data.vcs?.branch || "git",
      path: topPathLabel(),
      maxWidth: topbarLayout().pathWidth,
      isChildSession: Boolean(session()?.parentID),
    })
  })
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
        const sessionId = typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined
        if (!sessionId) continue
        const status = sessionLiveStateLabel({
          status: sync.data.session_status?.[sessionId],
          messages: sync.data.message[sessionId] ?? [],
          pendingInputCount:
            (sync.data.permission[sessionId]?.length ?? 0) +
            (sync.data.question[sessionId]?.length ?? 0) +
            (sync.data.plan_review[sessionId]?.length ?? 0),
          now: now(),
          connectionStatus:
            sdk.connection.status === "connected" && sdk.connection.recoveringSince !== undefined
              ? "reconnecting"
              : sdk.connection.status,
        })
        if (!shouldKeepCompactedSubagent({ compacted: state.time?.compacted, status })) continue
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
          now: now(),
          connectionStatus:
            sdk.connection.status === "connected" && sdk.connection.recoveringSince !== undefined
              ? "reconnecting"
              : sdk.connection.status,
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
        const aRelevant = isSubagentStatusActive(a.status)
        const bRelevant = isSubagentStatusActive(b.status)
        if (aRelevant !== bRelevant) return aRelevant ? -1 : 1
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
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
  let syncedSessionPermissionMode: string | undefined
  const permissionSyncAbort = new AbortController()
  const permissionSyncInFlight = new Map<string, Promise<boolean>>()

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

  async function syncSessionPermissionMode(mode: PermissionMode) {
    const sessionID = permissionSessionID()
    const syncKey = `${sessionID}:${mode}`
    if (syncedSessionPermissionMode === syncKey) return
    const inFlight = permissionSyncInFlight.get(syncKey)
    if (inFlight) return inFlight

    const request = Promise.resolve()
      .then(() =>
        syncPermissionModeWithRetry({
          mode,
          permissionName: Permission.SESSION_MODE_PERMISSION,
          signal: permissionSyncAbort.signal,
          read: async () => {
            const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
            return result.data?.permission
          },
           write: async () => {
             const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
             await sdk.client.session.update(
               {
                 sessionID,
                 permission: Permission.withSessionMode(result.data?.permission ?? [], mode),
               },
               { throwOnError: true },
             )
           },
        }),
      )
      .then((synced) => {
        if (synced) syncedSessionPermissionMode = syncKey
        return synced
      })

    const tracked = request.finally(() => {
      if (permissionSyncInFlight.get(syncKey) === tracked) permissionSyncInFlight.delete(syncKey)
    })
    permissionSyncInFlight.set(syncKey, tracked)
    return tracked
  }

  onCleanup(() => {
    permissionSyncAbort.abort()
    permissionSyncInFlight.clear()
  })

  createEffect(() => {
    const config = permissionsConfig()
    const sessionMode = sessionPermissionModeOverride()
    const mode = sessionMode || config?.mode
    const connectionStatus = sdk.connection.status
    if (!mode || !sync.ready || !session() || connectionStatus !== "connected") return
    setPermissionModeSetting(mode)
    void syncSessionPermissionMode(mode).catch((error) => {
      if (permissionSyncAbort.signal.aborted) return
      if (isTransientPermissionSyncError(error)) {
        toast.show({
          message: "Permission mode sync deferred until the local server reconnects.",
          variant: "warning",
          duration: 5000,
        })
        return
      }
      toast.show({
        message: `Could not sync permission mode: ${errorMessage(error)}`,
        variant: "error",
        duration: 5000,
      })
    })
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
    try {
      await sdk.client.permission.reply({
        reply: "once",
        requestID: request.id,
        workspace: project.workspace.current(),
      })
      return true
    } catch (error) {
      autoAcceptedPermissionIDs.delete(request.id)
      throw error
    }
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
      if (!shouldReviewSmartApproval(request)) {
        setSmartPermissionStatus("Smart needs your approval")
        continue
      }
      smartReviewedPermissionIDs.add(request.id)
      try {
        setSmartPermissionStatus(`Smart reviewing ${request.permission}`)
        const prompt = sessionUserPromptHistory({
          messages: sync.data.message[request.sessionID] ?? [],
          partsByMessage: sync.data.part,
        }).findLast((item) => item.input.trim().length > 0)?.input
        const decision = await reviewPermissionRequestWithModel(request, mend.root, { userPrompt: prompt })
        if (!decision.triggered || decision.decision === "ask") {
          setSmartPermissionStatus(`Smart needs approval`)
          toast.show({
            message: `Smart Approval needs manual input: ${decision.reason}`,
            variant: "info",
            duration: 5000,
          })
          continue
        }
        reviewed++
        await sdk.client.permission.reply({
          reply: decision.decision === "allow" ? "once" : "reject",
          requestID: request.id,
          workspace: project.workspace.current(),
        })
        toast.show({
          message: `Smart Approval ${decision.decision === "allow" ? "allowed" : "rejected"} this command: ${decision.reason}`,
          variant: decision.decision === "allow" ? "success" : "warning",
          duration: 5000,
        })
        setSmartPermissionStatus(`Smart ${decision.decision === "allow" ? "approved" : "rejected"}`)
        setTimeout(() => {
          setSmartPermissionStatus((current) => (current?.startsWith("Smart ") ? null : current))
        }, 5000)
      } catch (error) {
        smartReviewedPermissionIDs.delete(request.id)
        throw error
      }
    }
    return { accepted: 0, reviewed }
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
    const sessionID = permissionSessionID()
    await syncSessionPermissionMode(mode)
    const overrides = { ...sessionPermissionOverrides(), [sessionID]: mode }
    kv.set(sessionPermissionModesKey, overrides)
    if (permissionSessionID() === sessionID) setPermissionModeSetting(mode)
  }

  async function clearPermissionModeForSession() {
    const overrides = { ...sessionPermissionOverrides() }
    delete overrides[permissionSessionID()]
    kv.set(sessionPermissionModesKey, overrides)
    const globalMode = (await readPermissionsConfig()).mode
    setPermissionModeSetting(globalMode)
    await syncSessionPermissionMode(globalMode)
    await refetchPermissionsConfig()
  }

  async function setPermissionModeAsDefault(mode: PermissionMode) {
    await writePermissionsConfig({ mode })
    const activeMode = sessionPermissionModeOverride() || mode
    setPermissionModeSetting(activeMode)
    await syncSessionPermissionMode(activeMode)
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
              .then(() => smartReviewPendingPermissions())
              .then(({ accepted, reviewed }) => {
                const summary = [
                  accepted ? `auto-approved ${accepted} permission${accepted === 1 ? "" : "s"}` : "",
                  reviewed ? `reviewed ${reviewed} permission${reviewed === 1 ? "" : "s"}` : "",
                ]
                  .filter(Boolean)
                  .join("; ")
                toast.show({
                  message: summary
                    ? `Smart Approval enabled for this session; ${summary}.`
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
              .then(() => autoAcceptPendingPermissions())
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
  let lastObservedViewportHeight = 0
  let manualScrollGraceUntil = 0
  let bottomScrollToken = 0
  let routeBottomScrollToken = 0
  let followBottomScrollToken = 0
  let followBottomScrollSessionID: string | undefined
  let submitScrollToken = 0
  let applyingSubmitScroll = false
  const submittedTurnIDs = new Set<string>()
  let scrollPagingInFlight = false
  let scrollPagingToken = 0
  let scrollPagingRestoreToken = 0
  let suppressedPagingBoundary: "top" | "bottom" | undefined
  let activeSessionID = route.sessionID
  let restoringSessionScroll = false
  const [sessionScrollTop, setSessionScrollTop] = createSignal(0)
  // `scrollAnchor` is retained as the logical identity for persistence, but it
  // must not permanently constrain the virtual window. This separate signal
  // is armed only while a structural update still needs that row mounted for
  // scroll restoration.
  const [virtualScrollAnchorID, setVirtualScrollAnchorID] = createSignal<string>()
  let virtualScrollAnchorBoundary: "top" | "bottom" | undefined
  const armVirtualScrollAnchor = (id?: string, boundary?: "top" | "bottom") => {
    virtualScrollAnchorBoundary = boundary
    setVirtualScrollAnchorID(id)
  }
  const clearVirtualScrollAnchor = () => {
    virtualScrollAnchorBoundary = undefined
    setVirtualScrollAnchorID(undefined)
  }
  const measuredMessageHeights = new Map<string, number>()
  const [messageHeightRevision, setMessageHeightRevision] = createSignal(0)
  let measuredTranscriptWidth = 0
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const editQueuedPrompt = async (messageID: string, promptInfo: PromptInfo) => {
    if (!prompt) return false
    const current = prompt.current
    sync.session.unpinMessage(route.sessionID, messageID)
    cancelPendingPromptDelivery(route.sessionID, messageID)
    sync.session.removeMessage(route.sessionID, messageID)
    try {
      await sdk.client.session.deleteMessage({ sessionID: route.sessionID, messageID }, { throwOnError: true })
    } catch (error) {
      await sync.session.restoreMessage(route.sessionID, messageID).catch(() => undefined)
      sync.session.pinMessage(route.sessionID, messageID)
      toast.show({
        title: "Could not edit queued message",
        message: error instanceof Error ? error.message : "The queued message could not be removed.",
        variant: "error",
        duration: 5000,
      })
      return false
    }
    prompt.set(appendPromptInfo(current, promptInfo))
    prompt.focus()
    return true
  }
  const dialog = useDialog()
  const renderer = useRenderer()

  const updateMountedMessageHeights = () => {
    if (!scroll || scroll.isDestroyed) return false
    const width = Math.max(1, scroll.viewport.width)
    let changed = false
    if (measuredTranscriptWidth > 0 && measuredTranscriptWidth !== width) {
      const ratio = measuredTranscriptWidth / width
      for (const [messageID, height] of measuredMessageHeights) {
        measuredMessageHeights.set(messageID, Math.max(1, Math.round(height * ratio)))
      }
      changed = measuredMessageHeights.size > 0
    }
    measuredTranscriptWidth = width

    const liveIDs = new Set(transcriptRows().map((message) => message.id))
    for (const messageID of measuredMessageHeights.keys()) {
      if (liveIDs.has(messageID)) continue
      measuredMessageHeights.delete(messageID)
      changed = true
    }
    for (const child of scroll.getChildren()) {
      const messageID = child.id?.startsWith("queued-") ? child.id.slice("queued-".length) : child.id
      if (!messageID || !liveIDs.has(messageID)) continue
      const height = sessionMeasuredHeight(child.height, measuredMessageHeights.get(messageID))
      if (height === undefined || measuredMessageHeights.get(messageID) === height) continue
      measuredMessageHeights.set(messageID, height)
      changed = true
    }
    if (changed) setMessageHeightRevision((revision) => revision + 1)
    return changed
  }

  // Keep the child-session exit shortcut for states where the prompt is not mounted.
  const exit = useExit()

  const rememberSessionScroll = (sessionID: string) => {
    // Route updates remount the transcript before this effect runs. Never save the
    // newly mounted session's initial position under the session we just left.
    if (route.sessionID !== sessionID || !scroll || scroll.isDestroyed) return
    const anchor = captureScrollAnchor()
    sessionScrollStates.set(sessionID, {
      top: scroll.scrollTop,
      follow: followSessionOutput(),
      anchor,
    })
  }

  const navigate = (...args: Parameters<typeof navigateRoute>) => {
    rememberSessionScroll(activeSessionID)
    return navigateRoute(...args)
  }

  const sessionHistoryEnabled = () => tuiConfig.session_history?.enabled !== false
  const openSessionHistory = (selectedMessageID?: string) => {
    if (!sessionHistoryEnabled()) return
    navigate({
      type: "session-history",
      sessionID: route.sessionID,
      selectedMessageID,
      returnTo: { type: "session", sessionID: route.sessionID },
    })
  }

  const captureScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed) {
      scrollAnchor = undefined
      return undefined
    }

    scrollAnchor = sessionScrollAnchor({
      children: scroll.getChildren(),
      top: scroll.y,
      viewportHeight: scroll.viewport.height,
      transcriptChildIDs: transcriptChildIDs(),
    })
    return scrollAnchor
  }

  const persistSessionScroll = (sessionID: string) => {
    if (route.sessionID !== sessionID || !scroll || scroll.isDestroyed) return
    sessionScrollStates.set(sessionID, {
      top: scroll.scrollTop,
      follow: followSessionOutput(),
      anchor: scrollAnchor,
    })
  }

  const restoreScrollAnchor = (options?: { preserveMissing?: boolean }) => {
    if (!scroll || scroll.isDestroyed || !scrollAnchor) return false
    const anchor = scrollAnchor
    const child = scroll.getChildren().find((item) => item.id === anchor.id)
    if (!child) {
      if (!options?.preserveMissing) captureScrollAnchor()
      return false
    }

    const delta = child.y - scroll.y - anchor.offset
    if (delta !== 0) scroll.scrollBy(delta)
    if (virtualScrollAnchorID() === anchor.id) clearVirtualScrollAnchor()
    return true
  }

  const restoreScrollAfterPaging = (boundary: "top" | "bottom", anchor?: { id: string; offset: number }) => {
    const pagingToken = scrollPagingToken
    const restoreToken = ++scrollPagingRestoreToken
    const sessionID = route.sessionID
    scrollAnchor = anchor
    clearVirtualScrollAnchor()
    suppressedPagingBoundary = boundary
    const delays = [0, 16, 50, 120, 240, 480]
    delays.forEach((delay) => {
      setTimeout(() => {
        if (
          restoreToken !== scrollPagingRestoreToken ||
          pagingToken !== scrollPagingToken ||
          route.sessionID !== sessionID
        )
          return
        if (!scroll || scroll.isDestroyed) return
        if (
          anchor &&
          (boundary === "top" ? !isScrollboxAtTop(scroll, 1) : !isScrollboxAtBottom(scroll, 1))
        ) {
          // The user or the scrollbox already moved away from the paging edge.
          // Do not resurrect an old anchor into the virtual window: that would
          // mount rows around the old page while the physical viewport is at a
          // different position, producing a blank transcript on the next
          // scroll.
          scrollAnchor = undefined
          clearVirtualScrollAnchor()
          suppressedPagingBoundary = undefined
          setSessionScrollTop(scroll.scrollTop)
          persistSessionScroll(sessionID)
          return
        }
        armVirtualScrollAnchor(anchor?.id, anchor ? boundary : undefined)
        renderer.requestRender()
        const restored = Boolean(anchor && restoreScrollAnchor({ preserveMissing: true }))
        // Keep the outgoing anchor alive while the newly paged rows mount. If
        // the user moves before the anchor appears, cancelScrollPagingRestore
        // invalidates all remaining retries and leaves the manual position alone.
        if (!restored && anchor && delay !== delays[delays.length - 1]) return
        if (!restored) {
          scroll.scrollTo(boundary === "top" ? 0 : scroll.scrollHeight)
          clearVirtualScrollAnchor()
        }
        lastObservedScrollTop = scroll.scrollTop
        lastObservedScrollHeight = scroll.scrollHeight
        lastObservedViewportHeight = scroll.viewport.height
        setSessionScrollTop(scroll.scrollTop)
        persistSessionScroll(sessionID)
      }, delay)
    })
  }

  const cancelScrollPagingRestore = () => {
    scrollPagingRestoreToken += 1
    clearVirtualScrollAnchor()
  }

  const cancelBottomScrollTimers = () => {
    bottomScrollToken += 1
    routeBottomScrollToken += 1
    followBottomScrollToken += 1
    followBottomScrollSessionID = undefined
  }

  const cancelSubmitScrollIntent = (options?: { discard?: boolean }) => {
    if (options?.discard) {
      const messageID = submitScrollIntent()?.messageID
      if (messageID) submittedTurnIDs.delete(messageID)
    }
    submitScrollToken += 1
    applyingSubmitScroll = false
    setSubmitScrollIntent(undefined)
  }

  const reconcileSubmitScrollIntent = (token = submitScrollToken) => {
    const intent = submitScrollIntent()
    if (token !== submitScrollToken || !intent || route.sessionID !== intent.sessionID) return false
    if (!scroll || scroll.isDestroyed) return false
    renderer.requestRender()
    const child = scroll.getChildren().find((item) => item.id === intent.messageID)
    if (!child) return false
    applyingSubmitScroll = true
    const delta = child.y - scroll.y - intent.offset
    if (delta !== 0) scroll.scrollBy(delta)
    applyingSubmitScroll = false
    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
    lastObservedViewportHeight = scroll.viewport.height
    setSessionScrollTop(scroll.scrollTop)
    persistSessionScroll(intent.sessionID)
    return true
  }

  const scheduleSubmitScrollIntent = () => {
    const token = ++submitScrollToken
    ;[0, 16, 50, 120, 240, 480].forEach((delay) => {
      setTimeout(() => reconcileSubmitScrollIntent(token), delay)
    })
  }

  const activateSubmitScrollIntent = (input: { sessionID: string; messageID: string; offset?: number }) => {
    if (route.sessionID !== input.sessionID) return
    const currentID = submitScrollIntent()?.messageID
    if (currentID && currentID !== input.messageID) submittedTurnIDs.delete(currentID)
    cancelBottomScrollTimers()
    cancelScrollPagingRestore()
    scrollAnchor = undefined
    suppressedPagingBoundary = undefined
    restoringSessionScroll = false
    setFollowSessionOutput(false)
    setSubmitScrollIntent({ sessionID: input.sessionID, messageID: input.messageID, offset: input.offset ?? 0 })
    scheduleSubmitScrollIntent()
  }

  const syncScrollFollowMode = () => {
    if (!scroll || scroll.isDestroyed) return
    const heldAnchor = followSessionOutput() ? undefined : scrollAnchor ?? captureScrollAnchor()
    const scrollTop = scroll.scrollTop
    const scrollHeight = scroll.scrollHeight
    const viewportHeight = scroll.viewport.height
    const currentSessionID = route.sessionID
    if (restoringSessionScroll && currentSessionID === activeSessionID) return
    // Keep the active session's snapshot live while its keyed transcript still owns
    // the scrollbox. Do not recapture the anchor here: transcript growth has already
    // happened by the time this interval runs, so replacing it would lose the point
    // that must be held steady.
    persistSessionScroll(currentSessionID)
    setSessionScrollTop(scrollTop)
    const history = sync.session.history(currentSessionID)
    if (
      suppressedPagingBoundary &&
      shouldClearSessionPagingBoundarySuppression({
        boundary: suppressedPagingBoundary,
        hasMoreOlder: history.hasMoreOlder,
        hasMoreNewer: history.hasMoreNewer,
      })
    ) {
      suppressedPagingBoundary = undefined
    }
    const atTop = isScrollboxAtTop(scroll)
    const atBottom = isScrollboxAtBottom(scroll)
    const userMovedViewport = sessionUserMovedViewport({
      scrollTop,
      lastScrollTop: lastObservedScrollTop,
      scrollHeight,
      lastScrollHeight: lastObservedScrollHeight,
      viewportHeight,
      lastViewportHeight: lastObservedViewportHeight,
      followOutput: followSessionOutput(),
    })
    const contentHeightChanged = Math.abs(scrollHeight - lastObservedScrollHeight) > 1
    const viewportHeightChanged = Math.abs(viewportHeight - lastObservedViewportHeight) > 1
    const measurementsChanged = updateMountedMessageHeights()
    if (
      measurementsChanged &&
      heldAnchor &&
      shouldRestoreSessionScrollAnchor({
        now: Date.now(),
        manualScrollGraceUntil,
        userMovedViewport,
        hasAnchor: true,
      })
    ) {
      scrollAnchor = heldAnchor
      queueMicrotask(() => {
        if (!scroll || scroll.isDestroyed || followSessionOutput()) return
        renderer.requestRender()
        restoreScrollAnchor({ preserveMissing: true })
      })
    }

    if (submitScrollIntent()?.sessionID === currentSessionID) {
      if (userMovedViewport && !applyingSubmitScroll) {
        cancelSubmitScrollIntent({ discard: true })
        setFollowSessionOutput(false)
        captureScrollAnchor()
      } else {
        reconcileSubmitScrollIntent()
      }
      persistSessionScroll(currentSessionID)
      return
    }

    if (userMovedViewport) {
      blurCompactionArcade()
      cancelScrollPagingRestore()
      cancelBottomScrollTimers()
    }

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

    if (
      SESSION_OLDER_HISTORY_PAGING_ENABLED &&
      !followSessionOutput() &&
      atTop &&
      history.hasMoreOlder &&
      !history.loadingOlder &&
      !scrollPagingInFlight
    ) {
      if (suppressedPagingBoundary) {
        setFollowSessionOutput(false)
        persistSessionScroll(currentSessionID)
        return
      }
      const pagingToken = scrollPagingToken
      const pagingRestoreToken = scrollPagingRestoreToken
      const pagingAnchor = captureScrollAnchor()
      setFollowSessionOutput(false)
      persistSessionScroll(currentSessionID)
      scrollPagingInFlight = true
      void sync.session
        .loadOlder(currentSessionID)
        .then((loaded) => {
          if (!loaded) return
          if (
            pagingToken !== scrollPagingToken ||
            pagingRestoreToken !== scrollPagingRestoreToken ||
            route.sessionID !== currentSessionID
          )
            return
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
      const bottomFollowMode = sessionBottomFollowMode({
        alreadyFollowing: followSessionOutput(),
        hasMoreNewer: history.hasMoreNewer,
        loadingNewer: history.loadingNewer,
        suppressedBoundary: suppressedPagingBoundary,
      })
      const pagingAnchor =
        history.hasMoreNewer && !history.loadingNewer && !scrollPagingInFlight && !suppressedPagingBoundary
          ? captureScrollAnchor()
          : undefined
      scrollAnchor = undefined
      lastObservedScrollTop = scrollTop
      lastObservedScrollHeight = scrollHeight
      lastObservedViewportHeight = viewportHeight
      if (history.hasMoreNewer && !history.loadingNewer && !scrollPagingInFlight) {
        if (suppressedPagingBoundary) {
          setFollowSessionOutput(bottomFollowMode === "follow")
          persistSessionScroll(currentSessionID)
          return
        }
        const pagingToken = scrollPagingToken
        const pagingRestoreToken = scrollPagingRestoreToken
        setFollowSessionOutput(bottomFollowMode === "follow")
        persistSessionScroll(currentSessionID)
        scrollPagingInFlight = true
        void sync.session
          .loadNewer(currentSessionID)
          .then((loaded) => {
            if (!loaded) return
            if (
              pagingToken !== scrollPagingToken ||
              pagingRestoreToken !== scrollPagingRestoreToken ||
              route.sessionID !== currentSessionID
            )
              return
            restoreScrollAfterPaging("bottom", pagingAnchor)
          })
          .catch(() => undefined)
          .finally(() => {
            if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return
            scrollPagingInFlight = false
            if (bottomFollowMode === "follow" && pagingRestoreToken === scrollPagingRestoreToken) {
              setFollowSessionOutput(true)
              scheduleFollowBottomScroll(currentSessionID)
            }
          })
        return
      }
      if (suppressedPagingBoundary) {
        setFollowSessionOutput(bottomFollowMode === "follow")
        persistSessionScroll(currentSessionID)
        return
      }
      setFollowSessionOutput(true)
      persistSessionScroll(currentSessionID)
      return
    }

    if (isCompactionArcadeFocused()) {
      cancelBottomScrollTimers()
      persistSessionScroll(currentSessionID)
      return
    }

    if (
      shouldKeepSessionBottomFollow({
        following: followSessionOutput(),
        userMovedViewport,
        contentHeightChanged,
        viewportHeightChanged,
        compactionFocused: isCompactionArcadeFocused(),
      })
    ) {
      scheduleFollowBottomScroll(currentSessionID)
      persistSessionScroll(currentSessionID)
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
    setSessionScrollTop(scroll.scrollTop)
    persistSessionScroll(currentSessionID)

    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
    lastObservedViewportHeight = scroll.viewport.height
  }

  const markScrollDetached = () => {
    blurCompactionArcade()
    restoringSessionScroll = false
    cancelScrollPagingRestore()
    suppressedPagingBoundary = undefined
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    cancelSubmitScrollIntent({ discard: true })
    if (scroll && !scroll.isDestroyed) setSessionScrollTop(scroll.scrollTop)
    setFollowSessionOutput(false)
    setTimeout(() => {
      captureScrollAnchor()
      rememberSessionScroll(activeSessionID)
    }, 0)
  }

  const scrollToBottomIfAllowed = (options?: { force?: boolean }) => {
    if (!scroll || scroll.isDestroyed) return
    if (isCompactionArcadeFocused()) return
    if (submitScrollIntent()?.sessionID === route.sessionID) return
    if (!options?.force && !followSessionOutput()) return
    scrollAnchor = undefined
    renderer.requestRender()
    scroll.scrollTo(scroll.scrollHeight)
    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
    lastObservedViewportHeight = scroll.viewport.height
    setSessionScrollTop(scroll.scrollTop)
    rememberSessionScroll(activeSessionID)
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
          if (submitScrollIntent()?.sessionID === route.sessionID) {
            reconcileSubmitScrollIntent()
            return
          }
          if (followSessionOutput() && !isCompactionArcadeFocused()) scheduleBottomScroll(0, { force: true })
        })
      },
      { defer: true },
    ),
  )

  const scheduleFollowBottomScroll = (sessionID: string) => {
    if (submitScrollIntent()?.sessionID === sessionID) return
    if (followBottomScrollSessionID === sessionID) return
    followBottomScrollSessionID = sessionID
    const token = ++followBottomScrollToken
    const delays = SESSION_BOTTOM_FOLLOW_REFLOW_DELAYS_MS
    delays.forEach((delay, index) => {
      setTimeout(() => {
        if (token !== followBottomScrollToken || route.sessionID !== sessionID) return
        scrollToBottomIfAllowed({ force: true })
        if (index === delays.length - 1 || isScrollboxAtBottom(scroll, 1)) {
          if (token === followBottomScrollToken) followBottomScrollSessionID = undefined
        }
      }, delay)
    })
  }

  const scheduleTerminalReceiptBottomScroll = (sessionID: string) => {
    if (submitScrollIntent()?.sessionID === sessionID) return
    const token = ++routeBottomScrollToken
    // The terminal receipt and disappearing activity row settle across more
    // than one OpenTUI layout pass. Keep the bounded follow through that reflow.
    ;[0, 16, 50, 120].forEach((delay) => {
      setTimeout(() => scrollToBottomForRouteToken(token, sessionID, { force: true }), delay)
    })
  }

  createEffect(
    on(
      () => {
        const assistant = lastAssistant()
        const hasActiveTool = assistant
          ? (sync.data.part[assistant.id] ?? []).some(
              (part) =>
                part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
            )
          : false
        return [
          route.sessionID,
          assistant?.id,
          assistant?.finish,
          assistant?.time.completed,
          Boolean(assistant?.error),
          hasActiveTool,
          followSessionOutput(),
          submitScrollIntent()?.sessionID === route.sessionID,
        ] as const
      },
      ([sessionID, assistantID, finish, completed, error, hasActiveTool, following, submitIntentActive]) => {
        if (
          !sessionTerminalReceiptShouldFollow({
            following,
            submitIntentActive,
            hasActiveTool,
            assistant: assistantID ? { finish, error: error || undefined, time: { completed } } : undefined,
          })
        )
          return
        scheduleTerminalReceiptBottomScroll(sessionID)
      },
      { defer: true },
    ),
  )

  const scheduleSessionScrollRestore = (sessionID: string, state?: SessionScrollState) => {
    const token = ++routeBottomScrollToken
    const delays = [0, 16, 50, 120, 240, 480, 960]
    const target = sessionScrollTarget(state)
    delays.forEach((delay) => {
      setTimeout(() => {
        if (token !== routeBottomScrollToken || route.sessionID !== sessionID) return
        if (!scroll || scroll.isDestroyed) {
          if (delay === delays[delays.length - 1]) restoringSessionScroll = false
          return
        }
        if (target !== "bottom") {
          renderer.requestRender()
          const restored = state?.anchor ? restoreScrollAnchor({ preserveMissing: true }) : false
          if (!restored) {
            scroll.scrollTo(target)
            if (delay === delays[delays.length - 1]) clearVirtualScrollAnchor()
          }
          lastObservedScrollTop = scroll.scrollTop
          lastObservedScrollHeight = scroll.scrollHeight
          lastObservedViewportHeight = scroll.viewport.height
          setSessionScrollTop(scroll.scrollTop)

          if (delay === delays[delays.length - 1]) restoringSessionScroll = false
          return
        }
        setFollowSessionOutput(true)
        scrollToBottomIfAllowed({ force: true })
        if (delay === delays[delays.length - 1]) restoringSessionScroll = false
      }, delay)
    })
  }

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        if (!sessionID) return
        if (activeSessionID !== sessionID) rememberSessionScroll(activeSessionID)
        activeSessionID = sessionID
        measuredMessageHeights.clear()
        measuredTranscriptWidth = 0
        setMessageHeightRevision((revision) => revision + 1)
        const remembered = sessionScrollStates.get(sessionID)
        scrollPagingToken += 1
        cancelScrollPagingRestore()
        scrollPagingInFlight = false
        suppressedPagingBoundary = undefined
        scrollAnchor = remembered?.anchor
        armVirtualScrollAnchor(remembered?.follow ? undefined : remembered?.anchor?.id)
        lastObservedScrollTop = 0
        lastObservedScrollHeight = 0
        lastObservedViewportHeight = 0
        manualScrollGraceUntil = 0
        cancelBottomScrollTimers()
        cancelSubmitScrollIntent()
        cancelSubmitFollowSync()
        submittedTurnIDs.clear()
        setSubmittedUserMessageID(undefined)
        const submitted = route.submitted
        if (submitted) {
          submittedTurnIDs.add(submitted.messageID)
          setSubmittedUserMessageID(submitted.messageID)
          restoringSessionScroll = false
          setSessionScrollTop(0)
          setFollowSessionOutput(false)
          lastSessionEventAt = Date.now()
          if (scroll && !scroll.isDestroyed) {
            scroll.scrollTo(0)
            lastObservedScrollTop = scroll.scrollTop
            lastObservedScrollHeight = scroll.scrollHeight
            lastObservedViewportHeight = scroll.viewport.height
          }
          scheduleSubmitFollowSync({
            sessionID,
            messageID: submitted.messageID,
            inputRows: submitted.inputRows,
            queuedBehindActiveTurn: submitted.queuedBehindActiveTurn === true,
          })
          if (!submitted.queuedBehindActiveTurn) {
            activateSubmitScrollIntent({ sessionID, messageID: submitted.messageID })
          }
          return
        }
        const targetScrollTop = sessionScrollTarget(remembered)
        restoringSessionScroll = true
        setSessionScrollTop(targetScrollTop === "bottom" ? 0 : targetScrollTop)
        setFollowSessionOutput(remembered?.follow ?? true)
        lastSessionEventAt = Date.now()
        if (scroll && !scroll.isDestroyed && targetScrollTop !== "bottom") {
          scroll.scrollTo(targetScrollTop)
          lastObservedScrollTop = scroll.scrollTop
          lastObservedScrollHeight = scroll.scrollHeight
          lastObservedViewportHeight = scroll.viewport.height
          setSessionScrollTop(scroll.scrollTop)
        }
        scheduleSessionScrollRestore(sessionID, remembered)
      },
    ),
  )

  const scrollBySession = (delta: number) => {
    blurCompactionArcade()
    restoringSessionScroll = false
    cancelScrollPagingRestore()
    if (
      suppressedPagingBoundary &&
      shouldClearSessionPagingBoundarySuppression({
        boundary: suppressedPagingBoundary,
        hasMoreOlder: sync.session.history(route.sessionID).hasMoreOlder,
        hasMoreNewer: sync.session.history(route.sessionID).hasMoreNewer,
        direction: delta < 0 ? "up" : "down",
      })
    ) {
      suppressedPagingBoundary = undefined
    }
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    cancelSubmitScrollIntent({ discard: true })
    scroll.scrollBy(delta)
    setSessionScrollTop(scroll.scrollTop)
    rememberSessionScroll(activeSessionID)
    setTimeout(syncScrollFollowMode, 0)
  }
  const scrollToSession = (position: number) => {
    blurCompactionArcade()
    restoringSessionScroll = false
    cancelScrollPagingRestore()
    manualScrollGraceUntil = Date.now() + 250
    cancelBottomScrollTimers()
    cancelSubmitScrollIntent({ discard: true })
    scroll.scrollTo(position)
    setSessionScrollTop(scroll.scrollTop)
    rememberSessionScroll(activeSessionID)
    setTimeout(syncScrollFollowMode, 0)
  }
  const [validatedExitSessionID, setValidatedExitSessionID] = createSignal<string>()
  let exitSessionValidationToken = 0

  onMount(() => {
    const timer = setInterval(syncScrollFollowMode, 80)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => rememberSessionScroll(activeSessionID))

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

  function toBottom(options?: { sync?: boolean }) {
    cancelSubmitScrollIntent({ discard: true })
    cancelScrollPagingRestore()
    setFollowSessionOutput(true)
    scrollAnchor = undefined
    suppressedPagingBoundary = undefined
    if (options?.sync !== false) void sync.session.sync(route.sessionID, { force: true }).catch(() => undefined)
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
      submittedTurnIDs.add(info.messageID)
      setSubmittedUserMessageID(info.messageID)
      scheduleSubmitFollowSync(info)
      if (!info.queuedBehindActiveTurn) {
        activateSubmitScrollIntent({ sessionID: info.sessionID, messageID: info.messageID })
      }
    }
  }

  onCleanup(() => {
    cancelSubmitFollowSync()
    cancelSubmitScrollIntent()
  })

  const virtualScrollAnchorIndex = createMemo(() => {
    const intent = submitScrollIntent()
    const virtualAnchorID = virtualScrollAnchorID()
    const anchorID = intent?.sessionID === route.sessionID ? intent.messageID : virtualAnchorID
    if (!anchorID) return
    if (virtualAnchorID && virtualScrollAnchorBoundary && scroll && !scroll.isDestroyed) {
      const atBoundary =
        virtualScrollAnchorBoundary === "top" ? isScrollboxAtTop(scroll, 1) : isScrollboxAtBottom(scroll, 1)
      if (!atBoundary) return
    }
    const index = transcriptRows().findIndex((message) => message.id === anchorID)
    return index >= 0 ? index : undefined
  })
  const virtualWindow = createMemo(() =>
    (() => {
      messageHeightRevision()
      const rows = transcriptRows()
      return sessionMessageVirtualWindow({
        total: rows.length,
        scrollTop: sessionScrollTop(),
        viewportHeight: scroll && !scroll.isDestroyed ? scroll.viewport.height : dimensions().height,
        followOutput: followSessionOutput(),
        anchorIndex: virtualScrollAnchorIndex(),
        itemHeights: rows.map((message) => measuredMessageHeights.get(message.id)),
      })
    })(),
  )
  const visibleMessages = createMemo(() => {
    const window = virtualWindow()
    return transcriptRows().slice(window.start, window.end)
  })
  const visibleMessageIDs = createMemo(() => visibleMessages().map((message) => message.id))

  createEffect(() => {
    const pinnedID = pinnedTurnUserMessageID()
    const anchoredID = submitScrollIntent()?.messageID
    const pinnedIsMountedTurn =
      pinnedID !== undefined &&
      submittedTurnIDs.has(pinnedID) &&
      transcriptRows().some((message) => message.id === pinnedID)
    if (pinnedIsMountedTurn && pinnedID !== anchoredID) {
      activateSubmitScrollIntent({ sessionID: route.sessionID, messageID: pinnedID })
      return
    }
    if (pinnedIsMountedTurn) reconcileSubmitScrollIntent()

    const intent = submitScrollIntent()
    if (!intent || intent.sessionID !== route.sessionID) return
    const child = messages().findLast(
      (message): message is AssistantMessage => message.role === "assistant" && message.parentID === intent.messageID,
    )
    const settlement = sessionSubmitScrollSettlement({
      intentMessageID: intent.messageID,
      pinnedMessageID: pinnedTurnUserMessageID(),
      assistant: child,
    })
    if (settlement !== "follow") return
    submittedTurnIDs.delete(intent.messageID)
    if (submittedUserMessageID() === intent.messageID) setSubmittedUserMessageID(undefined)
    cancelSubmitScrollIntent()
    scrollAnchor = undefined
    suppressedPagingBoundary = undefined
    setFollowSessionOutput(true)
    scheduleTerminalReceiptBottomScroll(route.sessionID)
  })

  const renderSnapshot = (includeVisibleIDs = true) => {
    const window = virtualWindow()
    const mountedChildren = scroll && !scroll.isDestroyed ? scroll.getChildren() : []
    const mountedIDs = mountedChildren.flatMap((child) => (child.id ? [child.id] : []))
    const mountedIDCounts = mountedIDs.reduce(
      (counts, id) => counts.set(id, (counts.get(id) ?? 0) + 1),
      new Map<string, number>(),
    )

    return {
      sessionID: route.sessionID,
      messageCount: transcriptRows().length,
      queuedCount: queuedMessages().length,
      visibleCount: visibleMessages().length,
      visibleIDs: includeVisibleIDs ? visibleMessageIDs() : undefined,
      start: window.start,
      end: window.end,
      virtualized: window.virtualized,
      topSpacer: window.topSpacer,
      bottomSpacer: window.bottomSpacer,
      scrollTop: scroll && !scroll.isDestroyed ? scroll.scrollTop : sessionScrollTop(),
      sessionScrollTop: sessionScrollTop(),
      scrollHeight: scroll && !scroll.isDestroyed ? scroll.scrollHeight : undefined,
      viewportHeight: scroll && !scroll.isDestroyed ? scroll.viewport.height : undefined,
      maxScrollTop:
        scroll && !scroll.isDestroyed ? Math.max(0, scroll.scrollHeight - scroll.viewport.height) : undefined,
      follow: followSessionOutput(),
      renderKey: transcriptRenderKey(),
      anchorID: scrollAnchor?.id,
      anchorOffset: scrollAnchor?.offset,
      pinnedUserID: pinnedTurnUserMessageID(),
      stickyUserID: stickyUserMessageID(),
      mountedChildCount: mountedChildren.length,
      mountedFirstID: mountedIDs[0],
      mountedLastID: mountedIDs.at(-1),
      duplicateMountedIDs: [...mountedIDCounts].filter(([, count]) => count > 1).map(([id]) => id),
    }
  }

  createEffect(
    on(
      () =>
        [
          route.sessionID,
          transcriptRows().length,
          queuedMessages().length,
          visibleMessages().length,
          virtualWindow().start,
          virtualWindow().end,
        ] as const,
      () => {
        trace.trace("virtual-window", renderSnapshot())
        if (submitScrollIntent()?.sessionID === route.sessionID) {
          reconcileSubmitScrollIntent()
          return
        }
        if (followSessionOutput()) scheduleFollowBottomScroll(route.sessionID)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        [
        route.sessionID,
        sessionScrollTop(),
        followSessionOutput(),
        pinnedTurnUserMessageID(),
        stickyUserMessageID(),
        transcriptRenderKey(),
      ] as const,
      () => trace.trace("render-scroll-state", renderSnapshot(false)),
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
        const messageID = child.id?.startsWith("queued-") ? child.id.slice("queued-".length) : child.id
        const message = messageID ? byID.get(messageID) : undefined
        if (message?.role !== "user") return
        return { id: message.id, y: child.y }
      })
      .filter((item): item is { id: string; y: number } => Boolean(item))
      .sort((a, b) => a.y - b.y)

    const pinnedID = pinnedTurnUserMessageID()
    if (pinnedID) {
      const pinnedAnchor = userAnchors.find((item) => item.id === pinnedID)
      const pinnedIndex = transcriptRows().findIndex((message) => message.id === pinnedID)
      if (
        (pinnedIndex >= 0 && pinnedIndex < virtualWindow().start) ||
        shouldPinSessionStickyUserHeader({
          pinnedUserID: pinnedID,
          pinnedAnchor,
          top,
        })
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
        messages: transcriptRows(),
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

  function navigateToLoopOwner(dialog: DialogContext) {
    const ownerSessionID = currentLoopWorkflow()?.ownerSessionID
    if (ownerSessionID) navigate({ type: "session", sessionID: ownerSessionID })
    else navigate({ type: "home" })
    dialog.clear()
  }

  async function resolveWorkflowTaskContext(sessionID: string) {
    if (sessionID === route.sessionID) {
      const current = currentWorkflowTask()
      if (current) return current
    }
    const response = await sdk.client.workflow.list({ limit: 100 }).catch(() => undefined)
    return workflowTaskSessionContext({ sessionID, workflows: response?.data ?? [] })
  }

  async function navigateWorkflowTask(direction: -1 | 1, dialog: DialogContext) {
    const currentSessionID = route.sessionID
    const workflowTask = await resolveWorkflowTaskContext(currentSessionID)
    if (!workflowTask || route.sessionID !== currentSessionID) return false
    if (workflowTask.sessionIDs.length < 2) {
      toast.show({ variant: "info", message: "No other workflow task chat is available yet.", duration: 2500 })
      dialog.clear()
      return true
    }
    const sessionID = workflowTaskSiblingSessionID({
      sessionID: currentSessionID,
      sessionIDs: workflowTask.sessionIDs,
      direction,
    })
    if (sessionID) navigate({ type: "session", sessionID })
    dialog.clear()
    return true
  }

  async function navigateToSessionParent(dialog: DialogContext) {
    const currentSessionID = route.sessionID
    const knownWorkflowTask = currentWorkflowTask()
    if (knownWorkflowTask) {
      navigate({
        type: "workflows",
        selectedID: knownWorkflowTask.runID,
        returnTo: { type: "session", sessionID: currentSessionID },
      })
      dialog.clear()
      return
    }
    const parentSessionID = session()?.parentID
    if (!parentSessionID) return
    const response = await sdk.client.workflow.list({ limit: 100 }).catch(() => undefined)
    if (route.sessionID !== currentSessionID) return
    const workflowTask = workflowTaskSessionContext({ sessionID: currentSessionID, workflows: response?.data ?? [] })
    if (workflowTask) {
      navigate({
        type: "workflows",
        selectedID: workflowTask.runID,
        returnTo: { type: "session", sessionID: currentSessionID },
      })
      dialog.clear()
      return
    }
    navigate({
      type: "session",
      sessionID: workflowParentSessionID({
        sessionID: currentSessionID,
        parentSessionID,
        workflows: response?.data ?? [],
      }) ?? parentSessionID,
    })
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
    if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
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
    const loopItems = await refreshLoopWorkflows()
    if (route.sessionID !== sessionID) return
    const workflow = loopItems.find((item) => item.rootSessionID === sessionID)
    if (workflow) {
      setLoopBackgroundSummary(`Loop ${formatLoopWorkflowState(workflow.state, workflow.phase ?? "ready")}`)
      return
    }
    const info = await currentBackgroundSession(sessionID).catch(() => undefined)
    if (route.sessionID !== sessionID) return
    const title = session()?.title
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
          if (type?.startsWith("workflow.")) void refetchWorkflowTaskRuns()
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

  // Esc must cancel the active turn even when a transcript, widget, or an
  // autocomplete renderable owns focus. Pending approval/question UIs retain
  // their own Esc semantics (reject/close) and are deliberately excluded.
  useKeyboard((evt) => {
    if (
      !shouldHandleGlobalSessionInterrupt({
        eventName: evt.name,
        defaultPrevented: evt.defaultPrevented,
        activeTurn: Boolean(pending() || sessionWorking() || hasLocalActiveTurn()),
        pendingInput: disabled(),
      })
    )
      return
    evt.preventDefault()
    evt.stopPropagation()
    command.trigger("session.interrupt")
  })

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
        'Default to report-only unless I explicitly allow edits. Spanish/English requests such as codear, implementar, fixear, editar, hacer cambios, probar, compilar, run tests, or build are explicit edit permission for the loop; use permissionMode `normal` or `custom`, set `reportOnly: false`, and keep safety gates for push/merge/release/destructive shell. If I choose a model and reasoning effort/variant, pass `model` as provider/model and pass the effort as `variant` (for example `variant: "medium"`), or use provider/model#variant. For interval cadence, set `triggerMode: "interval"` and convert the interval to `intervalMs`; for a local daily schedule, set `triggerMode: "daily"`, `dailyAt` as `HH:mm`, and an explicit IANA `timezone`. Preserve the current session model by omitting `model` unless I choose one.',
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
      title: "Browse complete session history",
      value: "session.history",
      keybind: "session_history",
      category: "Session",
      enabled: sessionHistoryEnabled(),
      slash: {
        name: "history",
        aliases: ["session-history"],
      },
      onSelect: (dialog) => {
        dialog.clear()
        openSessionHistory()
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
            isQueued={(messageID) => queuedMessageIDs().has(messageID)}
            onEditPrompt={editQueuedPrompt}
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
        : "Loads historical tool calls progressively so long sessions stay responsive.",
      onSelect: async (dialog) => {
        const enable = !showCompactedToolCalls()
        if (enable) {
          const confirmed = await DialogConfirm.show(
            dialog,
            "Show all compacted tool calls?",
            "This loads additional historical tool calls in bounded pages as you scroll. You can disable it again from Ctrl+P.",
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
      enabled: !!currentWorkflowTask() || !!session()?.parentID || !!currentLoopWorkflow(),
      onSelect: (dialog) => {
        if (dialog.stack.length > 0) return
        if (!session()?.parentID && currentLoopWorkflow()) {
          navigateToLoopOwner(dialog)
          return
        }
        void navigateToSessionParent(dialog).catch((error) => toast.error(error))
      },
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!currentWorkflowTask() || !!session()?.parentID,
      onSelect: (dialog) => {
        if ((!currentWorkflowTask() && !session()?.parentID) || dialog.stack.length > 0) return
        void navigateWorkflowTask(1, dialog)
          .then((handled) => {
            if (handled) return
            moveChild(1)
            dialog.clear()
          })
          .catch((error) => toast.error(error))
      },
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!currentWorkflowTask() || !!session()?.parentID,
      onSelect: (dialog) => {
        if ((!currentWorkflowTask() && !session()?.parentID) || dialog.stack.length > 0) return
        void navigateWorkflowTask(-1, dialog)
          .then((handled) => {
            if (handled) return
            moveChild(-1)
            dialog.clear()
          })
          .catch((error) => toast.error(error))
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
        latestTodoWritePartID,
        latestCompletedTodoWritePartID,
        interrupted: sessionInterruptRequested,
        now,
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
                  <text fg={sessionAccent()} wrapMode="none">
                    {topbarLeftLabel()}
                  </text>
                </box>
                <Show when={topbarNavVisible() && topbarLayout().navWidth > 0}>
                  <box width={topbarLayout().navWidth} overflow="hidden" flexShrink={0}>
                    <SessionTopNav
                      mode={currentWorkflowTask() ? "workflow-task" : session()?.parentID ? "subagent" : "loop"}
                      canCycle={currentWorkflowTask() ? (currentWorkflowTask()?.sessionIDs.length ?? 0) > 1 : !!session()?.parentID}
                      hasParent={!!currentLoopWorkflow()?.ownerSessionID}
                      width={topbarLayout().navWidth}
                    />
                  </box>
                </Show>
              </box>
              <Show when={topbarLayout().titleGapWidth > 0}>
                <box width={topbarLayout().titleGapWidth} flexShrink={0} />
              </Show>
              <Show when={headerTitleVisible() && topbarLayout().titleWidth > 0}>
                <box
                  width={topbarLayout().titleWidth}
                  flexShrink={0}
                  overflow="hidden"
                  flexDirection="row"
                  justifyContent={headerTitleJustify()}
                >
                  <text fg={sessionAccent()} wrapMode="none">
                    {headerTitleDisplay()}
                  </text>
                </box>
              </Show>
              <box flexGrow={1} minWidth={topbarLayout().metricsGapWidth} />
              <Show when={topbarLayout().metricsWidth > 0}>
                <box width={topbarLayout().metricsWidth} overflow="hidden" flexShrink={0} justifyContent="flex-end">
                  <SessionTopMetrics
                    diff={topbarDiffStats()}
                    usage={topbarUsage()}
                    showDiffCount={tuiCustomization().diffCount}
                    showDiffFiles={tuiCustomization().diffFiles}
                  />
                </box>
              </Show>
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
                    scrollX
                    horizontalScrollbarOptions={{
                      paddingTop: 1,
                      trackOptions: {
                        backgroundColor: theme.backgroundElement,
                        foregroundColor: theme.border,
                      },
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
                    onMouseScroll={() => queueMicrotask(markScrollDetached)}
                  >
                    <Show
                      when={sessionHistoryBoundaryVisible({
                        enabled: sessionHistoryEnabled(),
                        hasMoreOlder: sync.session.history(route.sessionID).hasMoreOlder,
                      })}
                    >
                      <box
                        width="100%"
                        flexDirection="row"
                        justifyContent="space-between"
                        paddingLeft={2}
                        paddingRight={2}
                        paddingTop={1}
                        paddingBottom={1}
                        backgroundColor={theme.backgroundPanel}
                        onMouseUp={() => openSessionHistory(visibleMessageIDs().at(0))}
                      >
                        <text fg={theme.text}>↑ Earlier session history</text>
                        <text fg={theme.textMuted}>
                          {keybind.print("session_history")} or /history
                        </text>
                      </box>
                    </Show>
                    <box height={1} />
                    <Show when={virtualWindow().topSpacer > 0}>
                      <box height={virtualWindow().topSpacer} flexShrink={0} />
                    </Show>
                    <For each={visibleMessageIDs()}>
                      {(messageID, index) => {
                        return (
                          <Show when={messageByID().get(messageID)}>
                          {(message) => {
                            return (
                            <Switch>
                              <Match when={message().id === revert()?.messageID}>
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
                                    <text fg={theme.textMuted}>
                                              {revert()!.reverted.length} message reverted
                                            </text>
                                            <text fg={theme.textMuted}>
                                              <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span>{" "}
                                              or /redo to restore
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
                                                        <span style={{ fg: theme.diffRemoved }}>
                                                          {" "}
                                                          -{file.deletions}
                                                        </span>
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
                          <Match when={revert()?.messageID && message().id >= revert()!.messageID}>
                            <></>
                          </Match>
                           <Match when={queuedMessageIDs().has(message().id)}>
                             <UserMessage
                               index={virtualWindow().start + index()}
                               message={message() as UserMessage}
                               parts={sync.data.part[message().id] ?? []}
                               queued
                               sticky
                               anchorID={`queued-${message().id}`}
                               onSendNow={() => void sendQueuedNow(message().id)}
                               sendNowPending={sendNowMessageID() === message().id}
                               simpleHistory={false}
                               compactSubagentPrompt={Boolean(session()?.parentID)}
                               onMouseUp={() => {
                                 if (renderer.getSelection()?.getSelectedText()) return
                                 dialog.replace(() => (
                                   <DialogMessage
                                     messageID={message().id}
                                     sessionID={route.sessionID}
                                     queued
                                     setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                                     onEditPrompt={editQueuedPrompt}
                                   />
                                 ))
                               }}
                             />
                           </Match>
                           <Match when={message().role === "user" && !queuedMessageIDs().has(message().id)}>
                            <UserMessage
                              index={virtualWindow().start + index()}
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
                              message={message() as UserMessage}
                              parts={sync.data.part[message().id] ?? []}
                              onSendNow={() => void sendQueuedNow(message().id)}
                              sendNowPending={sendNowMessageID() === message().id}
                              simpleHistory={
                                !showCompactedToolCalls() &&
                                shouldUseSimpleSessionHistory({
                                  messageID: message().id,
                                  fullStartID: fullHistoryStartID(),
                                })
                              }
                              compactSubagentPrompt={Boolean(session()?.parentID)}
                            />
                           </Match>
                          <Match when={message().role === "assistant"}>
                            <box id={message().id} width="100%" flexDirection="column" flexShrink={0}>
                              <AssistantMessage
                                last={lastAssistant()?.id === message().id}
                                message={message() as AssistantMessage}
                                parts={sync.data.part[message().id] ?? []}
                                simpleHistory={
                                  !showCompactedToolCalls() &&
                                  shouldUseSimpleSessionHistory({
                                    messageID: message().id,
                                    fullStartID: fullHistoryStartID(),
                                  })
                                }
                              />
                            </box>
                          </Match>
                            </Switch>
                            )
                          }}
                          </Show>
                        )
                      }}
                    </For>
                    <box height={sessionTranscriptBottomSpacer(virtualWindow().bottomSpacer)} flexShrink={0} />
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
                      sticky
                      simpleHistory={false}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        dialog.replace(() => (
                          <DialogMessage
                            messageID={message().id}
                            sessionID={route.sessionID}
                            queued={queuedMessageIDs().has(message().id)}
                            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                            onEditPrompt={queuedMessageIDs().has(message().id) ? editQueuedPrompt : undefined}
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
                    status: sessionPendingInputStatus({
                      permissionCount: permissionPendingCount(),
                      questionCount: questions().length,
                      planReviewCount: planReviews().length,
                      assistantActive: Boolean(pending()),
                    }),
                    permission: permissionModeLabel(),
                  }}
                />
              </Show>
              <For each={listMendWidgets("aboveEditor")}>{(item) => <RenderMendWidget item={item} />}</For>
              {/* Do not keep the hidden prompt subtree mounted while a question/permission owns input. */}
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
                          onInterruptChange={setSessionInterruptRequested}
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

function SessionTopMetrics(props: {
  diff?: GitDiffStats
  usage?: ReturnType<typeof formatAssistantUsage>
  showDiffCount?: boolean
  showDiffFiles?: boolean
}) {
  const { theme } = useTheme()
  const showDiffCount = createMemo(() => props.showDiffCount !== false)
  const showDiffFiles = createMemo(() => props.showDiffFiles === true)
  const hasDiffFiles = createMemo(() => Boolean(props.diff && showDiffFiles() && props.diff.files !== undefined))
  const hasDiffCount = createMemo(() => Boolean(props.diff && showDiffCount()))
  const hasDiff = createMemo(() => hasDiffFiles() || hasDiffCount())

  return (
    <box flexDirection="row" flexShrink={0}>
      <Show when={hasDiffFiles() && props.diff}>
        {(diff) => (
          <text fg={theme.textMuted} wrapMode="none">
            {diff().files ?? 0} file{diff().files === 1 ? "" : "s"}
          </text>
        )}
      </Show>
      <Show when={hasDiffCount() && props.diff}>
        {(diff) => (
          <text wrapMode="none">
            <Show when={hasDiffFiles()}>
              <span style={{ fg: theme.textMuted }}> </span>
            </Show>
            <span style={{ fg: theme.diffAdded }}>+{compactNumber(diff().added)}</span>
            <span style={{ fg: theme.textMuted }}> </span>
            <span style={{ fg: theme.diffRemoved }}>-{compactNumber(diff().removed)}</span>
          </text>
        )}
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

function SessionTopNav(props: { mode: "subagent" | "workflow-task" | "loop"; canCycle?: boolean; hasParent?: boolean; width: number }) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const items = createMemo<(SessionTopbarNavItem & {
    id: "parent" | "prev" | "next"
    commandID: "session.parent" | "session.child.previous" | "session.child.next"
  })[]>(() => {
    const all = [
      {
        id: "parent" as const,
        icon: props.mode === "workflow-task" ? "↑" : "↖",
        label: props.mode === "workflow-task" ? "Workflow" : props.mode === "loop" ? (props.hasParent ? "Parent" : "Agent View") : "Parent",
        key: keybind.print("session_parent"),
        commandID: "session.parent" as const,
      },
      {
        id: "prev" as const,
        icon: "←",
        label: props.mode === "workflow-task" ? "Prev task" : props.mode === "loop" ? "Prev loop" : "Prev",
        key: keybind.print("session_child_cycle_reverse"),
        commandID: "session.child.previous" as const,
      },
      {
        id: "next" as const,
        icon: "→",
        label: props.mode === "workflow-task" ? "Next task" : props.mode === "loop" ? "Next loop" : "Next",
        key: keybind.print("session_child_cycle"),
        commandID: "session.child.next" as const,
      },
    ]
    return props.mode === "subagent" || props.canCycle ? all : all.slice(0, 1)
  })
  const layout = createMemo(() => sessionTopbarNavLayout({ width: props.width, items: items() }))

  return (
    <box width={Math.max(0, props.width)} overflow="hidden" flexDirection="row" flexShrink={0} gap={layout().gap}>
      <For each={items()}>
        {(item, index) => (
          <Show when={layout().items[index()]}>
            {(display) => (
              <box
                width={display().width}
                flexShrink={0}
                overflow="hidden"
                onMouseOver={() => setHover(item.id)}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger(item.commandID)}
                backgroundColor={hover() === item.id ? theme.backgroundElement : theme.background}
              >
                <text fg={theme.text} wrapMode="none" overflow="hidden">
                  {display().icon}
                  <Show when={display().showLabel}>{` ${display().label}`}</Show>
                  <Show when={display().showKey && display().key}>
                    {(key) => <span style={{ fg: theme.textMuted }}>{` ${key()}`}</span>}
                  </Show>
                </text>
              </box>
            )}
          </Show>
        )}
      </For>
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
  status?: { type: string; kind?: string; attempt?: number; message?: string; next?: number; startedAt?: number }
  messages: Message[]
  pendingInputCount: number
  now?: number
  connectionStatus?: string
  hasActiveTool?: boolean
}) {
  if (input.pendingInputCount > 0) return "needs input"
  const terminalAssistantSettles = terminalAssistantSettlesActivity({
    statusType: input.status?.type,
    statusKind: input.status?.kind,
    statusStartedAt: input.status?.type === "busy" ? input.status.startedAt : undefined,
    latestMessage: input.messages.findLast((message) => message.role === "assistant"),
    hasActiveTool: input.hasActiveTool,
  })
  if (
    input.status?.type === "retry" &&
    !terminalAssistantSettles &&
    isAssistantWorking({ statusType: input.status.type, now: input.now, statusNext: input.status.next })
  )
    return input.status.attempt && input.status.attempt > 1 ? `retry #${input.status.attempt}` : "retrying"
  const lastUser = input.messages.findLast((message) => message.role === "user")
  const lastAssistant = input.messages.findLast((message) => message.role === "assistant")
  if (
    input.status?.type === "busy" &&
    !terminalAssistantSettles &&
    isAssistantWorking({
      statusType: input.status.type,
      statusKind: input.status.kind,
      now: input.now,
      assistantCreated: lastAssistant?.time.created,
      statusUntil: (input.status as { until?: number }).until,
      hasActiveTool: input.hasActiveTool,
    })
  )
    return "working"
  if (
    lastAssistant &&
    !lastAssistant.time.completed &&
    isAssistantWorking({ now: input.now, assistantCreated: lastAssistant.time.created })
  )
    return "working"
  if (
    shouldShowAgentStateUnknown({
      connectionStatus: input.connectionStatus ?? "disconnected",
      hasUncertainAgentState:
        input.status?.type === "busy" ||
        input.status?.type === "retry" ||
        Boolean(lastAssistant && !lastAssistant.time.completed),
    })
  ) return SESSION_AGENT_STATE_UNKNOWN_MESSAGE
  if (lastUser && (!lastAssistant || lastAssistant.time.created < lastUser.time.created)) return "waiting"
  if (lastAssistant) return "responded"
  return "ready"
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

export function shouldClearSessionPagingBoundarySuppression(input: {
  boundary: "top" | "bottom"
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  direction?: "up" | "down"
}) {
  if (input.boundary === "top" && !input.hasMoreOlder) return true
  if (input.boundary === "bottom" && !input.hasMoreNewer) return true
  if (!input.direction) return false
  return input.boundary === "top" ? input.direction === "up" : input.direction === "down"
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
  return latestCompletedCompactionSummaryID(
    messages.map((message) => ({
      ...message,
      time: { created: message.time.created ?? 0, completed: message.time.completed },
    })),
  )
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
  editableScratchpad?: boolean
}) {
  const sdk = useSDK()
  const { theme, syntax } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const messageWidth = createMemo(() =>
    sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)),
  )
  const contentWidth = createMemo(() => Math.max(1, messageWidth() - 3))
  const renderWidth = createMemo(() => Math.min(contentWidth(), 100))
  const scratchpadAllowed = createMemo(
    () => props.editableScratchpad || mend.profile.presentation.compaction.allowScratchpad,
  )
  const summaryPreview = createMemo(() => compactionSummaryPreview(props.summaryPreview, 360))
  const transcriptPreview = createMemo(() => compactPreviewLine(props.transcriptPreview, 180))
  const summaryContent = createMemo(() => {
    const summary = props.summaryPreview?.trim()
    if (!summary) return ""
    return renderPlanMarkdownStatic(summary, renderWidth(), { tableMode: "grid", markdownMode: "tables-only" })
  })
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
      summaryContent={
        summaryContent() ? (
        <box paddingTop={1}>
          <StyledPlanMarkdown
            syntaxStyle={syntax()}
            width={contentWidth()}
            content={summaryContent()}
            tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
            conceal={true}
            fg={theme.text}
            bg={theme.backgroundPanel}
            stableTextMode={false}
            colorizeHex={true}
          />
        </box>
        ) : undefined
      }
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
  queued?: boolean
  anchorID?: string
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
  const [expandedFiles, setExpandedFiles] = createSignal(false)
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
  const compactFiles = createMemo(() => shouldCollapseUserMessageAttachments(files().length))
  const visibleFiles = createMemo(() => visibleUserMessageAttachments(files(), expandedFiles()))
  const hiddenFileCount = createMemo(() => hiddenUserMessageAttachmentCount(files().length))
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.queued === true)
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
  const toggleFiles = (event: unknown) => {
    consumeMouseEvent(event)
    setExpandedFiles((value) => !value)
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
  const latestCompactionMessageID = createMemo(
    () =>
    (sync.data.message[props.message.sessionID] ?? [])
      .filter((message) => message.role === "user")
      .findLast((message) => (sync.data.part[message.id] ?? []).some((part) => part.type === "compaction"))?.id,
  )
  const showCompactionCard = createMemo(() => props.message.id === latestCompactionMessageID())
  const visibleCompaction = createMemo(() => (showCompactionCard() ? compaction() : undefined))
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
  const summaryReady = createMemo(() => summaryAssistant()?.time.completed !== undefined)
  const summaryPreview = createMemo(() => (summaryReady() ? summaryOutputText() : undefined))
  const transcriptPreview = createMemo(() => compaction()?.instructions || text())

  return (
    <>
      <Show when={text()}>
        <box
          id={props.anchorID ?? (props.sticky ? undefined : props.message.id)}
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
                <For each={visibleFiles()}>
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
              <Show when={compactFiles()}>
                <box onMouseDown={consumeMouseEvent} onMouseUp={toggleFiles}>
                  <text fg={theme.textMuted}>
                    {expandedFiles()
                      ? `▾ hide ${Locale.number(hiddenFileCount())} extra attachment${hiddenFileCount() === 1 ? "" : "s"}`
                      : `▸ show ${Locale.number(hiddenFileCount())} more`}
                  </text>
                </box>
              </Show>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={visibleCompaction()}>
        {(part) => (
          <CompactionCard
            part={part()}
            summaryPreview={summaryPreview()}
            transcriptPreview={transcriptPreview()}
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
  const partsPaging = createMemo(() => sync.data.message_part_paging[props.message.id])
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
  const largeToolBatch = createMemo(
    () => visibleParts().filter((part) => part.type === "tool").length >= LARGE_TOOL_BATCH_THRESHOLD,
  )
  const groupedTimeline = createMemo(() =>
    mend.profile.presentation.profile === "raw" && !largeToolBatch()
      ? undefined
      : groupTimelineParts(mend.profile.presentation.profile, visibleParts() as any, {
          completed: !!props.message.time.completed,
          showReasoningRows: mend.profile.presentation.reasoning.defaultVisibility !== "hidden",
          forceCompact: largeToolBatch(),
          latestTodoWritePartID: ctx.latestTodoWritePartID(),
          currentTodos: sync.data.todo[props.message.sessionID],
        }),
  )
  const timelineNodes = createMemo(
    () => (groupedTimeline() ?? visibleParts()) as Array<Part | TimelineRow | TimelineCollapse>,
  )
  const timelineKeys = createMemo(() => timelineNodeKeys(timelineNodes()))
  const timelineNodeByKey = createMemo(() => {
    const nodes = timelineNodes()
    const keys = timelineKeys()
    return new Map(keys.map((key, index) => [key, nodes[index]] as const))
  })

  if (props.message.summary === true && parentHasCompaction()) return null

  return (
    <Switch>
      <Match when={props.simpleHistory}>
        <For each={simpleTextParts()}>{(part) => <TextPart last={false} part={part} message={props.message} />}</For>
      </Match>
      <Match when={true}>
        <>
          <For each={timelineKeys()}>
            {(key, index) => {
              const node = createMemo(() => timelineNodeByKey().get(key))
              const stackStart = createMemo(() =>
                isTimelineStackStart(timelineNodes() as Array<{ type: string; text?: string }>, index()),
              )
              const component = createMemo(() => {
                const value = node()
                if (!value || value.type === "row" || value.type === "collapse") return undefined
                return PART_MAPPING[value.type as keyof typeof PART_MAPPING]
              })
              return (
                <Show when={node()}>
                  {(value) => (
                    <Switch>
                      <Match when={value().type === "row"}>
                        <TimelineRowView row={value() as TimelineRow} stackStart={stackStart()} />
                      </Match>
                      <Match when={value().type === "collapse"}>
                        <TimelineCollapseRow collapse={value() as TimelineCollapse} stackStart={stackStart()} />
                      </Match>
                      <Match when={component()}>
                        <Dynamic
                          last={index() === timelineNodes().length - 1}
                          component={component()}
                          part={value() as any}
                          message={props.message}
                        />
                      </Match>
                    </Switch>
                  )}
                </Show>
              )
            }}
          </For>
          <Show when={partsPaging()?.hasMore}>
            <box
              paddingLeft={3}
              paddingTop={1}
              onMouseUp={() => {
                if (partsPaging()?.loading) return
                void sync.session.loadMoreMessageParts(props.message.sessionID, props.message.id).catch(() => {})
              }}
            >
              <text fg={theme.textMuted}>
                ◇ {partsPaging()?.loading ? "Loading more tool calls…" : "More tool calls available · click to load"}
              </text>
            </box>
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
          <Show when={streamingCompactionSummary()}>
            <CompactionPanel reason="auto" hasSummaryBody={false} />
          </Show>
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
  const planning = createMemo(() => props.row.class === "planning" && props.row.tool !== "memory")
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
  const dimensions = useTerminalDimensions()
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
  const fullReasoningMaxHeight = createMemo(() => reasoningViewportMaxHeight(dimensions().height))

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
            <Show when={content()}>
              {(body) => (
                <scrollbox
                  height={fullReasoningMaxHeight()}
                  maxHeight={fullReasoningMaxHeight()}
                  stickyScroll={streaming()}
                  stickyStart="bottom"
                  verticalScrollbarOptions={{ visible: false }}
                  viewportOptions={{ paddingRight: 0 }}
                >
                  <code
                    filetype="markdown"
                    drawUnstyledText={false}
                    streaming={streaming()}
                    syntaxStyle={subtleSyntax()}
                    content={body()}
                    conceal={ctx.conceal()}
                    fg={theme.textMuted}
                  />
                </scrollbox>
              )}
            </Show>
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
    return text
  })
  const messageWidth = createMemo(() =>
    sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)),
  )
  const markdownWidth = createMemo(() => Math.max(1, messageWidth() - textPaddingLeft))
  const richRenderWidth = createMemo(() => markdownWidth())
  const hasMermaid = createMemo(() => hasMermaidFence(source()))
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
  const markdownContent = createMemo(() => markdownStaticContent() ?? richContent() ?? source())
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
            <Show
              when={streaming()}
              fallback={
                <StyledPlanMarkdown
                  syntaxStyle={syntax()}
                  width={markdownWidth()}
                  source={source()}
                  content={markdownContent()}
                  tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
                  conceal={ctx.conceal()}
                  fg={theme.markdownText}
                  bg={theme.background}
                  stableTextMode={true}
                  colorizeHex={true}
                />
              }
            >
              <markdown
                syntaxStyle={syntax()}
                streaming={true}
                internalBlockMode="top-level"
                width={markdownWidth()}
                content={source()}
                tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
                conceal={ctx.conceal()}
                fg={theme.markdownText}
                bg={theme.background}
              />
            </Show>
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
    if (shouldRenderImageGenerationTool(props.part.tool)) return false
    if (props.part.tool === ShellID.ToolID) return false
    if (props.part.tool === "plan_review") return false
    if (props.part.tool === "loop") return false
    if (props.part.tool === "workflow" && shouldRenderSessionWorkflowCard(profile)) return false
    if (props.part.tool === "memory_graph") return false
    return shouldRenderCompactTool(profile, props.part.tool)
  })

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.tool === "image_gen") return false
    if (props.part.tool === "loop") return false
    if (props.part.tool === "workflow" && shouldRenderSessionWorkflowCard(mend.profile.presentation.profile)) return false
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
        <Match when={shouldRenderImageGenerationTool(props.part.tool)}>
          <ImageGen {...toolprops} />
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
        <Match
          when={
            props.part.tool === "loop" &&
            shouldRenderSessionLoopCard({
              toolStatus: props.part.state.status,
              workflowID: toolprops.metadata.workflowID,
              workflows: toolprops.metadata.workflows,
            })
          }
        >
          <Loop {...toolprops} />
        </Match>
        <Match when={props.part.tool === "workflow" && shouldRenderSessionWorkflowCard(mend.profile.presentation.profile)}>
          <Workflow {...toolprops} />
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

function imageGenMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function imageGenMetadataNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatImageArtifactBytes(value: number | undefined) {
  if (value === undefined) return
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`
  return `${Math.round(value / (1024 * 102.4)) / 10} MB`
}

function ImageGenToolAction(props: { label: string; onPress: () => void }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onPress()
      }}
    >
      <text fg={hover() ? theme.text : theme.primary}>[{props.label}]</text>
    </box>
  )
}

function ImageGen(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const toast = useToast()
  const [frame, setFrame] = createSignal(0)
  const running = createMemo(() =>
    isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: ctx.sync.data.session_status[ctx.sessionID]?.type,
      interrupted: ctx.interrupted(),
    }),
  )
  const completed = createMemo(() => props.part.state.status === "completed")
  const metadata = createMemo(() => props.metadata as Record<string, unknown>)
  const artifactPath = createMemo(() => imageGenMetadataString(metadata(), "path"))
  const generationModel = createMemo(() => {
    const provider = imageGenMetadataString(metadata(), "provider")
    const model = imageGenMetadataString(metadata(), "model")
    return provider && model ? `${provider}/${model}` : model
  })
  const visualCaption = createMemo(() => {
    const caption = metadata().caption
    if (!caption || typeof caption !== "object") return undefined
    const record = caption as Record<string, unknown>
    return record.status === "completed" && typeof record.caption === "string" ? record.caption : undefined
  })
  const captionError = createMemo(() => {
    const caption = metadata().caption
    if (!caption || typeof caption !== "object") return undefined
    const record = caption as Record<string, unknown>
    return record.status === "error" && typeof record.error === "string" ? record.error : undefined
  })
  const imageWait = createMemo(() => mend.profile.imageGeneration.wait)
  const activityCanvas = createMemo(() => {
    const available = sessionContentWidth(
      dimensions().width,
      promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset),
    )
    return imageGenerationCanvasSize(available, imageWait())
  })
  const activityFieldWidth = createMemo(() =>
    Math.max(8, activityCanvas().width - 2 - imageWait().canvas.paddingX * 2),
  )
  const activityFieldHeight = createMemo(() =>
    Math.max(
      4,
      activityCanvas().height -
        2 -
        imageWait().canvas.paddingY * 2 -
        (imageWait().showMetadata ? 2 : 0),
    ),
  )
  const activityFrameCount = createMemo(() => imageGenerationWaitFrameCount(imageWait()))
  const activityLines = createMemo(() =>
    imageGenerationWaitFrame(imageWait(), frame(), activityFieldWidth(), activityFieldHeight()),
  )
  const summary = createMemo(() =>
    [
      imageGenMetadataString(metadata(), "format") ?? "PNG",
      imageGenMetadataString(metadata(), "size"),
      formatImageArtifactBytes(imageGenMetadataNumber(metadata(), "bytes")),
      imageGenMetadataString(metadata(), "quality"),
      generationModel(),
      typeof metadata().cost === "number" ? `$${(metadata().cost as number).toFixed(4)}` : "cost unknown",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
  )

  createEffect(() => {
    const wait = imageWait()
    const count = activityFrameCount()
    setFrame((value) => value % count)
    if (!running() || mend.profile.workingIndicator.visible === false || wait.mode === "static" || count <= 1) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % count), wait.intervalMs)
    onCleanup(() => clearInterval(timer))
  })

  const activityLineColor = (line: string) => {
    const color = imageWait().textColor
    if (color === "accent") return theme.primary
    if (color === "muted") return theme.textMuted
    return line.includes("*") || line.includes("+") || line.includes("@") || line.includes("#") || line.includes("o")
      ? theme.primary
      : theme.textMuted
  }

  const openArtifact = async (target: string, label: string) => {
    try {
      await open(target)
      toast.show({ message: `${label}: ${target}`, variant: "success", duration: 2500 })
    } catch (error) {
      toast.show({ message: `${label} failed: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    }
  }

  const copyArtifactPath = async (target: string) => {
    try {
      await Clipboard.copy(target)
      toast.show({ message: "Image path copied", variant: "success", duration: 2500 })
    } catch (error) {
      toast.show({ message: `Copy failed: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    }
  }

  return (
    <Switch>
      <Match when={props.part.state.status === "error"}>
        <InlineTool
          icon={toolPresentationIcon("image_gen")}
          iconColor={theme.error}
          pending="Generating image..."
          complete={true}
          part={props.part}
        >
          Image generation failed
        </InlineTool>
      </Match>
      <Match when={running()}>
        <BlockTool
          title="Generating image..."
          icon={toolPresentationIcon("image_gen")}
          iconColor={theme.primary}
          titleColor={theme.text}
          part={props.part}
          paddingBottom={1}
        >
          <box width="100%" alignItems="center">
            <box
              border={["top", "bottom", "left", "right"]}
              borderColor={theme.border}
              paddingLeft={imageWait().canvas.paddingX}
              paddingRight={imageWait().canvas.paddingX}
              paddingTop={imageWait().canvas.paddingY}
              paddingBottom={imageWait().canvas.paddingY}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              width={activityCanvas().width}
              height={activityCanvas().height}
              flexShrink={0}
            >
              <For each={activityLines()}>{(line) => <text fg={activityLineColor(line)}>{line}</text>}</For>
              <Show when={imageWait().showMetadata}>
                <text fg={theme.textMuted}>{generationModel() ?? "configured image model"}</text>
                <text fg={theme.textMuted}>
                  size {imageGenMetadataString(metadata(), "requestedSize") ?? "auto"}
                </text>
              </Show>
            </box>
          </box>
        </BlockTool>
      </Match>
      <Match when={completed()}>
        <BlockTool
          title={props.part.state.status === "completed" ? props.part.state.title : "Generated image"}
          icon={toolPresentationIcon("image_gen")}
          iconColor={theme.primary}
          titleColor={theme.text}
          part={props.part}
          paddingBottom={1}
        >
          <box
            border={["top", "bottom", "left", "right"]}
            borderColor={theme.border}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            flexDirection="column"
            gap={1}
          >
            <text fg={theme.text}>{summary()}</text>
            <Show when={visualCaption()}>{(value) => <text fg={theme.textMuted}>Caption: {value()}</text>}</Show>
            <Show when={captionError()}>{(value) => <text fg={theme.warning}>Caption unavailable: {value()}</text>}</Show>
            <Show when={artifactPath()}>
              {(value) => (
                <>
                  <text fg={theme.textMuted} wrapMode="char">
                    {value()}
                  </text>
                  <box flexDirection="row" gap={2}>
                    <ImageGenToolAction label="Open Preview" onPress={() => void openArtifact(value(), "Opened preview")} />
                    <ImageGenToolAction
                      label="Reveal Folder"
                      onPress={() => void openArtifact(path.dirname(value()), "Opened folder")}
                    />
                    <ImageGenToolAction label="Copy Path" onPress={() => void copyArtifactPath(value())} />
                  </box>
                </>
              )}
            </Show>
          </box>
        </BlockTool>
      </Match>
    </Switch>
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
    if (props.tool === "memory" || props.tool === "memory_graph") {
      const tone = memoryToolPresentation({
        tool: props.tool,
        state: props.state,
        input: props.input,
        metadata: props.metadata,
      }).tone
      if (tone === "success") return theme.success
      if (tone === "active") return theme.primary
    }
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

function fullToolMetadata(part: ToolPart) {
  if (!("metadata" in part.state) || !part.state.metadata || typeof part.state.metadata !== "object") return undefined
  return part.state.metadata as Record<string, unknown>
}

function fullToolMetadataString(part: ToolPart, key: string) {
  const value = fullToolMetadata(part)?.[key]
  return typeof value === "string" ? value : undefined
}

function fullToolInputString(part: ToolPart | undefined, key: string) {
  if (!part || part.state.status !== "completed" || !part.state.input || typeof part.state.input !== "object")
    return undefined
  const value = (part.state.input as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function fullToolMetadataPatch(part: ToolPart, filePath: string) {
  const files = fullToolMetadata(part)?.files
  if (!Array.isArray(files)) return undefined
  const file = files.find((item) => {
    if (!item || typeof item !== "object") return false
    const record = item as Record<string, unknown>
    return [record.filePath, record.movePath, record.relativePath].some((value) => value === filePath)
  })
  if (!file || typeof file !== "object") return undefined
  const patch = (file as Record<string, unknown>).patch
  return typeof patch === "string" ? patch : undefined
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
  activityOverride?: boolean
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
  const spinner = createMemo(
    () =>
      props.spinner === true &&
      isToolActivityActive({
        toolStatus: props.part.state.status,
        sessionStatusType: sync.data.session_status[ctx.sessionID]?.type,
        interrupted: ctx.interrupted(),
        activityOverride: props.activityOverride,
      }),
  )

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
          <Match when={spinner()}>
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
  const ctx = use()
  const mend = useMendTuiProfile()
  const renderer = useRenderer()
  const [margin, setMargin] = createSignal(0)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const showIcon = createMemo(() => Boolean(props.icon && mend.profile.presentation.profile === "mendcode"))
  const titleText = createMemo(() => (typeof props.title === "string" ? props.title.replace(/^# /, "") : props.title))
  const spinner = createMemo(() => {
    if (props.spinner !== true) return false
    if (!props.part) return true
    return isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: ctx.sync.data.session_status[ctx.sessionID]?.type,
      interrupted: ctx.interrupted(),
    })
  })
  const title = () => (
    <Show
      when={spinner()}
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
  const ctx = use()
  const sync = useSync()
  const [now, setNow] = createSignal(Date.now())
  const isRunning = createMemo(() =>
    isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: sync.data.session_status[ctx.sessionID]?.type,
      interrupted: ctx.interrupted(),
    }),
  )
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
  const ctx = use()
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })
  const loadFullContent = () =>
    ctx.sync.session
      .loadFullToolPart(props.part.sessionID, props.part.messageID, props.part.id)
      .then((part) => fullToolInputString(part, "content"))

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
          <TimelineCode
            content={code()}
            filetype={filetype(props.input.filePath!)}
            syntaxStyle={syntax()}
            foregroundColor={theme.text}
            lineNumberColor={theme.diffHighlightAdded}
            backgroundColor={theme.diffAddedBg}
            loadFull={loadFullContent}
          />
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
  const taskVariant = createMemo(() => {
    if (typeof props.metadata.variant === "string") return props.metadata.variant
    if (typeof props.input.variant === "string") return props.input.variant
    const inputModel = typeof props.input.model === "string" ? props.input.model : undefined
    const separator = inputModel?.lastIndexOf("#") ?? -1
    if (!inputModel || separator <= inputModel.indexOf("/") || separator === inputModel.length - 1) return undefined
    return inputModel.slice(separator + 1)
  })
  const model = createMemo((): { providerID: string; modelID: string } | undefined => {
    const metadataModel = props.metadata.model as { providerID?: string; modelID?: string } | undefined
    if (metadataModel?.providerID && metadataModel.modelID) {
      return { providerID: metadataModel.providerID, modelID: metadataModel.modelID }
    }
    const inputModel = typeof props.input.model === "string" ? props.input.model.split("#", 1)[0] : undefined
    if (!inputModel?.includes("/")) return undefined
    const [providerID, ...modelParts] = inputModel.split("/")
    const modelID = modelParts.join("/")
    return providerID && modelID ? { providerID, modelID } : undefined
  })
  const modelLabel = createMemo(() => {
    const value = model()
    if (!value) return undefined
    return [Model.name(sync.data.provider, value.providerID, value.modelID), taskVariant()].filter(Boolean).join(" ")
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
      now: ctx.now(),
      connectionStatus:
        sdk.connection.status === "connected" && sdk.connection.recoveringSince !== undefined
          ? "reconnecting"
          : sdk.connection.status,
    })
  })
  const backgroundTask = createMemo(() => props.metadata.status === "started")
  const isTaskActive = createMemo(
    () =>
      isRunning() ||
      continuation().activeResume ||
      (backgroundTask() && isSubagentStatusActive(childLiveState() ?? "")),
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
    const recovering = state.status === "connected" && state.recoveringSince !== undefined
    if (state.status === "connected" && !recovering) return undefined
    if (state.status === "connecting") return "↳ connecting to MendCode..."
    if (state.status === "reconnecting" || recovering) {
      const attempt = state.attempt > 1 ? ` #${state.attempt}` : ""
      return `↳ reconnecting${attempt}: local connection lost`
    }
    if (state.status === "failed")
      return `↳ local connection unavailable after ${state.attempt} retries; agent state unknown`
    return "↳ disconnected: waiting for local connection"
  })
  const contentColor = (line: string) => {
    if (line.startsWith("↳ local connection unavailable")) return theme.error
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
        const active = isSubagentStatusActive(state ?? "")
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
        activityOverride={backgroundTask() && isSubagentStatusActive(childLiveState() ?? "")}
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
  const loadFullDiff = () =>
    ctx.sync.session
      .loadFullToolPart(props.part.sessionID, props.part.messageID, props.part.id)
      .then((part) => (part ? fullToolMetadataString(part, "diff") : undefined))

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
              loadFull={loadFullDiff}
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

  function Diff(p: { diff: string; filePath: string; loadFull?: () => Promise<string | undefined> }) {
    return (
      <box>
        <TimelineDiff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          wrapMode={ctx.diffWrapMode()}
          loadFull={p.loadFull}
        />
      </box>
    )
  }

  const loadFullPatch = (filePath: string) =>
    ctx.sync.session
      .loadFullToolPart(props.part.sessionID, props.part.messageID, props.part.id)
      .then((part) => (part ? fullToolMetadataPatch(part, filePath) : undefined))

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
              <Diff diff={file.patch} filePath={file.filePath} loadFull={() => loadFullPatch(file.filePath)} />
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
  const ctx = use()
  const currentTodos = createMemo(() => {
    if (ctx.latestCompletedTodoWritePartID() !== props.part.id) return undefined
    return ctx.sync.data.todo[props.part.sessionID]
  })
  const todos = createMemo(
    () => currentTodos() ?? props.input.todos ?? props.metadata.todos ?? parseTodoOutput(props.output),
  )
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

function MemoryGraph(props: ToolProps<any>) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const route = useRoute()
  const snapshot = createMemo(() => compactMemoryGraphSnapshot(props.metadata.graphSnapshot))
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
      connectedOnly: false,
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
    const data = snapshot()
    return data ? compactMemoryGraphRows(data, panelWidth() - 2) : []
  })
  const openGraph = () =>
    route.navigate({
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
          <text fg={healthTone()} wrapMode="none">
            {short(footer(), panelWidth() - 2)}
          </text>
          <For each={detailRows()}>
            {(row) => (
              <text fg={theme.textMuted} wrapMode="none">
                {row}
              </text>
            )}
          </For>
          <text fg={theme.primary} wrapMode="none">
            Open /memory-graph for the full view
          </text>
        </box>
      </BlockTool>
    </Show>
  )
}

type WorkflowSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient["workflow"]["show"]>>["data"]>

function workflowToolNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function workflowToolReceipt(snapshot: WorkflowSnapshot) {
  return {
    definition: { name: snapshot.definition.name, description: snapshot.definition.description },
    revision: { plan: { objective: snapshot.revision.plan.objective, model: snapshot.revision.plan.model } },
    run: {
      id: snapshot.run.id,
      state: snapshot.run.state,
      originSessionID: snapshot.run.originSessionID,
      rootSessionID: snapshot.run.rootSessionID,
      createdAt: workflowToolNumber(snapshot.run.createdAt),
      updatedAt: workflowToolNumber(snapshot.run.updatedAt),
    },
    phases: snapshot.phases.map((phase) => ({ state: phase.state, counts: phase.counts, id: phase.id, ordinal: phase.ordinal, name: phase.name })),
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      phaseID: task.phaseID,
      state: task.state,
      blocker: task.blocker,
      attempt: task.attempt,
    })),
    events: snapshot.events.map((event) => ({ type: event.type, summary: event.summary, createdAt: workflowToolNumber(event.createdAt) })),
    usage: snapshot.usage
      ? {
          inputTokens: workflowToolNumber(snapshot.usage.inputTokens),
          outputTokens: workflowToolNumber(snapshot.usage.outputTokens),
          cost: workflowToolNumber(snapshot.usage.cost),
        }
      : undefined,
  }
}

function Workflow(props: ToolProps<typeof WorkflowTool>) {
  const session = use()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [refresh, setRefresh] = createSignal(0)
  const [activityFrame, setActivityFrame] = createSignal(0)
  const [hover, setHover] = createSignal(false)
  const runID = createMemo(() => (typeof props.metadata.runID === "string" ? props.metadata.runID : undefined))
  const [snapshot] = createResource(() => `${runID() ?? ""}:${refresh()}`, async () => {
    const id = runID()
    if (!id) return undefined
    const response = await sdk.client.workflow.show({ runID: id }).catch(() => undefined)
    return response?.data
  })
  const live = createMemo(() => snapshot.latest ?? snapshot())
  const receipt = createMemo(() => {
    const current = live()
    return current ? workflowToolReceipt(current) : undefined
  })
  const phases = createMemo(() =>
    workflowReceiptFallbackPhases({
      live: receipt()?.phases,
      metadata: props.metadata.phases,
      plan: props.input.plan?.phases,
    }),
  )
  const phaseDiagram = createMemo(() => workflowReceiptPhaseDiagram({ phases: phases() }, activityFrame(), 8))
  const state = createMemo(() => live()?.run.state ?? props.metadata.state ?? (props.part.state.status === "running" ? "working" : props.part.state.status))
  const title = createMemo(() => live()?.definition.name || props.input.plan?.name || (typeof props.input.name === "string" ? props.input.name : "Workflow"))
  const objective = createMemo(() => live()?.revision.plan.objective || props.metadata.objective || props.input.plan?.objective || "Declarative workflow execution")
  const panelWidth = createMemo(() => Math.max(52, Math.min(92, dimensions().width - 12)))
  const rows = createMemo(() => {
    const current = receipt()
    if (!current) {
      return [
        ["workflow", runID() ?? "pending"],
        ["state", workflowReceiptStateLabel(state())],
        ["tasks", props.metadata.taskCount === undefined ? "pending" : String(props.metadata.taskCount)],
        ["phases", props.metadata.phaseCount === undefined ? "pending" : String(props.metadata.phaseCount)],
      ] as Array<[string, string]>
    }
    const counts = workflowReceiptCounts(current)
    const model = current.revision.plan.model
    return [
      ["workflow", current.run.id],
      ["state", workflowReceiptStateLabel(current.run.state)],
      ["phases", `${current.phases.filter((phase) => phase.state === "completed").length}/${current.phases.length}`],
      ["tasks", workflowReceiptProgress(current)],
      ["active", `${counts.working} working · ${counts.queued} queued`],
      ["elapsed", `${Math.round(workflowReceiptElapsed(current) / 1000)}s`],
      ["model", model ? `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` : "task route"],
      ["usage", workflowReceiptUsage(current)],
    ] as Array<[string, string]>
  })
  const nextAction = createMemo(() => receipt() ? workflowReceiptNextAction(receipt()!) : "Open the workflow monitor for the latest snapshot.")

  onMount(() => {
    const animation = setInterval(() => {
      if (workflowReceiptStateIsAnimated(state())) setActivityFrame((value) => value + 1)
    }, 180)
    const fallback = setInterval(() => {
      if (runID() && !workflowReceiptStateIsTerminal(state())) setRefresh((value) => value + 1)
    }, 5_000)
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = event.payload?.type as string | undefined
      if (type?.startsWith("workflow.")) setRefresh((value) => value + 1)
    })
    onCleanup(() => {
      clearInterval(animation)
      clearInterval(fallback)
      unsubscribe()
    })
  })

  async function control(action: "pause" | "resume" | "stop") {
    const id = runID()
    if (!id) return
    if (action === "stop") {
      const confirmed = await DialogConfirm.show(dialog, "Stop workflow", `Stop ${title()}?`)
      dialog.clear()
      if (!confirmed) return
    }
    const response =
      action === "pause"
        ? await sdk.client.workflow.pause({ runID: id, reason: "Session card pause" })
        : action === "resume"
          ? await sdk.client.workflow.resume({ runID: id, reason: "Session card resume" })
          : await sdk.client.workflow.stop({ runID: id, reason: "Session card stop" })
    if (response.error) throw new Error(String(response.error))
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: `Workflow ${action} requested.`, duration: 2500 })
  }

  async function openTarget() {
    const id = runID()
    if (!id) return
    navigate({ type: "workflows", selectedID: id, returnTo: { type: "session", sessionID: session.sessionID } })
  }

  const handleOpenTarget = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    void openTarget().catch((error) => toast.error(error))
  }

  return (
    <BlockTool
      title="Workflow"
      icon={toolPresentationIcon("workflow")}
      titleColor={state() === "completed" ? theme.success : state() === "failed" || state() === "blocked" ? theme.error : theme.secondary}
      contentGap={0}
      part={props.part}
      spinner={props.part.state.status === "running" && !runID()}
    >
      <box width="100%" alignItems="center">
        <box
          flexDirection="column"
          width={panelWidth()}
          flexShrink={0}
          borderStyle="single"
          borderColor={hover() ? theme.secondary : theme.border}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box flexDirection="row">
            <text fg={theme.secondary} attributes={TextAttributes.BOLD}>{toolPresentationIcon("workflow")} {Locale.truncateMiddle(title(), Math.max(18, panelWidth() - 24))}</text>
            <box flexGrow={1} />
            <text fg={theme.secondary}>{workflowReceiptStateMarker(state(), activityFrame())} {workflowReceiptStateLabel(state())}</text>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
            <For each={rows()}>
              {(row) => (
                <box flexDirection="row">
                  <text fg={theme.textMuted} wrapMode="none">{row[0].padEnd(10)}</text>
                  <text fg={theme.text} wrapMode="none">{Locale.truncateMiddle(row[1], Math.max(18, panelWidth() - 24))}</text>
                </box>
              )}
            </For>
            <text fg={theme.textMuted} wrapMode="word">{Locale.truncate(objective(), Math.max(24, panelWidth() - 8))}</text>
            <text fg={theme.warning} wrapMode="word">next: {Locale.truncate(nextAction(), Math.max(24, panelWidth() - 14))}</text>
          </box>
          <Show when={phaseDiagram().length}>
            <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>PHASE FLOW</text>
              <For each={phaseDiagram()}>
                {(row) => (
                  <text
                    fg={
                      row.kind !== "phase"
                        ? theme.border
                        : row.state === "completed"
                          ? theme.success
                          : row.state === "failed" || row.state === "blocked"
                            ? theme.error
                            : row.state === "working"
                              ? theme.secondary
                              : theme.textMuted
                    }
                    wrapMode="none"
                  >
                    {Locale.truncateMiddle(row.text, Math.max(24, panelWidth() - 8))}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="row">
            <text fg={hover() ? theme.secondary : theme.textMuted} onMouseUp={handleOpenTarget}>open monitor</text>
            <box flexGrow={1} />
            <text fg={theme.textMuted} onMouseUp={() => void control("pause").catch((error) => toast.error(error))}>[pause]</text>
            <text fg={theme.textMuted} onMouseUp={() => void control("resume").catch((error) => toast.error(error))}> [resume]</text>
            <text fg={theme.textMuted} onMouseUp={() => void control("stop").catch((error) => toast.error(error))}> [stop]</text>
          </box>
        </box>
      </box>
    </BlockTool>
  )
}

function Loop(props: ToolProps<typeof LoopTool>) {
  const session = use()
  const sdk = useSDK()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const renderer = useRenderer()
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
    const headers = new Headers(sdk.headers)
    headers.set("accept", "application/json")
    if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
    try {
      const response = await sdk.fetch(`${sdk.url}/loop/${id}`, { headers })
      if (!response.ok) return undefined
      return response.json().catch(() => undefined) as Promise<SessionLoopSnapshot | undefined>
    } catch {
      return undefined
    }
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
    const dailyAt = props.metadata.dailyAt ?? firstWorkflow()?.dailyAt ?? props.input.dailyAt
    const timezone = props.metadata.timezone ?? firstWorkflow()?.timezone ?? props.input.timezone
    if (mode === "interval" && typeof interval === "number" && interval > 0)
      return `interval · every ${Math.round(interval / 60000)}m`
    if (mode === "daily") return `daily · ${dailyAt ?? "configured time"}${timezone ? ` · ${timezone}` : ""}`
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
  const handleOpenTarget = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    void openTarget().catch((error) => toast.error(error))
  }

  return (
    <BlockTool
      title="Loop Workflow"
      icon={toolPresentationIcon("loop")}
      titleColor={receiptColor()}
      contentGap={0}
      part={props.part}
      spinner={props.part.state.status === "running" && !resolvedWorkflowID()}
    >
      <box width="100%" alignItems="center">
        <box
          flexDirection="column"
          width={panelWidth()}
          onMouseUp={handleOpenTarget}
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
