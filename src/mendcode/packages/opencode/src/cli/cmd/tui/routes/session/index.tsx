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
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useEditorContext } from "@tui/context/editor"
import { useCommandDialog } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { TodoItem } from "../../component/todo-item"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { SubagentFooter } from "./subagent-footer.tsx"
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
import { getScrollAcceleration } from "../../util/scroll"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { restorePromptFromSubmittedParts } from "../../component/prompt/submit-parts"
import { useMendTuiProfile } from "../../context/mend"
import { subagentTaskColorIndex, type SubagentTaskColorEntry } from "../../util/subagent-color"
import { presentationReasoningVisible, reasoningSummary, shouldDisplayReasoning } from "@/mend/tui/presentation"
import { promptChromeUsesFullSessionWidth } from "@/mend/tui/prompt-chrome"
import { formatDuration } from "@/util/format"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import { reviewPermissionRequestWithModel, shouldTriggerSmartApproval } from "@/mend/permission/smart-approval"
import { readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import { normalizeToolEvent, shouldRenderCompactTool } from "@/mend/tui/timeline/normalize"
import { groupTimelineParts } from "@/mend/tui/timeline/group"
import type { TimelineRow } from "@/mend/tui/timeline/types"
import { TimelineDiff } from "./renderers/diff"
import {
  expandPastedContentPlaceholders,
  isPastedContentPart,
  userMessageDisplayText,
  type PastedContentDisplayPart,
} from "./user-message-display"
import { planReviewInlineTitle } from "../../util/plan-markdown"

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
  }
}

type BackgroundWriterInfo = {
  sessionID: string
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  writer?: {
    clientID: string
    acquired: number
    expires: number
  } | null
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
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const planReviews = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.plan_review[x.id] ?? [])
  })
  const visible = createMemo(
    () => !session()?.parentID && permissions().length === 0 && questions().length === 0 && planReviews().length === 0,
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
  const contentWidth = createMemo(() => Math.max(20, dimensions().width - contentInset()))
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
  const todos = createMemo(() => sync.data.todo[route.sessionID] ?? [])

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
  const backgroundWriterLocked = createMemo(() => {
    const mode = backgroundWriterMode()
    return mode === "attaching" || mode === "following"
  })
  const showSessionBottomDock = createMemo(() => showTodos() && !disabled() && !backgroundWriterLocked())
  const promptDisabled = createMemo(() => disabled() || backgroundWriterLocked())
  const [permissionModeSetting, setPermissionModeSetting] = createSignal<PermissionMode>("approval")
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
    for (const request of permissions()) {
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
              "--dangerously-skip-permissions only applies to `mend run`. This TUI mode only affects the current interactive session and does not override explicit deny rules.",
            ].join("\n"),
          )
        }}
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
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
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
      }),
      ({ mode, status }) => {
        if (eventlessFollowTimer) clearInterval(eventlessFollowTimer)
        eventlessFollowTimer = undefined
        if (mode === "attached") return
        if (status !== "busy" && status !== "retry") return
        eventlessFollowTimer = setInterval(() => {
          if (Date.now() - lastFollowSyncAt < 1_200) return
          scheduleFollowSync(0)
        }, 1_200)
      },
    ),
  )

  const eventSessionID = (evt: { properties?: unknown }) => {
    const properties = evt.properties as
      | { sessionID?: string; info?: { sessionID?: string }; part?: { sessionID?: string } }
      | undefined
    return properties?.sessionID ?? properties?.info?.sessionID ?? properties?.part?.sessionID
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
      const memory = part?.type === "step-finish"
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
      if (shownMemoryToastParts.has(part.id)) return
      const message = memoryToastMessage((part.metadata as { mendMemory?: SessionMemoryMetadata } | undefined)?.mendMemory)
      if (!message) return
      shownMemoryToastParts.add(part.id)
      pendingMemoryToastParts.set(part.id, message)
      setMemoryToastQueueVersion((version) => version + 1)
      return
    }
    if (part.type !== "tool") return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set((part.state.metadata as { planExitAgent?: string } | undefined)?.planExitAgent || "build")
      lastSwitch = part.id
    } else if (part.tool === "plan_review" && part.state.title === "Plan approved") {
      local.agent.set((part.state.metadata as { planExitAgent?: string } | undefined)?.planExitAgent || "build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
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

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()

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
    if (!session()?.parentID) return
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
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
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
      return
    }
    if (!backgroundWriterOwns()) setBackgroundWriterMode("attaching")
    const result = await acquireBackgroundWriter(sessionID)
    if (route.sessionID !== sessionID) return
    setBackgroundWriterOwner(result.info?.writer?.clientID)
    setBackgroundWriterOwns(result.acquired)
    setBackgroundWriterMode(result.acquired ? "attached" : "following")
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
        void refreshBackgroundWriter(sessionID).catch(() => {
          if (route.sessionID !== sessionID) return
          setBackgroundWriterMode("unmanaged")
          setBackgroundWriterOwner(undefined)
          setBackgroundWriterOwns(false)
        })
        const timer = setInterval(() => {
          if (!backgroundWriterOwns()) return
          void acquireBackgroundWriter(sessionID)
            .then((result) => {
              if (route.sessionID !== sessionID) return
              setBackgroundWriterOwner(result.info?.writer?.clientID)
              setBackgroundWriterOwns(result.acquired)
              setBackgroundWriterMode(result.acquired ? "attached" : "following")
            })
            .catch(() => undefined)
        }, 15_000)
        const unsubscribe = sdk.event.on("event", (event) => {
          const payload = event.payload as { type?: string; properties?: { sessionID?: string } }
          const type = payload.type
          if (type !== "background_session.updated" && type !== "background_session.deleted") return
          if (payload.properties?.sessionID && payload.properties.sessionID !== sessionID) return
          void refreshBackgroundWriter(sessionID).catch(() => undefined)
        })
        onCleanup(() => {
          clearInterval(timer)
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
    const state = hasInput || status?.type === "retry" ? "needs_input" : status?.type === "busy" ? "working" : "completed"
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
  command.register(() => [
    {
      title: "Permission mode",
      value: "session.permission.status",
      category: "Permissions",
      description: permissionModeDescription(),
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
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
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
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
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
        scroll.scrollBy(-scroll.height / 2)
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
        scroll.scrollBy(scroll.height / 2)
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
        scroll.scrollBy(-1)
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
        scroll.scrollBy(1)
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
        scroll.scrollBy(-scroll.height / 4)
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
        scroll.scrollBy(scroll.height / 4)
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
        scroll.scrollTo(0)
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
        scroll.scrollTo(scroll.scrollHeight)
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
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
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
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(-1)
        dialog.clear()
      }),
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
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexDirection="row" position="relative" width="100%">
        <Show when={!backgroundWriterLocked() && planReviews().length > 0}>
          <PlanReviewPrompt request={planReviews()[0]} />
        </Show>
        <box
          width="100%"
          flexGrow={1}
          flexShrink={0}
          paddingBottom={1}
          paddingLeft={promptEdgeToEdge() ? 0 : 2}
          paddingRight={promptEdgeToEdge() ? 0 : 2}
          gap={1}
        >
          <Show when={session()}>
            <box width="100%" height={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
              <text fg={theme.textMuted} wrapMode="none">
                 {sync.data.vcs?.branch || "git"} {topPathLabel()}
              </text>
              <SessionTopMetrics diff={topDiffStats()} usage={topUsage()} />
            </box>
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
                stickyScroll={true}
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
              <Show when={session()?.parentID}>
                <SubagentFooter />
              </Show>
              <Show when={backgroundWriterMode() === "following"}>
                <box paddingLeft={contentInset()} paddingRight={contentInset()} width="100%">
                  <text fg={theme.textMuted} wrapMode="none">
                    Following read-only · attached in another terminal
                    <Show when={backgroundWriterOwner()}>
                      {(owner) => <span style={{ fg: theme.textMuted }}> · {Locale.truncate(owner(), 18)}</span>}
                    </Show>
                  </text>
                </box>
              </Show>
              <Show when={backgroundWriterMode() === "attaching"}>
                <box paddingLeft={contentInset()} paddingRight={contentInset()} width="100%">
                  <text fg={theme.textMuted} wrapMode="none">Attaching session…</text>
                </box>
              </Show>
              <Show when={showSessionBottomDock()}>
                <SessionBottomDock
                  todos={todos()}
                  width={contentWidth()}
                  sessionID={route.sessionID}
                  info={{
                    branch: topBranchLabel(),
                    cwd: topPathLabel(),
                    model: (() => {
                      const model = local.model.current()
                      return model ? Model.name(providers(), model.providerID, model.modelID) : "model unset"
                    })(),
                    context: topUsage()?.contextLabel ?? "context n/a",
                    status: permissionPendingCount() > 0 ? `${permissionPendingCount()} permission` : pending() ? "assistant active" : "idle",
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

  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={props.diff}>
        {(diff) => (
          <text wrapMode="none">
            <span style={{ fg: theme.diffAdded }}>+{Locale.number(diff().added)}</span>
            <span style={{ fg: theme.textMuted }}> </span>
            <span style={{ fg: theme.diffRemoved }}>-{Locale.number(diff().removed)}</span>
          </text>
        )}
      </Show>
      <Show when={props.usage}>
        {(usage) => (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Show when={hasDiff()}>
              <text fg={theme.textMuted} wrapMode="none">
                |
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

function SessionUsageBar(props: { context: number; contextLimit?: number; contextPercent?: number }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const width = 8
  const percent = createMemo(() => {
    if (props.contextPercent === undefined) return undefined
    return Math.max(0, Math.min(100, props.contextPercent))
  })
  const filledCells = createMemo(() => {
    if (percent() === undefined) return 0
    if (percent()! <= 0) return 0
    return Math.max(1, Math.min(width, Math.round((percent()! / 100) * width)))
  })
  const emptyCells = createMemo(() => Math.max(0, width - filledCells()))
  const compactNumber = (value: number) => Locale.number(value).replace(".0K", "K").replace(".0M", "M")
  const detailLabel = createMemo(() => {
    if (props.contextLimit) return `${compactNumber(props.context)} / ${compactNumber(props.contextLimit)}`
    return compactNumber(props.context)
  })
  const compactLabel = createMemo(() => {
    if (props.contextLimit) {
      const rawPercent = (props.context / props.contextLimit) * 100
      if (rawPercent >= 100) return ">99%"
      return `${Math.max(1, Math.min(99, Math.round(rawPercent)))}%`
    }
    if (percent() === undefined) return Locale.number(props.context)
    return `${Math.max(1, Math.min(99, percent()!))}%`
  })
  const barWidth = createMemo(() =>
    percent() === undefined ? compactLabel().length : width + 1 + compactLabel().length,
  )
  const displayWidth = createMemo(() => Math.max(barWidth(), detailLabel().length))
  const barPad = createMemo(() => " ".repeat(Math.max(0, displayWidth() - barWidth())))
  const hoverLabel = createMemo(() => Locale.truncateMiddle(detailLabel(), displayWidth()))
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

type SessionTodo = { content: string; status: string; priority?: string }

type SessionBottomInfo = {
  branch: string
  cwd: string
  model: string
  context: string
  status: string
  permission: string
}

function clampDockWidth(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function sessionTodoIcon(status: string) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "▸"
  if (status === "cancelled") return "×"
  return "□"
}

function sessionTodoPanelWidth(input: {
  todos: SessionTodo[]
  maxWidth: number
  expanded: boolean
  collapsedLimit: number
}) {
  const hidden = Math.max(0, input.todos.length - input.collapsedLimit)
  const visibleTodos = input.expanded || hidden === 0 ? input.todos : input.todos.slice(0, input.collapsedLimit)
  const open = input.todos.filter((todo) => todo.status !== "completed").length
  const openLabel = `${Locale.number(open)} open`
  const headerWidth = "Todos".length + openLabel.length + 3
  const fallbackWidth = "□ No todo items.".length
  const itemWidth = Math.max(
    0,
    ...visibleTodos.map((todo) => `${sessionTodoIcon(todo.status)} ${todo.content}`.length),
    hidden > 0 ? `${input.expanded ? "▾ collapse" : `▸ ${Locale.number(hidden)} more`}`.length : 0,
  )
  return Math.min(input.maxWidth, Math.max(20, headerWidth, fallbackWidth, itemWidth) + 4)
}

function SessionBottomDock(props: { todos: SessionTodo[]; width: number; sessionID: string; info: SessionBottomInfo }) {
  const { theme } = useTheme()
  const mascotClearance = 8
  const dockHeight = 7
  const dockWidth = createMemo(() => Math.max(20, props.width - mascotClearance))
  const todoWidth = createMemo(() =>
    sessionTodoPanelWidth({
      todos: props.todos,
      maxWidth: dockWidth(),
      expanded: false,
      collapsedLimit: 7,
    }),
  )
  const remainingWidth = createMemo(() => Math.max(0, dockWidth() - todoWidth() - 2))
  const compact = createMemo(() => dockWidth() < 72 || remainingWidth() < 48)
  const showNotes = createMemo(() => !compact() || dockWidth() >= 52)
  const showInfo = createMemo(() => !compact() && remainingWidth() >= 74)
  const notesWidth = createMemo(() =>
    compact() ? dockWidth() : clampDockWidth(Math.floor(remainingWidth() * 0.6), 28, 44),
  )
  const infoWidth = createMemo(() => clampDockWidth(remainingWidth() - notesWidth() - 1, 24, 36))

  return (
    <box flexShrink={0} width="100%" paddingBottom={1}>
      <box
        width={dockWidth()}
        height={dockHeight}
        flexDirection={compact() ? "column" : "row"}
        gap={1}
        alignItems="stretch"
        overflow="hidden"
      >
        <SessionTodoPanel todos={props.todos} width={dockWidth()} height={dockHeight} />
        <Show when={showNotes()}>
          <SessionNotesWidget sessionID={props.sessionID} width={notesWidth()} height={dockHeight} />
        </Show>
        <Show when={showInfo()}>
          <SessionInfoWidget info={props.info} width={infoWidth()} height={dockHeight} />
        </Show>
        <Show when={!compact()}>
          <For each={listMendWidgets("sessionBottomDock")}>
            {(item) => (
              <box flexShrink={1} minWidth={18} height={dockHeight} backgroundColor={theme.backgroundPanel}>
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
  const textareaHeight = createMemo(() => Math.max(1, props.height - 3))
  const noteRows = createMemo(() => {
    const contentWidth = Math.max(1, props.width - 5)
    const lines = note().split("\n")
    return Math.max(
      1,
      lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / contentWidth)), 0),
    )
  })
  const noteOverflow = createMemo(() => noteRows() > textareaHeight())
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
          onKeyDown={(event) => {
            if (event.name !== "escape") return
            event.preventDefault()
            leaveNotes()
          }}
          onContentChange={() => {
            const next = textarea?.plainText ?? ""
            setNote(next)
            kv.set(key(), next)
          }}
        />
        <Show when={noteOverflow()}>
          <box width={1} height={textareaHeight()} flexShrink={0}>
            <For each={Array.from({ length: textareaHeight() })}>
              {(_, index) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {index() === 0 ? "█" : "│"}
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
      {label} <span style={{ fg: theme.text }}>{Locale.truncateMiddle(value, Math.max(8, props.width - label.length - 5))}</span>
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

function SessionTodoPanel(props: { todos: SessionTodo[]; width: number; height: number }) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const collapsedLimit = 7
  const open = createMemo(() => props.todos.filter((todo) => todo.status !== "completed").length)
  const hidden = createMemo(() => Math.max(0, props.todos.length - collapsedLimit))
  const visibleTodos = createMemo(() =>
    expanded() || hidden() === 0 ? props.todos : props.todos.slice(0, collapsedLimit),
  )
  const panelWidth = createMemo(() => {
    return sessionTodoPanelWidth({
      todos: props.todos,
      maxWidth: props.width,
      expanded: expanded(),
      collapsedLimit,
    })
  })
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
        onMouseUp={() => {
          if (hidden() > 0) setExpanded((value) => !value)
        }}
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
          <For each={visibleTodos()}>
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
          <Show when={hidden() > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {expanded() ? "▾" : "▸"} {expanded() ? "collapse" : `${Locale.number(hidden())} more`}
            </text>
          </Show>
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
  const displayText = createMemo(() =>
    userMessageDisplayText(
      fullText(),
      props.sticky ? { maxLines: 2, maxChars: 220 } : expandedPaste() ? { maxLines: 240, maxChars: 40_000 } : undefined,
    ),
  )
  const pastedContentChars = createMemo(() => pastedContentParts().reduce((total, part) => total + part.text.length, 0))
  const togglePastedContent = (event: unknown) => {
    const maybeEvent = event as { stopPropagation?: () => void } | undefined
    maybeEvent?.stopPropagation?.()
    setExpandedPaste((value) => !value)
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
            <Show when={displayText().compacted}>
              <text
                fg={theme.textMuted}
                onMouseUp={(event) => {
                  if (pastedContentParts().length > 0) togglePastedContent(event)
                }}
              >
                … {Locale.number(displayText().hiddenChars)} chars hidden
                <Show when={displayText().hiddenLines > 0}>
                  <span style={{ fg: theme.textMuted }}> · {Locale.number(displayText().hiddenLines)} more lines</span>
                </Show>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  · click to{" "}
                  {expandedPaste() ? "collapse" : pastedContentParts().length > 0 ? "expand" : "open actions"}
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

function memoryToastMessage(info: SessionMemoryMetadata | undefined) {
  if (!info?.output?.generate) return ""
  const output = info.output
  const saved = output.saved?.length ?? 0
  const proposals = output.proposals?.length ?? 0
  if (saved > 0) return `Memory saved ${saved}`
  if (proposals > 0) return `Memory proposal${proposals === 1 ? "" : "s"} ready: ${proposals}`
  return ""
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
              const component = createMemo(() =>
                node.type === "part" ? PART_MAPPING[node.part.type as keyof typeof PART_MAPPING] : undefined,
              )
              return (
                <Switch>
                  <Match when={node.type === "row"}>
                    <TimelineRowView row={node as TimelineRow} stackStart={isTimelineStackStart(nodes(), index())} />
                  </Match>
                  <Match when={node.type === "collapse"}>
                    <TimelineCollapseRow
                      count={node.type === "collapse" ? node.count : 0}
                      stackStart={isTimelineStackStart(nodes(), index())}
                    />
                  </Match>
                  <Match when={node.type === "part" && component()}>
                    <Dynamic
                      last={index() === nodes().length - 1}
                      component={component()}
                      part={node.type === "part" ? (node.part as any) : undefined}
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
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={usage()}>{(item) => <span style={{ fg: theme.textMuted }}> · {item().tokens}</span>}</Show>
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

function isTimelineStackStart(nodes: Array<{ type: string }>, index: number) {
  if (index === 0) return true
  const previous = nodes[index - 1]
  return previous?.type !== "row" && previous?.type !== "collapse"
}

function TimelineRowView(props: { row: TimelineRow; stackStart?: boolean }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.row.state === "pending" || props.row.state === "running")
  const failed = createMemo(() => props.row.state === "error" || props.row.class === "failure")
  const planning = createMemo(() => props.row.class === "planning")
  const color = createMemo(() => (failed() ? theme.error : planning() ? theme.warning : active() ? theme.text : theme.textMuted))
  const icon = createMemo(() => (planning() ? "" : failed() ? "×" : "◆"))
  return (
    <box paddingLeft={3} marginTop={0} flexShrink={0}>
      <text fg={color()} attributes={active() && !planning() ? TextAttributes.BOLD : undefined}>
        <Show when={icon()}>
          {(value) => <span>{value()} </span>}
        </Show>
        <span>{props.row.title}</span>
      </text>
    </box>
  )
}

function TimelineCollapseRow(props: { count: number; stackStart?: boolean }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} marginTop={0} flexShrink={0}>
      <text fg={theme.textMuted}>◇ {props.count} more</text>
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
  const summary = createMemo(() => reasoningSummary(content()))
  const reasoningDetail = createMemo(() => {
    return [
      reasoningTokenCount() > 0 ? `${Locale.number(reasoningTokenCount())} reasoning tokens` : undefined,
      !reasoningTokenCount() && encryptedReasoning() ? "reasoning metadata" : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  })
  const headerDetail = createMemo(() =>
    [isDone() ? Locale.duration(duration()) : undefined, reasoningDetail()].filter(Boolean).join(" · "),
  )
  const activeReasoningLabel = createMemo(() => "Thinking")

  return (
    <Show when={visible()}>
      <Switch>
        <Match when={raw()}>
          <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
            <box>
              <ReasoningHeader
                toggleable={false}
                open={true}
                done={isDone()}
                activeLabel={activeReasoningLabel()}
                title={summary().title}
                duration={headerDetail() || undefined}
              />
            </box>
            <Show when={summary().body}>
              <box marginTop={1}>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={subtleSyntax()}
                  content={summary().body}
                  conceal={ctx.conceal()}
                  fg={theme.textMuted}
                />
              </box>
            </Show>
          </box>
        </Match>
        <Match when={true}>
          <box
            id={"text-" + props.part.id}
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
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </Match>
          <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
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
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <text fg={errored() ? theme.error : pending() ? theme.text : theme.textMuted}>
            {icon()} {detail()}
          </text>
        </box>
      }
    >
      <Show
        when={event().lines.length > 0}
        fallback={
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <text fg={errored() ? theme.error : pending() ? theme.text : theme.textMuted}>
              {icon()} {title()}
            </text>
          </box>
        }
      >
        <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
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
          const parent = el.parent
          if (!parent) {
            return
          }
          if (el.height > 1) {
            setMargin(1)
            return
          }
          const children = parent.getChildren()
          const index = children.indexOf(el)
          const previous = children[index - 1]
          if (!previous) {
            setMargin(0)
            return
          }
          if (previous.height > 1 || previous.id.startsWith("text-")) {
            setMargin(1)
            return
          }
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
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={3}
      marginTop={1}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text fg={theme.textMuted}>
            {props.title}
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
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
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={!output() && isRunning()}>
              <text fg={theme.textMuted}>No output emitted yet · running {elapsed()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>
                {expanded() ? "Click to collapse" : isRunning() ? "Showing latest output" : "Click to expand"}
              </text>
            </Show>
          </box>
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
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
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
  const childStatusLabel = createMemo(() => {
    const status = childStatus()
    if (!isRunning() || status?.type !== "retry") return undefined
    return `↳ retrying${status.attempt > 1 ? ` #${status.attempt}` : ""}: ${status.message}`
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

    const status = childStatusLabel()
    if (status) content.push(status)

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
  const { syntax } = useTheme()

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

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
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

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
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
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
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
