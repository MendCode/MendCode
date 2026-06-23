import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
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
import { useSync } from "@tui/context/sync"
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
  type TextareaRenderable,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
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
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { listMendWidgets } from "@/mend/tui/widgets"
import { renderMendEditor } from "@/mend/tui/editor-host"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@mendcode/core/global"
import { PermissionPrompt } from "./permission"
import { PlanReviewPrompt } from "./plan-review"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatAssistantUsage, formatLatestAssistantContextUsage } from "../../util/usage"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration, isScrollboxAtBottom } from "../../util/scroll"
import {
  sessionContentWidth,
  sessionDiffStatsLabel,
  sessionPendingInputSessionIDs,
  sessionPromptVisible,
  sessionTopMetricsWidth,
  sessionTopbarLeftLabel,
  sessionTopbarLeftWidth,
  sessionUsageBarLabels,
} from "../../util/session-layout"
import {
  sessionBottomDockLayout,
  sessionTodoIcon,
  sessionTodoPanelWidth,
  type SessionTodo,
} from "../../util/session-bottom-dock"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { restorePromptFromSubmittedParts } from "../../component/prompt/submit-parts"
import { useMendTuiProfile } from "../../context/mend"
import { subagentTaskColorIndex, type SubagentTaskColorEntry } from "../../util/subagent-color"
import {
  presentationReasoningVisible,
  rawReasoningDisplay,
  reasoningSummary,
  shouldDisplayReasoning,
  unavailableReasoningLabel,
} from "@/mend/tui/presentation"
import { promptChromeUsesFullSessionWidth } from "@/mend/tui/prompt-chrome"
import { formatDuration } from "@/util/format"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import { reviewPermissionRequestWithModel, shouldTriggerSmartApproval } from "@/mend/permission/smart-approval"
import { readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import { normalizeToolEvent, shouldRenderCompactTool } from "@/mend/tui/timeline/normalize"
import { groupTimelineParts, isTimelineStackStart } from "@/mend/tui/timeline/group"
import type { TimelineCollapse, TimelineRow } from "@/mend/tui/timeline/types"
import { TimelineDiff } from "./renderers/diff"
import {
  expandPastedContentPlaceholders,
  isPastedContentPart,
  userMessageDisplayText,
  type PastedContentDisplayPart,
} from "./user-message-display"
import {
  hasMermaidFence,
  planReviewInlineTitle,
  renderPlanMarkdown,
  renderPlanMarkdownStatic,
  renderStreamingMarkdownTail,
} from "../../util/plan-markdown"

addDefaultParsers(parsers.parsers)

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

const activeBackgroundWriterStates = new Set<BackgroundWriterInfo["state"]>(["working", "needs_input"])

type SessionLoopWorkflow = {
  id: string
  ownerSessionID?: string
  rootSessionID?: string
  state: string
  phase?: string
  name?: string
  nextWakeup?: number
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

function formatLoopWorkflowState(state: string, phase?: string) {
  if (!phase || phase === state) return state
  return `${state}: ${phase}`
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

function sessionMatchesLoopWorkflow(workflow: Pick<SessionLoopWorkflow, "rootSessionID" | "ownerSessionID">, sessionID: string) {
  return workflow.rootSessionID === sessionID || workflow.ownerSessionID === sessionID
}

type BackgroundWriterAcquireResult =
  | {
      acquired: true
      info: BackgroundWriterInfo
    }
  | {
      acquired: false
      info?: BackgroundWriterInfo
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

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
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
  const [showTodos, setShowTodos] = kv.signal("session_todos_visible", false)

  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentInset = createMemo(() => (promptEdgeToEdge() ? 0 : 4))
  const contentWidth = createMemo(() => sessionContentWidth(dimensions().width, promptEdgeToEdge()))
  const insetRowWidth = createMemo(() => Math.max(1, contentWidth() - contentInset() * 2))
  const providers = createMemo(() => Model.index(sync.data.provider))
  const rootSessionID = createMemo(() => session()?.parentID ?? route.sessionID)
  const rootMessages = createMemo(() => sync.data.message[rootSessionID()] ?? [])
  const mainAgentNames = createMemo(
    () => new Set(sync.data.agent.filter((agent) => agent.mode !== "subagent").map((agent) => agent.name)),
  )
  const topUsage = createMemo(() => {
    const assistantMessages = rootMessages().filter(
      (message): message is AssistantMessage => message.role === "assistant",
    )
    const mainUsage = formatLatestAssistantContextUsage(assistantMessages, providers(), {
      include: (message) => mainAgentNames().has(message.agent),
    })
    return mainUsage ?? formatLatestAssistantContextUsage(assistantMessages, providers())
  })
  const stickyUserHeaderEnabled = createMemo(() => {
    const sessionLayout = mend.profile.layout.zones.session
    return Boolean((sessionLayout as { stickyUserHeader?: unknown }).stickyUserHeader)
  })
  const [stickyUserMessageID, setStickyUserMessageID] = createSignal<string>()
  const stickyUserMessage = createMemo(() => {
    const id = stickyUserMessageID()
    if (!id) return undefined
    return messages().find((message): message is UserMessage => message.id === id && message.role === "user")
  })
  const sessionDirectory = createMemo(() => {
    for (const message of messages().toReversed()) {
      const cwd = (message as { path?: { cwd?: string } }).path?.cwd
      if (cwd) return cwd
    }
    return project.instance.path().directory || process.cwd()
  })
  const [topStatsTick, setTopStatsTick] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setTopStatsTick((tick) => tick + 1), 1500)
    onCleanup(() => clearInterval(timer))
  })
  const topPathLabel = createMemo(() => {
    return sessionDirectory().replace(Global.Path.home, "~")
  })
  const [topStats] = createResource(
    () => ({ directory: sessionDirectory(), tick: topStatsTick() }),
    async ({ directory }) => {
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
  const topbarReservedWidth = createMemo(() => {
    const navWidth = Bun.stringWidth(sessionTopNavLabel())
    const metricsWidth = topMetricsWidth()
    return navWidth + metricsWidth + (navWidth > 0 && metricsWidth > 0 ? 1 : 0)
  })
  const topbarLeftWidth = createMemo(() =>
    sessionTopbarLeftWidth({
      contentWidth: contentWidth(),
      metricsWidth: topbarReservedWidth(),
    }),
  )
  const topbarLeftLabel = createMemo(() =>
    sessionTopbarLeftLabel({
      branch: sync.data.vcs?.branch || "git",
      path: topPathLabel(),
      maxWidth: topbarLeftWidth(),
      isChildSession: Boolean(session()?.parentID),
    }),
  )
  const todos = createMemo(() => sync.data.todo[route.sessionID] ?? [])
  const taskSubagentBySession = createMemo(() => {
    const result = new Map<string, { description?: string; subagentType?: string }>()
    for (const message of rootMessages()) {
      for (const part of sync.data.part[message.id] ?? []) {
        if (part.type !== "tool" || part.tool !== "task") continue
        const state = part.state as {
          input?: Record<string, unknown>
          metadata?: Record<string, unknown>
          title?: string
        }
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
      .map((child) => {
        const task = taskSubagentBySession().get(child.id)
        const childMessages = sync.data.message[child.id] ?? []
        const latestAgent = childMessages.findLast((message) => message.role === "assistant" || message.role === "user")
          ?.agent
        const label = normalizeSubagentLabel(task?.subagentType ?? child.agent ?? latestAgent ?? "subagent")
        return {
          id: child.id,
          label: Locale.titlecase(label),
          description: task?.description ?? child.title ?? child.path ?? child.directory ?? child.id,
          status: sessionLiveStateLabel({
            status: sync.data.session_status?.[child.id],
            messages: childMessages,
            pendingInputCount:
              (sync.data.permission[child.id]?.length ?? 0) +
              (sync.data.question[child.id]?.length ?? 0) +
              (sync.data.plan_review[child.id]?.length ?? 0),
          }),
          updated: Locale.time(child.time.updated),
          active: child.id === route.sessionID,
        }
      })
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()
  const backgroundWriterClientID = `tui-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const [backgroundWriterMode, setBackgroundWriterMode] = createSignal<
    "unmanaged" | "attaching" | "attached" | "following"
  >("unmanaged")
  const [backgroundWriterOwner, setBackgroundWriterOwner] = createSignal<string>()
  const [backgroundWriterOwns, setBackgroundWriterOwns] = createSignal(false)
  const [backgroundWriterState, setBackgroundWriterState] = createSignal<BackgroundWriterInfo["state"]>()
  const [loopBackgroundSummary, setLoopBackgroundSummary] = createSignal<string>()
  const backgroundWriterLocked = createMemo(() => {
    const mode = backgroundWriterMode()
    const state = backgroundWriterState()
    return (mode === "attaching" || mode === "following") && !!state && activeBackgroundWriterStates.has(state)
  })
  const loopStatusLabel = createMemo(() => {
    const workflow = currentLoopWorkflow()
    const summary = loopBackgroundSummary()
    if (!workflow && !summary) return undefined
    const turns = workflow?.metrics?.turns ?? 0
    const maxTurns = workflow?.policy?.maxTurns
    const progress = maxTurns ? `${turns}/${maxTurns}` : `${turns}/unlimited`
    const state = workflow ? formatLoopWorkflowState(workflow.state, workflow.phase ?? "ready") : summary?.replace(/^Loop\s+/i, "")
    const name = workflow?.name ? `${workflow.name} · ` : ""
    return Locale.truncate(`${name}${state}${workflow ? ` · ${progress}` : ""}`, Math.max(12, contentWidth() - 16))
  })
  const showSessionBottomDock = createMemo(() => showTodos() && !disabled() && !backgroundWriterLocked())
  const promptDisabled = createMemo(() => disabled() || backgroundWriterLocked())
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
                    description: "Default future sessions to approving permission prompts.",
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
      if (route.sessionID === sessionID && scroll) toBottom()
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

  const runFollowSync = () => {
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
        mode: backgroundWriterMode(),
        sessionID: route.sessionID,
        status: sync.data.session_status?.[route.sessionID]?.type,
        loopState: currentLoopWorkflow()?.state,
        title: session()?.title ?? "",
      }),
      ({ mode, status, loopState, title }) => {
        const isLoopSession = Boolean(loopState) || title.startsWith("Loop:")
        if (eventlessFollowTimer) clearInterval(eventlessFollowTimer)
        eventlessFollowTimer = undefined
        if (mode === "attached" && !isLoopSession) return
        if (!isLoopSession && status !== "busy" && status !== "retry") return
        const intervalMs =
          status === "busy" || status === "retry" || loopState === "working"
            ? 600
            : isLoopSession
              ? 900
              : 600
        eventlessFollowTimer = setInterval(() => {
          if (Date.now() - lastFollowSyncAt < intervalMs) return
          scheduleFollowSync(0)
        }, intervalMs)
      },
    ),
  )

  const eventSessionID = (evt: { properties?: unknown }) => {
    const properties = evt.properties as
      | {
          sessionID?: string
          info?: { sessionID?: string; rootSessionID?: string }
          part?: { sessionID?: string }
          run?: { rootSessionID?: string }
          thread?: { sessionID?: string }
          event?: { sessionID?: string }
        }
      | undefined
    return (
      properties?.sessionID ??
      properties?.info?.sessionID ??
      properties?.info?.rootSessionID ??
      properties?.run?.rootSessionID ??
      properties?.thread?.sessionID ??
      properties?.event?.sessionID ??
      properties?.part?.sessionID
    )
  }

  const immediateFollowEvents = new Set([
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
    "session.idle",
    "session.status",
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
    "session.next.compaction.ended",
    "loop.workflow.updated",
    "loop.run.updated",
    "loop.event.created",
    "loop.thread.updated",
  ])
  const liveFollowEvents = new Set([
    "message.part.delta",
    "session.next.text.delta",
    "session.next.reasoning.delta",
    "session.next.tool.input.delta",
    "session.next.tool.progress",
    "session.next.shell.output",
    "session.next.compaction.delta",
  ])

  const unsubscribeFollowSync = sdk.event.on("event", (event) => {
    if (event.payload.type === "sync") return
    const evt = event.payload
    if (eventSessionID(evt) !== route.sessionID) return
    if (backgroundWriterMode() === "attached") return
    if (evt.type === "message.part.updated") {
      const part = (evt.properties as { part?: Part } | undefined)?.part
      const memory =
        part?.type === "step-finish"
          ? (part.metadata as { mendMemory?: SessionMemoryMetadata } | undefined)?.mendMemory
          : undefined
      if (memoryToastMessage(memory)) return
    }
    if (immediateFollowEvents.has(evt.type)) {
      scheduleFollowSync(50)
      return
    }
    if (liveFollowEvents.has(evt.type)) scheduleLiveFollowSync()
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
    if (disabled() || backgroundWriterLocked()) return false
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
      local.model.pinCurrent()
      lastSwitch = part.id
    } else if (part.tool === "plan_review" && part.state.title === "Plan approved") {
      local.agent.set((part.state.metadata as { planExitAgent?: string } | undefined)?.planExitAgent || "build")
      local.model.pinCurrent()
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      local.model.pinCurrent()
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  const [followSessionOutput, setFollowSessionOutput] = createSignal(true)
  let scrollAnchor: { id: string; offset: number } | undefined
  let lastObservedScrollTop = 0
  let lastObservedScrollHeight = 0
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
      return
    }

    const top = scroll.y
    const child = scroll
      .getChildren()
      .filter((item) => item.id && item.y >= top)
      .sort((a, b) => a.y - b.y)[0]
    scrollAnchor = child?.id ? { id: child.id, offset: child.y - top } : undefined
  }

  const restoreScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed || !scrollAnchor) return
    const child = scroll.getChildren().find((item) => item.id === scrollAnchor?.id)
    if (!child) {
      captureScrollAnchor()
      return
    }

    const delta = child.y - scroll.y - scrollAnchor.offset
    if (delta !== 0) scroll.scrollBy(delta)
  }

  const syncScrollFollowMode = () => {
    if (!scroll || scroll.isDestroyed) return
    const scrollTop = scroll.scrollTop
    const scrollHeight = scroll.scrollHeight

    if (isScrollboxAtBottom(scroll)) {
      setFollowSessionOutput(true)
      scrollAnchor = undefined
      lastObservedScrollTop = scrollTop
      lastObservedScrollHeight = scrollHeight
      return
    }

    setFollowSessionOutput(false)

    const userMovedViewport =
      Math.abs(scrollTop - lastObservedScrollTop) > 1 && Math.abs(scrollHeight - lastObservedScrollHeight) <= 1
    if (userMovedViewport || !scrollAnchor) {
      captureScrollAnchor()
    } else {
      restoreScrollAnchor()
      captureScrollAnchor()
    }

    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
  }

  const markScrollDetached = () => {
    setFollowSessionOutput(false)
    setTimeout(captureScrollAnchor, 0)
  }
  const scrollBySession = (delta: number) => {
    scroll.scrollBy(delta)
    setTimeout(syncScrollFollowMode, 0)
  }
  const scrollToSession = (position: number) => {
    scroll.scrollTo(position)
    setTimeout(syncScrollFollowMode, 0)
  }

  onMount(() => {
    const timer = setInterval(syncScrollFollowMode, 80)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        `${logo[0] ?? ""}`,
        `${logo[1] ?? ""}`,
        `${logo[2] ?? ""}`,
        `${logo[3] ?? ""}`,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}mend -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
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

  function toBottom() {
    setFollowSessionOutput(true)
    scrollAnchor = undefined
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

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

    const stuck = [...userAnchors].reverse().find((item) => item.y < top)
    setStickyUserMessageID(stuck?.id)
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

  const acquireBackgroundWriter = async (sessionID: string) =>
    backgroundJSON<BackgroundWriterAcquireResult>(`/session/${sessionID}/background/writer`, {
      method: "POST",
      body: JSON.stringify({ clientID: backgroundWriterClientID, ttlMs: 45_000 }),
    })

  const releaseBackgroundWriter = async (sessionID: string) =>
    backgroundJSON<BackgroundWriterInfo | null>(`/session/${sessionID}/background/writer`, {
      method: "DELETE",
      body: JSON.stringify({ clientID: backgroundWriterClientID }),
    }).catch(() => null)

  const refreshBackgroundWriter = async (sessionID: string, notify = false) => {
    const info = await currentBackgroundSession(sessionID)
    if (route.sessionID !== sessionID) return
    if (!info) {
      setBackgroundWriterMode("unmanaged")
      setBackgroundWriterOwner(undefined)
      setBackgroundWriterOwns(false)
      setBackgroundWriterState(undefined)
      await refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
      return
    }
    setBackgroundWriterState(info.state)
    if (!activeBackgroundWriterStates.has(info.state)) {
      setBackgroundWriterMode("unmanaged")
      setBackgroundWriterOwner(info.writer?.clientID)
      setBackgroundWriterOwns(false)
      await refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
      return
    }
    if (!backgroundWriterOwns()) setBackgroundWriterMode("attaching")
    const result = await acquireBackgroundWriter(sessionID)
    if (route.sessionID !== sessionID) return
    setBackgroundWriterOwner(result.info?.writer?.clientID)
    setBackgroundWriterOwns(result.acquired)
    setBackgroundWriterState(result.info?.state ?? info.state)
    setBackgroundWriterMode(result.acquired ? "attached" : "following")
    await refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
    if (notify) {
      toast.show({
        variant: result.acquired ? "success" : "info",
        message: result.acquired ? "Attached to session." : "Following read-only. Another terminal is attached.",
        duration: 3000,
      })
    }
  }

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        let released = false
        setLoopBackgroundSummary(undefined)
        setLoopSessionWorkflows([])
        void refreshBackgroundWriter(sessionID).catch(() => {
          if (route.sessionID !== sessionID) return
          setBackgroundWriterMode("unmanaged")
          setBackgroundWriterOwner(undefined)
          setBackgroundWriterOwns(false)
          setBackgroundWriterState(undefined)
          void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
        })
        const timer = setInterval(() => {
          if (!backgroundWriterOwns()) return
          void acquireBackgroundWriter(sessionID)
            .then((result) => {
              if (route.sessionID !== sessionID) return
              setBackgroundWriterOwner(result.info?.writer?.clientID)
              setBackgroundWriterOwns(result.acquired)
              setBackgroundWriterState(result.info?.state)
              setBackgroundWriterMode(result.acquired ? "attached" : "following")
            })
            .catch(() => undefined)
        }, 15_000)
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
            void refreshBackgroundWriter(sessionID).catch(() => undefined)
            void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
            return
          }
          if (type?.startsWith("loop.")) {
            void refreshLoopBackgroundSummary(sessionID).catch(() => undefined)
          }
        })
        onCleanup(() => {
          clearInterval(timer)
          clearInterval(loopPoll)
          unsubscribe()
          if (released || !backgroundWriterOwns()) return
          released = true
          void releaseBackgroundWriter(sessionID)
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
    await releaseBackgroundWriter(route.sessionID)
    setBackgroundWriterOwns(false)
    setBackgroundWriterMode("following")
    setBackgroundWriterState(state)
    setBackgroundWriterOwner(undefined)
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
        "Default to report-only unless I explicitly allow edits. For interval cadence, set `triggerMode: \"interval\"` and convert the interval to `intervalMs`. Preserve the current session model by omitting `model` unless I choose one.",
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
      title: stickyUserHeaderEnabled() ? "Disable sticky user header" : "Enable sticky user header",
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
      title: "Loop Workflows",
      value: "session.loop.list",
      category: "Session",
      description: "Open the live loop workflow dashboard.",
      slash: {
        name: "loops",
      },
      onSlash: (dialog, input) => {
        dialog.clear()
        const selectedID = input.arguments.trim() || undefined
        navigate({ type: "loops", selectedID, returnTo: { type: "session", sessionID: route.sessionID } })
      },
      onSelect: (dialog) => {
        dialog.clear()
        navigate({ type: "loops", returnTo: { type: "session", sessionID: route.sessionID } })
      },
    },
    {
      title: "Detach to Agent View",
      value: "session.background",
      category: "Session",
      description: "Move this session to Agent View and return home.",
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
      title: backgroundWriterMode() === "following" ? "Attach session" : "Refresh session attach",
      value: "session.attach",
      category: "Session",
      enabled: backgroundWriterMode() === "following",
      description: "Try to take the writer lease for this background session.",
      slash: {
        name: "attach",
      },
      onSelect: (dialog) => {
        void refreshBackgroundWriter(route.sessionID, true)
          .then(() => dialog.clear())
          .catch((error) => {
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
        const parts = sync.data.part[message.id]
        prompt?.set(restorePromptFromSubmittedParts(parts))
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
        setFollowSessionOutput(true)
        scrollToSession(scroll.scrollHeight)
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

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

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
        <Show when={!backgroundWriterLocked() && planReviews().length > 0}>
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
            <box width="100%" height={1} flexDirection="row" flexShrink={0} gap={1}>
              <box width={topbarLeftWidth()} overflow="hidden" flexShrink={0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {topbarLeftLabel()}
                </text>
              </box>
              <Show when={session()?.parentID || currentLoopWorkflow()}>
                <SessionTopNav mode={session()?.parentID ? "subagent" : "loop"} canCycle={session()?.parentID ? true : loopRootWorkflows().length > 1} hasParent={!!currentLoopWorkflow()?.ownerSessionID} />
              </Show>
              <SessionTopMetrics diff={topDiffStats()} usage={topUsage()} />
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
            <box position="relative" flexGrow={1} width="100%">
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
              >
                <box height={1} />
                <For each={messages()}>
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
                                  <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                  restore
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
                          index={index()}
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
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </scrollbox>
              <Show when={stickyUserHeaderEnabled() && stickyUserMessage()}>
                {(message) => (
                  <box position="absolute" top={0} left={0} right={showScrollbar() ? 1 : 0} zIndex={1000}>
                    <UserMessage
                      index={0}
                      message={message()}
                      parts={sync.data.part[message().id] ?? []}
                      sticky
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
              <Show when={!backgroundWriterLocked() && permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={!backgroundWriterLocked() && permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={backgroundWriterMode() === "following" && backgroundWriterLocked()}>
                <box paddingLeft={contentInset()} paddingRight={contentInset()} width={insetRowWidth()}>
                  <text fg={theme.textMuted} wrapMode="none">
                    Following read-only · attached in another terminal
                    <Show when={backgroundWriterOwner()}>
                      {(owner) => <span style={{ fg: theme.textMuted }}> · {Locale.truncate(owner(), 18)}</span>}
                    </Show>
                  </text>
                </box>
              </Show>
              <Show when={backgroundWriterMode() === "attaching"}>
                <box paddingLeft={contentInset()} paddingRight={contentInset()} width={insetRowWidth()}>
                  <text fg={theme.textMuted} wrapMode="none">
                    Attaching session…
                  </text>
                </box>
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
              <For each={listMendWidgets("aboveEditor")}>{(item) => item.render() as any}</For>
              <Show when={visible()}>
                <box position="relative" zIndex={2500} overflow="visible" width="100%">
                  <TuiPluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={promptDisabled()}
                    on_submit={toBottom}
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
                        onSubmit: () => {
                          toBottom()
                        },
                        right: <TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />,
                        defaultEditor: () => (
                          <Prompt
                            visible={visible()}
                            ref={bind}
                            disabled={promptDisabled()}
                            historyScope={`session:${route.sessionID}`}
                            onSubmit={() => {
                              toBottom()
                            }}
                            sessionID={route.sessionID}
                            permissionMode={permissionMode()}
                            permissionModeLabel={permissionModeLabel()}
                            permissionPending={permissionPendingCount()}
                            right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                          />
                        ),
                      }) as any
                    }
                  </TuiPluginRuntime.Slot>
                </box>
              </Show>
              <For each={listMendWidgets("belowEditor")}>{(item) => item.render() as any}</For>
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
      {item("parent", "↖", props.mode === "loop" ? (props.hasParent ? "Parent" : "Agent View") : "Parent", "session_parent", "session.parent")}
      <Show when={props.mode === "subagent" || props.canCycle}>
        {item("prev", "←", props.mode === "loop" ? "Prev loop" : "Prev", "session_child_cycle_reverse", "session.child.previous")}
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
  updated: string
  active: boolean
}

function sessionLiveStateLabel(input: {
  status?: { type: string; attempt?: number; message?: string }
  messages: Message[]
  pendingInputCount: number
}) {
  if (input.pendingInputCount > 0) return "needs input"
  if (input.status?.type === "retry") return input.status.attempt && input.status.attempt > 1 ? `retry #${input.status.attempt}` : "retrying"
  if (input.status?.type === "busy") return "working"
  const lastUser = input.messages.findLast((message) => message.role === "user")
  const lastAssistant = input.messages.findLast((message) => message.role === "assistant")
  if (lastAssistant && !lastAssistant.time.completed) return "working"
  if (lastUser && (!lastAssistant || lastAssistant.time.created < lastUser.time.created)) return "waiting"
  if (lastAssistant) return "responded"
  return "ready"
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
  const layout = createMemo(() =>
    sessionBottomDockLayout({ todos: props.todos, width: props.width, subagentCount: props.subagents.length }),
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
        <Show when={layout().showNotes}>
          <For each={listMendWidgets("sessionBottomDock")}>
            {(item) => (
              <box flexShrink={1} minWidth={18} height={layout().dockHeight} backgroundColor={theme.backgroundPanel}>
                {item.render() as any}
              </box>
            )}
          </For>
        </Show>
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
                  <span style={{ bg: index() === noteScrollThumb() ? theme.textMuted : theme.backgroundPanel }}>
                    {" "}
                  </span>
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
  const visibleRows = createMemo(() => Math.max(1, props.height - 3))
  const visible = createMemo(() => props.subagents.slice(0, visibleRows()))
  const hidden = createMemo(() => Math.max(0, props.subagents.length - visibleRows()))
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
              flexDirection="row"
              gap={1}
              width="100%"
              backgroundColor={item.active ? theme.backgroundElement : theme.backgroundPanel}
              onMouseUp={() => props.onOpen(item.id)}
            >
              <text fg={color(item.status)} flexShrink={0} wrapMode="none">
                {item.active ? ">" : "•"}
              </text>
              <text fg={theme.text} flexGrow={1} wrapMode="none">
                {Locale.truncateMiddle(`${item.label} ${item.description}`, Math.max(6, props.width - 24))}
              </text>
              <text fg={color(item.status)} flexShrink={0} wrapMode="none">
                {Locale.truncateMiddle(item.status, 10)}
              </text>
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

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
  sticky?: boolean
}) {
  const local = useLocal()
  const [expandedText, setExpandedText] = createSignal(false)
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
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const collapsedDisplayText = createMemo(() =>
    userMessageDisplayText(fullText(), props.sticky ? { maxLines: 2, maxChars: 220 } : undefined),
  )
  const expandedDisplayText = createMemo(() => userMessageDisplayText(fullText(), { maxLines: 240, maxChars: 40_000 }))
  const displayText = createMemo(() => (expandedText() ? expandedDisplayText() : collapsedDisplayText()))
  const pastedContentChars = createMemo(() => pastedContentParts().reduce((total, part) => total + part.text.length, 0))
  const togglePastedContent = (event: unknown) => {
    const maybeEvent = event as { stopPropagation?: () => void } | undefined
    maybeEvent?.stopPropagation?.()
    setExpandedPaste((value) => !value)
  }
  const toggleExpandedText = (event?: unknown) => {
    const maybeEvent = event as { stopPropagation?: () => void } | undefined
    maybeEvent?.stopPropagation?.()
    setExpandedText((value) => !value)
  }

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

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
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
            width="100%"
          >
            <box flexDirection="row" justifyContent="space-between" width="100%" gap={2}>
              <text fg={theme.textMuted} wrapMode="none">
                <span style={{ fg: color() }}>●</span> You
              </text>
              <Show
                when={queued()}
                fallback={
                  <text fg={theme.textMuted} wrapMode="none">
                    {Locale.todayTimeOrDateTime(props.message.time.created)}
                  </text>
                }
              >
                <text fg={theme.textMuted} wrapMode="none">
                  <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
                </text>
              </Show>
            </box>
            <text fg={theme.text}>{displayText().text}</text>
            <Show when={pastedContentParts().length > 0}>
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
            </Show>
            <Show when={collapsedDisplayText().compacted}>
              <text
                fg={theme.textMuted}
                onMouseUp={(event) => {
                  toggleExpandedText(event)
                }}
              >
                … {Locale.number(collapsedDisplayText().hiddenChars)} chars hidden
                <Show when={collapsedDisplayText().hiddenLines > 0}>
                  <span style={{ fg: theme.textMuted }}> · {Locale.number(collapsedDisplayText().hiddenLines)} more lines</span>
                </Show>
                <span style={{ fg: theme.textMuted }}>
                  {" "}· click to {expandedText() ? "collapse" : "expand"}
                </span>
              </text>
            </Show>
            <Show when={files().length}>
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
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
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
  if (reason === "no durable memory candidates" || (output.candidates === 0 && reason === "no pending update")) return ""
  return `Memory checked: ${Locale.truncate(reason, 72)}`
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const mend = useMendTuiProfile()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
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

  return (
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
                    <TimelineRowView row={node as TimelineRow} stackStart={isTimelineStackStart(nodes(), index())} />
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
  const active = createMemo(() => props.row.state === "pending" || props.row.state === "running")
  const failed = createMemo(() => props.row.state === "error" || props.row.class === "failure")
  const planning = createMemo(() => props.row.class === "planning")
  const lines = createMemo(() => props.row.lines ?? [])
  const detailed = createMemo(() => lines().length > 0)
  const color = createMemo(() =>
    failed() ? theme.error : planning() ? theme.warning : active() ? theme.text : theme.textMuted,
  )
  const icon = createMemo(() => (planning() ? "" : failed() ? "×" : "◆"))
  return (
    <box paddingLeft={3} marginTop={props.stackStart ? 1 : 0} flexShrink={0} flexDirection="column">
      <Show
        when={detailed()}
        fallback={
          <text fg={color()} attributes={active() && !planning() ? TextAttributes.BOLD : undefined}>
            <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
            <span>{props.row.title}</span>
          </text>
        }
      >
        <text fg={failed() ? theme.error : active() ? theme.text : theme.textMuted}>╭─ {props.row.title}</text>
        <For each={lines()}>{(line) => <text fg={theme.textMuted}>│ {line}</text>}</For>
        <text fg={theme.textMuted}>╰─</text>
      </Show>
    </box>
  )
}

function TimelineCollapseRow(props: { collapse: TimelineCollapse; stackStart?: boolean }) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  return (
    <box flexDirection="column" flexShrink={0} marginTop={props.stackStart ? 1 : 0}>
      <box
        paddingLeft={3}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => setExpanded((value) => !value)}
      >
        <text fg={hover() || expanded() ? theme.text : theme.textMuted}>
          ◇ {props.collapse.count} more
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
  const source = createMemo(() => (streaming() ? props.part.text.trimStart() : props.part.text.trim()))
  const messageWidth = createMemo(() =>
    sessionContentWidth(dimensions().width, promptChromeUsesFullSessionWidth(mend.profile.promptChrome.preset)),
  )
  const markdownWidth = createMemo(() => Math.max(1, messageWidth() - textPaddingLeft))
  const richRenderWidth = createMemo(() => Math.min(markdownWidth(), 100))
  const hasMermaid = createMemo(() => hasMermaidFence(source()))
  const streamingMarkdownContent = createMemo(() => {
    if (!streaming()) return
    if (renderer() !== "markdown" && renderer() !== "rich") {
      return
    }
    return { content: "", tail: source() }
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
  const markdownContent = createMemo(() => streamingMarkdownContent()?.content ?? markdownStaticContent() ?? richContent() ?? source())
  const markdownTail = createMemo(() => {
    const tail = streamingMarkdownContent()?.tail ?? ""
    return renderStreamingMarkdownTail(tail, richRenderWidth(), { tableMode: "grid", markdownMode: "tables-only" }, {
      finalized: !streaming(),
    })
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
              stableTextMode={false}
              colorizeHex={true}
              streamingTail={markdownTail()}
              streamingTailColorizeHex={true}
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
    return shouldRenderCompactTool(profile, props.part.tool)
  })

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
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
          <PresentationToolRow tool={props.part.tool} state={props.part.state.status} input={toolprops.input} />
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
      icon="◈"
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

function PresentationToolRow(props: { tool: string; state: string; input: Record<string, any> }) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const [margin, setMargin] = createSignal(0)
  const pending = createMemo(() => props.state === "pending" || props.state === "running")
  const errored = createMemo(() => props.state === "error")
  const event = createMemo(() => normalizeToolEvent({ tool: props.tool, state: props.state, input: props.input }))
  const icon = createMemo(() => {
    if (mend.profile.presentation.profile === "minimal") return props.state === "completed" ? "←" : "→"
    if (errored()) return "×"
    return "◈"
  })
  const title = createMemo(() => event().title)
  const detail = createMemo(() => {
    if (mend.profile.presentation.profile === "minimal") return title()
    return title()
  })
  return (
    <Show
      when={mend.profile.presentation.profile === "mendcode"}
      fallback={
        <box
          paddingLeft={3}
          marginTop={margin()}
          flexShrink={0}
          renderBefore={function () {
            updateToolBreakMargin(this as BoxRenderable, setMargin)
          }}
        >
          <text fg={errored() ? theme.error : pending() ? theme.text : theme.textMuted}>
            {icon()} {detail()}
          </text>
        </box>
      }
    >
      <Show
        when={event().lines.length > 0}
        fallback={
          <box
            paddingLeft={3}
            marginTop={margin()}
            flexShrink={0}
            renderBefore={function () {
              updateToolBreakMargin(this as BoxRenderable, setMargin)
            }}
          >
            <text fg={errored() ? theme.error : pending() ? theme.text : theme.textMuted}>
              {icon()} {title()}
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
          <text fg={errored() ? theme.error : pending() ? theme.text : theme.textMuted}>╭─ {title()}</text>
          <For each={event().lines}>{(line) => <text fg={theme.textMuted}>│ {line}</text>}</For>
          <Show when={event().result}>{(result) => <text fg={theme.textMuted}>╰─ {result()}</text>}</Show>
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
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const maxLines = 3
  const overflow = createMemo(() => lines().length > maxLines)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, maxLines), "…"].join("\n")
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
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
  const [hover, setHover] = createSignal(false)

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
                <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
              </Show>
            </text>
          </Match>
        </Switch>
        <Show when={error() && !denied()}>
          <text fg={theme.error}>{error()}</text>
        </Show>
      </box>
    </Show>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  titleColor?: RGBA
  titleAttributes?: typeof TextAttributes.BOLD
  variant?: "plain" | "left-line"
  contentGap?: number
  marginTop?: number
  paddingBottom?: number
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [margin, setMargin] = createSignal(0)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const title = () => (
    <Show
      when={props.spinner}
      fallback={
        <text fg={props.titleColor ?? theme.textMuted} attributes={props.titleAttributes}>
          {props.title}
        </text>
      }
    >
      <Spinner color={props.titleColor ?? theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
    </Show>
  )
  const content = () => (
    <>
      {title()}
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
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
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>$</text>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {props.command}
        </text>
      </box>
      <Show when={props.output}>
        <box paddingLeft={2} flexDirection="column">
          <For each={props.output?.split("\n") ?? []}>{(line) => <text fg={theme.textMuted}>{line || " "}</text>}</For>
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

function Shell(props: ToolProps<typeof ShellTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const [now, setNow] = createSignal(Date.now())
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    if (isRunning()) return ["...", ...lines().slice(-10)].join("\n")
    return [...lines().slice(0, 10), "…"].join("\n")
  })

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

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })
  const elapsed = createMemo(() => {
    if (!isRunning()) return
    const start = props.part.state.status === "running" ? props.part.state.time.start : undefined
    if (!start) return
    return formatDuration(Math.max(0, Math.round((now() - start) / 1000)))
  })

  const interval = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(interval))

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
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
            empty={<text fg={theme.textMuted}>No output emitted yet · running {elapsed()}</text>}
            overflow={overflow()}
            expanded={expanded()}
            running={isRunning()}
          />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
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
          title={"# Wrote " + normalizePath(props.input.filePath!)}
          titleColor={theme.diffHighlightAdded}
          part={props.part}
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
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
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
        icon="→"
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
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={props.input.url} part={props.part}>
      WebFetch {props.input.url}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const metadata = props.metadata as { numResults?: number }
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={props.input.query} part={props.part}>
      Exa Web Search "{props.input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
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
      content.push(
        [`└ ${tools().length} toolcalls`, Locale.duration(duration()), usage()?.compact ?? modelLabel()]
          .filter(Boolean)
          .join(" · "),
      )
    }

    return content
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
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
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { syntax } = useTheme()

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
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
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
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
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
      <box paddingLeft={1}>
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

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  function titleColor(file: { type: string }) {
    if (file.type === "delete") return theme.diffHighlightRemoved
    if (file.type === "add") return theme.diffHighlightAdded
    return undefined
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} titleColor={titleColor(file)} part={props.part}>
              <Diff diff={file.patch} filePath={file.filePath} />
              <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
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
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
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
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

function Loop(props: ToolProps<typeof LoopTool>) {
  const session = use()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal(false)

  const action = createMemo(() => (typeof props.input.action === "string" ? props.input.action : "loop"))
  const workflowID = createMemo(() => (typeof props.metadata.workflowID === "string" ? props.metadata.workflowID : undefined))
  const rootSessionID = createMemo(() => {
    const root = props.metadata.rootSessionID ?? props.metadata.sessionId
    return typeof root === "string" ? root : undefined
  })
  const firstWorkflow = createMemo(() => {
    const workflows = props.metadata.workflows
    if (!Array.isArray(workflows)) return undefined
    return workflows.find((item): item is {
      workflowID?: string
      rootSessionID?: string
      name?: string
    } => Boolean(item && typeof item === "object"))
  })
  const resolvedWorkflowID = createMemo(() => workflowID() ?? firstWorkflow()?.workflowID)
  const resolvedRootSessionID = createMemo(() => rootSessionID() ?? firstWorkflow()?.rootSessionID)
  const title = createMemo(() => {
    const name = firstWorkflow()?.name ?? (typeof props.input.name === "string" ? props.input.name : undefined)
    if (name?.trim()) return name.trim()
    if (action() === "list") return "Loop dashboard"
    if (action() === "draft") return "Loop draft"
    return "Loop workflow"
  })
  const objective = createMemo(() => {
    const value = typeof props.input.objective === "string" ? props.input.objective.trim() : ""
    return value || undefined
  })
  const panelWidth = createMemo(() => Math.max(48, Math.min(82, dimensions().width - 12)))
  const compact = (value: string, width = Math.max(16, panelWidth() - 18)) => Locale.truncateMiddle(value.replace(/\s+/g, " ").trim(), width)
  const rows = createMemo(() => [
    { label: "workflow", value: resolvedWorkflowID() ?? "pending", color: resolvedWorkflowID() ? theme.secondary : theme.textMuted },
    { label: "chat", value: resolvedRootSessionID() ?? "created on activation", color: resolvedRootSessionID() ? theme.secondary : theme.textMuted },
    { label: "dashboard", value: "/loops", color: theme.textMuted },
    { label: "goal", value: objective() ?? "configured by loop tool", color: theme.text },
  ])
  const openTarget = () => {
    const root = resolvedRootSessionID()
    if (root) {
      navigate({ type: "session", sessionID: root })
      return
    }
    navigate({ type: "loops", selectedID: resolvedWorkflowID(), returnTo: { type: "session", sessionID: session.sessionID } })
  }
  const openLabel = createMemo(() => resolvedRootSessionID() ? "open loop chat" : "open loops dashboard")

  return (
    <BlockTool
      title="↻ Loop Workflow"
      titleColor={theme.secondary}
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
          borderColor={hover() ? theme.secondary : theme.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={0}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box flexDirection="row">
            <text fg={theme.secondary} attributes={TextAttributes.BOLD}>↻ {compact(title(), Math.max(18, panelWidth() - 24))}</text>
            <box flexGrow={1} />
            <text fg={theme.textMuted}>receipt</text>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
            <For each={rows()}>
              {(row) => (
                <box flexDirection="row">
                  <text fg={theme.textMuted} wrapMode="none">{row.label.padEnd(9)}</text>
                  <text fg={row.color} wrapMode="none">{compact(row.value)}</text>
                </box>
              )}
            </For>
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
