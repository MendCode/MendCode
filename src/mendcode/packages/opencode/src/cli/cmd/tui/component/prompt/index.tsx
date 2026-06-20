import { BoxRenderable, RGBA, TextareaRenderable, MouseEvent, PasteEvent, decodePasteBytes } from "@opentui/core"
import {
  createEffect,
  createMemo,
  onMount,
  createSignal,
  onCleanup,
  on,
  Show,
  Switch,
  Match,
  For,
  createResource,
} from "solid-js"
import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "@tui/context/editor"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { computePromptTraits } from "./traits"
import { resolveActivePromptAgentName, resolveSelectedPromptModel, resolveSelectedPromptVariant } from "./agent"
import * as Model from "../../util/model"
import { assign } from "./part"
import {
  DEFAULT_PASTE_SUMMARY_MIN_CHARS,
  pastedContentLabel,
  parsePortableImageClipboard,
  promptSubmitParts,
  shouldSummarizePastedContentWithThreshold,
} from "./submit-parts"
import { findSlashCommandInvocation } from "./slash-command"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import type { AssistantMessage, FilePart, UserMessage } from "@mendcode/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { isTextareaNewlineKey, useTextareaKeybindings } from "../textarea-keybindings"
import { DialogSkill } from "../dialog-skill"
import { openWorkspaceSelect, warpWorkspaceSession, type WorkspaceSelection } from "../dialog-workspace-create"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { useArgs } from "@tui/context/args"
import { Flag } from "@mendcode/core/flag/flag"
import { WorkspaceLabel, type WorkspaceStatus } from "../workspace-label"
import { readModelsConfig } from "@/mend/config/models"
import { budgetEnforcementStatus } from "@/mend/runtime/budget"
import { useMendTuiProfile } from "@tui/context/mend"
import { listMendStatusEntries } from "@/mend/tui/status"
import { getMendFooter, listMendFooterEntries } from "@/mend/tui/footer"
import { readMendWorkingIndicator } from "@/mend/tui/working-indicator"
import { readMendEditorVisual } from "@/mend/tui/editor-host"
import { promptChromeUsesFullSessionWidth, resolvePromptChrome } from "@/mend/tui/prompt-chrome"
import { activityMascotHoverText, activityMascotText, mascotLineHitboxes, mascotTextWidth } from "@/mend/tui/mascot"
import { activityMessage, resolveActivityPhase } from "../../util/activity-signal"
import {
  assistantTokenTotals,
  compactContextTokenLabel,
  formatAssistantLiveUsage,
  formatWorkingLiveTokenUsage,
  usableContextLimit,
} from "../../util/usage"
import {
  pickPromptStatusScriptOutput,
  promptStatusScriptIdentityKey,
  readPromptStatusScript,
  resolvePromptStatus,
  type MendPromptStatusBuiltin,
  type MendPromptStatusScriptOutput,
  type MendPromptStatusScriptResult,
} from "@/mend/tui/prompt-status"

const NATIVE_COMPACTION_SLASHES = new Set(["compact", "summarize"])

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  permissionMode?: string
  permissionModeLabel?: string
  permissionPending?: number
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined
const workingStartedAtBySession = new Map<string, number>()

export function resolveWorkingStartedAt(input: {
  stored?: number
  activeAssistantCreated?: number
  sessionUpdated?: number
  fallback?: number
}) {
  return [input.stored, input.activeAssistantCreated, input.sessionUpdated, input.fallback]
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0)
    .toSorted((a, b) => a - b)[0]
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const args = useArgs()
  const mend = useMendTuiProfile()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const [promptStatusTick, setPromptStatusTick] = createSignal(Date.now())
  const [workingTick, setWorkingTick] = createSignal(Date.now())
  const [workingStartedAt, setWorkingStartedAt] = createSignal<number>()
  const [mascotHover, setMascotHover] = createSignal(false)
  let clearWorkingStartTimer: Timer | undefined
  function findActiveWorkingAssistant() {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    return msg.findLast((item): item is AssistantMessage => item.role === "assistant" && !item.time.completed)
  }
  onCleanup(() => {
    if (clearWorkingStartTimer) clearTimeout(clearWorkingStartTimer)
  })
  onMount(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setPromptStatusTick(now)
      setWorkingTick(now)
    }, 500)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(
    on(
      () => status().type !== "idle",
      (active) => {
        const sessionID = props.sessionID
        if (clearWorkingStartTimer) {
          clearTimeout(clearWorkingStartTimer)
          clearWorkingStartTimer = undefined
        }
        if (active) {
          const started = resolveWorkingStartedAt({
            stored: sessionID ? workingStartedAtBySession.get(sessionID) : undefined,
            activeAssistantCreated: findActiveWorkingAssistant()?.time.created,
            sessionUpdated: sessionID ? sync.session.get(sessionID)?.time.updated : undefined,
            fallback: workingStartedAt() ?? Date.now(),
          })
          if (sessionID && started) workingStartedAtBySession.set(sessionID, started)
          if (started) setWorkingStartedAt(started)
          return
        }
        setWorkingStartedAt(undefined)
        if (!sessionID) return
        clearWorkingStartTimer = setTimeout(() => {
          if (status().type === "idle" && !props.permissionPending) workingStartedAtBySession.delete(sessionID)
          clearWorkingStartTimer = undefined
        }, 1000)
      },
    ),
  )
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [workspaceSelection, setWorkspaceSelection] = createSignal<WorkspaceSelection>()
  const [workspaceCreating, setWorkspaceCreating] = createSignal(false)
  const [workspaceCreatingDots, setWorkspaceCreatingDots] = createSignal(3)
  const [warpNotice, setWarpNotice] = createSignal<string>()
  const editorVisual = createMemo(() => readMendEditorVisual())
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))
  const defaultWorkspaceID = createMemo(() => props.workspaceID ?? project.workspace.current())

  function selectWorkspace(selection: WorkspaceSelection | undefined) {
    setWorkspaceSelection(selection)
  }

  function setCreatingWorkspace(creating: boolean) {
    setWorkspaceCreating(creating)
  }

  function showWarpNotice(name: string) {
    setWarpNotice(`Warped to ${name}`)
    setTimeout(() => setWarpNotice(undefined), 4000)
  }

  async function createWorkspace(selection: Extract<WorkspaceSelection, { type: "new" }>) {
    setCreatingWorkspace(true)
    const result = await sdk.client.experimental.workspace
      .create({ type: selection.workspaceType, branch: null })
      .catch(() => undefined)
    if (result == undefined || result.error || !result.data) {
      selectWorkspace(undefined)
      setCreatingWorkspace(false)
      toast.show({
        message: "Creating workspace failed",
        variant: "error",
      })
      return
    }

    await project.workspace.sync()
    const workspace = result.data
    selectWorkspace({
      type: "existing",
      workspaceID: workspace.id,
      workspaceType: workspace.type,
      workspaceName: workspace.name,
    })
    setCreatingWorkspace(false)
    return workspace
  }

  async function warpSession(selection: WorkspaceSelection) {
    if (!props.sessionID) {
      selectWorkspace(selection)
      dialog.clear()
      if (selection.type === "new") void createWorkspace(selection)
      return
    }
    selectWorkspace(selection)
    dialog.clear()

    const workspace =
      selection.type === "none"
        ? { id: null, name: "local project" }
        : selection.type === "existing"
          ? { id: selection.workspaceID, name: selection.workspaceName }
          : await createWorkspace(selection)
    if (!workspace) return

    const warped = await warpWorkspaceSession({
      dialog,
      sdk,
      sync,
      project,
      toast,
      workspaceID: workspace.id,
      sessionID: props.sessionID,
    })
    if (warped) showWarpNotice(workspace.name)
  }

  createEffect(() => {
    if (!workspaceCreating()) {
      setWorkspaceCreatingDots(3)
      return
    }
    const timer = setInterval(() => setWorkspaceCreatingDots((dots) => (dots % 3) + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }

  const textareaKeybindings = useTextareaKeybindings()
  let suppressSubmitFromNewline = false
  let suppressSubmitFromNewlineTimer: ReturnType<typeof setTimeout> | undefined
  function markSubmitSuppressedForNewline() {
    suppressSubmitFromNewline = true
    if (suppressSubmitFromNewlineTimer) clearTimeout(suppressSubmitFromNewlineTimer)
    suppressSubmitFromNewlineTimer = setTimeout(() => {
      suppressSubmitFromNewline = false
      suppressSubmitFromNewlineTimer = undefined
    }, 0)
  }

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })
  const currentSession = createMemo(() => {
    if (!props.sessionID) return undefined
    return sync.data.session.find((item) => item.id === props.sessionID)
  })
  const sessionAgent = createMemo(() => {
    const name = currentSession()?.agent ?? lastUserMessage()?.agent
    if (!name) return undefined
    return sync.data.agent.find((item) => item.name === name && !item.hidden)
  })
  const sessionUsesSubagent = createMemo(() => {
    const name = sessionAgent()?.name
    if (!name) return false
    return !local.agent.list().some((item) => item.name === name)
  })
  const activeAgent = createMemo(() => {
    const name = resolveActivePromptAgentName({
      sessionAgentName: sessionAgent()?.name,
      localAgentName: local.agent.current()?.name,
      primaryAgentNames: local.agent.list().map((item) => item.name),
    })
    if (!name) return undefined
    return sync.data.agent.find((item) => item.name === name && !item.hidden)
  })
  const selectedPromptModel = createMemo(() => {
    const userModel = lastUserMessage()?.model
    const localOverride = local.model.overrideInfo()
    const sessionModel = currentSession()?.model as
      | { providerID?: string; id?: string; modelID?: string; variant?: string }
      | undefined
    const agentModel = sessionAgent()?.model as { providerID?: string; modelID?: string; id?: string } | undefined
    return resolveSelectedPromptModel({
      hasSession: Boolean(props.sessionID),
      sessionUsesSubagent: sessionUsesSubagent(),
      localModel: local.model.current(),
      localOverride: localOverride?.model,
      localOverrideUpdatedAt: localOverride?.updatedAt,
      userModel,
      userModelCreatedAt: lastUserMessage()?.time.created,
      sessionModel,
      agentModel,
    })
  })
  const selectedPromptVariant = createMemo(() => {
    const selectedModel = selectedPromptModel()
    const localVariantOverride = local.model.variant.overrideInfo(selectedModel)
    const sessionModel = currentSession()?.model as { variant?: string } | undefined
    return resolveSelectedPromptVariant({
      hasSession: Boolean(props.sessionID),
      localVariant: local.model.variant.current(selectedModel),
      hasLocalVariantOverride: local.model.variant.hasOverride(selectedModel),
      localVariantOverrideUpdatedAt: localVariantOverride?.updatedAt,
      userModel: lastUserMessage()?.model,
      userModelCreatedAt: lastUserMessage()?.time.created,
      sessionModel,
    })
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []

    const formatPromptUsage = (
      tokens: number,
      contextLimit: number | undefined,
      cost: number | undefined,
      estimated = false,
    ) => {
      if (tokens <= 0) return
      const contextPercent = contextLimit ? Math.round((tokens / contextLimit) * 100) : undefined
      const tokenLabel = `${estimated ? "~" : ""}${Locale.number(tokens)}`
      return {
        context: contextPercent ? `${tokenLabel} ${contextPercent}%` : tokenLabel,
        contextTokens: tokens,
        contextLimit,
        contextPercent,
        cost: cost && cost > 0 ? money.format(cost) : undefined,
      }
    }

    const active = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && !item.time.completed)
    if (active) {
      const previous = msg
        .slice(0, msg.indexOf(active))
        .findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
      const previousContext = previous ? assistantTokenTotals(previous).context : 0
      const live = formatAssistantLiveUsage(active, sync.data.provider)
      if (live) {
        const context = Math.max(live.context, previousContext)
        return formatPromptUsage(context, live.contextLimit, undefined, context > live.context)
      }

      const tokens = assistantTokenTotals(active).context
      const model = sync.data.provider.find((item) => item.id === active.providerID)?.models[active.modelID]
      const contextLimit = usableContextLimit(model)
      const context = Math.max(tokens, previousContext)
      const activeUsage = formatPromptUsage(context, contextLimit, undefined, context > tokens)
      if (activeUsage) return activeUsage
    }

    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens = assistantTokenTotals(last).context
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const contextLimit = usableContextLimit(model)
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return formatPromptUsage(tokens, contextLimit, cost)
  })
  const workingTokenUsage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const active = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && !item.time.completed)
    if (!active) return
    const live = active.liveUsage as
      | {
          source: "provider" | "tokenizer" | "estimate"
          phase: "input" | "output"
          input: number
          output: number
          reasoning: number
          cache: { read: number; write: number }
        }
      | undefined
    if (!live) return
    return formatWorkingLiveTokenUsage(live, { showReasoning: mend.profile.presentation.profile === "raw" })
  })
  const pasteSummaryMinChars = createMemo(() => {
    const experimental = sync.data.config.experimental as
      | (typeof sync.data.config.experimental & { paste_summary_min_chars?: number })
      | undefined
    return Math.max(1, experimental?.paste_summary_min_chars ?? DEFAULT_PASTE_SUMMARY_MIN_CHARS)
  })
  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Keep local prompt chrome aligned with the latest submitted user turn.
  let syncedUserModelKey: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()
    const modelKey = sessionID && msg?.id ? `${sessionID}:${msg.id}` : undefined

    if (modelKey !== syncedUserModelKey) {
      if (!sessionID || !msg || !modelKey) return

      syncedUserModelKey = modelKey

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        if (msg.model) {
          const hydrated = local.model.set(msg.model, { source: "hydrated" })
          if (hydrated) local.model.variant.set(msg.model.variant, { source: "hydrated", model: msg.model })
        }
      }
    }
  })

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "Prompt",
        hidden: true,
        onSelect: async (dialog) => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        value: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        onSelect: (dialog) => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
      {
        title: "Skills",
        value: "prompt.skills",
        category: "Prompt",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Warp",
        description: "Change the workspace for the session",
        value: "workspace.set",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slash: {
          name: "warp",
        },
        onSelect: (dialog) => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            toast,
            onSelect: (selection) => {
              void warpSession(selection)
            },
          })
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = computePromptTraits({
      mode: store.mode,
      disabled: !!props.disabled,
      autocompleteVisible: !!auto()?.visible,
    })
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  async function submit() {
    setWarpNotice(undefined)

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
    }
    syncExtmarksWithPromptParts()
    if (props.disabled) return false
    if (workspaceCreating()) return false
    if (autocomplete?.visible) return false
    if (!store.prompt.input) return false
    const agent = activeAgent()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const uiSlashInvocation = findSlashCommandInvocation(trimmed, (name) => {
      if (NATIVE_COMPACTION_SLASHES.has(name)) return false
      return command
        .slashes()
        .some((item) => item.display === `/${name}` || item.aliases?.some((alias) => alias === `/${name}`))
    })
    if (store.mode !== "shell" && uiSlashInvocation && command.triggerSlash(uiSlashInvocation.name)) {
      input.extmarks.clear()
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      return true
    }
    const selectedModel = selectedPromptModel()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }
    const modelConfig = await readModelsConfig(mend.root).catch(() => undefined)
    const configuredRole = Object.values(modelConfig?.roles || {}).find(
      (role) => role?.providerID === selectedModel.providerID && role?.modelID === selectedModel.modelID,
    )
    const budgetGate = await budgetEnforcementStatus(
      {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        authMode: configuredRole?.authMode || null,
      },
      mend.root,
    )
    if (budgetGate.blockers.length) {
      await DialogAlert.show(dialog, "MendCode Budget", budgetGate.blockers.join("\n"))
      return false
    }
    if (budgetGate.warnings.length) {
      toast.show({
        variant: "warning",
        message: budgetGate.warnings[0],
        duration: 5000,
      })
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            void openWorkspaceSelect({
              dialog,
              sdk,
              sync,
              toast,
              onSelect: (selection) => {
                void warpSession(selection)
              },
            })
            return false
          }}
        />
      ))
      return false
    }

    const variant = selectedPromptVariant()
    let sessionID = props.sessionID
    if (sessionID == null) {
      const workspace = workspaceSelection()
      const workspaceID = iife(() => {
        if (!workspace) return defaultWorkspaceID()
        if (workspace.type === "none") return undefined
        if (workspace.type === "existing") return workspace.workspaceID
        return undefined
      })

      const res = await sdk.client.session.create({
        workspace: workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant,
        },
      })

      if (res.error) {
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    local.model.set(selectedModel)
    local.model.variant.set(variant, { model: selectedModel })

    const messageID = MessageID.ascending()
    workingStartedAtBySession.set(sessionID, Date.now())
    setWorkingStartedAt(workingStartedAtBySession.get(sessionID))
    const submittedPrompt = promptSubmitParts(store.prompt)
    const inputText = submittedPrompt.inputText
    const nonTextParts = submittedPrompt.nonTextParts

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = editorContext()
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              id: PartID.ascending(),
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []
    const slashInvocation = findSlashCommandInvocation(
      inputText,
      (command) => NATIVE_COMPACTION_SLASHES.has(command) || sync.data.command.some((x) => x.name === command),
    )

    if (store.mode === "shell") {
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (slashInvocation && NATIVE_COMPACTION_SLASHES.has(slashInvocation.name)) {
      void sdk.client.session
        .summarize({
          sessionID,
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          auto: false,
          instructions: slashInvocation.arguments.trim() || undefined,
        })
        .catch((error) => {
          toast.show({
            title: "Compact failed",
            message: error instanceof Error && error.message ? error.message : "Could not compact this session.",
            variant: "error",
            duration: 5000,
          })
        })
    } else if (slashInvocation) {
      void sdk.client.session.command({
        sessionID,
        command: slashInvocation.name,
        arguments: slashInvocation.arguments,
        agent: agent.name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: PartID.ascending(),
            ...x,
          })),
      })
    } else {
      sdk.client.session
        .promptAsync({
          sessionID,
          ...selectedModel,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: [...editorParts, ...submittedPrompt.parts.map(assign)],
        })
        .catch((error) => {
          toast.show({
            title: "Prompt not sent",
            message:
              error instanceof Error && error.message ? error.message : "Connection failed. MendCode is reconnecting.",
            variant: "error",
            duration: 5000,
          })
        })
      if (editorParts.length > 0) editor.markSelectionSent()
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    input.clear()
    return true
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = activeAgent()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const selectedModel = selectedPromptModel()
    const variants = local.model.variant.list(selectedModel)
    if (variants.length === 0) return false
    const current = local.model.variant.current(selectedModel)
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!activeAgent(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!activeAgent() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!activeAgent() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))
  const promptChrome = createMemo(() => resolvePromptChrome(mend.profile.promptChrome, editorVisual()?.chrome))
  const promptBorderGlyph = createMemo(() => {
    if (editorVisual()?.borderGlyph) return editorVisual()!.borderGlyph!
    if (promptChrome().preset === "left-rail") return SplitBorder.customBorderChars.vertical
    return promptChrome().borderGlyph
  })
  const promptFooterGlyph = createMemo(() => editorVisual()?.footerGlyph || promptChrome().footerGlyph)
  const promptUsesPanelBackground = createMemo(() => {
    const preset = promptChrome().preset
    return preset === "left-rail" || preset === "minimal"
  })
  const promptUsesCompactTopPadding = createMemo(() => {
    const preset = promptChrome().preset
    return preset === "box" || preset === "top-bottom" || preset === "ascii-box"
  })
  const promptWantsFullWidth = createMemo(() => promptChromeUsesFullSessionWidth(promptChrome().preset))
  const promptLeadText = createMemo(() => promptChrome().leadText)
  const promptUsesFlushLead = createMemo(() => !!promptLeadText())
  const promptLeadInsetLeft = createMemo(() => (promptChrome().preset === "box" ? 1 : 0))
  const promptInnerTextBottomPadding = createMemo(() => {
    const preset = promptChrome().preset
    if (preset === "ascii-box") return 0
    if (preset === "minimal") return 1
    return 0
  })
  const promptInnerMetaTopPadding = createMemo(() => (promptChrome().preset === "ascii-box" ? 1 : 0))
  const promptFooterPadRight = createMemo(() => {
    const preset = promptChrome().preset
    return preset === "minimal" || preset === "top-bottom" ? 2 : 0
  })
  const promptFooterPadTop = createMemo(() => (promptChrome().preset === "minimal" ? 1 : 0))
  const promptOuterMetaPadLeft = createMemo(() => {
    const preset = promptChrome().preset
    if (preset === "minimal" || preset === "top-bottom" || preset === "box") return 1
    return 3
  })
  const promptStatusConfig = createMemo(() => resolvePromptStatus(mend.profile.promptStatus, promptChrome().preset))
  const commandsHintText = createMemo(() => `${keybind.print("command_list")} commands`)
  const agentsHintText = createMemo(() => `${keybind.print("agent_cycle")} agents`)
  const promptStatusVisibleInPrompt = createMemo(() => true)
  const promptStatusUsesDefaultItems = createMemo(() => promptChrome().preset !== "ascii-box")
  const promptStatusPlacement = createMemo(() => promptStatusConfig().placement)
  const promptStatusUsesOuterMeta = createMemo(
    () => promptStatusVisibleInPrompt() && promptStatusPlacement() === "outside",
  )
  const promptStatusSeparator = createMemo(() => promptStatusConfig().separator)
  const currentAgentLabel = createMemo(() => {
    if (store.mode === "shell") return "Shell"
    const agent = activeAgent()
    if (agent?.name) return Locale.titlecase(agent.name)
    return mend.promptMode
  })
  const currentModelLabel = createMemo(() => {
    const selectedModel = selectedPromptModel()
    if (!selectedModel) return local.model.parsed().model
    return Model.name(sync.data.provider, selectedModel.providerID, selectedModel.modelID)
  })
  const currentSelectedProviderLabel = createMemo(() => {
    const selectedModel = selectedPromptModel()
    if (!selectedModel) return currentProviderLabel()
    return sync.data.provider.find((item) => item.id === selectedModel.providerID)?.name ?? selectedModel.providerID
  })
  const currentProviderText = createMemo(() => currentSelectedProviderLabel())
  const currentReasoningLabel = createMemo(() => selectedPromptVariant() || undefined)
  const currentRootName = createMemo(() => {
    const normalized = mend.root.replace(/\/+$/, "")
    const parts = normalized.split("/")
    return parts[parts.length - 1] || normalized
  })

  type PromptStatusSegment = {
    text: string
    fg: RGBA
    render?: JSX.Element
    bold?: boolean
    separatorBefore?: boolean
  }

  function PromptStatusSegmentText(props: { segment: PromptStatusSegment }) {
    return (
      <Show
        when={props.segment.render}
        fallback={
          <text fg={props.segment.fg} wrapMode="none">
            <Show when={props.segment.bold} fallback={props.segment.text}>
              <span style={{ bold: true }}>{props.segment.text}</span>
            </Show>
          </text>
        }
      >
        {props.segment.render}
      </Show>
    )
  }

  const resolvePromptStatusScriptColor = (token?: string) => {
    if (!token) return theme.textMuted
    const override = promptStatusConfig().colors?.[token]
    const value = override || token
    if (value.startsWith?.("#")) {
      try {
        return RGBA.fromHex(value)
      } catch {
        return theme.textMuted
      }
    }
    switch (value) {
      case "text":
        return theme.text
      case "muted":
        return theme.textMuted
      case "accent":
        return theme.accent
      case "primary":
        return theme.primary
      case "secondary":
        return theme.secondary
      case "warning":
        return theme.warning
      case "error":
        return theme.error
      case "success":
        return theme.success
      case "info":
        return theme.info
      case "mode":
        return highlight()
      case "provider":
        return theme.textMuted
      case "reasoning":
        return theme.warning
      case "seda":
        return theme.error
      case "divider":
        return theme.textMuted
      case "contextbar":
        return theme.accent
      case "contextempty":
        return theme.backgroundElement
      case "contexttext":
        return theme.textMuted
      case "greeting":
        return theme.textMuted
      default: {
        const maybeTheme = (theme as unknown as Record<string, RGBA | undefined>)[value]
        return maybeTheme || theme.textMuted
      }
    }
  }

  const promptStatusBuiltinSegment = (value: MendPromptStatusBuiltin): PromptStatusSegment | undefined => {
    switch (value) {
      case "mode":
        if (store.mode === "shell") return { text: "Shell", fg: theme.primary }
        return activeAgent()
          ? { text: Locale.titlecase(activeAgent()!.name), fg: highlight() }
          : undefined
      case "model":
        return store.mode === "normal" ? { text: currentModelLabel(), fg: keybind.leader ? theme.textMuted : theme.text } : undefined
      case "provider":
        return store.mode === "normal" ? { text: currentProviderText(), fg: theme.textMuted } : undefined
      case "reasoning":
      case "variant":
        return store.mode === "normal" && currentReasoningLabel()
          ? { text: currentReasoningLabel()!, fg: theme.warning, bold: true }
          : undefined
      case "context":
        if (promptStatusConfig().context?.visible !== true) return undefined
        return usage()?.context
          ? {
              text: usage()!.contextPercent === undefined ? usage()!.context! : "█".repeat(8) + " 100%",
              fg: theme.textMuted,
              render: (
                <ContextUsageBar
                  tokens={usage()!.context!}
                  tokenCount={usage()!.contextTokens}
                  limit={usage()!.contextLimit}
                  percent={usage()!.contextPercent}
                />
              ),
            }
          : undefined
      case "permissionMode": {
        const label = props.permissionModeLabel || props.permissionMode
        if (!label) return
        return {
          text: props.permissionPending ? `${label} (${props.permissionPending})` : label,
          fg:
            props.permissionMode === "full_access"
              ? theme.warning
              : props.permissionMode === "smart"
                ? theme.primary
                : theme.textMuted,
          bold: props.permissionMode === "full_access" || props.permissionMode === "smart",
        }
      }
      case "commandsHint":
        return { text: commandsHintText(), fg: theme.text }
      case "agentsHint":
        return { text: agentsHintText(), fg: theme.text }
    }
  }

  function ContextUsageBar(props: { tokens: string; tokenCount?: number; limit?: number; percent?: number }) {
    const [hover, setHover] = createSignal(false)
    const width = 8
    const labelWidth = 4
    const totalWidth = width + 1 + labelWidth
    const pct = createMemo(() => {
      if (props.percent === undefined) return undefined
      return Math.max(0, Math.min(100, props.percent))
    })
    const filled = createMemo(() => {
      if (pct() === undefined) return 0
      return Math.max(1, Math.min(width, Math.round((pct()! / 100) * width)))
    })
    const empty = createMemo(() => Math.max(0, width - filled()))
    const label = createMemo(() => {
      if (hover() && props.tokenCount) return compactContextTokenLabel(props.tokenCount)
      return `${pct()}%`.padEnd(labelWidth)
    })
    return (
      <text
        width={totalWidth}
        flexShrink={0}
        wrapMode="none"
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <Show when={pct() !== undefined} fallback={<span style={{ fg: theme.textMuted }}>{props.tokens}</span>}>
          <span style={{ fg: theme.text }}>{"█".repeat(filled())}</span>
          <span style={{ fg: theme.backgroundElement }}>{"█".repeat(empty())}</span>
          <span style={{ fg: theme.textMuted }}> {label()}</span>
        </Show>
      </text>
    )
  }

  const promptStatusScriptSource = createMemo(() => {
    if (!promptStatusConfig().enabled) return {}
    const shared = {
      root: mend.root,
      rootName: currentRootName(),
      sessionID: props.sessionID,
      workspaceID: props.workspaceID,
      promptMode: mend.promptMode,
      promptModeLabel: currentAgentLabel(),
      agentLabel: currentAgentLabel(),
      model: currentModelLabel(),
      modelLabel: currentModelLabel(),
      provider: currentProviderText(),
      providerLabel: currentProviderText(),
      reasoning: currentReasoningLabel(),
      reasoningLabel: currentReasoningLabel(),
      variant: currentReasoningLabel(),
      context: usage()?.context,
      contextTokens: usage()?.contextTokens,
      contextLimit: usage()?.contextLimit,
      contextPercent: usage()?.contextPercent,
      permissionMode: props.permissionMode,
      permissionModeLabel: props.permissionModeLabel,
      permissionPending: props.permissionPending,
      commandsHint: commandsHintText(),
      agentsHint: agentsHintText(),
      preset: promptChrome().preset,
    }
    return {
      left: (() => {
        const script = promptStatusConfig().scripts?.left
        if (!script?.enabled || !script.command?.trim()) return
        const refreshMs = Math.max(250, script.refreshMs || 1000)
        return {
          ...shared,
          command: script.command.trim(),
          side: "left" as const,
          prepend: Boolean(script.prepend),
          timeoutMs: script.timeoutMs || 150,
          refreshKey: Math.floor(promptStatusTick() / refreshMs),
        }
      })(),
      right: (() => {
        const script = promptStatusConfig().scripts?.right
        if (!script?.enabled || !script.command?.trim()) return
        const refreshMs = Math.max(250, script.refreshMs || 1000)
        return {
          ...shared,
          command: script.command.trim(),
          side: "right" as const,
          prepend: Boolean(script.prepend),
          timeoutMs: script.timeoutMs || 150,
          refreshKey: Math.floor(promptStatusTick() / refreshMs),
        }
      })(),
    }
  })
  const promptStatusLeftScriptSource = createMemo(() => {
    const input = promptStatusScriptSource().left
    if (!input) return
    return {
      identity: promptStatusScriptIdentityKey(input),
      input,
    }
  })
  const promptStatusRightScriptSource = createMemo(() => {
    const input = promptStatusScriptSource().right
    if (!input) return
    return {
      identity: promptStatusScriptIdentityKey(input),
      input,
    }
  })
  const [promptStatusLeftScriptResult] = createResource(
    () => promptStatusLeftScriptSource(),
    async (source): Promise<MendPromptStatusScriptResult> => ({
      identity: source.identity,
      output: await readPromptStatusScript(source.input),
    }),
  )
  const [promptStatusRightScriptResult] = createResource(
    () => promptStatusRightScriptSource(),
    async (source): Promise<MendPromptStatusScriptResult> => ({
      identity: source.identity,
      output: await readPromptStatusScript(source.input),
    }),
  )

  const promptStatusSegments = (side: "left" | "right") => {
    const resolved = promptStatusConfig()
    if (!promptStatusVisibleInPrompt()) return [] as PromptStatusSegment[]
    if (!resolved.enabled) return [] as PromptStatusSegment[]
    const script = resolved.scripts?.[side]
    const scriptOwnsLeftStatus =
      side === "left" && promptStatusUsesOuterMeta() && Boolean(script?.enabled && script.command?.trim())
    const items = promptStatusUsesDefaultItems()
      ? side === "left"
        ? scriptOwnsLeftStatus
          ? []
          : resolved.left
        : resolved.right
      : []
    const base = items
      .map((item) => (item.type === "builtin" ? promptStatusBuiltinSegment(item.value) : undefined))
      .filter((item): item is PromptStatusSegment => Boolean(item && item.text.trim()))
      .map((item, index) => ({ ...item, separatorBefore: index > 0 }))
    const currentScript = (side === "left" ? promptStatusLeftScriptResult() : promptStatusRightScriptResult()) as
      | MendPromptStatusScriptResult
      | undefined
    const latestScript = (
      side === "left" ? promptStatusLeftScriptResult.latest : promptStatusRightScriptResult.latest
    ) as MendPromptStatusScriptResult | undefined
    const currentIdentity = side === "left" ? promptStatusLeftScriptSource()?.identity : promptStatusRightScriptSource()?.identity
    const scriptOutput = pickPromptStatusScriptOutput({
      currentIdentity,
      current: currentScript,
      latest: latestScript,
    }) as MendPromptStatusScriptOutput | undefined
    if (scriptOutput?.segments?.length) {
      const separatorBefore = base.length > 0
      const next = scriptOutput.segments
        .filter((item): item is { text: string; fg?: string; bold?: boolean } => Boolean(item.text.trim()))
        .map((item, index: number) => ({
          text: item.text,
          fg: resolvePromptStatusScriptColor(item.fg),
          bold: item.bold,
          separatorBefore: index === 0 ? separatorBefore : false,
        }))
      if (script?.prepend) base.unshift(...next)
      else base.push(...next)
      return base
    }
    if (scriptOutput?.text?.trim()) {
      const next = { text: scriptOutput.text.trim(), fg: theme.textMuted, separatorBefore: base.length > 0 }
      if (script?.prepend) base.unshift(next)
      else base.push(next)
    }
    return base
  }

  const promptStatusLeftSegments = createMemo(() => promptStatusSegments("left"))
  const promptStatusRightSegments = createMemo(() => promptStatusSegments("right"))
  const promptStatusOuterRightSegments = createMemo(() =>
    promptStatusRightSegments()
      .filter((segment) => segment.text !== usage()?.context)
      .map((segment, index) => ({ ...segment, separatorBefore: index > 0 })),
  )

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false || editorVisual()?.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      const examples = editorVisual()?.shellExamples?.length ? editorVisual()!.shellExamples! : shell()
      if (!examples.length) return undefined
      const example = examples[store.placeholder % examples.length]
      return `${editorVisual()?.shellPrefix || "Run a command..."} "${example}"`
    }
    const examples = editorVisual()?.normalExamples?.length ? editorVisual()!.normalExamples! : list()
    if (!examples.length) return undefined
    return `${editorVisual()?.normalPrefix || "Ask anything..."} "${examples[store.placeholder % examples.length]}"`
  })

  const workspaceLabel = createMemo<
    | { type: "new"; workspaceType: string }
    | { type: "existing"; workspaceType: string; workspaceName: string; status?: WorkspaceStatus }
    | undefined
  >(() => {
    const selected = workspaceSelection()
    if (!selected) {
      const workspaceID = defaultWorkspaceID()
      if (props.sessionID || !workspaceID) return
      const workspace = project.workspace.get(workspaceID)
      return {
        type: "existing",
        workspaceType: workspace?.type ?? "unknown",
        workspaceName: workspace?.name ?? workspaceID,
        status: project.workspace.status(workspaceID) ?? "error",
      }
    }
    if (selected.type === "none") return
    if (props.sessionID && !workspaceCreating()) return
    if (selected.type === "new") {
      return {
        type: "new",
        workspaceType: selected.workspaceType,
      }
    }
    return {
      type: "existing",
      workspaceType: selected.workspaceType,
      workspaceName: selected.workspaceName,
      status: selected.type === "existing" ? "connected" : undefined,
    }
  })

  const workingIndicatorConfig = createMemo(() => {
    const profile = mend.profile.workingIndicator
    const presentation = mend.profile.presentation
    const runtime = readMendWorkingIndicator()
    return {
      frames: runtime.frames ?? profile.frames,
      intervalMs: runtime.intervalMs ?? profile.intervalMs,
      messages: runtime.messages ?? profile.messages ?? ["Thinking..."],
      messageIntervalMs: runtime.messageIntervalMs ?? profile.messageIntervalMs ?? 2500,
      visible: runtime.visible ?? profile.visible ?? true,
      showElapsed: runtime.showElapsed ?? presentation.activity.showElapsed ?? profile.showElapsed ?? true,
      showTokenUsage: runtime.showTokenUsage ?? presentation.activity.showTokens ?? profile.showTokenUsage ?? true,
      showModel: presentation.activity.showModel,
      showInterruptHint: presentation.activity.showInterruptHint,
    }
  })
  const activeWorkingAssistant = createMemo(findActiveWorkingAssistant)
  const workingLiveUsage = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return
    return active.liveUsage
  })
  const activityToolNames = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return []
    return (sync.data.part[active.id] ?? [])
      .map((part) => {
        const raw = part as Record<string, any>
        return raw.tool || raw.toolID || raw.title || raw.name || raw.type
      })
      .filter((item): item is string => typeof item === "string")
  })
  const activeActivityToolNames = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return []
    return (sync.data.part[active.id] ?? [])
      .filter((part) => {
        const raw = part as Record<string, any>
        return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
      })
      .map((part) => {
        const raw = part as Record<string, any>
        return raw.tool || raw.toolID || raw.title || raw.name
      })
      .filter((item): item is string => typeof item === "string")
  })
  const activityHasReasoning = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return false
    return (sync.data.part[active.id] ?? []).some((part) => (part as Record<string, unknown>).type === "reasoning")
  })
  const activityHasAnswerText = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return false
    return (sync.data.part[active.id] ?? []).some((part) => (part as Record<string, unknown>).type === "text")
  })
  const effectiveConnectionStatus = createMemo(() => {
    const connection = sdk.connection
    if (
      status().type !== "idle" &&
      connection.status === "connected" &&
      connection.recoveringSince &&
      (!connection.lastApplicationEventAt || connection.lastApplicationEventAt < connection.recoveringSince)
    ) {
      return "reconnecting" as const
    }
    return connection.status
  })
  const activityPhase = createMemo(() => {
    const currentStatus = status()
    return resolveActivityPhase({
      status: currentStatus.type,
      statusKind: currentStatus.type === "busy" ? currentStatus.kind : undefined,
      retry: currentStatus.type === "retry",
      connection: effectiveConnectionStatus(),
      toolNames: activityToolNames(),
      activeToolNames: activeActivityToolNames(),
      hasReasoning: activityHasReasoning(),
      hasAnswerText: activityHasAnswerText(),
      livePhase: workingLiveUsage()?.phase,
      liveOutputTokens: workingLiveUsage()?.output,
      liveReasoningTokens: workingLiveUsage()?.reasoning,
    })
  })
  const workingMessage = createMemo(() => {
    if (props.permissionPending) return props.permissionModeLabel || "Permission pending..."
    const config = workingIndicatorConfig()
    const phaseMessage = activityMessage({ profile: mend.profile, phase: activityPhase(), tick: workingTick() })
    if (phaseMessage) return phaseMessage
    const messages = config.messages.filter((item) => item.trim())
    if (!messages.length) return "Thinking..."
    const interval = Math.max(250, config.messageIntervalMs || 2500)
    return messages[Math.floor(workingTick() / interval) % messages.length]
  })
  const resolvedWorkingStartedAt = createMemo(() =>
    resolveWorkingStartedAt({
      stored: props.sessionID ? workingStartedAtBySession.get(props.sessionID) : undefined,
      activeAssistantCreated: activeWorkingAssistant()?.time.created,
      sessionUpdated: props.sessionID ? sync.session.get(props.sessionID)?.time.updated : undefined,
      fallback: workingStartedAt(),
    }),
  )
  createEffect(() => {
    if (status().type === "idle") return
    const started = resolvedWorkingStartedAt()
    if (!started) return
    if (props.sessionID && workingStartedAtBySession.get(props.sessionID) !== started) {
      workingStartedAtBySession.set(props.sessionID, started)
    }
    if (workingStartedAt() !== started) setWorkingStartedAt(started)
  })
  const workingElapsed = createMemo(() => {
    if (!workingIndicatorConfig().showElapsed) return
    const started = resolvedWorkingStartedAt()
    if (!started) return
    return formatDuration(Math.max(0, Math.round((workingTick() - started) / 1000)))
  })
  const workingRightMeta = createMemo(() => {
    const items = [workingIndicatorConfig().showModel ? currentModelLabel() : undefined].filter(Boolean)
    return items.length ? items.join(" ") : undefined
  })
  const hoverMascot = createMemo(() => activityMascotHoverText(mend.profile))
  const displayMascot = (text: string | undefined) => (mascotHover() ? hoverMascot() || text : text)
  const workingMascotBase = createMemo(() => activityMascotText(mend.profile, activityPhase()))
  const idleMascotBase = createMemo(() => activityMascotText(mend.profile, "idle"))
  const workingMascot = createMemo(() => displayMascot(workingMascotBase()))
  const idleMascot = createMemo(() => displayMascot(idleMascotBase()))
  const mascotRightOffset = createMemo(() => {
    const preset = promptChrome().preset
    if (preset === "box" || preset === "ascii-box") return promptFooterPadRight() + 2
    return promptFooterPadRight()
  })
  const mascotPromptTopOffset = createMemo(() => {
    const preset = promptChrome().preset
    if (preset === "minimal") return 0
    if (preset === "left-rail") return 0
    return -3
  })
  const workingIndicatorVisible = createMemo(() => {
    return Boolean(props.sessionID && workingIndicatorConfig().visible !== false && status().type !== "idle")
  })
  const promptInputPadTop = createMemo(() => {
    if (promptChrome().preset === "minimal") return 1
    if (promptUsesPanelBackground()) return 0
    return promptUsesCompactTopPadding() ? 0 : 1
  })
  const promptMascotTopSpacerHeight = createMemo(() => {
    const preset = promptChrome().preset
    if (preset !== "minimal" && preset !== "left-rail") return 0
    if (!props.sessionID) return 0
    if (!workingMascot() && !idleMascot()) return 0
    return 3
  })
  const mascotTopOffset = createMemo(() => {
    return (workingIndicatorVisible() ? 1 : 0) + mascotPromptTopOffset()
  })
  const workingLeftMaxWidth = createMemo(() => {
    const rightMetaWidth = workingRightMeta()?.length ?? 0
    const mascotWidth = 0
    const interruptWidth = workingIndicatorConfig().showInterruptHint ? "[esc again to interrupt]".length : 0
    const separatorWidth = [rightMetaWidth, interruptWidth, mascotWidth].filter(Boolean).length * 2
    return Math.max(
      12,
      dimensions().width -
        promptOuterMetaPadLeft() -
        promptFooterPadRight() -
        rightMetaWidth -
        interruptWidth -
        mascotWidth -
        separatorWidth -
        8,
    )
  })
  const fitWorkingText = (value: string) => Locale.truncate(value, workingLeftMaxWidth())
  const workingConnectionMessage = createMemo(() => {
    const connection = sdk.connection
    const effectiveStatus = effectiveConnectionStatus()
    if (effectiveStatus === "connecting") return "connecting to MendCode..."
    if (effectiveStatus === "reconnecting")
      return `reconnecting to MendCode${connection.attempt > 1 ? ` #${connection.attempt}` : ""}...`
    if (effectiveStatus === "failed") return `connection lost after ${connection.attempt} reconnect attempts`
    if (effectiveStatus === "disconnected") return "disconnected from MendCode"

    return
  })
  const mflowWaitMessage = createMemo(() => {
    const current = status() as { type: string; kind?: string; message?: string; until?: number }
    if (current.type !== "busy" || current.kind !== "mflow-wait" || !current.message) return
    const seconds = current.until ? Math.max(0, Math.ceil((current.until - workingTick()) / 1000)) : undefined
    return `${current.message}${seconds === undefined ? "" : ` (${seconds}s)`}`
  })
  const workingIndicatorView = () => {
    const connectionMessage = workingConnectionMessage()
    const mflowMessage = mflowWaitMessage()
    const message = fitWorkingText(
      connectionMessage ??
        mflowMessage ??
        [workingMessage(), workingElapsed(), workingIndicatorConfig().showTokenUsage ? workingTokenUsage() : undefined]
          .filter(Boolean)
          .join("  "),
    )
    const color =
      effectiveConnectionStatus() === "failed" ? theme.error : connectionMessage || mflowMessage ? theme.warning : theme.text
    return <Spinner color={color}>{message}</Spinner>
  }
  const MascotLines = (props: { text: string; hoverText?: string; paddingTop?: number }) => (
    <box
      flexDirection="column"
      flexShrink={0}
      width={mascotTextWidth(props.text, props.hoverText)}
      paddingTop={props.paddingTop ?? 1}
    >
      {mascotLineHitboxes(props.text).map((line) => (
        <box flexDirection="row" height={1}>
          <Show when={line.left > 0}>
            <box width={line.left} />
          </Show>
          <text
            fg={theme.textMuted}
            wrapMode="none"
            onMouseOver={() => setMascotHover(true)}
            onMouseMove={() => setMascotHover(true)}
            onMouseOut={() => setMascotHover(false)}
          >
            {line.text}
          </text>
        </box>
      ))}
    </box>
  )
  const statusEntries = createMemo(() => listMendStatusEntries())
  const footerEntries = createMemo(() => listMendFooterEntries())
  const customFooter = createMemo(() => getMendFooter())
  const promptShowsOuterFooter = createMemo(() => {
    if (status().type !== "idle") return true
    if (warpNotice()) return true
    if (workspaceLabel()) return true
    if (store.mode === "shell") return true
    if (customFooter()) return true
    if (promptStatusUsesOuterMeta() && (promptStatusLeftSegments().length || promptStatusRightSegments().length))
      return true
    if (promptStatusUsesOuterMeta() && (statusEntries().length || footerEntries().length)) return true
    if (promptStatusUsesOuterMeta() && editorContextLabelState() !== "none" && editorFileLabelDisplay()) return true
    return false
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          autocomplete = r
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box
        ref={(r) => (anchor = r)}
        visible={props.visible !== false}
        width="100%"
        position="relative"
        zIndex={1000}
        overflow="visible"
      >
        <Show when={workingIndicatorVisible()}>
          <box
            width="100%"
            height={1}
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={promptOuterMetaPadLeft()}
            paddingRight={promptFooterPadRight()}
          >
            <box flexDirection="row" gap={1} flexShrink={1}>
              <Show when={status().type !== "idle"}>
                {(() => {
                  const retry = createMemo(() => {
                    const s = status()
                    if (s.type !== "retry") return
                    return s
                  })
                  const message = createMemo(() => {
                    const r = retry()
                    if (!r) return
                    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                      return "gemini is way too hot right now"
                    if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                    return r.message
                  })
                  const isTruncated = createMemo(() => {
                    const r = retry()
                    if (!r) return false
                    return r.message.length > 120
                  })
                  const [seconds, setSeconds] = createSignal(0)
                  onMount(() => {
                    const timer = setInterval(() => {
                      const next = retry()?.next
                      if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                    }, 1000)

                    onCleanup(() => {
                      clearInterval(timer)
                    })
                  })
                  const handleMessageClick = () => {
                    const r = retry()
                    if (!r) return
                    if (isTruncated()) {
                      void DialogAlert.show(dialog, "Retry Error", r.message)
                    }
                  }

                  const retryText = () => {
                    const r = retry()
                    if (!r) return ""
                    const baseMessage = message()
                    const truncatedHint = isTruncated() ? " (click to expand)" : ""
                    const duration = formatDuration(seconds())
                    const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                    return fitWorkingText(baseMessage + truncatedHint + retryInfo)
                  }

                  return (
                    <Show when={retry()} fallback={workingIndicatorView()}>
                      <box onMouseUp={handleMessageClick}>
                        <Spinner color={theme.error}>{retryText()}</Spinner>
                      </box>
                    </Show>
                  )
                })()}
              </Show>
            </box>
            <box flexDirection="row" gap={2} flexShrink={0}>
              <Show when={status().type !== "retry" && status().type !== "idle" && workingRightMeta()}>
                {(meta) => (
                  <text fg={theme.textMuted} wrapMode="none">
                    {meta()}
                  </text>
                )}
              </Show>
            </box>
          </box>
        </Show>
        <Show when={props.sessionID && status().type !== "idle" && workingMascot()}>
          {(mascot) => (
            <box position="absolute" right={mascotRightOffset()} top={mascotTopOffset()} zIndex={2000} flexShrink={0}>
              <MascotLines text={mascot()} hoverText={hoverMascot()} paddingTop={0} />
            </box>
          )}
        </Show>
        <Show when={props.sessionID && status().type === "idle" && idleMascot()}>
          {(mascot) => (
            <box position="absolute" right={mascotRightOffset()} top={mascotTopOffset()} zIndex={2000} flexShrink={0}>
              <MascotLines text={mascot()} hoverText={hoverMascot()} paddingTop={0} />
            </box>
          )}
        </Show>
        <Show when={promptMascotTopSpacerHeight() > 0}>
          <box height={promptMascotTopSpacerHeight()} />
        </Show>
        <box
          width="100%"
          border={promptChrome().mainSides}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            horizontal: promptChrome().chars.horizontal,
            vertical: promptBorderGlyph(),
            topLeft: promptChrome().chars.topLeft,
            topRight: promptChrome().chars.topRight,
            bottomLeft: promptChrome().chars.bottomLeft,
            bottomRight: promptChrome().chars.bottomRight,
          }}
        >
          <box
            paddingLeft={promptUsesFlushLead() ? 0 : 2}
            paddingRight={2}
            paddingTop={promptInputPadTop()}
            paddingBottom={promptInnerTextBottomPadding()}
            flexShrink={0}
            backgroundColor={promptUsesPanelBackground() ? theme.backgroundElement : undefined}
            flexGrow={1}
            width={promptWantsFullWidth() ? "100%" : undefined}
          >
            <box
              flexDirection="row"
              alignItems="flex-start"
              gap={promptLeadText() ? 1 : 0}
              paddingLeft={promptUsesFlushLead() ? promptLeadInsetLeft() : undefined}
            >
              <Show when={promptLeadText()}>
                {(glyph) => (
                  <text fg={theme.textMuted} flexShrink={0}>
                    {glyph()}
                  </text>
                )}
              </Show>
              <textarea
                placeholder={placeholderText()}
                placeholderColor={theme.textMuted}
                textColor={keybind.leader ? theme.textMuted : theme.text}
                focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
                minHeight={1}
                maxHeight={6}
                onContentChange={() => {
                  const value = input.plainText
                  setStore("prompt", "input", value)
                  autocomplete.onInput(value)
                  syncExtmarksWithPromptParts()
                }}
                keyBindings={textareaKeybindings()}
                onKeyDown={async (e) => {
                  if (props.disabled) {
                    e.preventDefault()
                    return
                  }
                  if (isTextareaNewlineKey(e, keybind.all)) markSubmitSuppressedForNewline()
                  // Check clipboard for images before terminal-handled paste runs.
                  // This helps terminals that forward Ctrl+V to the app; Windows
                  // Terminal 1.25+ usually handles Ctrl+V before this path.
                  if (keybind.match("input_paste", e)) {
                    const content = await Clipboard.read()
                    if (content?.mime.startsWith("image/")) {
                      e.preventDefault()
                      await pasteAttachment({
                        filename: "clipboard",
                        mime: content.mime,
                        content: content.data,
                      })
                      return
                    }
                    // If no image, let the default paste behavior continue
                  }
                  if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                    input.clear()
                    input.extmarks.clear()
                    setStore("prompt", {
                      input: "",
                      parts: [],
                    })
                    setStore("extmarkToPartIndex", new Map())
                    return
                  }
                  if (keybind.match("app_exit", e)) {
                    if (store.prompt.input === "") {
                      await exit()
                      // Don't preventDefault - let textarea potentially handle the event
                      e.preventDefault()
                      return
                    }
                  }
                  if (e.name === "!" && input.visualCursor.offset === 0) {
                    setStore("placeholder", randomIndex(shell().length))
                    setStore("mode", "shell")
                    e.preventDefault()
                    return
                  }
                  if (store.mode === "shell") {
                    if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                      setStore("mode", "normal")
                      e.preventDefault()
                      return
                    }
                  }
                  if (store.mode === "normal") autocomplete.onKeyDown(e)
                  if (!autocomplete.visible) {
                    if (
                      (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                      (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                    ) {
                      const direction = keybind.match("history_previous", e) ? -1 : 1
                      const item = history.move(direction, input.plainText)

                      if (item) {
                        input.setText(item.input)
                        setStore("prompt", item)
                        setStore("mode", item.mode ?? "normal")
                        restoreExtmarksFromParts(item.parts)
                        e.preventDefault()
                        if (direction === -1) input.cursorOffset = 0
                        if (direction === 1) input.cursorOffset = input.plainText.length
                      }
                      return
                    }

                    if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0)
                      input.cursorOffset = 0
                    if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                      input.cursorOffset = input.plainText.length
                  }
                }}
                onSubmit={() => {
                  if (suppressSubmitFromNewline) {
                    suppressSubmitFromNewline = false
                    if (suppressSubmitFromNewlineTimer) {
                      clearTimeout(suppressSubmitFromNewlineTimer)
                      suppressSubmitFromNewlineTimer = undefined
                    }
                    return
                  }
                  // IME: double-defer so the last composed character (e.g. Korean
                  // hangul) is flushed to plainText before we read it for submission.
                  setTimeout(() => setTimeout(() => submit(), 0), 0)
                }}
                onPaste={async (event: PasteEvent) => {
                  if (props.disabled) {
                    event.preventDefault()
                    return
                  }

                  // Normalize line endings at the boundary
                  // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                  // Replace CRLF first, then any remaining CR
                  const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                  const pastedContent = normalizedText.trim()

                  // Windows Terminal <1.25 can surface image-only clipboard as an
                  // empty bracketed paste. Windows Terminal 1.25+ does not.
                  if (!pastedContent) {
                    command.trigger("prompt.paste")
                    return
                  }

                  // Once we cross an async boundary below, the terminal may perform its
                  // default paste unless we suppress it first and handle insertion ourselves.
                  event.preventDefault()

                  const filepath = iife(() => {
                    const raw = pastedContent.replace(/^['"]+|['"]+$/g, "")
                    if (raw.startsWith("file://")) {
                      try {
                        return fileURLToPath(raw)
                      } catch {}
                    }
                    if (process.platform === "win32") return raw
                    return raw.replace(/\\(.)/g, "$1")
                  })
                  const isUrl = /^(https?):\/\//.test(filepath)
                  if (!isUrl) {
                    try {
                      const mime = await Filesystem.mimeType(filepath)
                      const filename = path.basename(filepath)
                      // Handle SVG as raw text content, not as base64 image
                      if (mime === "image/svg+xml") {
                        const content = await Filesystem.readText(filepath).catch(() => {})
                        if (content) {
                          pasteText(content, `[SVG: ${filename ?? "image"}]`)
                          return
                        }
                      }
                      if (mime.startsWith("image/") || mime === "application/pdf") {
                        const content = await Filesystem.readArrayBuffer(filepath)
                          .then((buffer) => Buffer.from(buffer).toString("base64"))
                          .catch(() => {})
                        if (content) {
                          await pasteAttachment({
                            filename,
                            filepath,
                            mime,
                            content,
                          })
                          return
                        }
                      }
                    } catch {}
                  }

                  const portableImageTokens = parsePortableImageClipboard(pastedContent)
                  if (portableImageTokens) {
                    for (const token of portableImageTokens) {
                      if (token.type === "text") {
                        input.insertText(token.text)
                        continue
                      }
                      await pasteAttachment({
                        filename: token.filename,
                        mime: token.mime,
                        content: token.content,
                      })
                    }
                    return
                  }

                  if (
                    shouldSummarizePastedContentWithThreshold(pastedContent, pasteSummaryMinChars()) &&
                    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
                  ) {
                    pasteText(pastedContent, pastedContentLabel(pastedContent))
                    return
                  }

                  input.insertText(normalizedText)

                  // Force layout update and render for the pasted content
                  setTimeout(() => {
                    // setTimeout is a workaround and needs to be addressed properly
                    if (!input || input.isDestroyed) return
                    input.getLayoutNode().markDirty()
                    renderer.requestRender()
                  }, 0)
                }}
                ref={(r: TextareaRenderable) => {
                  input = r
                  if (promptPartTypeId === 0) {
                    promptPartTypeId = input.extmarks.registerType("prompt-part")
                  }
                  props.ref?.(ref)
                  setTimeout(() => {
                    // setTimeout is a workaround and needs to be addressed properly
                    if (!input || input.isDestroyed) return
                    input.cursorColor = theme.text
                  }, 0)
                }}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                focusedBackgroundColor={promptUsesPanelBackground() ? theme.backgroundElement : undefined}
                cursorColor={
                  props.disabled
                    ? promptUsesPanelBackground()
                      ? theme.backgroundElement
                      : theme.background
                    : theme.text
                }
                syntaxStyle={syntax()}
              />
            </box>
            <Show
              when={
                !promptStatusUsesOuterMeta() &&
                (promptStatusLeftSegments().length || promptStatusRightSegments().length || hasRightContent())
              }
            >
              <box
                flexDirection="row"
                flexShrink={0}
                paddingTop={promptInnerMetaTopPadding() || (promptUsesCompactTopPadding() ? 0 : 1)}
                gap={1}
                justifyContent="space-between"
                width="100%"
              >
                <box flexDirection="row" gap={1} flexShrink={1}>
                  <Show when={promptStatusLeftSegments().length} fallback={<box height={1} />}>
                    <box flexDirection="row" gap={0}>
                      <For each={promptStatusLeftSegments()}>
                        {(segment, index) => (
                          <>
                            <Show when={segment.separatorBefore}>
                              <text fg={theme.textMuted} wrapMode="none">
                                {promptStatusSeparator()}
                              </text>
                            </Show>
                            <PromptStatusSegmentText segment={segment} />
                          </>
                        )}
                      </For>
                    </box>
                  </Show>
                </box>
                <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                  <Show when={promptStatusRightSegments().length}>
                    <box flexDirection="row" gap={0}>
                      <For each={promptStatusRightSegments()}>
                        {(segment, index) => (
                          <>
                            <Show when={segment.separatorBefore}>
                              <text fg={theme.textMuted} wrapMode="none">
                                {promptStatusSeparator()}
                              </text>
                            </Show>
                            <PromptStatusSegmentText segment={segment} />
                          </>
                        )}
                      </For>
                    </box>
                  </Show>
                  <Show when={hasRightContent()}>
                    <box flexDirection="row" gap={1} alignItems="center">
                      {props.right}
                    </box>
                  </Show>
                </box>
              </box>
            </Show>
          </box>
        </box>
        <Switch>
          <Match when={promptChrome().preset === "left-rail" && promptShowsOuterFooter()}>
            <box
              height={1}
              border={["left"]}
              borderColor={borderHighlight()}
              customBorderChars={{
                ...EmptyBorder,
                vertical: theme.backgroundElement.a !== 0 ? promptFooterGlyph() : " ",
              }}
            >
              <box
                height={1}
                border={["bottom"]}
                borderColor={theme.backgroundElement}
                customBorderChars={
                  theme.backgroundElement.a !== 0
                    ? {
                        ...EmptyBorder,
                        horizontal: "▄",
                      }
                    : {
                        ...EmptyBorder,
                        horizontal: " ",
                      }
                }
              />
            </box>
          </Match>
          <Match when={promptChrome().preset !== "left-rail" && promptChrome().footerSides.length > 0}>
            <box
              height={1}
              border={promptChrome().footerSides}
              borderColor={borderHighlight()}
              customBorderChars={{
                ...EmptyBorder,
                horizontal: theme.backgroundElement.a !== 0 ? promptFooterGlyph() : " ",
                vertical: theme.backgroundElement.a !== 0 ? promptBorderGlyph() : " ",
                bottomLeft: promptChrome().chars.bottomLeft,
                bottomRight: promptChrome().chars.bottomRight,
              }}
            />
          </Match>
        </Switch>
        <Show when={promptShowsOuterFooter()}>
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            paddingTop={promptFooterPadTop()}
            paddingRight={promptFooterPadRight()}
          >
            <Switch>
              <Match when={warpNotice()}>
                {(notice) => (
                  <box paddingLeft={3}>
                    <text fg={theme.accent}>{notice()}</text>
                  </box>
                )}
              </Match>
              <Match when={workspaceLabel()}>
                {(workspace) => (
                  <box paddingLeft={3} flexDirection="row" gap={1}>
                    <Show when={workspaceCreating()}>
                      <Spinner color={theme.accent} />
                    </Show>
                    <text fg={workspaceCreating() ? theme.accent : theme.text}>
                      {(() => {
                        const item = workspace()
                        if (item.type === "new") {
                          if (workspaceCreating())
                            return `Creating ${item.workspaceType}${".".repeat(workspaceCreatingDots())}`
                          return (
                            <>
                              Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                            </>
                          )
                        }
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                          </>
                        )
                      })()}
                    </text>
                  </box>
                )}
              </Match>
              <Match when={promptStatusUsesOuterMeta() && promptStatusLeftSegments().length}>
                <box paddingLeft={promptOuterMetaPadLeft()} flexDirection="row" gap={1}>
                  <box flexDirection="row" gap={0}>
                    <For each={promptStatusLeftSegments()}>
                      {(segment, index) => (
                        <>
                          <Show when={segment.separatorBefore}>
                            <text fg={theme.textMuted} wrapMode="none">
                              {promptStatusSeparator()}
                            </text>
                          </Show>
                          <PromptStatusSegmentText segment={segment} />
                        </>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
              <Match when={true}>{props.hint ?? <text />}</Match>
            </Switch>
            <Show when={status().type !== "retry"}>
              <Show
                when={customFooter()}
                fallback={
                  <box gap={2} flexDirection="row">
                    <For each={statusEntries()}>{(item) => <text fg={theme.textMuted}>{item.value}</text>}</For>
                    <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                      {(file) => (
                        <text fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted}>
                          {file()}
                        </text>
                      )}
                    </Show>
                    <Switch>
                      <Match when={store.mode === "normal" && promptStatusUsesOuterMeta()}>
                        <Show when={promptStatusOuterRightSegments().length}>
                          <box flexDirection="row" gap={0}>
                            <For each={promptStatusOuterRightSegments()}>
                              {(segment, index) => (
                                <>
                                  <Show when={segment.separatorBefore}>
                                    <text fg={theme.textMuted} wrapMode="none">
                                      {promptStatusSeparator()}
                                    </text>
                                  </Show>
                                  <PromptStatusSegmentText segment={segment} />
                                </>
                              )}
                            </For>
                          </box>
                        </Show>
                        <For each={footerEntries()}>{(item) => item.render() as any}</For>
                      </Match>
                      <Match when={store.mode === "shell"}>
                        <text fg={theme.text}>
                          esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                        </text>
                      </Match>
                    </Switch>
                  </box>
                }
              >
                {(render) => render() as any}
              </Show>
            </Show>
          </box>
        </Show>
      </box>
    </>
  )
}
