import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type ParsedKey,
} from "@opentui/core"
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
  batch,
} from "solid-js"
import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useSDK, type SDKConnectionStatus } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { sessionControlAllowsPrompt, useSessionControl } from "@tui/context/session-control"
import { useEvent } from "@tui/context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "@tui/context/editor"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { movePromptHistoryItems, usePromptHistory, type PromptHistoryScope, type PromptInfo } from "./history"
import { computePromptTraits } from "./traits"
import { resolveActivePromptAgentName, resolveSelectedPromptModel, resolveSelectedPromptVariant } from "./agent"
import * as Model from "../../util/model"
import { assign } from "./part"
import {
  DEFAULT_PASTE_SUMMARY_MIN_CHARS,
  expandEditedPastedContentInPrompt,
  expandPastedContentAtOffset,
  expandPastedContentInPrompt,
  pastedContentLabel,
  parsePortableImageClipboard,
  promptSubmitParts,
  shouldSummarizePastedContentWithThreshold,
} from "./submit-parts"
import { findSlashCommandInvocation, findSlashCommandToken } from "./slash-command"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import type { AssistantMessage, FilePart, OpencodeClient, Part, UserMessage } from "@mendcode/sdk/v2"
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
import * as Log from "@mendcode/core/util/log"
import { WorkspaceLabel, type WorkspaceStatus } from "../workspace-label"
import { readModelsConfig } from "@/mend/config/models"
import { budgetEnforcementStatus } from "@/mend/runtime/budget"
import { useMendTuiProfile } from "@tui/context/mend"
import { compareSessionMessages } from "../../util/session-message-order"
import { withTimeout } from "@/util/timeout"
import { listMendStatusEntries } from "@/mend/tui/status"
import { listMendWidgets } from "@/mend/tui/widgets"
import { getMendFooter, listMendFooterEntries } from "@/mend/tui/footer"
import { readMendWorkingIndicator } from "@/mend/tui/working-indicator"
import { readMendEditorVisual } from "@/mend/tui/editor-host"
import { promptChromeUsesFullSessionWidth, resolvePromptChrome } from "@/mend/tui/prompt-chrome"
import { activityMascotHoverText, activityMascotText, mascotLineHitboxes, mascotTextWidth } from "@/mend/tui/mascot"
import { activityMessage, resolveActivityPhase, trailingActivityToolNames } from "../../util/activity-signal"
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
import {
  isAssistantWorking,
  knownAgentActivityConnectionLabel,
  terminalAssistantSettlesActivity,
  SESSION_AGENT_STATE_UNKNOWN_MESSAGE,
  displayConnectionStatus,
  shouldShowAgentStateUnknown,
} from "../../util/session-working"

const NATIVE_COMPACTION_SLASHES = new Set(["compact", "summarize"])
const ACTIVE_LOOP_STATES = new Set(["active", "sleeping", "working", "needs_input", "blocked"])
const trace = Log.create({ service: "tui.prompt" })

export type LoopWorkflowInfo = {
  id: string
  state: string
  phase?: string
  rootSessionID?: string
  nextWakeup?: number
}

export async function fetchLoopWorkflowsFromServer(input: {
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  url: string
  headers?: HeadersInit
  directory?: string
}) {
  const headers = new Headers(input.headers)
  headers.set("accept", "application/json")
  if (input.directory) headers.set("x-mendcode-directory", encodeURIComponent(input.directory))
  try {
    const response = await input.fetcher(`${input.url}/loop`, { headers })
    if (!response.ok) return [] as LoopWorkflowInfo[]
    const data = await response.json().catch(() => undefined)
    return Array.isArray(data) ? (data as LoopWorkflowInfo[]) : []
  } catch {
    // Loop status is auxiliary; a server reconnect must not crash the TUI.
    return [] as LoopWorkflowInfo[]
  }
}

export type PromptProps = {
  sessionID?: string
  historyScope?: PromptHistoryScope
  historyItems?: () => readonly PromptInfo[]
  workspaceID?: string
  permissionMode?: string
  permissionModeLabel?: string
  permissionPending?: number
  visible?: boolean
  disabled?: boolean
  onSubmit?: (info: PromptSubmitInfo) => void
  onInterruptChange?: (interrupted: boolean) => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptSubmitInfo = {
  sessionID: string
  messageID: string
  inputRows: number
  queuedBehindActiveTurn: boolean
}

type OptimisticPromptPart = PromptInfo["parts"][number] & { id: string }

export function optimisticUserMessage(input: {
  sessionID: string
  messageID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  created: number
}): UserMessage {
  return {
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created },
    agent: input.agent,
    model: {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      variant: input.variant,
    },
  }
}

export function optimisticUserParts(input: {
  sessionID: string
  messageID: string
  parts: OptimisticPromptPart[]
}): Part[] {
  return input.parts.map(
    (part) =>
      ({
        ...part,
        sessionID: input.sessionID,
        messageID: input.messageID,
      }) as Part,
  )
}

export function mergeOptimisticUserParts(input: { current?: Part[]; optimistic: Part[] }) {
  if (!input.current?.length) return input.optimistic
  return [
    ...input.current,
    ...input.optimistic.filter((part) => !input.current?.some((current) => current.id === part.id)),
  ].toSorted((a, b) => a.id.localeCompare(b.id))
}

export function supplementalSlashPromptParts<T extends { type: string; synthetic?: boolean }>(parts: readonly T[]) {
  return parts.filter((part) => part.type !== "text" || part.synthetic)
}

export type PromptRef = {
  focused: boolean
  submitPending?: boolean
  current: PromptInfo
  inputRows?: number
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

type PromptAsyncInput = Parameters<OpencodeClient["session"]["promptAsync"]>[0]

type PendingPromptDelivery = {
  request: PromptAsyncInput
  attempt: number
  nextAttemptAt: number
  inFlight: boolean
  state: "pending" | "accepted"
  // Compaction can end while the original runner is still iterating.
  queuedBehindActiveTurn: boolean
}

const pendingPromptDeliveries = new Map<string, PendingPromptDelivery>()
// In-flight cancellation must not make a newly submitted prompt render as queued.
const pendingPromptDeliveryInFlightBySession = new Map<string, Set<string>>()
const latestPromptDeliveryKeyBySession = new Map<string, string>()
const cancelledPromptDeliveryKeys = new Set<string>()
const pendingPromptDeliveryListeners = new Set<() => void>()

function pendingPromptDeliveryKey(request: PromptAsyncInput) {
  return `${request.sessionID}:${request.messageID ?? ""}`
}

function notifyPendingPromptDeliveryListeners() {
  for (const listener of pendingPromptDeliveryListeners) listener()
}

export function promptDeliveryIsQueued(state: "pending" | "accepted", queuedBehindActiveTurn = false) {
  return state === "pending" || queuedBehindActiveTurn
}

export function subscribePendingPromptDeliveries(listener: () => void) {
  pendingPromptDeliveryListeners.add(listener)
  return () => pendingPromptDeliveryListeners.delete(listener)
}

export function pendingPromptDeliveryMessageIDs(sessionID: string, options?: { includeAccepted?: boolean }) {
  return new Set(
    [...pendingPromptDeliveries.values()]
      .filter(
        (delivery) =>
          delivery.request.sessionID === sessionID &&
          (promptDeliveryIsQueued(delivery.state, delivery.queuedBehindActiveTurn) ||
            options?.includeAccepted === true),
      )
      .map((delivery) => delivery.request.messageID)
      .filter((messageID): messageID is string => Boolean(messageID)),
  )
}

const PROMPT_DELIVERY_RETRY_INTERVAL = 1000

export function promptDeliveryRetryDelay(_attempt: number) {
  return PROMPT_DELIVERY_RETRY_INTERVAL
}

export function shouldRetryConnectionForPrompt(status: SDKConnectionStatus) {
  return status === "failed" || status === "disconnected"
}

export function promptRecoveryReady(input: {
  connectionStatus: SDKConnectionStatus
  reconciledAt?: number
  recoveredAt?: number
}) {
  if (input.connectionStatus !== "connected" || input.reconciledAt === undefined) return false
  return input.recoveredAt === undefined || input.reconciledAt >= input.recoveredAt
}

export function isRetryablePromptDelivery(input: { error?: unknown; response?: Response }) {
  if (!input.error) return false
  if (!input.response) return true
  return (
    input.response.status === 408 ||
    input.response.status === 425 ||
    input.response.status === 429 ||
    input.response.status >= 500
  )
}

export function promptDeliveryErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof value.data?.message === "string" && value.data.message) return value.data.message
    if (typeof value.message === "string" && value.message) return value.message
  }
  return "The server rejected this prompt."
}

export function storedAssistantDeliveryState(info: { time: { completed?: number }; finish?: string; error?: unknown }) {
  // Delivery and turn completion are different contracts. Once the backend
  // created an assistant child it consumed this exact user prompt; replaying
  // it after abort, tool-calls, or a transport failure can repeat mutations.
  void info
  return "completed" as const
}

export function promptDeliveryHasCompletedAssistant(
  messages: ReadonlyArray<{
    role: string
    parentID?: string
    time: { created?: number; completed?: number }
    finish?: string
    error?: unknown
  }>,
  messageID: string,
) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parentID === messageID &&
      storedAssistantDeliveryState(message) === "completed",
  )
}

export function storedPromptDeliveryStateFromMessages(
  messages: ReadonlyArray<{
    role: string
    parentID?: string
    time: { created?: number; completed?: number }
    finish?: string
    error?: unknown
  }>,
  messageID: string,
) {
  const assistants = messages.filter((message) => message.role === "assistant" && message.parentID === messageID)
  if (assistants.length === 0) return "accepted" as const
  return assistants.some((message) => storedAssistantDeliveryState(message) === "completed")
    ? ("completed" as const)
    : ("accepted" as const)
}

export function promptDeliveryRetryAction(input: {
  state: "completed" | "accepted" | "missing" | "unknown"
  forceAccepted: boolean
  replaceExisting: boolean
}) {
  if (input.state === "completed") return "settle" as const
  if (input.replaceExisting || input.state === "missing") return "dispatch" as const
  if (input.state === "accepted") return input.forceAccepted ? ("dispatch" as const) : ("accept" as const)
  return "queue" as const
}

export function shouldRecoverAcceptedPromptDeliveries(input: {
  statusType: string
  statusSupersededByTerminalAssistant?: boolean
  deliveries: readonly { state: "pending" | "accepted"; queuedBehindActiveTurn?: boolean }[]
}) {
  return (
    (input.statusType === "idle" || input.statusSupersededByTerminalAssistant === true) &&
    input.deliveries.some((delivery) => delivery.state === "accepted" && delivery.queuedBehindActiveTurn === true)
  )
}

export function acceptedPromptRecoveryDecision(input: {
  previousKey?: string
  eligible: boolean
  deliveryKeys: readonly string[]
}) {
  const recoveryKey = [...input.deliveryKeys].sort().join("|")
  if (!recoveryKey) return { key: undefined, retry: false } as const
  // Keep the consumed key while the recovered turn becomes busy. Clearing it
  // on every busy snapshot makes the subsequent delivery notification look
  // like a new recovery and can create an unbounded prompt_async loop.
  if (!input.eligible || recoveryKey === input.previousKey) return { key: input.previousKey, retry: false } as const
  return { key: recoveryKey, retry: true } as const
}

function queuePendingPromptDelivery(request: PromptAsyncInput) {
  const key = pendingPromptDeliveryKey(request)
  const delivery = pendingPromptDeliveries.get(key)
  if (delivery) {
    delivery.request = request
    delivery.attempt += 1
    delivery.nextAttemptAt = Date.now() + promptDeliveryRetryDelay(delivery.attempt)
    delivery.inFlight = false
    delivery.state = "pending"
    delivery.queuedBehindActiveTurn = true
  } else {
    pendingPromptDeliveries.set(key, {
      request,
      attempt: 1,
      nextAttemptAt: Date.now() + promptDeliveryRetryDelay(1),
      inFlight: false,
      state: "pending",
      queuedBehindActiveTurn: true,
    })
  }
  notifyPendingPromptDeliveryListeners()
}

function acceptPendingPromptDelivery(request: PromptAsyncInput, queuedBehindActiveTurn = false) {
  const key = pendingPromptDeliveryKey(request)
  const delivery = pendingPromptDeliveries.get(key)
  if (delivery) {
    delivery.request = request
    delivery.state = "accepted"
    delivery.inFlight = false
    delivery.nextAttemptAt = Number.POSITIVE_INFINITY
    delivery.queuedBehindActiveTurn ||= queuedBehindActiveTurn
  } else {
    pendingPromptDeliveries.set(key, {
      request,
      attempt: 0,
      nextAttemptAt: Number.POSITIVE_INFINITY,
      inFlight: false,
      state: "accepted",
      queuedBehindActiveTurn,
    })
  }
  notifyPendingPromptDeliveryListeners()
}

function settlePendingPromptDelivery(request: PromptAsyncInput) {
  const key = pendingPromptDeliveryKey(request)
  if (!pendingPromptDeliveries.delete(key)) return
  if (latestPromptDeliveryKeyBySession.get(request.sessionID) === key)
    latestPromptDeliveryKeyBySession.delete(request.sessionID)
  notifyPendingPromptDeliveryListeners()
}

function cancelPendingPromptDeliveryKey(sessionID: string, key: string) {
  const inFlight = pendingPromptDeliveryInFlightBySession.get(sessionID)
  const wasInFlight = inFlight?.delete(key) ?? false
  if (inFlight && inFlight.size === 0) pendingPromptDeliveryInFlightBySession.delete(sessionID)
  const removed = pendingPromptDeliveries.delete(key)
  if (latestPromptDeliveryKeyBySession.get(sessionID) === key) latestPromptDeliveryKeyBySession.delete(sessionID)
  if (wasInFlight) cancelledPromptDeliveryKeys.add(key)
  if (removed || wasInFlight) notifyPendingPromptDeliveryListeners()
}

export function cancelPendingPromptDelivery(sessionID: string, messageID: string) {
  cancelPendingPromptDeliveryKey(sessionID, `${sessionID}:${messageID}`)
}

function pendingPromptDeliveriesForSession(sessionID: string) {
  return [...pendingPromptDeliveries.values()].filter((delivery) => delivery.request.sessionID === sessionID)
}

export function pendingPromptDeliveryIsActive(sessionID: string) {
  return (
    (pendingPromptDeliveryInFlightBySession.get(sessionID)?.size ?? 0) > 0 ||
    pendingPromptDeliveriesForSession(sessionID).length > 0
  )
}

function beginPendingPromptDelivery(request: PromptAsyncInput) {
  const key = pendingPromptDeliveryKey(request)
  const inFlight = pendingPromptDeliveryInFlightBySession.get(request.sessionID) ?? new Set<string>()
  inFlight.add(key)
  pendingPromptDeliveryInFlightBySession.set(request.sessionID, inFlight)
  notifyPendingPromptDeliveryListeners()
}

function endPendingPromptDelivery(request: PromptAsyncInput) {
  const key = pendingPromptDeliveryKey(request)
  const inFlight = pendingPromptDeliveryInFlightBySession.get(request.sessionID)
  const removed = inFlight?.delete(key) ?? false
  if (inFlight?.size === 0) pendingPromptDeliveryInFlightBySession.delete(request.sessionID)
  if (cancelledPromptDeliveryKeys.has(key) && !pendingPromptDeliveries.has(key)) cancelledPromptDeliveryKeys.delete(key)
  if (removed) notifyPendingPromptDeliveryListeners()
}

function cancelPendingPromptDeliveryForInterrupt(sessionID: string, targetMessageID?: string) {
  if (!targetMessageID) return
  cancelPendingPromptDelivery(sessionID, targetMessageID)
}

export function latestPendingAssistantID(
  messages: ReadonlyArray<{
    id: string
    role: string
    time: { created?: number; completed?: number }
    error?: { name?: string }
    finish?: string
  }>,
  input?: {
    statusType?: string
    now?: number
    statusUntil?: number
    statusNext?: number
    hasActiveTool?: boolean
  },
) {
  const latestAssistant = messages.findLast((message) => message.role === "assistant")
  if (!latestAssistant || latestAssistant.error) return
  const continuation = latestAssistant.finish === "tool-calls" || latestAssistant.finish === "unknown"
  if (latestAssistant.finish && !continuation) return
  if (latestAssistant.time.completed && !continuation) return
  // A completed tool-call step is only a live continuation while the backend
  // still owns the turn or one of its tools is genuinely pending/running.
  // Question rejection is persisted as a completed assistant/tool error and
  // an idle session; treating that receipt as live caused ghost Generating.
  if (
    latestAssistant.time.completed &&
    continuation &&
    input?.statusType === "idle" &&
    !input.hasActiveTool
  )
    return
  if (
    input &&
    !isAssistantWorking({
      statusType: input.statusType,
      now: input.now,
      assistantCreated: latestAssistant.time.created,
      statusUntil: input.statusUntil,
      statusNext: input.statusNext,
      hasActiveTool: input.hasActiveTool,
    })
  )
    return
  return latestAssistant.id
}

export function sessionActivityMessages<T extends { id: string; time: { created: number } }>(input: {
  messages: readonly T[]
  latestAssistant?: T
}) {
  const latest = input.latestAssistant
  if (!latest) return input.messages
  return [...input.messages.filter((message) => message.id !== latest.id), latest].toSorted(compareSessionMessages)
}

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

export function shouldClearWorkingStartedAt(input: {
  statusType: string
  hasActiveWorkingAssistant?: boolean
  permissionPending?: boolean
  interrupted?: boolean
  terminalAssistant?: boolean
}) {
  if (input.interrupted) return true
  if (input.permissionPending) return false
  if (input.terminalAssistant) return true
  return input.statusType === "idle" && !input.hasActiveWorkingAssistant && !input.permissionPending
}

export function shouldKeepWorkingStatus(input: {
  interrupted?: boolean
  submitPreflightActive?: boolean
  hasPendingPromptDelivery?: boolean
  compactionActive?: boolean
  hasActiveWorkingAssistant?: boolean
  permissionPending?: boolean
  terminalAssistant?: boolean
  statusType: string
}) {
  if (input.interrupted) return false
  // A stale preflight flag can survive the terminal assistant event. Do not
  // let that local flag resurrect Generating after a completed turn.
  if (
    input.terminalAssistant &&
    !input.hasPendingPromptDelivery &&
    !input.compactionActive &&
    !input.permissionPending &&
    !input.hasActiveWorkingAssistant
  )
    return false
  return Boolean(
    input.submitPreflightActive ||
      input.hasPendingPromptDelivery ||
      input.compactionActive ||
      !shouldClearWorkingStartedAt({
        statusType: input.statusType,
        hasActiveWorkingAssistant: input.hasActiveWorkingAssistant,
        permissionPending: input.permissionPending,
        terminalAssistant: input.terminalAssistant,
      }),
  )
}

export function promptWorkingIndicatorVisible(input: {
  hasSession: boolean
  submitPreflightActive: boolean
  configuredVisible: boolean
  working: boolean
}) {
  return (input.hasSession || input.submitPreflightActive) && input.configuredVisible && input.working
}

export function shouldEnableSessionInterrupt(input: {
  statusType: string
  hasActiveWorkingAssistant?: boolean
  hasPendingPromptDelivery?: boolean
  autocompleteVisible?: boolean
  promptFocused?: boolean
  compactionActive?: boolean
  interruptRequested?: boolean
}) {
  if (input.interruptRequested) return false
  // An active turn owns Esc even when autocomplete/another prompt overlay has
  // focus. The backend cancellation must not wait for the overlay to close.
  if (input.statusType !== "idle" || input.hasActiveWorkingAssistant || input.hasPendingPromptDelivery) return true
  if (input.autocompleteVisible) return false
  return false
}

export function shouldInterruptImmediately(input: {
  statusType: string
  hasDraft?: boolean
  hasActiveWorkingAssistant?: boolean
  hasPendingPromptDelivery?: boolean
  compactionActive?: boolean
}) {
  return input.statusType !== "idle" || Boolean(input.hasActiveWorkingAssistant || input.hasPendingPromptDelivery)
}

export function clipboardPasteAction(content: { mime?: string; data?: string } | undefined): "image" | "text" | "none" {
  if (!content) return "none"
  if (content.mime?.startsWith("image/")) return "image"
  if (content.mime === "text/plain" && content.data) return "text"
  return "none"
}

export function shouldAcceptPromptInterruptFocus(input: {
  inputFocused: boolean
  currentFocusedRenderable?: unknown
  promptInput?: unknown
}) {
  return input.inputFocused && input.currentFocusedRenderable === input.promptInput
}

export function shouldUseStoredPromptHistoryFallback(input: {
  historyItems?: () => readonly PromptInfo[]
  messageHistoryCount?: number
}) {
  return input.historyItems === undefined
}

function stablePromptPartForHistory(part: PromptInfo["parts"][number]) {
  if (part.type === "text" && part.source?.text) {
    return {
      ...part,
      source: {
        ...part.source,
        text: {
          value: part.source.text.value,
        },
      },
    }
  }
  if (part.type === "file" && part.source?.text) {
    return {
      ...part,
      source: {
        ...part.source,
        text: {
          value: part.source.text.value,
        },
      },
    }
  }
  if (part.type === "agent" && part.source) {
    return {
      ...part,
      source: {
        value: part.source.value,
      },
    }
  }
  return part
}

export function promptHistoryMatchesCurrent(input: {
  currentPrompt: PromptInfo
  currentMode: "normal" | "shell"
  historyIndex: number
  historyPrompt?: PromptInfo
}) {
  if (input.historyIndex === 0) return input.currentPrompt.input.length === 0 && input.currentPrompt.parts.length === 0
  if (!input.historyPrompt) return false
  if (input.currentPrompt.input !== input.historyPrompt.input) return false
  if (input.currentMode !== (input.historyPrompt.mode ?? "normal")) return false
  return (
    JSON.stringify(input.currentPrompt.parts.map(stablePromptPartForHistory)) ===
    JSON.stringify(input.historyPrompt.parts.map(stablePromptPartForHistory))
  )
}

export function shouldPreferMessagePromptHistory(input: { direction?: 1 | -1; currentPromptMatchesHistory: boolean }) {
  if (input.direction === undefined) return false
  return input.currentPromptMatchesHistory
}

function trailingPromptPlaceholderStart(input: { text: string; parts?: readonly PromptInfo["parts"][number][] }) {
  const trimmedEnd = input.text.trimEnd().length
  return input.parts
    ?.flatMap((part) => {
      if ((part.type === "text" || part.type === "file") && part.source?.text) return [part.source.text]
      if (part.type === "agent" && part.source) return [part.source]
      return []
    })
    .filter((source) => source.end >= trimmedEnd)
    .map((source) => source.start)
    .sort((a, b) => a - b)
    .at(0)
}

export function shouldAttemptPromptHistoryNavigation(input: {
  direction?: 1 | -1
  cursorOffset: number
  text: string
  parts?: readonly PromptInfo["parts"][number][]
}) {
  if (input.direction === undefined) return false
  if (input.direction === -1) return input.cursorOffset === 0
  if (input.cursorOffset === promptCursorEndOffset(input.text)) return true
  const placeholderStart = trailingPromptPlaceholderStart(input)
  return placeholderStart !== undefined && input.cursorOffset >= placeholderStart
}

export function shouldSnapPromptCursorToEnd(input: {
  direction?: 1 | -1
  cursorOffset: number
  text: string
  visualRow: number
  totalVisualRows: number
  scrollY: number
}) {
  if (input.direction !== 1) return false
  // OpenTUI reports visualRow relative to the viewport. Use the total wrapped
  // row count instead of logical newline count so long lines do not look like
  // the end of the prompt while ArrowDown is still scrolling through them.
  const absoluteVisualRow = input.visualRow + input.scrollY
  return absoluteVisualRow >= input.totalVisualRows - 1 && input.cursorOffset < promptCursorEndOffset(input.text)
}

export function shouldHandlePromptCursorArrow(input: Pick<ParsedKey, "name" | "ctrl" | "meta" | "shift" | "super">) {
  if (input.ctrl || input.meta || input.shift || input.super) return false
  return input.name === "left" || input.name === "right"
}

export function promptDraftHistoryAction(input: { undo: boolean; redo: boolean; canUndo: boolean; canRedo: boolean }) {
  if (input.undo && input.canUndo) return "undo" as const
  if (input.redo && input.canRedo) return "redo" as const

  return undefined
}

export function promptCursorEndOffset(text: string) {
  return text.length
}

export function promptCursorOffsetAfterArrow(input: {
  cursorOffset: number
  text: string
  direction: "left" | "right"
  atomicRanges?: readonly { start: number; end: number }[]
}) {
  const textEnd = promptCursorEndOffset(input.text)
  const cursorOffset = Math.max(0, Math.min(textEnd, input.cursorOffset))
  const atomicRanges = (input.atomicRanges ?? [])
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({
      start: Math.max(0, Math.min(textEnd, range.start)),
      end: Math.max(0, Math.min(textEnd, range.end)),
    }))
    .filter((range) => range.end > range.start)

  if (input.direction === "left") {
    const atomicRange = atomicRanges.find((range) => cursorOffset > range.start && cursorOffset <= range.end)
    if (atomicRange) return Math.max(0, atomicRange.start - 1)
    return Math.max(0, cursorOffset - 1)
  }

  const atomicRange = atomicRanges.find((range) => cursorOffset >= range.start && cursorOffset < range.end)
  if (atomicRange) return atomicRange.end
  return Math.min(textEnd, cursorOffset + 1)
}

export function promptCursorOffsetFromMouse(input: { visualOffset: number; text: string }) {
  return Math.max(0, Math.min(promptCursorEndOffset(input.text), Math.floor(input.visualOffset)))
}

function removeVisibleResolvingText(value: string) {
  return value.replace(/(?:^|\s)(?:[^\w\s]\s*)*Resolving\s+\[\d+\/\d+\]\s*/giu, (match) =>
    match.startsWith(" ") ? " " : "",
  )
}

function cleanPromptInputText(value: string) {
  return removeVisibleResolvingText(value)
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let suppressPromptInputSync = false
  let submitPending = false
  let pendingPromptRetryTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPromptRetryInFlight = false
  let promptDisposed = false
  let interruptRequest: Promise<unknown> | undefined
  let interruptResetTimer: ReturnType<typeof setTimeout> | undefined
  let autocomplete: AutocompleteRef
  let lastPastedContentClick: { time: number; offset: number } | undefined

  const keybind = useKeybind()
  const local = useLocal()
  const args = useArgs()
  const mend = useMendTuiProfile()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const sessionControl = useSessionControl()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const messagesForActivity = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return []
    return sessionActivityMessages({
      messages: sync.data.message[sessionID] ?? [],
      latestAssistant: sync.data.session_latest_assistant[sessionID],
    })
  })
  const history = usePromptHistory()
  const [messageHistoryIndex, setMessageHistoryIndex] = createSignal(0)
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
  const [pendingPromptDeliveryRevision, setPendingPromptDeliveryRevision] = createSignal(0)
  const [workingTick, setWorkingTick] = createSignal(Date.now())
  const [workingStartedAt, setWorkingStartedAt] = createSignal<number>()
  const [submitPreflightActive, setSubmitPreflightActive] = createSignal(false)
  const [interruptRequested, setInterruptRequested] = createSignal(false)
  const [interruptTargetMessageID, setInterruptTargetMessageID] = createSignal<string>()
  const updateInterruptRequested = (interrupted: boolean, targetMessageID?: string) => {
    setInterruptTargetMessageID(interrupted ? (targetMessageID ?? interruptTargetMessageID()) : undefined)
    setInterruptRequested(interrupted)
    props.onInterruptChange?.(interrupted)
  }
  const [compactionActive, setCompactionActive] = createSignal(false)
  const [mascotHover, setMascotHover] = createSignal(false)
  let clearWorkingStartTimer: Timer | undefined
  let acceptedPromptRecoveryKey: string | undefined
  const messageHistoryItems = createMemo(() => {
    const supplied = props.historyItems?.().filter((item) => item.input.length > 0 || item.parts.length > 0) ?? []
    const stored = history.items(props.historyScope).filter((item) => item.input.length > 0 || item.parts.length > 0)
    if (supplied.length === 0) return stored
    if (stored.length === 0) return supplied

    const suppliedInputs = new Set(supplied.map((item) => item.input))
    return [...supplied, ...stored.filter((item) => !suppliedInputs.has(item.input))]
  })
  const allowStoredPromptHistoryFallback = createMemo(() =>
    shouldUseStoredPromptHistoryFallback({
      historyItems: props.historyItems,
      messageHistoryCount: messageHistoryItems().length,
    }),
  )
  createEffect(
    on(
      () => [props.historyScope, messageHistoryItems()] as const,
      () => setMessageHistoryIndex(0),
    ),
  )
  createEffect(
    on(
      () => props.sessionID,
      () => updateInterruptRequested(false),
      { defer: true },
    ),
  )
  function applyPromptHistoryItem(
    item: PromptInfo,
    direction: 1 | -1,
    event: ParsedKey & { preventDefault: () => void },
  ) {
    const cleanInput = cleanPromptInputText(item.input)
    // Keep the draft that was replaced by ↑/↓ recoverable through the
    // editor's temporary undo history.
    input.replaceText(cleanInput)
    setStore("prompt", { ...item, input: cleanInput })
    setStore("mode", item.mode ?? "normal")
    restoreExtmarksFromParts(item.parts)
    event.preventDefault()
    if (direction === -1) input.cursorOffset = 0
    if (direction === 1) input.cursorOffset = promptCursorEndOffset(input.plainText)
  }
  function moveMessageHistory(direction: 1 | -1, event: ParsedKey & { preventDefault: () => void }) {
    const result = movePromptHistoryItems({
      items: messageHistoryItems(),
      index: messageHistoryIndex(),
      direction,
      currentPromptMatchesHistory: currentPromptMatchesMessageHistory(),
    })
    if (!result?.prompt) return false
    setMessageHistoryIndex(result.index)
    applyPromptHistoryItem(result.prompt, direction, event)
    return true
  }
  function findActiveWorkingAssistant() {
    const sessionID = props.sessionID
    if (!sessionID) return
    const messages = messagesForActivity()
    const currentStatus = status()
    const latestAssistant = messages.findLast((item): item is AssistantMessage => item.role === "assistant")
    const hasActiveTool = latestAssistant
      ? (sync.data.part[latestAssistant.id] ?? []).some((part) => {
          const raw = part as Record<string, any>
          return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
        })
      : false
    const activeID = latestPendingAssistantID(messages, {
      statusType: currentStatus.type,
      now: promptStatusTick(),
      statusUntil: currentStatus.type === "busy" ? currentStatus.until : undefined,
      statusNext: currentStatus.type === "retry" ? currentStatus.next : undefined,
      hasActiveTool,
    })
    return messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.id === activeID)
  }
  function activeTurnTargetMessageID() {
    return (
      findActiveWorkingAssistant()?.parentID ??
      findOrphanedAssistant()?.parentID ??
      (props.sessionID
        ? pendingPromptDeliveriesForSession(props.sessionID)
            .map((delivery) => delivery.request.messageID)
            .filter((messageID): messageID is string => typeof messageID === "string")
            .at(-1)
        : undefined) ??
      messagesForActivity().findLast((message) => message.role === "user")?.id
    )
  }
  function findOrphanedAssistant() {
    const sessionID = props.sessionID
    if (!sessionID) return
    const messages = messagesForActivity()
    const latestAssistant = messages.findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!latestAssistant || latestAssistant.error) return
    const continuation = latestAssistant.finish === "tool-calls" || latestAssistant.finish === "unknown"
    if (latestAssistant.finish && !continuation) return
    if (latestAssistant.time.completed && !continuation) return
    if (
      latestAssistant.time.completed &&
      continuation &&
      status().type === "idle" &&
      !(sync.data.part[latestAssistant.id] ?? []).some((part) => {
        const raw = part as Record<string, any>
        return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
      })
    )
      return
    if (findActiveWorkingAssistant()?.id === latestAssistant.id) return
    return latestAssistant
  }
  const hasActiveWorkingAssistant = createMemo(() => Boolean(findActiveWorkingAssistant()))
  const hasPendingPromptDelivery = createMemo(() => {
    pendingPromptDeliveryRevision()
    return Boolean(props.sessionID && pendingPromptDeliveryIsActive(props.sessionID))
  })
  const terminalAssistantSupersedesBusy = createMemo(() => {
    const current = status()
    const messages = messagesForActivity()
    const latestAssistant = messages.findLast((message) => message.role === "assistant")
    const hasActiveTool = latestAssistant
      ? (sync.data.part[latestAssistant.id] ?? []).some((part) => {
          const raw = part as Record<string, any>
          return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
        })
      : false
    return terminalAssistantSettlesActivity({
      statusType: current.type,
      statusKind: current.type === "busy" ? current.kind : undefined,
      statusStartedAt: current.type === "busy" ? current.startedAt : undefined,
      // A queued user message or late tool event can be the last item even
      // after the assistant response is terminal. Reconcile against the
      // latest assistant, not the last heterogeneous timeline item.
      latestMessage: latestAssistant,
      hasActiveTool,
    })
  })
  const workingStatusActive = createMemo(() =>
    shouldKeepWorkingStatus({
      interrupted: interruptRequested(),
      submitPreflightActive: submitPreflightActive(),
      hasPendingPromptDelivery: hasPendingPromptDelivery(),
      compactionActive: compactionActive(),
      hasActiveWorkingAssistant: hasActiveWorkingAssistant(),
      permissionPending: Boolean(props.permissionPending),
      terminalAssistant: terminalAssistantSupersedesBusy(),
      statusType: status().type,
    }),
  )
  const hasKnownAgentActivity = createMemo(
    () =>
      workingStatusActive() && (hasActiveWorkingAssistant() || compactionActive() || Boolean(props.permissionPending)),
  )
  createEffect(() => {
    if (!submitPreflightActive() || !props.sessionID) return
    if (status().type === "idle" && !hasPendingPromptDelivery() && !hasActiveWorkingAssistant()) return
    setSubmitPreflightActive(false)
  })
  const connectionStateMessage = createMemo(() => {
    if (
      shouldShowAgentStateUnknown({
        connectionStatus: displayConnectionStatus(sdk.connection),
        hasKnownAgentActivity: hasKnownAgentActivity(),
        hasUncertainAgentState:
          Boolean(findOrphanedAssistant()) || (status().type !== "idle" && !terminalAssistantSupersedesBusy()),
      })
    ) {
      return `local connection ${displayConnectionStatus(sdk.connection)}; ${SESSION_AGENT_STATE_UNKNOWN_MESSAGE}`
    }
  })
  createEffect(() => {
    const sessionID = props.sessionID
    const targetMessageID = interruptTargetMessageID()
    if (!sessionID || !interruptRequested() || !targetMessageID) return
    const control = sessionControl.status(sessionID)
    const targetTerminal = messagesForActivity().some(
      (message) =>
        message.role === "assistant" && message.parentID === targetMessageID && message.time.completed !== undefined,
    )
    const rejected = control.state === "stop_confirmed" && control.result !== "cancelled"
    const sessionSettled = status().type === "idle" && !hasActiveWorkingAssistant() && !hasPendingPromptDelivery()
    if (targetTerminal || rejected || sessionSettled) updateInterruptRequested(false)
  })
  onCleanup(() => {
    if (clearWorkingStartTimer) clearTimeout(clearWorkingStartTimer)
  })
  onMount(() => {
    const unsubscribe = subscribePendingPromptDeliveries(() => setPendingPromptDeliveryRevision((value) => value + 1))
    const timer = setInterval(() => {
      const now = Date.now()
      setPromptStatusTick(now)
      setWorkingTick(now)
    }, 500)
    onCleanup(unsubscribe)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(
    on(
      () =>
        [
          workingStatusActive(),
          status().type,
          hasActiveWorkingAssistant(),
          Boolean(props.permissionPending),
          interruptRequested(),
          terminalAssistantSupersedesBusy(),
        ] as const,
      ([active, statusType, hasActiveAssistant, permissionPending, interrupted, terminalAssistant]) => {
        const sessionID = props.sessionID
        if (clearWorkingStartTimer) {
          clearTimeout(clearWorkingStartTimer)
          clearWorkingStartTimer = undefined
        }
        if (active && !interrupted) {
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
        if (
          !shouldClearWorkingStartedAt({
            statusType,
            hasActiveWorkingAssistant: hasActiveAssistant,
            permissionPending,
            interrupted,
            terminalAssistant,
          })
        ) {
          return
        }
        setWorkingStartedAt(undefined)
        if (!sessionID) return
        clearWorkingStartTimer = setTimeout(() => {
          if (
            shouldClearWorkingStartedAt({
              statusType: status().type,
              hasActiveWorkingAssistant: hasActiveWorkingAssistant(),
              permissionPending: Boolean(props.permissionPending),
              interrupted: interruptRequested(),
              terminalAssistant: terminalAssistantSupersedesBusy(),
            })
          ) {
            workingStartedAtBySession.delete(sessionID)
          }
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
  function stablePromptStatusText(value: string | undefined) {
    const text = value?.trim()
    if (!text) return undefined
    if (isTransientPromptStatusText(text)) return undefined
    return text
  }

  function isTransientPromptStatusText(value: string | undefined) {
    return Boolean(value && /\b(resolving|loading|fetching)\b/i.test(value))
  }

  const currentProviderLabel = createMemo(() => stablePromptStatusText(local.model.parsed().provider))
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
  const slashCommandStyleIds = new Map<string, number>()
  let promptPartTypeId = 0
  let slashCommandTypeId = 0
  const event = useEvent()
  const [loopRefreshTick, setLoopRefreshTick] = createSignal(0)

  async function fetchLoopWorkflows() {
    return fetchLoopWorkflowsFromServer({
      fetcher: sdk.fetch,
      url: sdk.url,
      headers: sdk.headers,
      directory: sdk.directory,
    })
  }

  const [loopWorkflows] = createResource(loopRefreshTick, fetchLoopWorkflows)
  const [availableSkills, { refetch: refetchAvailableSkills }] = createResource(async () => {
    try {
      const result = await sdk.client.app.skills()
      return result.data ?? []
    } catch {
      return []
    }
  })
  const skillNames = createMemo(() => new Set((availableSkills() ?? []).map((skill) => skill.name)))
  const activeLoopCount = createMemo(
    () => loopWorkflows.latest?.filter((loop) => ACTIVE_LOOP_STATES.has(loop.state)).length ?? 0,
  )
  const loopStatusText = createMemo(() => {
    const count = activeLoopCount()
    if (!count) return
    return `↻ ${count} loop${count === 1 ? "" : "s"}`
  })
  onMount(() => {
    setLoopRefreshTick((tick) => tick + 1)
    const timer = setInterval(() => setLoopRefreshTick((tick) => tick + 1), 2_000)
    const unsubscribe = sdk.event.on("event", (evt) => {
      const type = evt.payload?.type as string | undefined
      if (type?.startsWith("loop.")) setLoopRefreshTick((tick) => tick + 1)
      if (type === "skill.updated") void refetchAvailableSkills()
    })
    onCleanup(() => {
      clearInterval(timer)
      unsubscribe()
    })
  })

  onMount(() => {
    const unsubscribe = event.subscribe((evt) => {
      const eventSessionID = (evt.properties as { sessionID?: string } | undefined)?.sessionID
      if (!props.sessionID || eventSessionID !== props.sessionID) return
      if (evt.type === "session.next.compaction.started") setCompactionActive(true)
      if (evt.type === "session.next.compaction.ended" || evt.type === "session.compacted") setCompactionActive(false)
    })
    onCleanup(unsubscribe)
  })

  createEffect(() => {
    if (status().type === "idle" && !hasActiveWorkingAssistant() && !props.permissionPending) setCompactionActive(false)
  })

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    const text = cleanPromptInputText(evt.properties.text)
    if (!text) return
    input.insertText(text)
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
      localOverrideMessageID: localOverride?.messageID,
      userModel,
      userModelCreatedAt: lastUserMessage()?.time.created,
      userMessageID: lastUserMessage()?.id,
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
      localVariantOverrideMessageID: localVariantOverride?.messageID,
      userModel: lastUserMessage()?.model,
      userModelCreatedAt: lastUserMessage()?.time.created,
      userMessageID: lastUserMessage()?.id,
      sessionModel,
    })
  })

  const usage = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    const msg = sync.data.message[sessionID] ?? []

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

    const active = findActiveWorkingAssistant()
    const selectedModel = selectedPromptModel()
    const selectedModelInfo = selectedModel
      ? sync.data.provider.find((item) => item.id === selectedModel.providerID)?.models[selectedModel.modelID]
      : undefined
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
    const model =
      selectedModelInfo ?? sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const contextLimit = usableContextLimit(model)
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return formatPromptUsage(tokens, contextLimit, cost)
  })
  const workingTokenUsage = createMemo(() => {
    if (!props.sessionID) return
    const active = findActiveWorkingAssistant()
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
  const pasteSummaryDefaultEnabled = createMemo(() =>
    sync.data.config.experimental?.disable_paste_summary === undefined
      ? mend.profile.presentation.input.pasteSummary
      : !sync.data.config.experimental.disable_paste_summary,
  )
  const pasteSummaryMinChars = createMemo(() => {
    const experimental = sync.data.config.experimental as
      | (typeof sync.data.config.experimental & { paste_summary_min_chars?: number })
      | undefined
    return Math.max(
      1,
      experimental?.paste_summary_min_chars ??
        mend.profile.presentation.input.pasteSummaryMinChars ??
        DEFAULT_PASTE_SUMMARY_MIN_CHARS,
    )
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
  const currentMessageHistoryPrompt = createMemo(() =>
    messageHistoryIndex() === 0 ? undefined : messageHistoryItems().at(messageHistoryIndex()),
  )
  const currentPromptMatchesMessageHistory = createMemo(() =>
    promptHistoryMatchesCurrent({
      currentPrompt: store.prompt,
      currentMode: store.mode,
      historyIndex: messageHistoryIndex(),
      historyPrompt: currentMessageHistoryPrompt(),
    }),
  )

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
          input.replaceText("")
          input.extmarks.clear()
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
        onSelect: () => {
          void Clipboard.read()
            .then((content) => {
              if (clipboardPasteAction(content) !== "image") return
              return pasteAttachment({
                filename: "clipboard",
                mime: content!.mime,
                content: content!.data,
              })
            })
            .catch(() => undefined)
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: () =>
          shouldEnableSessionInterrupt({
            statusType: status().type,
            hasActiveWorkingAssistant: hasActiveWorkingAssistant(),
            hasPendingPromptDelivery: Boolean(props.sessionID && pendingPromptDeliveryIsActive(props.sessionID)),
            autocompleteVisible: Boolean(autocomplete?.visible),
            compactionActive: compactionActive(),
            interruptRequested: interruptRequested(),
            promptFocused: shouldAcceptPromptInterruptFocus({
              inputFocused: Boolean(input?.focused),
              currentFocusedRenderable: renderer.currentFocusedRenderable,
              promptInput: input,
            }),
          }),
        onSelect: (dialog) => {
          const immediateInterrupt = shouldInterruptImmediately({
            statusType: status().type,
            hasDraft: store.prompt.input.trim().length > 0 || store.prompt.parts.length > 0,
            hasActiveWorkingAssistant: hasActiveWorkingAssistant(),
            hasPendingPromptDelivery: Boolean(props.sessionID && pendingPromptDeliveryIsActive(props.sessionID)),
            compactionActive: compactionActive(),
          })
          if (autocomplete?.visible && !immediateInterrupt) return
          if (
            !immediateInterrupt &&
            !shouldAcceptPromptInterruptFocus({
              inputFocused: input.focused,
              currentFocusedRenderable: renderer.currentFocusedRenderable,
              promptInput: input,
            })
          )
            return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return
          if (immediateInterrupt) {
            const targetMessageID = activeTurnTargetMessageID()
            cancelPendingPromptDeliveryForInterrupt(props.sessionID, targetMessageID)
            abortSession(props.sessionID, targetMessageID)
            setStore("interrupt", 0)
            dialog.clear()
            return
          }

          const nextInterrupt = store.interrupt + 1
          setStore("interrupt", nextInterrupt)
          if (interruptResetTimer) clearTimeout(interruptResetTimer)
          interruptResetTimer = setTimeout(() => {
            setStore("interrupt", 0)
            interruptResetTimer = undefined
          }, 5000)

          if (nextInterrupt >= 2) {
            const targetMessageID = activeTurnTargetMessageID()
            cancelPendingPromptDeliveryForInterrupt(props.sessionID, targetMessageID)
            abortSession(props.sessionID, targetMessageID)
            setStore("interrupt", 0)
            clearTimeout(interruptResetTimer)
            interruptResetTimer = undefined
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

          const cleanContent = cleanPromptInputText(content)
          input.setText(cleanContent)

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

              const newStart = cleanContent.indexOf(virtualText)
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
            input: cleanContent,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = cleanContent.length
        },
      },
      {
        title: "Skills",
        value: "prompt.skills",
        category: "Prompt",
        description: "View and activate or deactivate skills for this project",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          dialog.replace(() => <DialogSkill />)
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
    get submitPending() {
      return submitPending
    },
    get current() {
      return store.prompt
    },
    get inputRows() {
      return input.height
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      const cleanInput = cleanPromptInputText(prompt.input)
      input.setText(cleanInput)
      setStore("prompt", { ...prompt, input: cleanInput })
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.replaceText("")
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
      const cleanInput = cleanPromptInputText(saved.prompt.input)
      if (!cleanInput) return
      input.setText(cleanInput)
      setStore("prompt", { ...saved.prompt, input: cleanInput })
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = Math.min(saved.cursor, cleanInput.length)
    }
  })

  onCleanup(() => {
    promptDisposed = true
    if (input.focused) input.blur()
    if (pendingPromptRetryTimer) clearTimeout(pendingPromptRetryTimer)
    if (interruptResetTimer) clearTimeout(interruptResetTimer)
    if (store.prompt.input) {
      const prompt = unwrap(store.prompt)
      const cleanInput = cleanPromptInputText(prompt.input)
      if (cleanInput) stashed = { prompt: { ...prompt, input: cleanInput }, cursor: input.cursorOffset }
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

  function slashCommandExists(name: string) {
    if (NATIVE_COMPACTION_SLASHES.has(name)) return true
    if (skillNames().has(name)) return true
    if (sync.data.command.some((item) => item.name === name)) return true
    return command
      .slashes()
      .some((item) => item.display === `/${name}` || item.aliases?.some((alias) => alias === `/${name}`))
  }

  async function findSkill(name: string) {
    const loaded = availableSkills.latest ?? availableSkills()
    const existing = loaded?.find((skill) => skill.name === name)
    if (existing) return existing
    const result = await sdk.client.app.skills()
    return result.data?.find((skill) => skill.name === name)
  }

  function slashCommandStyleId() {
    const color = highlight()
    const key = `${color.r}:${color.g}:${color.b}:${color.a}`
    const existing = slashCommandStyleIds.get(key)
    if (existing !== undefined) return existing
    const styleId = syntax().registerStyle(`prompt.slash-command.${slashCommandStyleIds.size}`, {
      fg: color,
      bold: true,
    })
    slashCommandStyleIds.set(key, styleId)
    return styleId
  }

  function syncSlashCommandExtmark(value?: string) {
    if (!input || input.isDestroyed || slashCommandTypeId === 0) return
    for (const extmark of input.extmarks.getAllForTypeId(slashCommandTypeId)) input.extmarks.delete(extmark.id)
    if (store.mode === "shell") return

    const token = findSlashCommandToken(value ?? input.plainText ?? store.prompt.input, slashCommandExists)
    if (!token) return

    input.extmarks.create({
      start: token.start,
      end: token.end,
      styleId: slashCommandStyleId(),
      typeId: slashCommandTypeId,
      priority: 10,
    })
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
        input.replaceText("")
        input.extmarks.clear()
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
          const cleanInput = cleanPromptInputText(entry.input)
          input.setText(cleanInput)
          setStore("prompt", { input: cleanInput, parts: entry.parts })
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
              const cleanInput = cleanPromptInputText(entry.input)
              input.setText(cleanInput)
              setStore("prompt", { input: cleanInput, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  function insertOptimisticUserTurn(input: {
    sessionID: string
    messageID: string
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    created: number
    parts: OptimisticPromptPart[]
  }) {
    const message = optimisticUserMessage(input)
    const parts = optimisticUserParts(input)
    const messages = sync.data.message[input.sessionID]
    sync.session.pinMessage(input.sessionID, input.messageID)

    batch(() => {
      if (!messages) {
        sync.set("message", input.sessionID, [message])
      } else if (!messages.some((item) => item.id === input.messageID)) {
        sync.set(
          "message",
          input.sessionID,
          produce((draft) => {
            const index = draft.findIndex((item) => compareSessionMessages(item, message) > 0)
            draft.splice(index < 0 ? draft.length : index, 0, message)
          }),
        )
      }

      sync.set(
        "part",
        input.messageID,
        mergeOptimisticUserParts({ current: sync.data.part[input.messageID], optimistic: parts }),
      )
    })
  }

  function clearPromptForSubmit() {
    suppressPromptInputSync = true
    // Keep the editor's in-memory undo point so a cleared draft can be
    // recovered with Ctrl+_ without persisting prompt contents anywhere.
    input.replaceText("")
    input.extmarks.clear()
    setStore("prompt", { input: "", parts: [] })
    setStore("extmarkToPartIndex", new Map())
    suppressPromptInputSync = false
  }

  function handlePromptDraftHistoryKey(event: ParsedKey & { preventDefault: () => void; stopPropagation: () => void }) {
    const action = promptDraftHistoryAction({
      undo: keybind.match("input_undo", event),
      redo: keybind.match("input_redo", event),
      canUndo: input.editBuffer.canUndo(),
      canRedo: input.editBuffer.canRedo(),
    })
    if (action === "undo") {
      event.preventDefault()
      event.stopPropagation()
      input.undo()
      return true
    }
    if (action === "redo") {
      event.preventDefault()
      event.stopPropagation()
      input.redo()
      return true
    }
    return false
  }

  function restorePromptAfterSubmitFailure(prompt: PromptInfo) {
    submitPending = false
    if (submitPreflightActive()) setWorkingStartedAt(undefined)
    setSubmitPreflightActive(false)
    suppressPromptInputSync = true
    input.setText(prompt.input)
    input.cursorOffset = prompt.input.length
    setStore("prompt", prompt)
    suppressPromptInputSync = false
    restoreExtmarksFromParts(prompt.parts)
    input.gotoBufferEnd()
  }

  function abortSession(sessionID: string, targetMessageID?: string) {
    if (!targetMessageID) return
    sessionControl.request({ sessionID, targetMessageID })
    updateInterruptRequested(true, targetMessageID)
    if (interruptRequest) return
    interruptRequest = withTimeout(sessionControl.drain(), 2000, "Session interrupt timed out")
      .catch(() => undefined)
      .finally(() => {
        interruptRequest = undefined
      })
  }

  function schedulePendingPromptRetry() {
    if (promptDisposed || pendingPromptRetryTimer || !props.sessionID) return
    const nextAttemptAt = pendingPromptDeliveriesForSession(props.sessionID)
      .filter((delivery) => !delivery.inFlight && delivery.state === "pending")
      .map((delivery) => delivery.nextAttemptAt)
      .sort((a, b) => a - b)[0]
    if (nextAttemptAt === undefined) return
    pendingPromptRetryTimer = setTimeout(
      () => {
        pendingPromptRetryTimer = undefined
        void retryPendingPromptDeliveries()
      },
      Math.max(0, nextAttemptAt - Date.now()),
    )
  }

  function wakePendingPromptRetry(forceAccepted = false) {
    if (promptDisposed || !props.sessionID) return
    if (pendingPromptRetryTimer) clearTimeout(pendingPromptRetryTimer)
    pendingPromptRetryTimer = setTimeout(() => {
      pendingPromptRetryTimer = undefined
      void retryPendingPromptDeliveries({ forceAccepted })
    }, 0)
  }

  async function storedPromptDeliveryState(request: PromptAsyncInput) {
    if (!request.messageID) return "unknown" as const
    const result = await sdk.client.session.message({
      sessionID: request.sessionID,
      messageID: request.messageID,
    })
    if (!result.error) {
      const messages = await sdk.client.session.messages({
        sessionID: request.sessionID,
        limit: 100,
        view: "tui",
      })
      if (messages.error || !messages.data) return "unknown" as const
      return storedPromptDeliveryStateFromMessages(
        messages.data.map((message) => message.info),
        request.messageID,
      )
    }
    if (result.response?.status === 404) return "missing" as const
    return "unknown" as const
  }

  function handlePromptDeliveryFailure(input: {
    request: PromptAsyncInput
    error?: unknown
    response?: Response
    notify: boolean
  }) {
    if (isRetryablePromptDelivery(input)) {
      queuePendingPromptDelivery(input.request)
      if (input.notify) {
        toast.show({
          title: "Prompt queued",
          message:
            "Connection lost. The prompt remains in this session and will be sent automatically after reconnecting.",
          variant: "warning",
          duration: 5000,
        })
      }
      wakePendingPromptRetry()
      return
    }

    settlePendingPromptDelivery(input.request)
    toast.show({
      title: "Prompt not sent",
      message: `${promptDeliveryErrorMessage(input.error)} The prompt remains in session history; press Enter to retry it.`,
      variant: "error",
      duration: 5000,
    })
  }

  async function deliverPrompt(
    request: PromptAsyncInput,
    options?: { retry?: boolean; notify?: boolean; forceAccepted?: boolean; queuedBehindActiveTurn?: boolean },
  ) {
    const retry = options?.retry === true
    const forceAccepted = options?.forceAccepted === true
    const deliveryKey = pendingPromptDeliveryKey(request)
    if (!retry) {
      cancelledPromptDeliveryKeys.delete(deliveryKey)
      latestPromptDeliveryKeyBySession.set(request.sessionID, deliveryKey)
    }
    beginPendingPromptDelivery(request)
    try {
      if (cancelledPromptDeliveryKeys.has(deliveryKey)) return
      if (retry) {
        const state = await storedPromptDeliveryState(request).catch(() => "unknown" as const)
        if (cancelledPromptDeliveryKeys.has(deliveryKey)) return
        const action = promptDeliveryRetryAction({
          state,
          forceAccepted,
          replaceExisting: request.replaceExisting === true,
        })
        if (action === "settle") {
          settlePendingPromptDelivery(request)
          return
        }
        if (action === "accept") {
          acceptPendingPromptDelivery(request, options?.queuedBehindActiveTurn)
          return
        }
        if (action === "queue") {
          queuePendingPromptDelivery(request)
          return
        }
      }

      try {
        const result = await sdk.client.session.promptAsync(request)
        if (cancelledPromptDeliveryKeys.has(deliveryKey)) return
        if (!result.error) {
          // A terminal message event can settle the delivery while this retry
          // request is still in flight. Never recreate that stale delivery or
          // it will dispatch the already-completed prompt in a tight idle loop.
          if (retry && !pendingPromptDeliveries.has(deliveryKey)) return
          if (!request.messageID) {
            settlePendingPromptDelivery(request)
            return
          }
          if (forceAccepted) {
            const state = await storedPromptDeliveryState(request).catch(() => "unknown" as const)
            if (cancelledPromptDeliveryKeys.has(deliveryKey)) return
            if (state === "completed") {
              settlePendingPromptDelivery(request)
              return
            }
          }
          acceptPendingPromptDelivery(request, options?.queuedBehindActiveTurn)
          schedulePendingPromptRetry()
          return
        }
        handlePromptDeliveryFailure({
          request,
          error: result.error,
          response: result.response,
          notify: options?.notify ?? !retry,
        })
      } catch (error) {
        if (cancelledPromptDeliveryKeys.has(deliveryKey)) return
        handlePromptDeliveryFailure({ request, error, notify: options?.notify ?? !retry })
      }
    } finally {
      endPendingPromptDelivery(request)
    }
  }

  async function retryPendingPromptDeliveries(input?: { forceAccepted?: boolean }) {
    if (
      pendingPromptRetryInFlight ||
      !props.sessionID ||
      !promptRecoveryReady({
        connectionStatus: sdk.connection.status,
        reconciledAt: sync.reconciledAt,
        recoveredAt: sdk.connection.recoveredAt,
      })
    )
      return
    pendingPromptRetryInFlight = true
    let blockedBySessionControl = false
    try {
      if (!(await sessionControl.drain())) {
        blockedBySessionControl = true
        return
      }
      const now = Date.now()
      const forceAccepted = input?.forceAccepted === true
      for (const delivery of pendingPromptDeliveriesForSession(props.sessionID)) {
        if (delivery.inFlight) continue
        if (!forceAccepted && delivery.state === "accepted") continue
        if (!forceAccepted && delivery.nextAttemptAt > now) continue
        delivery.inFlight = true
        try {
          await deliverPrompt(delivery.request, {
            retry: true,
            forceAccepted: forceAccepted && delivery.state === "accepted",
          })
        } finally {
          delivery.inFlight = false
        }
      }
    } finally {
      pendingPromptRetryInFlight = false
      if (!blockedBySessionControl) schedulePendingPromptRetry()
    }
  }

  createEffect(() => {
    pendingPromptDeliveryRevision()
    if (
      promptRecoveryReady({
        connectionStatus: sdk.connection.status,
        reconciledAt: sync.reconciledAt,
        recoveredAt: sdk.connection.recoveredAt,
      })
    )
      // Delivery revisions are the normal network retry path. Accepted turns
      // are recovered separately below so accepting one cannot immediately
      // force-dispatch the same prompt again.
      wakePendingPromptRetry()
  })

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) {
      acceptedPromptRecoveryKey = undefined
      return
    }
    pendingPromptDeliveryRevision()
    const deliveries = pendingPromptDeliveriesForSession(sessionID)
    const deliveryKeys = deliveries
      .filter((delivery) => delivery.state === "accepted" && delivery.queuedBehindActiveTurn)
      .map((delivery) => pendingPromptDeliveryKey(delivery.request))
    const decision = acceptedPromptRecoveryDecision({
      previousKey: acceptedPromptRecoveryKey,
      eligible: shouldRecoverAcceptedPromptDeliveries({
        statusType: status().type,
        statusSupersededByTerminalAssistant: terminalAssistantSupersedesBusy(),
        deliveries,
      }),
      deliveryKeys,
    })
    acceptedPromptRecoveryKey = decision.key
    if (!decision.retry) return
    // A healthy RunningThenRun handoff stays busy. Idle, including a terminal assistant superseding stale busy state,
    // means the accepted queued turn lost its runner queue state.
    wakePendingPromptRetry(true)
  })

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    const messages = messagesForActivity()
    for (const delivery of pendingPromptDeliveriesForSession(sessionID)) {
      const messageID = delivery.request.messageID
      if (!messageID) continue
      if (promptDeliveryHasCompletedAssistant(messages, messageID)) {
        settlePendingPromptDelivery(delivery.request)
      }
    }
  })

  onMount(() => {
    const unsubscribe = sdk.event.on("event", (event) => {
      if (event.payload.type !== "server.connected") return
      void retryPendingPromptDeliveries({ forceAccepted: true })
    })
    onCleanup(unsubscribe)
  })

  async function submit() {
    if (submitPending) return false
    setWarpNotice(undefined)

    // Esc is stop-and-hold: a new prompt cannot be accepted or promoted while
    // the cancellation request is still waiting for the backend terminal state.
    if (props.sessionID && !sessionControlAllowsPrompt(sessionControl.status(props.sessionID))) {
      const delivered = await sessionControl.drain()
      const status = sessionControl.status(props.sessionID)
      if (!delivered || !sessionControlAllowsPrompt(status)) {
        toast.show({
          title: "Stop in progress",
          message: "The active turn must confirm cancellation before a new prompt is sent.",
          variant: "warning",
          duration: 4000,
        })
        return false
      }
    }

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      const next = removeVisibleResolvingText(input.plainText)
      if (next !== input.plainText) input.setText(next)
      setStore("prompt", "input", next)
    }
    if (store.prompt.input) {
      const clean = removeVisibleResolvingText(store.prompt.input)
      if (clean !== store.prompt.input) {
        if (input && !input.isDestroyed && input.plainText !== clean) input.setText(clean)
        setStore("prompt", "input", clean)
      }
    }
    syncExtmarksWithPromptParts()
    const promptSnapshot: PromptInfo = {
      input: store.prompt.input,
      parts: [...store.prompt.parts],
      mode: store.prompt.mode,
    }
    const submittedInputRows = input.height
    if (props.disabled) return false
    if (workspaceCreating()) return false
    if (autocomplete?.visible) return false
    if (!promptSnapshot.input) return false
    const agent = activeAgent()
    if (!agent) return false
    const trimmed = promptSnapshot.input.trim()
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
    if (
      store.mode !== "shell" &&
      uiSlashInvocation &&
      command.triggerSlash(uiSlashInvocation.name, uiSlashInvocation.arguments)
    ) {
      input.replaceText("")
      input.extmarks.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      return true
    }
    const selectedModel = selectedPromptModel()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }
    if (shouldRetryConnectionForPrompt(sdk.connection.status)) sdk.reconnect.retry()
    const submittedPrompt = promptSubmitParts(promptSnapshot)
    const queuedBehindActiveTurn = workingStatusActive()
    const submissionStartedAt = Date.now()
    submitPending = true
    setSubmitPreflightActive(true)
    if (!queuedBehindActiveTurn) {
      setWorkingStartedAt(submissionStartedAt)
      if (props.sessionID) workingStartedAtBySession.set(props.sessionID, submissionStartedAt)
    }
    updateInterruptRequested(false)
    clearPromptForSubmit()
    renderer.requestRender()
    const modelConfig = await readModelsConfig(mend.root).catch(() => undefined)
    const configuredRole = Object.values(modelConfig?.roles || {}).find(
      (role) => role?.providerID === selectedModel.providerID && role?.modelID === selectedModel.modelID,
    )
    let budgetGate: Awaited<ReturnType<typeof budgetEnforcementStatus>>
    try {
      budgetGate = await budgetEnforcementStatus(
        {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          authMode: configuredRole?.authMode || null,
        },
        mend.root,
      )
    } catch (error) {
      restorePromptAfterSubmitFailure(promptSnapshot)
      throw error
    }
    if (budgetGate.blockers.length) {
      restorePromptAfterSubmitFailure(promptSnapshot)
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
      restorePromptAfterSubmitFailure(promptSnapshot)
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

      try {
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
          restorePromptAfterSubmitFailure(promptSnapshot)
          console.log("Creating a session failed:", res.error)

          toast.show({
            message: "Creating a session failed. Open console for more details.",
            variant: "error",
          })

          return true
        }

        sessionID = res.data.id
      } catch (error) {
        restorePromptAfterSubmitFailure(promptSnapshot)
        throw error
      }
    }

    local.model.set(selectedModel)
    local.model.variant.set(variant, { model: selectedModel })

    updateInterruptRequested(false)
    if (!queuedBehindActiveTurn) {
      workingStartedAtBySession.set(sessionID, submissionStartedAt)
      setWorkingStartedAt(submissionStartedAt)
    }
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
    const promptParts = [...editorParts, ...submittedPrompt.parts.map(assign)]
    const slashInvocation = findSlashCommandInvocation(inputText, () => true)
    const slashServerCommand = slashInvocation
      ? sync.data.command.find((command) => command.name === slashInvocation.name)
      : undefined
    const messageID = MessageID.ascending()
    trace.trace("submit", {
      sessionID,
      messageID,
      mode: currentMode,
      inputChars: inputText.length,
      partTypes: promptParts.map((part) => part.type),
      status: status().type,
    })
    let skillInvocation: Awaited<ReturnType<typeof findSkill>>
    try {
      skillInvocation =
        slashInvocation && !NATIVE_COMPACTION_SLASHES.has(slashInvocation.name) && !slashServerCommand
          ? await findSkill(slashInvocation.name)
          : undefined
    } catch (error) {
      restorePromptAfterSubmitFailure(promptSnapshot)
      throw error
    }

    history.append(
      {
        ...promptSnapshot,
        mode: currentMode,
      },
      props.historyScope,
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
    } else if (slashInvocation && skillInvocation) {
      const visible = `/${slashInvocation.name}${slashInvocation.arguments ? ` ${slashInvocation.arguments}` : ""}`
      const skillPromptParts = [
        {
          id: PartID.ascending(),
          type: "text" as const,
          text: visible,
        },
        {
          id: PartID.ascending(),
          type: "text" as const,
          text: `Use the skill tool to load "${skillInvocation.name}", then follow its instructions for: ${slashInvocation.arguments}`,
          synthetic: true,
          metadata: {
            kind: "skill_invocation",
            skill: skillInvocation.name,
          },
        },
        ...supplementalSlashPromptParts(promptParts),
      ]
      const optimisticCreated = Date.now()
      insertOptimisticUserTurn({
        sessionID,
        messageID,
        agent: agent.name,
        model: selectedModel,
        variant,
        created: optimisticCreated,
        parts: skillPromptParts,
      })
      void deliverPrompt(
        {
          sessionID,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: skillPromptParts,
        },
        { queuedBehindActiveTurn },
      )
      if (editorParts.length > 0) editor.markSelectionSent()
    } else if (slashInvocation && slashServerCommand) {
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
      const optimisticCreated = Date.now()
      insertOptimisticUserTurn({
        sessionID,
        messageID,
        agent: agent.name,
        model: selectedModel,
        variant,
        created: optimisticCreated,
        parts: promptParts,
      })
      void deliverPrompt(
        {
          sessionID,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: promptParts,
        },
        { queuedBehindActiveTurn },
      )
      if (editorParts.length > 0) editor.markSelectionSent()
    }
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.({ sessionID, messageID, inputRows: submittedInputRows, queuedBehindActiveTurn })

    if (props.sessionID) submitPending = false

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      submitPending = false
      route.navigate({
        type: "session",
        sessionID,
        submitted: { messageID, inputRows: submittedInputRows, queuedBehindActiveTurn },
      })
    }
    return true
  }
  const exit = useExit()

  function applyExpandedPastedText(expanded: ReturnType<typeof expandPastedContentInPrompt>) {
    if (!expanded) return false
    input.setText(expanded.input)
    setStore("prompt", {
      input: expanded.input,
      parts: expanded.parts,
    })
    restoreExtmarksFromParts(expanded.parts)
    input.cursorOffset = expanded.cursorOffset
    return true
  }

  function expandPastedText(text: string) {
    return applyExpandedPastedText(expandPastedContentInPrompt(store.prompt, text))
  }

  function expandEditedPastedText() {
    return applyExpandedPastedText(expandEditedPastedContentInPrompt(store.prompt))
  }

  function expandPastedTextAtCursor(offset = input.cursorOffset) {
    return applyExpandedPastedText(expandPastedContentAtOffset(store.prompt, offset))
  }

  function handlePromptMouseDown(event: MouseEvent) {
    event.target?.focus()
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      const offset = input.cursorOffset
      const now = performance.now()
      const previous = lastPastedContentClick
      lastPastedContentClick = { time: now, offset }
      if (!previous || now - previous.time > 500 || Math.abs(previous.offset - offset) > 1) return
      expandPastedTextAtCursor(offset)
    }, 0)
  }

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

  function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
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
    // Native clipboard reads can leave the renderer without a focused target; do not steal focus from another control.
    if (dialog.stack.length === 0 && !input.isDestroyed && renderer.currentFocusedRenderable === null) {
      input.focus()
    }
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = activeAgent()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  createEffect(on(highlight, () => syncSlashCommandExtmark(), { defer: true }))

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
    return Locale.titlecase(local.agent.current()?.name || "build")
  })
  const currentModelLabel = createMemo(() => {
    const selectedModel = selectedPromptModel()
    if (!selectedModel) return stablePromptStatusText(local.model.parsed().model)
    return stablePromptStatusText(Model.name(sync.data.provider, selectedModel.providerID, selectedModel.modelID))
  })
  const currentSelectedProviderLabel = createMemo(() => {
    const selectedModel = selectedPromptModel()
    if (!selectedModel) return currentProviderLabel()
    return stablePromptStatusText(
      sync.data.provider.find((item) => item.id === selectedModel.providerID)?.name ?? selectedModel.providerID,
    )
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
        return currentAgentLabel() ? { text: currentAgentLabel(), fg: highlight() } : undefined
      case "model":
        return store.mode === "normal" && currentModelLabel()
          ? { text: currentModelLabel()!, fg: keybind.leader ? theme.textMuted : theme.text }
          : undefined
      case "provider":
        return store.mode === "normal" && currentProviderText()
          ? { text: currentProviderText()!, fg: theme.textMuted }
          : undefined
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
      promptModeLabel: mend.promptModeLabel,
      agentLabel: currentAgentLabel(),
      model: currentModelLabel() ?? "",
      modelLabel: currentModelLabel(),
      provider: currentProviderText() ?? "",
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
      .filter((item): item is PromptStatusSegment =>
        Boolean(item && item.text.trim() && !isTransientPromptStatusText(item.text)),
      )
      .map((item, index) => ({ ...item, separatorBefore: index > 0 }))
    const currentScript = (side === "left" ? promptStatusLeftScriptResult() : promptStatusRightScriptResult()) as
      | MendPromptStatusScriptResult
      | undefined
    const latestScript = (
      side === "left" ? promptStatusLeftScriptResult.latest : promptStatusRightScriptResult.latest
    ) as MendPromptStatusScriptResult | undefined
    const currentIdentity =
      side === "left" ? promptStatusLeftScriptSource()?.identity : promptStatusRightScriptSource()?.identity
    const scriptOutput = pickPromptStatusScriptOutput({
      currentIdentity,
      current: currentScript,
      latest: latestScript,
    }) as MendPromptStatusScriptOutput | undefined
    if (scriptOutput?.segments?.length) {
      const separatorBefore = base.length > 0
      const next = scriptOutput.segments
        .filter((item): item is { text: string; fg?: string; bold?: boolean } =>
          Boolean(item.text.trim() && !isTransientPromptStatusText(item.text)),
        )
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
    if (scriptOutput?.text?.trim() && !isTransientPromptStatusText(scriptOutput.text)) {
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
      const placeholder = `${editorVisual()?.shellPrefix || "Run a command..."} "${example}"`
      return removeVisibleResolvingText(placeholder) === placeholder ? placeholder : undefined
    }
    const examples = editorVisual()?.normalExamples?.length ? editorVisual()!.normalExamples! : list()
    if (!examples.length) return undefined
    const placeholder = `${editorVisual()?.normalPrefix || "Ask anything..."} "${examples[store.placeholder % examples.length]}"`
    return removeVisibleResolvingText(placeholder) === placeholder ? placeholder : undefined
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
  const activityStatusType = createMemo(() =>
    workingStatusActive() && status().type === "idle" ? "busy" : status().type,
  )
  const workingLiveUsage = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return
    return active.liveUsage
  })
  const activityToolNames = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return []
    return (sync.data.part[active.id] ?? [])
      .filter((part) => {
        const raw = part as Record<string, any>
        return raw.type === "tool" && (raw.state?.status === "pending" || raw.state?.status === "running")
      })
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
  const latestActivityToolNames = createMemo(() => {
    const active = activeWorkingAssistant()
    if (!active) return []
    const parts = sync.data.part[active.id] ?? []
    const latest = trailingActivityToolNames(parts)
    if (!latest.length) return []
    const latestTool = [...parts].reverse().find((part) => (part as Record<string, any>).type === "tool") as
      | Record<string, any>
      | undefined
    return latestTool?.state?.status === "pending" || latestTool?.state?.status === "running" ? latest : []
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
    if (workingStatusActive() && connection.status === "connected" && connection.recoveringSince) {
      return "reconnecting" as const
    }
    return connection.status
  })
  const activityPhase = createMemo(() => {
    const currentStatus = status()
    const type = activityStatusType()
    return resolveActivityPhase({
      status: type,
      statusKind: compactionActive()
        ? "compaction"
        : type === "busy" && "kind" in currentStatus && typeof currentStatus.kind === "string"
          ? currentStatus.kind
          : undefined,
      retry: type === "retry",
      connection: effectiveConnectionStatus(),
      toolNames: activityToolNames(),
      activeToolNames: activeActivityToolNames(),
      latestToolNames: latestActivityToolNames(),
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
    const sessionID = props.sessionID
    if (sessionID && workingStartedAtBySession.get(sessionID) !== started) {
      workingStartedAtBySession.set(sessionID, started)
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
  const workingIndicatorVisible = createMemo(() =>
    promptWorkingIndicatorVisible({
      hasSession: Boolean(props.sessionID),
      submitPreflightActive: submitPreflightActive(),
      configuredVisible: workingIndicatorConfig().visible !== false,
      working: workingStatusActive(),
    }),
  )
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
    if (
      knownAgentActivityConnectionLabel({
        connectionStatus: effectiveStatus,
        hasKnownAgentActivity: hasKnownAgentActivity(),
        attempt: connection.attempt,
      })
    )
      return
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
    const activityConnectionLabel = knownAgentActivityConnectionLabel({
      connectionStatus: effectiveConnectionStatus(),
      hasKnownAgentActivity: hasKnownAgentActivity(),
      attempt: sdk.connection.attempt,
    })
    const mflowMessage = mflowWaitMessage()
    const message = fitWorkingText(
      connectionMessage ??
        mflowMessage ??
        [
          workingMessage(),
          workingElapsed(),
          workingIndicatorConfig().showTokenUsage ? workingTokenUsage() : undefined,
          activityConnectionLabel,
        ]
          .filter(Boolean)
          .join("  "),
    )
    const color =
      effectiveConnectionStatus() === "failed"
        ? theme.error
        : connectionMessage || mflowMessage
          ? theme.warning
          : theme.text
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
  const bottomDockWidgetTitles = createMemo(
    () =>
      new Set(
        listMendWidgets("sessionBottomDock")
          .map((item) => item.title)
          .filter((item): item is string => Boolean(item)),
      ),
  )
  const visibleStatusEntries = createMemo(() =>
    statusEntries().filter((item) => {
      const value = item.value
      return Boolean(value && !isTransientPromptStatusText(value) && !bottomDockWidgetTitles().has(value))
    }),
  )
  const footerEntries = createMemo(() => listMendFooterEntries())
  const customFooter = createMemo(() => getMendFooter())
  const promptShowsOuterFooter = createMemo(() => {
    if (workingStatusActive()) return true
    if (warpNotice()) return true
    if (workspaceLabel()) return true
    if (store.mode === "shell") return true
    if (customFooter()) return true
    if (promptStatusUsesOuterMeta() && (promptStatusLeftSegments().length || promptStatusRightSegments().length))
      return true
    if (loopStatusText()) return true
    if (promptStatusUsesOuterMeta() && (visibleStatusEntries().length || footerEntries().length)) return true
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
        skills={() => availableSkills() ?? []}
      />
      <box
        ref={(r) => (anchor = r)}
        visible={props.visible !== false}
        width="100%"
        position="relative"
        zIndex={1000}
        overflow="visible"
      >
        <Show when={workingIndicatorVisible() || Boolean(connectionStateMessage())}>
          <box
            width="100%"
            height={1}
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={promptOuterMetaPadLeft()}
            paddingRight={promptFooterPadRight()}
          >
            <box flexDirection="row" gap={1} flexShrink={1}>
              <Show when={connectionStateMessage()}>
                {(message) => (
                  <text fg={theme.warning} wrapMode="none">
                    {message()}
                  </text>
                )}
              </Show>
              <Show when={!connectionStateMessage() && workingStatusActive()}>
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
              <Show when={status().type !== "retry" && workingStatusActive() && workingRightMeta()}>
                {(meta) => (
                  <text fg={theme.textMuted} wrapMode="none">
                    {meta()}
                  </text>
                )}
              </Show>
            </box>
          </box>
        </Show>
        <Show when={props.sessionID && workingStatusActive() && workingMascot()}>
          {(mascot) => (
            <box position="absolute" right={mascotRightOffset()} top={mascotTopOffset()} zIndex={2000} flexShrink={0}>
              <MascotLines text={mascot()} hoverText={hoverMascot()} paddingTop={0} />
            </box>
          )}
        </Show>
        <Show when={props.sessionID && !workingStatusActive() && idleMascot()}>
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
                  if (suppressPromptInputSync) return
                  const raw = input.plainText
                  const value = removeVisibleResolvingText(raw)
                  if (value !== raw) {
                    input.setText(value)
                    input.gotoBufferEnd()
                  }
                  setStore("prompt", "input", value)
                  autocomplete.onInput(value)
                  syncExtmarksWithPromptParts()
                  if (expandEditedPastedText()) return
                  syncSlashCommandExtmark(value)
                }}
                keyBindings={textareaKeybindings()}
                onKeyDown={(e) => {
                  if (props.disabled) {
                    e.preventDefault()
                    return
                  }
                  if (handlePromptDraftHistoryKey(e)) return
                  if (isTextareaNewlineKey(e, keybind.all)) markSubmitSuppressedForNewline()
                  // Check clipboard for images before terminal-handled paste runs.
                  // This helps terminals that forward Ctrl+V to the app; Windows
                  // Terminal 1.25+ usually handles Ctrl+V before this path.
                  if (keybind.match("input_paste", e)) {
                    // Claim the event before the native clipboard probe. The
                    // probe can cross a process boundary (osascript/wl-paste),
                    // and awaiting it here serializes later Esc events behind
                    // the clipboard read in some terminal renderers.
                    e.preventDefault()
                    void Clipboard.read()
                      .then((content) => {
                        const action = clipboardPasteAction(content)
                        if (action === "image") {
                          return pasteAttachment({
                            filename: "clipboard",
                            mime: content!.mime,
                            content: content!.data,
                          })
                        }
                        if (action === "text" && !input.isDestroyed) input.insertText(content!.data)
                      })
                      .catch(() => undefined)
                    return
                  }
                  if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                    input.replaceText("")
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
                      void exit()
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
                  const historyDirection = keybind.match("history_previous", e)
                    ? -1
                    : keybind.match("history_next", e)
                      ? 1
                      : undefined
                  if (store.mode === "normal") autocomplete.onKeyDown(e)
                  if (!autocomplete.visible) {
                    if (shouldHandlePromptCursorArrow(e)) {
                      // cursorOffset writes bypass OpenTUI's extmark movement wrappers; keep virtual prompt parts atomic.
                      input.cursorOffset = promptCursorOffsetAfterArrow({
                        cursorOffset: input.cursorOffset,
                        text: input.plainText,
                        direction: e.name === "left" ? "left" : "right",
                        atomicRanges: input.extmarks.getVirtual(),
                      })
                      e.preventDefault()
                      return
                    }

                    if (
                      shouldSnapPromptCursorToEnd({
                        direction: historyDirection,
                        cursorOffset: input.cursorOffset,
                        text: input.plainText,
                        visualRow: input.visualCursor.visualRow,
                        totalVisualRows: input.editorView.getTotalVirtualLineCount(),
                        scrollY: input.scrollY,
                      })
                    ) {
                      setTimeout(() => {
                        if (!input || input.isDestroyed) return
                        input.gotoBufferEnd()
                      }, 0)
                      return
                    }

                    if (
                      historyDirection !== undefined &&
                      shouldAttemptPromptHistoryNavigation({
                        direction: historyDirection,
                        cursorOffset: Math.max(input.cursorOffset, input.visualCursor.offset),
                        text: input.plainText,
                        parts: store.prompt.parts,
                      })
                    ) {
                      const prefersMessagePromptHistory = shouldPreferMessagePromptHistory({
                        direction: historyDirection,
                        currentPromptMatchesHistory: currentPromptMatchesMessageHistory(),
                      })
                      if (prefersMessagePromptHistory && moveMessageHistory(historyDirection, e)) return
                      if (allowStoredPromptHistoryFallback()) {
                        const item = history.move(historyDirection, input.plainText, props.historyScope)
                        if (item) {
                          applyPromptHistoryItem(item, historyDirection, e)
                          return
                        }
                      }
                      if (prefersMessagePromptHistory) return
                    }

                    if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) {
                      setTimeout(() => {
                        if (!input || input.isDestroyed) return
                        input.cursorOffset = 0
                      }, 0)
                    }
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
                  const normalizedText = cleanPromptInputText(
                    decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
                  )
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

                  const isPortableImageClipboard = pastedContent.includes("![") && pastedContent.includes("data:image/")
                  if (
                    !isPortableImageClipboard &&
                    shouldSummarizePastedContentWithThreshold(pastedContent, pasteSummaryMinChars()) &&
                    kv.get("paste_summary_enabled", pasteSummaryDefaultEnabled())
                  ) {
                    if (!expandPastedText(pastedContent)) pasteText(pastedContent, pastedContentLabel(pastedContent))
                    return
                  }

                  const filepath = iife(() => {
                    // Do not run path detection on a large text paste. Apart from
                    // being unnecessary, it creates another full-size string and
                    // delays the bounded placeholder path above.
                    if (pastedContent.length > 8192 || pastedContent.includes("\n")) return ""
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

                  const portableImageTokens = isPortableImageClipboard
                    ? parsePortableImageClipboard(pastedContent)
                    : undefined
                  if (portableImageTokens) {
                    for (const token of portableImageTokens) {
                      if (token.type === "text") {
                        const text = cleanPromptInputText(token.text)
                        if (text) input.insertText(text)
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
                  if (slashCommandTypeId === 0) {
                    slashCommandTypeId = input.extmarks.registerType("slash-command")
                  }
                  props.ref?.(ref)
                  setTimeout(() => {
                    // setTimeout is a workaround and needs to be addressed properly
                    if (!input || input.isDestroyed) return
                    input.cursorColor = theme.text
                  }, 0)
                }}
                onMouseDown={handlePromptMouseDown}
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
                    <Show when={loopStatusText()}>{(label) => <text fg={theme.secondary}>{label()}</text>}</Show>
                    <For each={visibleStatusEntries()}>{(item) => <text fg={theme.textMuted}>{item.value}</text>}</For>
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
