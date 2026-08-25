import type {
  Message,
  AssistantMessage,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  PlanReviewRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@mendcode/sdk/v2"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@mendcode/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import * as Log from "@mendcode/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"
import { useSessionControl } from "./session-control"
import { isRecentWorkingAssistant, sessionStatusExpiryDelay } from "../util/session-working"
import { appendLiveShellOutput, previewShellOutput } from "./shell-output"
import { tuiText } from "../util/text"
import {
  isCurrentTuiBootstrap,
  syncBootstrapReadiness,
  syncReadyForStatus,
  tuiFastBootEnabled,
} from "../util/fast-boot"
import { pickTuiSessionCacheEvictions, TUI_SESSION_CACHE_LIMIT } from "../util/session-cache"
import {
  compareSessionMessages,
  isSessionMessageAfter,
  isSessionMessageBefore,
  latestCompletedCompactionSummaryID,
  sortSessionMessages,
} from "../util/session-message-order"

type ShellOutputEvent = {
  type: "session.next.shell.output"
  properties: {
    sessionID: string
    callID: string
    delta: string
  }
}

export const TUI_SESSION_MESSAGE_SYNC_LIMIT = 50
// Keep three pages resident as a bounded sliding cache; this is a 150-message history limit.
export const TUI_SESSION_MESSAGE_PAGE_WINDOW = 3
export const TUI_SESSION_MESSAGE_STORE_LIMIT = TUI_SESSION_MESSAGE_SYNC_LIMIT * TUI_SESSION_MESSAGE_PAGE_WINDOW
export const TUI_SESSION_MESSAGE_PART_SYNC_LIMIT = 96
export const TUI_SESSION_MESSAGE_PART_STORE_LIMIT = 256
export const COMPACTED_TOOL_CALLS_KV_KEY = "compacted_tool_calls_visible"
const TUI_TEXT_PREVIEW_CHARS = 128 * 1024
const TUI_TOOL_OUTPUT_PREVIEW_CHARS = 16 * 1024
const TUI_METADATA_PREVIEW_CHARS = 4 * 1024
const TUI_DIFF_PREVIEW_CHARS = 512 * 1024
const TUI_CONTENT_PREVIEW_CHARS = 512 * 1024
const TUI_FIELD_PREVIEW_CHARS = 2 * 1024
const TUI_PATCH_FILE_LIMIT = 256
const TUI_PREVIEW_ARRAY_LIMIT = 8
const TUI_PENDING_PART_DELTA_SESSION_LIMIT = 4
const TUI_PENDING_PART_DELTA_MESSAGE_LIMIT = 16
const TUI_PENDING_PART_DELTA_PART_LIMIT = 4
const TUI_PENDING_PART_DELTA_FIELD_LIMIT = 4
const trace = Log.create({ service: "tui.sync" })

function previewString(input: unknown, maxChars: number, label: string) {
  if (typeof input !== "string" || input.length <= maxChars) return typeof input === "string" ? input : undefined
  const marker = `\n[${label} preview truncated: omitted ${input.length - maxChars} chars; showing start and latest tail.]\n`
  const budget = Math.max(0, maxChars - marker.length)
  if (budget <= 0) return input.slice(-maxChars)
  const head = Math.floor(budget / 3)
  const tail = budget - head
  return `${input.slice(0, head)}${marker}${input.slice(input.length - tail)}`
}

function previewDiff(input: string) {
  if (input.length <= TUI_DIFF_PREVIEW_CHARS) return input
  const marker = "\n[Diff preview truncated: too large to render safely. Show more to inspect the full diff.]\n"
  const budget = Math.max(0, TUI_DIFF_PREVIEW_CHARS - marker.length)
  if (budget <= 0) return marker.slice(0, TUI_DIFF_PREVIEW_CHARS)
  const head = Math.floor(budget / 3)
  return `${input.slice(0, head)}${marker}${input.slice(input.length - (budget - head))}`
}

function previewUnknown(
  input: unknown,
  maxChars: number,
  label: string,
  depth = 0,
  preserveCurrentArray = false,
): unknown {
  if (typeof input === "string") return previewString(input, maxChars, label)
  if (!input || typeof input !== "object") return input
  if (depth >= 4) return "[nested value omitted]"
  if (Array.isArray(input)) {
    const itemLimit = Math.min(TUI_PREVIEW_ARRAY_LIMIT, Math.max(1, Math.floor(maxChars / 1024)))
    const itemMaxChars = Math.max(256, Math.floor(maxChars / itemLimit))
    const items = preserveCurrentArray ? input : input.slice(0, itemLimit)
    return items.map((item) => previewUnknown(item, itemMaxChars, label, depth + 1))
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const diffLike = key === "diff" || key === "patch"
    const nextMax = diffLike
      ? TUI_DIFF_PREVIEW_CHARS
      : key === "content"
        ? TUI_CONTENT_PREVIEW_CHARS
        : key === "output"
          ? maxChars
          : Math.min(maxChars, TUI_FIELD_PREVIEW_CHARS)
    result[key] =
      diffLike && typeof value === "string"
        ? previewDiff(value)
        : previewUnknown(value, nextMax, `${label}.${key}`, depth + 1, key === "todos")
  }
  return result
}

function previewPartForStore(part: Part): Part {
  if (part.type === "text" || part.type === "reasoning") {
    return { ...part, text: previewString(part.text, TUI_TEXT_PREVIEW_CHARS, `${part.type} part`) ?? "" } as Part
  }
  if (part.type === "file") {
    return {
      ...part,
      url: part.url?.startsWith("data:") ? previewString(part.url, TUI_FIELD_PREVIEW_CHARS, "file url") : part.url,
      source: previewUnknown(part.source, TUI_FIELD_PREVIEW_CHARS, "file source"),
    } as Part
  }
  if (part.type === "patch") return { ...part, files: part.files.slice(0, TUI_PATCH_FILE_LIMIT) }
  if (part.type !== "tool") return part

  const state = part.state
  const nextState =
    state.status === "pending"
      ? {
          ...state,
          raw: previewString(state.raw, TUI_FIELD_PREVIEW_CHARS, "tool raw input"),
          input: previewUnknown(state.input, TUI_FIELD_PREVIEW_CHARS, "tool input"),
        }
      : state.status === "running"
        ? {
            ...state,
            input: previewUnknown(state.input, TUI_FIELD_PREVIEW_CHARS, "tool input"),
            metadata: previewUnknown(state.metadata, TUI_METADATA_PREVIEW_CHARS, "tool metadata"),
          }
        : state.status === "completed"
          ? {
              ...state,
              input: previewUnknown(state.input, TUI_FIELD_PREVIEW_CHARS, "tool input"),
              output:
                part.tool === "bash" || part.tool === "shell"
                  ? previewShellOutput(state.output)
                  : (previewString(state.output, TUI_TOOL_OUTPUT_PREVIEW_CHARS, "tool output") ?? ""),
              metadata: previewUnknown(state.metadata, TUI_METADATA_PREVIEW_CHARS, "tool metadata"),
            }
          : {
              ...state,
              input: previewUnknown(state.input, TUI_FIELD_PREVIEW_CHARS, "tool input"),
              error: previewString(state.error, TUI_TOOL_OUTPUT_PREVIEW_CHARS, "tool error") ?? "",
              metadata: previewUnknown(state.metadata, TUI_METADATA_PREVIEW_CHARS, "tool metadata"),
            }

  return {
    ...part,
    state: nextState,
    metadata: previewUnknown(part.metadata, TUI_METADATA_PREVIEW_CHARS, "tool part metadata"),
  } as Part
}

function preserveAppendOnlyPartText(current: Part, incoming: Part): Part {
  if (current.type !== incoming.type) return incoming
  if (current.type !== "text" && current.type !== "reasoning") return incoming
  if (incoming.type !== "text" && incoming.type !== "reasoning") return incoming

  const currentText = tuiText(current.text)
  const incomingText = tuiText(incoming.text)
  if (currentText.length > incomingText.length && currentText.startsWith(incomingText)) {
    return previewPartForStore({ ...incoming, text: currentText } as Part)
  }

  return incoming
}

function preserveRunningShellOutput(current: Part, incoming: Part): Part {
  if (current.type !== "tool" || incoming.type !== "tool") return incoming
  if (current.tool !== incoming.tool || (current.tool !== "bash" && current.tool !== "shell")) return incoming
  if (current.state.status !== "running" || incoming.state.status !== "running") return incoming
  const output = current.state.metadata?.output
  if (typeof output !== "string" || output.length === 0) return incoming
  return {
    ...incoming,
    state: {
      ...incoming.state,
      metadata: {
        ...(incoming.state.metadata ?? {}),
        output,
      },
    },
  }
}

function toolStateRank(status: string) {
  if (status === "pending") return 0
  if (status === "running") return 1
  return 2
}

function preserveNewerToolState(current: Part, incoming: Part): Part {
  if (current.type !== "tool" || incoming.type !== "tool") return incoming
  if (current.callID !== incoming.callID || current.tool !== incoming.tool) return incoming

  const currentRank = toolStateRank(current.state.status)
  const incomingRank = toolStateRank(incoming.state.status)
  if (currentRank > incomingRank) return current
  if (currentRank < incomingRank) return incoming

  if (current.state.status === "completed" && incoming.state.status === "completed") {
    if (current.state.time.end >= incoming.state.time.end) return current
  }
  if (current.state.status === "error" && incoming.state.status === "error") {
    if (current.state.time.end >= incoming.state.time.end) return current
  }
  if (current.state.status === "running" && incoming.state.status === "running") {
    if (current.state.time.start > incoming.state.time.start) return current
    const currentDiff = current.state.metadata?.diff
    const incomingDiff = incoming.state.metadata?.diff
    if (typeof currentDiff === "string" && typeof incomingDiff !== "string") return current
  }

  return incoming
}

function preserveLivePart(current: Part, incoming: Part) {
  const live = preserveRunningShellOutput(current, preserveAppendOnlyPartText(current, incoming))
  return preserveNewerToolState(current, live)
}

function trimStoredParts(parts: Part[]) {
  if (parts.length <= TUI_SESSION_MESSAGE_PART_STORE_LIMIT) return parts
  const head = Math.min(32, Math.floor(TUI_SESSION_MESSAGE_PART_STORE_LIMIT / 4))
  return [...parts.slice(0, head), ...parts.slice(parts.length - (TUI_SESSION_MESSAGE_PART_STORE_LIMIT - head))]
}

function mergeFetchedParts(current: Part[] | undefined, incoming: Part[]) {
  if (!current?.length) return trimStoredParts(incoming)

  const currentByID = new Map(current.map((part) => [part.id, part]))
  const seen = new Set<string>()
  const merged = incoming.map((part) => {
    seen.add(part.id)
    const existing = currentByID.get(part.id)
    return existing ? preserveLivePart(existing, part) : part
  })

  for (const part of current) {
    if (seen.has(part.id)) continue
    merged.push(part)
  }

  return trimStoredParts(merged.toSorted((a, b) => a.id.localeCompare(b.id)))
}

function mergeMessageInfo(current: Message | undefined, incoming: Message): Message {
  if (!current || current.role !== incoming.role) return incoming
  if (incoming.role !== "assistant" || current.role !== "assistant") return incoming

  return {
    ...current,
    ...incoming,
    time: {
      ...current.time,
      ...incoming.time,
      completed: incoming.time.completed ?? current.time.completed,
    },
    finish: incoming.finish ?? current.finish,
    providerID: incoming.providerID || current.providerID,
    modelID: incoming.modelID || current.modelID,
    variant: incoming.variant ?? current.variant,
  }
}

type SessionMessagePageItem = {
  info: Message
  parts: Part[]
  partsMore?: boolean
  partsCursor?: string
}

type FullToolPart = Extract<Part, { type: "tool" }>

function normalizeSessionMessages(messages: readonly Message[]) {
  const byID = new Map<string, Message>()
  for (const message of messages) {
    byID.set(message.id, mergeMessageInfo(byID.get(message.id), message))
  }
  return sortSessionMessages([...byID.values()])
}

function trimLoadedSessionMessages(input: {
  messages: Message[]
  max: number
  drop: "oldest" | "newest"
  preserveIDs?: ReadonlySet<string>
}) {
  const messages = normalizeSessionMessages(input.messages)
  if (messages.length <= input.max) return { messages, removed: [] as Message[] }
  const removeCount = messages.length - input.max
  const candidates = input.drop === "oldest" ? messages : messages.toReversed()
  const removedIDs = new Set(
    candidates
      .filter((message) => !input.preserveIDs?.has(message.id))
      .slice(0, removeCount)
      .map((message) => message.id),
  )
  if (removedIDs.size < removeCount) {
    for (const message of candidates) {
      if (removedIDs.has(message.id)) continue
      removedIDs.add(message.id)
      if (removedIDs.size === removeCount) break
    }
  }
  return {
    messages: messages.filter((message) => !removedIDs.has(message.id)),
    removed: messages.filter((message) => removedIDs.has(message.id)),
  }
}

function visibleUserParts(parts: readonly Part[] | undefined) {
  if (!parts) return
  return parts.some(
    (part) => (part.type === "text" && !part.synthetic && tuiText(part.text).trim().length > 0) || part.type === "file",
  )
}

function visibleAssistantParts(parts: readonly Part[] | undefined) {
  if (!parts) return false
  return parts.some((part) => part.type === "text" && !part.synthetic && tuiText(part.text).trim().length > 0)
}

function isHiddenCompactionSummary(
  message: Message,
  messages: readonly Message[],
  parts?: (messageID: string) => readonly Part[] | undefined,
) {
  if (message.role !== "assistant" || message.summary !== true || !message.parentID) return false
  const parent = messages.find((candidate) => candidate.id === message.parentID)
  return (parent && parts?.(parent.id)?.some((part) => part.type === "compaction")) === true
}

function preserveSessionTailIDs(
  messages: readonly Message[],
  pinned?: ReadonlySet<string>,
  parts?: (messageID: string) => readonly Part[] | undefined,
  working = false,
) {
  const result = new Set(pinned)
  const users = messages.filter((message) => message.role === "user")
  const latestUser =
    users.findLast((message) => visibleUserParts(parts?.(message.id)) === true) ??
    users.findLast((message) => visibleUserParts(parts?.(message.id)) === undefined)
  if (latestUser) result.add(latestUser.id)
  const latestAssistant = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      !isHiddenCompactionSummary(message, messages, parts) &&
      visibleAssistantParts(parts?.(message.id)),
  )
  if (latestAssistant) result.add(latestAssistant.id)
  const workingAssistant = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      (message.time.completed === undefined || (working && ["tool-calls", "unknown"].includes(message.finish ?? ""))),
  )
  if (workingAssistant) result.add(workingAssistant.id)
  return result
}

export function releasablePinnedSessionMessageIDs(messages: readonly Message[], pinned: ReadonlySet<string>) {
  const completedParents = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" &&
      message.parentID &&
      message.time.completed !== undefined &&
      (Boolean(message.error) || Boolean(message.finish && !["tool-calls", "unknown"].includes(message.finish)))
        ? [message.parentID]
        : [],
    ),
  )
  return [...pinned].filter((messageID) => completedParents.has(messageID))
}

function mergeSessionMessagePage(input: {
  current: Message[] | undefined
  incoming: Message[]
  max?: number
  drop?: "oldest" | "newest"
  preserveCurrent?: "all" | "newer-working-assistant"
  preserveIDs?: ReadonlySet<string>
  excludedIDs?: ReadonlySet<string>
}) {
  const byID = new Map<string, Message>()
  const currentByID = new Map((input.current ?? []).map((message) => [message.id, message]))
  const oldestIncoming = input.incoming[0]
  const newestIncoming = input.incoming.at(-1)
  const preserveAllCurrent = input.preserveCurrent === "all" || input.incoming.length === 0
  for (const message of input.current ?? []) {
    if (input.excludedIDs?.has(message.id)) continue
    if (input.preserveIDs?.has(message.id)) {
      byID.set(message.id, message)
      continue
    }
    if (!preserveAllCurrent && input.preserveCurrent === "newer-working-assistant") {
      if (message.role === "user") {
        byID.set(message.id, message)
        continue
      }
      if (message.role === "assistant" && message.time.completed === undefined) {
        byID.set(message.id, message)
        continue
      }
      if (oldestIncoming && isSessionMessageBefore(message, oldestIncoming)) {
        byID.set(message.id, message)
        continue
      }
      if (!newestIncoming || !isSessionMessageAfter(message, newestIncoming)) continue
      if (message.role !== "assistant" || message.time.completed) continue
    }
    byID.set(message.id, message)
  }
  for (const message of input.incoming) {
    if (input.excludedIDs?.has(message.id)) continue
    byID.set(message.id, mergeMessageInfo(currentByID.get(message.id), message))
  }
  const normalized = sortSessionMessages([...byID.values()])
  const trimmed =
    input.max === undefined
      ? { messages: normalized, removed: [] as Message[] }
      : trimLoadedSessionMessages({
          messages: normalized,
          max: input.max,
          drop: input.drop ?? "oldest",
          preserveIDs: input.preserveIDs,
        })
  const retained = new Set(trimmed.messages.map((message) => message.id))
  return {
    messages: trimmed.messages,
    removed: (input.current ?? []).filter((message) => !retained.has(message.id)),
  }
}

function messageCursor(message: Message) {
  return Buffer.from(JSON.stringify({ id: message.id, time: message.time.created })).toString("base64url")
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      provider_metadata_ready: boolean
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      plan_review: {
        [sessionID: string]: PlanReviewRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      session_latest_assistant: {
        [sessionID: string]: AssistantMessage
      }
      part: {
        [messageID: string]: Part[]
      }
      message_part_paging: {
        [messageID: string]: {
          hasMore: boolean
          cursor?: string
          loading?: boolean
        }
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      provider_metadata_ready: false,
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      plan_review: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      session_latest_assistant: {},
      part: {},
      message_part_paging: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()
    const sessionControl = useSessionControl()
    const [showCompactedToolCalls] = kv.signal(COMPACTED_TOOL_CALLS_KV_KEY, false)

    const sessionMessagePaging = new Map<
      string,
      {
        olderCursor?: string
        hasMoreOlder: boolean
        newerCursor?: string
        hasMoreNewer: boolean
        keepLoadedHistory?: boolean
        loadingOlder?: Promise<boolean>
        loadingNewer?: Promise<boolean>
      }
    >()
    const sessionMessageSyncGeneration = new Map<string, number>()
    const sessionMessageSyncInFlight = new Map<string, Promise<void>>()
    const sessionMessageSyncQueued = new Set<string>()
    const sessionDiffHydrationRequested = new Set<string>()
    const sessionDiffHydrationInFlight = new Map<string, Promise<void>>()
    const sessionCacheSeen = new Set<string>()
    let activeSessionID: string | undefined
    const pinnedSessionMessages = new Map<string, Set<string>>()
    const removedSessionMessages = new Map<string, Set<string>>()
    const pendingPartDeltas = new Map<string, Map<string, Map<string, Map<string, string>>>>()
    const fullMessageRequests = new Map<string, Promise<SessionMessagePageItem>>()
    const sessionStatusTimers = new Map<string, Timer>()
    const [reconciledAt, setReconciledAt] = createSignal<number>()
    let syncedWorkspace = project.workspace.current()
    let bootstrapGeneration = 0
    let pendingInputRefreshTimer: Timer | undefined

    function beginSessionMessageSync(sessionID: string) {
      const generation = (sessionMessageSyncGeneration.get(sessionID) ?? 0) + 1
      sessionMessageSyncGeneration.set(sessionID, generation)
      return generation
    }

    function isCurrentSessionMessageSync(sessionID: string, generation: number) {
      return sessionMessageSyncGeneration.get(sessionID) === generation
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    async function listSessions() {
      const query = sessionListQuery()
      const recentStart = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sort = (items: typeof store.session) => items.toSorted((a, b) => a.id.localeCompare(b.id))
      const attempts: Array<() => Promise<typeof store.session>> = [
        () =>
          sdk.client.session.list({ start: recentStart, ...query }, { throwOnError: true }).then((x) => x.data ?? []),
        () => sdk.client.session.list(query, { throwOnError: true }).then((x) => x.data ?? []),
      ]

      if (query.path || query.scope !== "project") {
        attempts.push(
          () =>
            sdk.client.session
              .list({ start: recentStart, scope: "project" }, { throwOnError: true })
              .then((x) => x.data ?? []),
          () => sdk.client.session.list({ scope: "project" }, { throwOnError: true }).then((x) => x.data ?? []),
        )
      }

      attempts.push(
        () =>
          sdk.client.experimental.session
            .list({ start: recentStart, limit: 100 }, { throwOnError: true })
            .then((x) => x.data ?? []),
        () => sdk.client.experimental.session.list({ limit: 100 }, { throwOnError: true }).then((x) => x.data ?? []),
      )

      let succeeded = false
      let lastError: unknown
      for (const attempt of attempts) {
        try {
          const sessions = await attempt()
          succeeded = true
          if (sessions.length > 0) return sort(sessions)
        } catch (error) {
          lastError = error
          // Try the next scope; Home should not look empty just because one listing path failed.
        }
      }

      if (!succeeded && lastError !== undefined) throw lastError
      return []
    }

    async function fetchSessionMessagePage(input: {
      sessionID: string
      limit: number
      before?: string
      after?: string
    }) {
      const url = new URL(`/session/${encodeURIComponent(input.sessionID)}/message`, sdk.url)
      url.searchParams.set("limit", String(input.limit))
      const showAllToolCalls = showCompactedToolCalls()
      url.searchParams.set("view", showAllToolCalls ? "tui-all" : "tui")
      if (showAllToolCalls) url.searchParams.set("partsLimit", String(TUI_SESSION_MESSAGE_PART_SYNC_LIMIT))
      if (input.before) url.searchParams.set("before", input.before)
      if (input.after) url.searchParams.set("after", input.after)
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      const response = await sdk.fetch(url.toString(), { headers: sdk.headers })
      if (!response.ok) throw new Error(`session message page failed: ${response.status} ${response.statusText}`)
      return {
        items: (await response.json()) as SessionMessagePageItem[],
        cursor: response.headers.get("X-Next-Cursor") ?? undefined,
        sparse: response.headers.get("X-Message-View-Sparse") === "true",
      }
    }

    async function fetchSessionMessageParts(input: { sessionID: string; messageID: string; after: string }) {
      const url = new URL(
        `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
        sdk.url,
      )
      url.searchParams.set("view", "tui-all")
      url.searchParams.set("partsLimit", String(TUI_SESSION_MESSAGE_PART_SYNC_LIMIT))
      url.searchParams.set("partsAfter", input.after)
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      const response = await sdk.fetch(url.toString(), { headers: sdk.headers })
      if (!response.ok) throw new Error(`session message parts failed: ${response.status} ${response.statusText}`)
      return (await response.json()) as SessionMessagePageItem
    }

    async function fetchFullSessionMessage(input: { sessionID: string; messageID: string }) {
      const url = new URL(
        `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
        sdk.url,
      )
      url.searchParams.set("view", "full")
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      const response = await sdk.fetch(url.toString(), { headers: sdk.headers })
      if (!response.ok) throw new Error(`full session message failed: ${response.status} ${response.statusText}`)
      return (await response.json()) as SessionMessagePageItem
    }

    async function loadFullToolPart(sessionID: string, messageID: string, partID: string) {
      const key = `${sessionID}\u0000${messageID}`
      const current = fullMessageRequests.get(key)
      const request = current ?? fetchFullSessionMessage({ sessionID, messageID })
      if (!current) fullMessageRequests.set(key, request)
      try {
        const item = await request
        if (item.info.sessionID !== sessionID || item.info.id !== messageID) return undefined
        return item.parts.find((part): part is FullToolPart => part.type === "tool" && part.id === partID)
      } finally {
        if (fullMessageRequests.get(key) === request) fullMessageRequests.delete(key)
      }
    }

    function hydrateSessionDiff(sessionID: string) {
      if (sessionDiffHydrationRequested.has(sessionID)) return
      sessionDiffHydrationRequested.add(sessionID)
      const run: Promise<void> = sdk.client.session
        .diff({ sessionID })
        .then((diff) => {
          if (sessionDiffHydrationInFlight.get(sessionID) !== run) return
          setStore("session_diff", sessionID, reconcile(diff.data ?? []))
        })
        .catch(() => undefined)
        .finally(() => {
          if (sessionDiffHydrationInFlight.get(sessionID) === run) sessionDiffHydrationInFlight.delete(sessionID)
        })
      sessionDiffHydrationInFlight.set(sessionID, run)
    }

    async function fetchSessionMessageWindow(sessionID: string) {
      const first = await fetchSessionMessagePage({ sessionID, limit: TUI_SESSION_MESSAGE_SYNC_LIMIT })
      let items = first.items
      let cursor = first.cursor
      let sparse = first.sparse
      let before: string | undefined
      while (cursor && cursor !== before && items.length < TUI_SESSION_MESSAGE_STORE_LIMIT) {
        before = cursor
        const older = await fetchSessionMessagePage({
          sessionID,
          limit: Math.min(TUI_SESSION_MESSAGE_SYNC_LIMIT, TUI_SESSION_MESSAGE_STORE_LIMIT - items.length),
          before,
        })
        if (older.items.length === 0) {
          cursor = undefined
          break
        }
        items = [...older.items, ...items]
        sparse ||= older.sparse
        cursor = older.cursor === before ? undefined : older.cursor
      }
      return { items, cursor, sparse }
    }

    function setLatestAssistantSnapshot(sessionID: string, message: AssistantMessage) {
      const snapshot = structuredClone(unwrap(message))
      setStore(
        "session_latest_assistant",
        produce((draft) => {
          draft[sessionID] = snapshot
        }),
      )
    }

    function rememberLatestAssistant(sessionID: string, messages: readonly Message[]) {
      const latest = messages.findLast((message): message is AssistantMessage => message.role === "assistant")
      if (!latest) return
      const current = store.session_latest_assistant[sessionID]
      if (current && isSessionMessageBefore(latest, current)) return
      setLatestAssistantSnapshot(sessionID, latest)
    }

    function recomputeLatestAssistant(sessionID: string) {
      const latest = store.message[sessionID]?.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      )
      if (latest) {
        setLatestAssistantSnapshot(sessionID, latest)
        return
      }
      setStore(
        "session_latest_assistant",
        produce((draft) => delete draft[sessionID]),
      )
    }

    function clearPendingPartDeltas(sessionID: string, messageID: string, partID?: string) {
      const byMessage = pendingPartDeltas.get(sessionID)
      if (!byMessage) return
      const byPart = byMessage.get(messageID)
      if (!byPart) return
      if (partID) {
        byPart.delete(partID)
        if (byPart.size > 0) return
      }
      byMessage.delete(messageID)
      if (byMessage.size > 0) return
      pendingPartDeltas.delete(sessionID)
    }

    function prunePendingPartDeltas(sessionID: string) {
      const byMessage = pendingPartDeltas.get(sessionID)
      if (!byMessage) return

      while (byMessage.size > TUI_PENDING_PART_DELTA_MESSAGE_LIMIT) {
        const oldest = byMessage.keys().next().value
        if (!oldest) break
        byMessage.delete(oldest)
      }

      for (const [messageID, byPart] of byMessage) {
        while (byPart.size > TUI_PENDING_PART_DELTA_PART_LIMIT) {
          const oldest = byPart.keys().next().value
          if (!oldest) break
          byPart.delete(oldest)
        }
        for (const [partID, fields] of byPart) {
          while (fields.size > TUI_PENDING_PART_DELTA_FIELD_LIMIT) {
            const oldest = fields.keys().next().value
            if (!oldest) break
            fields.delete(oldest)
          }
          if (fields.size === 0) byPart.delete(partID)
        }
        if (byPart.size === 0) byMessage.delete(messageID)
      }

      if (byMessage.size === 0) {
        pendingPartDeltas.delete(sessionID)
        return
      }

      while (pendingPartDeltas.size > TUI_PENDING_PART_DELTA_SESSION_LIMIT) {
        const oldest = [...pendingPartDeltas.keys()].find((id) => id !== activeSessionID)
        if (!oldest) break
        pendingPartDeltas.delete(oldest)
      }
    }

    function queuePartDelta(sessionID: string, messageID: string, partID: string, field: string, delta: string) {
      const byMessage = pendingPartDeltas.get(sessionID) ?? new Map<string, Map<string, Map<string, string>>>()
      const byPart = byMessage.get(messageID) ?? new Map<string, Map<string, string>>()
      const fields = byPart.get(partID) ?? new Map<string, string>()
      const maxChars = field === "text" ? TUI_TEXT_PREVIEW_CHARS : TUI_FIELD_PREVIEW_CHARS
      fields.set(field, previewString(`${fields.get(field) ?? ""}${delta}`, maxChars, `part ${field}`) ?? "")
      byPart.set(partID, fields)
      byMessage.set(messageID, byPart)
      pendingPartDeltas.set(sessionID, byMessage)
      prunePendingPartDeltas(sessionID)
    }

    function applyPendingPartDeltas(part: Part) {
      const fields = pendingPartDeltas.get(part.sessionID)?.get(part.messageID)?.get(part.id)
      if (!fields) return part
      clearPendingPartDeltas(part.sessionID, part.messageID, part.id)

      let next = part
      for (const [field, delta] of fields) {
        const current = next[field as keyof typeof next]
        if (typeof current !== "string" || current.endsWith(delta)) continue
        const maxChars = field === "text" ? TUI_TEXT_PREVIEW_CHARS : TUI_FIELD_PREVIEW_CHARS
        next = {
          ...next,
          [field]: previewString(`${current}${delta}`, maxChars, `part ${field}`) ?? "",
        } as Part
      }
      return next
    }

    function removeSessionParts(messages: Message[]) {
      if (!messages.length) return
      setStore(
        "part",
        produce((draft) => {
          for (const message of messages) delete draft[message.id]
        }),
      )
      setStore(
        "message_part_paging",
        produce((draft) => {
          for (const message of messages) delete draft[message.id]
        }),
      )
      for (const message of messages) clearPendingPartDeltas(message.sessionID, message.id)
    }

    // Drop only in-memory UI caches; persisted session data remains untouched.
    function evictSessionCache(sessionID: string) {
      const messages = store.message[sessionID] ?? []
      const orphanPartMessageIDs = new Set<string>()
      batch(() => {
        removeSessionParts(messages)
        setStore(
          "part",
          produce((draft) => {
            for (const [messageID, parts] of Object.entries(draft)) {
              if (!parts?.some((part) => part.sessionID === sessionID)) continue
              orphanPartMessageIDs.add(messageID)
              delete draft[messageID]
            }
          }),
        )
        setStore(
          "message_part_paging",
          produce((draft) => {
            for (const messageID of orphanPartMessageIDs) delete draft[messageID]
          }),
        )
        setStore(
          "message",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "session_latest_assistant",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "todo",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "session_diff",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "session_status",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "permission",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "question",
          produce((draft) => delete draft[sessionID]),
        )
        setStore(
          "plan_review",
          produce((draft) => delete draft[sessionID]),
        )
      })
      sessionMessagePaging.delete(sessionID)
      sessionMessageSyncGeneration.delete(sessionID)
      sessionMessageSyncQueued.delete(sessionID)
      sessionDiffHydrationRequested.delete(sessionID)
      sessionDiffHydrationInFlight.delete(sessionID)
      pinnedSessionMessages.delete(sessionID)
      removedSessionMessages.delete(sessionID)
      clearSessionStatusTimer(sessionID)
      sessionCacheSeen.delete(sessionID)
    }

    function sessionCachePreserveIDs() {
      const preserve = new Set<string>()
      if (activeSessionID) preserve.add(activeSessionID)
      for (const sessionID of sessionMessageSyncInFlight.keys()) preserve.add(sessionID)
      for (const sessionID of sessionMessageSyncQueued) preserve.add(sessionID)
      for (const sessionID of pinnedSessionMessages.keys()) preserve.add(sessionID)
      for (const [sessionID, page] of sessionMessagePaging) {
        if (page.loadingOlder || page.loadingNewer) preserve.add(sessionID)
      }
      for (const [sessionID, status] of Object.entries(store.session_status)) {
        if (status.type !== "idle") preserve.add(sessionID)
      }
      for (const [sessionID, requests] of Object.entries(store.permission)) {
        if (requests.length > 0) preserve.add(sessionID)
      }
      for (const [sessionID, requests] of Object.entries(store.question)) {
        if (requests.length > 0) preserve.add(sessionID)
      }
      for (const [sessionID, requests] of Object.entries(store.plan_review)) {
        if (requests.length > 0) preserve.add(sessionID)
      }
      return preserve
    }

    function touchSessionCache(sessionID: string, active = false) {
      if (active) activeSessionID = sessionID
      sessionCacheSeen.delete(sessionID)
      sessionCacheSeen.add(sessionID)
      if (sessionCacheSeen.size <= TUI_SESSION_CACHE_LIMIT) return
      const evicted = pickTuiSessionCacheEvictions({
        seen: sessionCacheSeen,
        preserve: sessionCachePreserveIDs(),
      })
      for (const stale of evicted) evictSessionCache(stale)
    }

    function markSessionMessageRemoved(sessionID: string, messageID: string) {
      const removed = removedSessionMessages.get(sessionID) ?? new Set<string>()
      removed.add(messageID)
      removedSessionMessages.set(sessionID, removed)
      return removed
    }

    function removeLoadedSessionMessage(sessionID: string, messageID: string) {
      const messages = store.message[sessionID]
      if (!messages) {
        clearPendingPartDeltas(sessionID, messageID)
        return
      }
      const index = messages.findIndex((message) => message.id === messageID)
      if (index < 0) {
        clearPendingPartDeltas(sessionID, messageID)
        return
      }
      batch(() => {
        setStore(
          "message",
          sessionID,
          produce((draft) => {
            draft.splice(index, 1)
          }),
        )
        setStore(
          "part",
          produce((draft) => delete draft[messageID]),
        )
        setStore(
          "message_part_paging",
          produce((draft) => delete draft[messageID]),
        )
      })
      clearPendingPartDeltas(sessionID, messageID)
      recomputeLatestAssistant(sessionID)
    }

    function applySessionMessagePage(input: {
      sessionID: string
      items: SessionMessagePageItem[]
      max?: number
      drop?: "oldest" | "newest"
      preserveCurrent?: "all" | "newer-working-assistant"
    }) {
      const current = store.message[input.sessionID]
      const removed = removedSessionMessages.get(input.sessionID)
      const items = removed ? input.items.filter((item) => !removed.has(item.info.id)) : input.items
      const incoming = items.map((item) => item.info)
      const incomingParts = new Map(
        items.map((item) => [item.info.id, mergeFetchedParts(store.part[item.info.id], item.parts)]),
      )
      const sessionIsWorking = ["busy", "retry"].includes(store.session_status[input.sessionID]?.type ?? "")
      const preserveIDs = new Set(
        input.drop === "oldest"
          ? preserveSessionTailIDs(
              sortSessionMessages([...(current ?? []), ...incoming]),
              pinnedSessionMessages.get(input.sessionID),
              (messageID) => incomingParts.get(messageID) ?? store.part[messageID],
              sessionIsWorking,
            )
          : pinnedSessionMessages.get(input.sessionID),
      )
      const compactionBoundaryID = latestCompletedCompactionSummaryID([...(current ?? []), ...incoming])
      if (compactionBoundaryID) preserveIDs.add(compactionBoundaryID)
      const merged = mergeSessionMessagePage({
        current,
        incoming,
        max: input.max,
        drop: input.drop,
        preserveCurrent: input.preserveCurrent ?? "all",
        // A sliding history window must be allowed to evict completed rows.
        // Pin only the active/tail contract above; preserving every visible
        // assistant makes the nominal 150-message cap grow without bound and
        // prevents older pages from ever entering the window.
        preserveIDs,
        excludedIDs: removed,
      })
      trace.trace("message-page-merged", {
        sessionID: input.sessionID,
        drop: input.drop,
        incoming: incoming.length,
        current: current?.length ?? 0,
        merged: merged.messages.length,
        removedIDs: merged.removed.map((message) => message.id),
        incomingIDs: incoming.map((message) => message.id),
        mergedIDs: merged.messages.map((message) => message.id),
        pinnedIDs: [...(pinnedSessionMessages.get(input.sessionID) ?? [])],
      })
      setStore("message", input.sessionID, reconcile(merged.messages))
      rememberLatestAssistant(input.sessionID, merged.messages)
      for (const item of items) {
        if (!merged.messages.some((message) => message.id === item.info.id)) continue
        setStore(
          "part",
          item.info.id,
          reconcile(mergeFetchedParts(store.part[item.info.id], item.parts.map(previewPartForStore))),
        )
        if (item.partsMore !== undefined || store.message_part_paging[item.info.id]) {
          setStore("message_part_paging", item.info.id, {
            hasMore: item.partsMore === true,
            cursor: item.partsCursor,
            loading: false,
          })
        }
      }
      removeSessionParts(merged.removed)
      return merged
    }

    function groupBySession<T extends { sessionID: string }>(items: ReadonlyArray<T>) {
      const grouped: Record<string, T[]> = {}
      for (const item of items) {
        grouped[item.sessionID] ??= []
        grouped[item.sessionID].push(item)
      }
      return grouped
    }

    function eventSessionID(event: { type: string; properties?: Record<string, unknown> }) {
      const properties = event.properties
      if (!properties) return
      if (typeof properties.sessionID === "string") return properties.sessionID
      const part = properties.part
      if (part && typeof part === "object" && typeof (part as { sessionID?: unknown }).sessionID === "string")
        return (part as { sessionID: string }).sessionID
      const info = properties.info
      if (info && typeof info === "object") {
        if (typeof (info as { sessionID?: unknown }).sessionID === "string")
          return (info as { sessionID: string }).sessionID
        if (event.type.startsWith("session.") && typeof (info as { id?: unknown }).id === "string")
          return (info as { id: string }).id
      }
    }

    async function refreshPendingInput() {
      const workspace = project.workspace.current()
      const [permissions, questions, planReviews] = await Promise.allSettled([
        sdk.client.permission.list({ workspace }),
        sdk.client.question.list({ workspace }),
        sdk.client.planReview.list({ workspace }),
      ])
      batch(() => {
        if (permissions.status === "fulfilled" && permissions.value.error === undefined)
          setStore("permission", reconcile(groupBySession(permissions.value.data ?? [])))
        if (questions.status === "fulfilled" && questions.value.error === undefined)
          setStore("question", reconcile(groupBySession(questions.value.data ?? [])))
        if (planReviews.status === "fulfilled" && planReviews.value.error === undefined)
          setStore("plan_review", reconcile(groupBySession(planReviews.value.data ?? [])))
      })
    }

    function schedulePendingInputRefresh() {
      if (pendingInputRefreshTimer) clearTimeout(pendingInputRefreshTimer)
      pendingInputRefreshTimer = setTimeout(() => {
        pendingInputRefreshTimer = undefined
        void refreshPendingInput().catch(() => undefined)
      }, 25)
    }

    function clearSessionStatusTimer(sessionID: string) {
      const timer = sessionStatusTimers.get(sessionID)
      if (!timer) return
      clearTimeout(timer)
      sessionStatusTimers.delete(sessionID)
    }

    function releaseCompletedPinnedMessages(sessionID: string) {
      const pinned = pinnedSessionMessages.get(sessionID)
      if (!pinned) return
      for (const messageID of releasablePinnedSessionMessageIDs(store.message[sessionID] ?? [], pinned))
        pinned.delete(messageID)
      if (pinned.size === 0) pinnedSessionMessages.delete(sessionID)
    }

    function scheduleSessionStatusExpiry(sessionID: string, status: SessionStatus, source: "snapshot" | "live") {
      clearSessionStatusTimer(sessionID)
      const delay = sessionStatusExpiryDelay(status, Date.now(), source)
      if (!delay) return
      sessionStatusTimers.set(
        sessionID,
        setTimeout(() => {
          sessionStatusTimers.delete(sessionID)
          const current = store.session_status[sessionID]
          if (!current || current.type !== status.type) return
          if (current.type === "busy" && status.type === "busy") {
            const currentUntil = "until" in current && typeof current.until === "number" ? current.until : undefined
            const statusUntil = "until" in status && typeof status.until === "number" ? status.until : undefined
            if (currentUntil !== statusUntil) return
          }
          if (current.type === "retry" && status.type === "retry") {
            if (current.next !== status.next) return
            if (current.heartbeatAt !== status.heartbeatAt) return
          }
          setStore("session_status", sessionID, { type: "idle" })
        }, delay),
      )
    }

    function setSessionStatus(sessionID: string, status: SessionStatus) {
      setStore("session_status", sessionID, status)
      if (status.type === "idle") {
        clearSessionStatusTimer(sessionID)
        releaseCompletedPinnedMessages(sessionID)
      } else scheduleSessionStatusExpiry(sessionID, status, "live")
    }

    function replaceSessionStatuses(statuses: Record<string, SessionStatus>) {
      for (const sessionID of sessionStatusTimers.keys()) {
        if (!(sessionID in statuses)) clearSessionStatusTimer(sessionID)
      }
      setStore("session_status", reconcile(statuses))
      for (const [sessionID, status] of Object.entries(statuses)) {
        if (status.type === "idle") releaseCompletedPinnedMessages(sessionID)
        else scheduleSessionStatusExpiry(sessionID, status, "snapshot")
      }
    }

    onCleanup(() => {
      if (pendingInputRefreshTimer) clearTimeout(pendingInputRefreshTimer)
      for (const timer of sessionStatusTimers.values()) clearTimeout(timer)
      sessionStatusTimers.clear()
      unsubscribeEvent()
      sessionCacheSeen.clear()
      sessionMessagePaging.clear()
      sessionMessageSyncGeneration.clear()
      sessionMessageSyncQueued.clear()
      sessionDiffHydrationRequested.clear()
      sessionDiffHydrationInFlight.clear()
      pendingPartDeltas.clear()
      fullMessageRequests.clear()
      pinnedSessionMessages.clear()
      removedSessionMessages.clear()
      activeSessionID = undefined
    })

    const unsubscribeEvent = event.subscribe((event) => {
      const eventProperties = (event as { properties?: Record<string, unknown> }).properties
      trace.trace("event", {
        id: typeof (event as { id?: unknown }).id === "string" ? (event as { id: string }).id : undefined,
        type: event.type,
        sessionID: typeof eventProperties?.sessionID === "string" ? eventProperties.sessionID : undefined,
        messageID: typeof eventProperties?.messageID === "string" ? eventProperties.messageID : undefined,
        partID: typeof eventProperties?.partID === "string" ? eventProperties.partID : undefined,
        propertyKeys: eventProperties ? Object.keys(eventProperties) : [],
      })
      const sessionID = eventSessionID({ type: event.type, properties: eventProperties })
      if (sessionID) touchSessionCache(sessionID)
      const shellOutputEvent = event as typeof event | ShellOutputEvent
      if (shellOutputEvent.type === "session.next.shell.output") {
        const messages = store.message[shellOutputEvent.properties.sessionID] ?? []
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
          const message = messages[messageIndex]
          const parts = store.part[message.id]
          if (!parts) continue
          const partIndex = parts.findIndex(
            (part) => part.type === "tool" && part.callID === shellOutputEvent.properties.callID,
          )
          if (partIndex < 0) continue
          setStore(
            "part",
            message.id,
            partIndex,
            produce((part) => {
              if (part.type !== "tool" || part.state.status !== "running") return
              part.state.metadata = {
                ...(part.state.metadata ?? {}),
                output: appendLiveShellOutput(part.state.metadata?.output, shellOutputEvent.properties.delta),
              }
            }),
          )
          break
        }
        return
      }

      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap({ fatal: false })
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "plan_review.replied": {
          const requests = store.plan_review[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "plan_review",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "plan_review.asked": {
          const request = event.properties
          const requests = store.plan_review[request.sessionID]
          if (!requests) {
            setStore("plan_review", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("plan_review", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "plan_review",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          sessionDiffHydrationRequested.add(event.properties.sessionID)
          sessionDiffHydrationInFlight.delete(event.properties.sessionID)
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const sessionID = event.properties.info.id
          const result = Binary.search(store.session, sessionID, (s) => s.id)
          const removedMessages = store.message[sessionID] ?? []
          batch(() => {
            if (result.found) {
              setStore(
                "session",
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
            }
            setStore(
              "message",
              produce((draft) => delete draft[sessionID]),
            )
            setStore(
              "session_latest_assistant",
              produce((draft) => delete draft[sessionID]),
            )
            setStore(
              "todo",
              produce((draft) => delete draft[sessionID]),
            )
            setStore(
              "session_diff",
              produce((draft) => delete draft[sessionID]),
            )
            setStore(
              "session_status",
              produce((draft) => delete draft[sessionID]),
            )
            removeSessionParts(removedMessages)
          })
          sessionCacheSeen.delete(sessionID)
          pendingPartDeltas.delete(sessionID)
          if (activeSessionID === sessionID) activeSessionID = undefined
          sessionMessagePaging.delete(sessionID)
          sessionMessageSyncQueued.delete(sessionID)
          sessionDiffHydrationRequested.delete(sessionID)
          sessionDiffHydrationInFlight.delete(sessionID)
          pinnedSessionMessages.delete(sessionID)
          removedSessionMessages.delete(sessionID)
          clearSessionStatusTimer(sessionID)
          break
        }
        case "session.created":
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          trace.trace("event-session-status", {
            sessionID: event.properties.sessionID,
            status: event.properties.status,
            loadedIDs: (store.message[event.properties.sessionID] ?? []).map((message) => message.id),
          })
          setSessionStatus(event.properties.sessionID, event.properties.status)
          break
        }

        case "session.compacted":
        case "session.next.compaction.ended": {
          const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
          if (sessionID) void result.session.sync(sessionID, { force: true }).catch(() => undefined)
          break
        }

        case "message.updated": {
          trace.trace("event-message-updated", {
            sessionID: event.properties.info.sessionID,
            messageID: event.properties.info.id,
            role: event.properties.info.role,
            parentID: "parentID" in event.properties.info ? event.properties.info.parentID : undefined,
            completed: "completed" in event.properties.info.time ? event.properties.info.time.completed : undefined,
            finish: event.properties.info.role === "assistant" ? event.properties.info.finish : undefined,
            loadedIDs: (store.message[event.properties.info.sessionID] ?? []).map((message) => message.id),
          })
          const sessionID = event.properties.info.sessionID
          if (removedSessionMessages.get(sessionID)?.has(event.properties.info.id)) break
          const messages = store.message[sessionID]
          if (!messages) {
            setStore("message", sessionID, [event.properties.info])
            rememberLatestAssistant(sessionID, [event.properties.info])
            break
          }
          const paging = sessionMessagePaging.get(sessionID)
          const newestLoaded = messages.at(-1)
          if (paging?.hasMoreNewer && newestLoaded && isSessionMessageAfter(event.properties.info, newestLoaded)) {
            rememberLatestAssistant(sessionID, [event.properties.info])
            break
          }

          const updated = normalizeSessionMessages([...messages, event.properties.info])
          const overflowed = updated.length > TUI_SESSION_MESSAGE_STORE_LIMIT
          const keepLoadedHistory = paging?.keepLoadedHistory === true
          const preserveIDs = preserveSessionTailIDs(
            updated,
            pinnedSessionMessages.get(event.properties.info.sessionID),
            (messageID) => store.part[messageID],
            ["busy", "retry"].includes(store.session_status[event.properties.info.sessionID]?.type ?? ""),
          )
          const rememberedAssistantID = store.session_latest_assistant[sessionID]?.id
          if (rememberedAssistantID) preserveIDs.add(rememberedAssistantID)
          const trimmed = keepLoadedHistory
            ? { messages: updated, removed: [] as Message[] }
            : trimLoadedSessionMessages({
                messages: updated,
                max: TUI_SESSION_MESSAGE_STORE_LIMIT,
                drop: "oldest",
                preserveIDs,
              })
          batch(() => {
            setStore("message", event.properties.info.sessionID, reconcile(trimmed.messages, { key: "id" }))
            if (trimmed.removed.length > 0) removeSessionParts(trimmed.removed)
          })
          rememberLatestAssistant(event.properties.info.sessionID, [event.properties.info])
          const first = store.message[event.properties.info.sessionID]?.[0]
          if (paging && first) {
            sessionMessagePaging.set(event.properties.info.sessionID, {
              ...paging,
              olderCursor: paging.hasMoreOlder ? paging.olderCursor : messageCursor(first),
              hasMoreOlder: paging.hasMoreOlder || (!keepLoadedHistory && overflowed),
              newerCursor: undefined,
              hasMoreNewer: false,
              keepLoadedHistory,
            })
          }
          break
        }
        case "message.removed": {
          const sessionID = event.properties.sessionID
          const messageID = event.properties.messageID
          const isRevertRemoval = "reason" in event.properties && event.properties.reason === "revert"
          if (isRevertRemoval) {
            markSessionMessageRemoved(sessionID, messageID)
            const pinned = pinnedSessionMessages.get(sessionID)
            pinned?.delete(messageID)
            if (pinned?.size === 0) pinnedSessionMessages.delete(sessionID)
          }
          if (!isRevertRemoval && pinnedSessionMessages.get(sessionID)?.has(messageID)) break
          removeLoadedSessionMessage(sessionID, messageID)
          break
        }
        case "message.part.updated": {
          trace.trace("event-message-part-updated", {
            sessionID: event.properties.part.sessionID,
            messageID: event.properties.part.messageID,
            partID: event.properties.part.id,
            type: event.properties.part.type,
          })
          if (removedSessionMessages.get(event.properties.part.sessionID)?.has(event.properties.part.messageID)) break
          const loadedMessage = (store.message[event.properties.part.sessionID] ?? []).some(
            (message) => message.id === event.properties.part.messageID,
          )
          if (!loadedMessage && !store.part[event.properties.part.messageID]) {
            clearPendingPartDeltas(event.properties.part.sessionID, event.properties.part.messageID)
            break
          }
          const incomingPart = previewPartForStore(applyPendingPartDeltas(event.properties.part))
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [incomingPart])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            const next = previewPartForStore(preserveLivePart(parts[result.index], incomingPart))
            setStore("part", event.properties.part.messageID, result.index, reconcile(next))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            reconcile(trimStoredParts([...parts.slice(0, result.index), incomingPart, ...parts.slice(result.index)])),
          )
          break
        }

        case "message.part.delta": {
          if (removedSessionMessages.get(event.properties.sessionID)?.has(event.properties.messageID)) break
          const loadedMessage = (store.message[event.properties.sessionID] ?? []).some(
            (message) => message.id === event.properties.messageID,
          )
          if (!loadedMessage && !store.part[event.properties.messageID]) {
            clearPendingPartDeltas(event.properties.sessionID, event.properties.messageID)
            break
          }
          const parts = store.part[event.properties.messageID]
          if (!parts) {
            queuePartDelta(
              event.properties.sessionID,
              event.properties.messageID,
              event.properties.partID,
              event.properties.field,
              event.properties.delta,
            )
            break
          }
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) {
            queuePartDelta(
              event.properties.sessionID,
              event.properties.messageID,
              event.properties.partID,
              event.properties.field,
              event.properties.delta,
            )
            break
          }
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const fieldName = event.properties.field
              const field = fieldName as keyof typeof part
              const existing = part[field] as string | undefined
              const maxChars = fieldName === "text" ? TUI_TEXT_PREVIEW_CHARS : TUI_FIELD_PREVIEW_CHARS
              ;(part[field] as string) =
                previewString((existing ?? "") + event.properties.delta, maxChars, String(field)) ?? ""
            }),
          )
          break
        }

        case "message.part.removed": {
          if (removedSessionMessages.get(event.properties.sessionID)?.has(event.properties.messageID)) break
          clearPendingPartDeltas(event.properties.sessionID, event.properties.messageID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const generation = ++bootstrapGeneration
      setReconciledAt(undefined)
      const controlsDelivered = await sessionControl.drain()
      if (!controlsDelivered) {
        Log.Default.warn("tui session control outbox remains pending", {
          pending: sessionControl.entries().length,
        })
      }
      trace.trace("bootstrap-start", {
        generation,
        workspace,
        fatal,
        fastBoot: tuiFastBootEnabled(),
        continueSession: Boolean(args.continue),
      })
      const isCurrentBootstrap = () =>
        isCurrentTuiBootstrap({
          generation,
          currentGeneration: bootstrapGeneration,
          workspace,
          currentWorkspace: project.workspace.current(),
        })
      const setIfCurrent = (apply: () => void) => {
        if (!isCurrentBootstrap()) return
        apply()
      }
      if (workspace !== syncedWorkspace) {
        sessionMessageSyncGeneration.forEach((generation, sessionID) =>
          sessionMessageSyncGeneration.set(sessionID, generation + 1),
        )
        for (const sessionID of [...sessionCacheSeen]) evictSessionCache(sessionID)
        sessionCacheSeen.clear()
        activeSessionID = undefined
        sessionMessagePaging.clear()
        sessionMessageSyncQueued.clear()
        pinnedSessionMessages.clear()
        syncedWorkspace = workspace
        setStore("provider_metadata_ready", false)
      }
      const readiness = syncBootstrapReadiness({
        fastBoot: tuiFastBootEnabled(),
        continueSession: Boolean(args.continue),
      })
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())
      void sessionListPromise.catch(() => undefined)
      const promptMetadataPromise = Promise.all([
        sdk.client.config.providers({ workspace }, { throwOnError: true }).then((x) => x.data!),
        sdk.client.app.agents({ workspace }, { throwOnError: true }).then((x) => x.data ?? []),
        sdk.client.config.get({ workspace }, { throwOnError: true }).then((x) => x.data!),
      ])
      void promptMetadataPromise.catch(() => undefined)
      const providerUxMetadataPromise = Promise.all([
        sdk.client.provider.list({ workspace }, { throwOnError: true }).then((x) => x.data!),
        sdk.client.experimental.console
          .get({ workspace }, { throwOnError: true })
          .then((x) => x.data)
          .catch(() => emptyConsoleState),
      ])
      void providerUxMetadataPromise.catch(() => undefined)
      const hydrateProviderMetadata = async () => {
        const [providers, agents, config] = await promptMetadataPromise

        setIfCurrent(() => {
          batch(() => {
            setStore("provider", reconcile(providers.providers))
            setStore("provider_default", reconcile(providers.default))
            setStore("agent", reconcile(agents))
            setStore("config", reconcile(config))
            setStore("provider_metadata_ready", true)
          })
        })
      }
      const hydrateProviderUxMetadata = async () => {
        const [providerList, consoleState] = await providerUxMetadataPromise

        setIfCurrent(() => {
          batch(() => {
            setStore("provider_next", reconcile(providerList))
            setStore("console_state", reconcile(consoleState))
          })
        })
      }
      const hydrateSessionList = async () => {
        const sessions = await sessionListPromise
        setIfCurrent(() => setStore("session", reconcile(sessions)))
      }
      const reportBootstrapError = async (e: unknown) => {
        Log.Default.error("tui bootstrap failed", {
          error: e instanceof Error ? e.message : String(e),
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
        })
        if (fatal) await exit(e)
      }
      const blockingRequests: Promise<unknown>[] = [
        projectPromise,
        ...(readiness.blockProviderMetadata ? [hydrateProviderMetadata()] : []),
        ...(readiness.blockProviderUxMetadata ? [hydrateProviderUxMetadata()] : []),
        ...(readiness.blockSessionList ? [hydrateSessionList()] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          if (!isCurrentBootstrap()) return
          if (store.status !== "complete") setStore("status", "partial")
          return Promise.all([
            ...(readiness.blockProviderMetadata ? [] : [hydrateProviderMetadata()]),
            ...(readiness.blockProviderUxMetadata ? [] : [hydrateProviderUxMetadata()]),
            ...(readiness.blockSessionList ? [] : [hydrateSessionList()]),
            sdk.client.command
              .list({ workspace })
              .then((x) => setIfCurrent(() => setStore("command", reconcile(x.data ?? [])))),
            sdk.client.lsp
              .status({ workspace })
              .then((x) => setIfCurrent(() => setStore("lsp", reconcile(x.data ?? [])))),
            sdk.client.mcp
              .status({ workspace })
              .then((x) => setIfCurrent(() => setStore("mcp", reconcile(x.data ?? {})))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setIfCurrent(() => setStore("mcp_resource", reconcile(x.data ?? {})))),
            sdk.client.formatter
              .status({ workspace })
              .then((x) => setIfCurrent(() => setStore("formatter", reconcile(x.data ?? [])))),
            sdk.client.session.status({ workspace }).then((x) => {
              setIfCurrent(() => replaceSessionStatuses(x.data ?? {}))
            }),
            sdk.client.provider
              .auth({ workspace })
              .then((x) => setIfCurrent(() => setStore("provider_auth", reconcile(x.data ?? {})))),
            sdk.client.vcs.get({ workspace }).then((x) => setIfCurrent(() => setStore("vcs", reconcile(x.data)))),
            refreshPendingInput(),
            project.workspace.sync(),
          ])
            .then(() => {
              if (!isCurrentBootstrap()) return
              const completedAt = Date.now()
              setStore("status", "complete")
              setReconciledAt(completedAt)
              // The SDK keeps recovery visible until either a heartbeat or a
              // full snapshot proves that missed events have been reconciled.
              // A completed bootstrap is that proof and must clear the marker
              // immediately instead of leaving a healthy turn labelled sync.
              sdk.reconnect.confirm(completedAt)
              trace.trace("bootstrap-complete", {
                generation,
                workspace,
                sessionCount: store.session.length,
                status: store.status,
              })
            })
            .catch((e) => {
              void reportBootstrapError(e)
            })
        })
        .catch(async (e) => {
          await reportBootstrapError(e)
          if (fatal) throw e
        })
    }

    onMount(() => {
      void bootstrap({ fatal: false })
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return syncReadyForStatus(store.status)
      },
      get providerMetadataReady() {
        return store.provider_metadata_ready
      },
      get reconciledAt() {
        return reconciledAt()
      },
      get path() {
        return project.instance.path()
      },
      session: {
        pinMessage(sessionID: string, messageID: string) {
          const pinned = pinnedSessionMessages.get(sessionID) ?? new Set<string>()
          pinned.add(messageID)
          pinnedSessionMessages.set(sessionID, pinned)
        },
        unpinMessage(sessionID: string, messageID: string) {
          const pinned = pinnedSessionMessages.get(sessionID)
          if (!pinned) return
          pinned.delete(messageID)
          if (pinned.size === 0) pinnedSessionMessages.delete(sessionID)
        },
        removeMessage(sessionID: string, messageID: string) {
          markSessionMessageRemoved(sessionID, messageID)
          removeLoadedSessionMessage(sessionID, messageID)
        },
        async restoreMessage(sessionID: string, messageID: string) {
          const removed = removedSessionMessages.get(sessionID)
          if (!removed?.delete(messageID)) return
          if (removed.size === 0) removedSessionMessages.delete(sessionID)
          sessionMessagePaging.delete(sessionID)
          await result.session.sync(sessionID, { force: true })
        },
        async reloadMessages(sessionID: string) {
          touchSessionCache(sessionID, true)
          sessionMessagePaging.delete(sessionID)
          await result.session.sync(sessionID, { force: true }).catch((error: unknown) => {
            sessionMessagePaging.delete(sessionID)
            throw error
          })
        },
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          if (last.time.completed) return "idle"
          return isRecentWorkingAssistant({
            assistantCreated: last.time.created,
            sessionUpdated: session.time.updated,
          })
            ? "working"
            : "idle"
        },
        history(sessionID: string) {
          const page = sessionMessagePaging.get(sessionID)
          return {
            hasMoreOlder: page?.hasMoreOlder ?? false,
            hasMoreNewer: page?.hasMoreNewer ?? false,
            loadingOlder: Boolean(page?.loadingOlder),
            loadingNewer: Boolean(page?.loadingNewer),
            loaded: store.message[sessionID]?.length ?? 0,
          }
        },
        async loadMoreMessageParts(sessionID: string, messageID: string) {
          touchSessionCache(sessionID, true)
          const paging = store.message_part_paging[messageID]
          if (!paging?.hasMore || !paging.cursor) return false
          if (paging.loading) return false
          setStore("message_part_paging", messageID, "loading", true)
          try {
            const item = await fetchSessionMessageParts({ sessionID, messageID, after: paging.cursor })
            if (item.info.sessionID !== sessionID || item.info.id !== messageID) {
              setStore("message_part_paging", messageID, "loading", false)
              return false
            }
            batch(() => {
              setStore(
                "message",
                sessionID,
                produce((draft) => {
                  const index = draft.findIndex((message) => message.id === messageID)
                  if (index >= 0) draft[index] = mergeMessageInfo(draft[index], item.info)
                }),
              )
              setStore(
                "part",
                messageID,
                reconcile(mergeFetchedParts(store.part[messageID], item.parts.map(previewPartForStore))),
              )
              setStore("message_part_paging", messageID, {
                hasMore: item.partsMore === true,
                cursor: item.partsCursor,
                loading: false,
              })
            })
            return item.parts.length > 0
          } catch (error) {
            setStore("message_part_paging", messageID, "loading", false)
            throw error
          }
        },
        loadFullToolPart,
        async loadOlder(sessionID: string) {
          touchSessionCache(sessionID, true)
          const page = sessionMessagePaging.get(sessionID)
          if (!page?.hasMoreOlder || !page.olderCursor) return false
          if (page.loadingOlder) return page.loadingOlder
          const generation = sessionMessageSyncGeneration.get(sessionID) ?? 0
          const load = (async () => {
            const messages = await fetchSessionMessagePage({
              sessionID,
              limit: TUI_SESSION_MESSAGE_SYNC_LIMIT,
              before: page.olderCursor,
            })
            if (!isCurrentSessionMessageSync(sessionID, generation)) return false
            batch(() => {
              const merged = applySessionMessagePage({ sessionID, items: messages.items })
              const advancedOlderCursor = Boolean(messages.cursor && messages.cursor !== page.olderCursor)
              const newest = merged.messages.at(-1)
              sessionMessagePaging.set(sessionID, {
                olderCursor: messages.cursor,
                hasMoreOlder: messages.items.length > 0 && advancedOlderCursor,
                newerCursor: newest ? messageCursor(newest) : page.newerCursor,
                hasMoreNewer:
                  page.hasMoreNewer ||
                  merged.removed.some((message) => newest && isSessionMessageAfter(message, newest)),
                keepLoadedHistory: true,
                loadingOlder: page.loadingOlder,
                loadingNewer: page.loadingNewer,
              })
            })
            return messages.items.length > 0
          })().finally(() => {
            const latest = sessionMessagePaging.get(sessionID)
            if (latest?.loadingOlder === load)
              sessionMessagePaging.set(sessionID, { ...latest, loadingOlder: undefined })
          })
          sessionMessagePaging.set(sessionID, { ...page, loadingOlder: load })
          return load
        },
        async loadNewer(sessionID: string) {
          touchSessionCache(sessionID, true)
          const page = sessionMessagePaging.get(sessionID)
          if (!page?.hasMoreNewer) return false
          if (page.loadingNewer) return page.loadingNewer
          const current = store.message[sessionID] ?? []
          const newest = current.at(-1)
          const after = page.newerCursor ?? (newest ? messageCursor(newest) : undefined)
          if (!after) return false
          const generation = sessionMessageSyncGeneration.get(sessionID) ?? 0
          const load = (async () => {
            const messages = await fetchSessionMessagePage({
              sessionID,
              limit: TUI_SESSION_MESSAGE_SYNC_LIMIT,
              after,
            })
            if (!isCurrentSessionMessageSync(sessionID, generation)) return false
            batch(() => {
              const merged = applySessionMessagePage({ sessionID, items: messages.items })
              const oldest = merged.messages[0]
              const latest = merged.messages.at(-1)
              const advancedNewerCursor = Boolean(messages.cursor && messages.cursor !== after)
              sessionMessagePaging.set(sessionID, {
                olderCursor: oldest ? messageCursor(oldest) : page.olderCursor,
                hasMoreOlder:
                  page.hasMoreOlder ||
                  merged.removed.some((message) => oldest && isSessionMessageBefore(message, oldest)),

                newerCursor: latest ? messageCursor(latest) : messages.cursor,
                hasMoreNewer: messages.items.length > 0 && advancedNewerCursor,
                keepLoadedHistory: true,
                loadingOlder: page.loadingOlder,
                loadingNewer: page.loadingNewer,
              })
            })
            return messages.items.length > 0
          })().finally(() => {
            const latest = sessionMessagePaging.get(sessionID)
            if (latest?.loadingNewer === load)
              sessionMessagePaging.set(sessionID, { ...latest, loadingNewer: undefined })
          })
          sessionMessagePaging.set(sessionID, { ...page, loadingNewer: load })
          return load
        },
        async sync(sessionID: string, options?: { force?: boolean }): Promise<void> {
          const force = options?.force ?? false
          touchSessionCache(sessionID, !force)
          trace.trace("sync-start", {
            sessionID,
            force,
            loadedIDs: (store.message[sessionID] ?? []).map((message) => message.id),
            paging: sessionMessagePaging.get(sessionID),
          })
          if (!force && sessionMessagePaging.has(sessionID)) return

          const active = sessionMessageSyncInFlight.get(sessionID)
          if (active) {
            if (!force) return active
            sessionMessageSyncQueued.add(sessionID)
            await active
            if (!sessionMessageSyncQueued.delete(sessionID)) return
            return result.session.sync(sessionID, { force: true })
          }

          const run = (async () => {
            const generation = beginSessionMessageSync(sessionID)
            const workspace = project.workspace.current()
            const [session, messages, todo, statuses] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              fetchSessionMessageWindow(sessionID),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.status({ workspace }),
            ])
            if (!isCurrentSessionMessageSync(sessionID, generation)) return
            const currentPaging = sessionMessagePaging.get(sessionID)
            const keepLoadedHistory = currentPaging?.keepLoadedHistory === true
            batch(() => {
              setStore(
                "session",
                produce((draft) => {
                  const match = Binary.search(draft, sessionID, (s) => s.id)
                  if (match.found) draft[match.index] = session.data!
                  if (!match.found) draft.splice(match.index, 0, session.data!)
                }),
              )
              setStore("todo", sessionID, reconcile(todo.data ?? []))
              applySessionMessagePage({
                sessionID,
                items: messages.items,
                max: keepLoadedHistory ? undefined : TUI_SESSION_MESSAGE_STORE_LIMIT,
                drop: "oldest",
                preserveCurrent: "newer-working-assistant",
              })
              sessionMessagePaging.set(sessionID, {
                olderCursor: messages.cursor,
                hasMoreOlder: Boolean(messages.cursor),
                newerCursor: undefined,
                hasMoreNewer: false,
                keepLoadedHistory,
              })
              replaceSessionStatuses(statuses.data ?? {})
            })
            const status = statuses.data?.[sessionID]
            if (!status || status.type === "idle") hydrateSessionDiff(sessionID)
            trace.trace("sync-end", {
              sessionID,
              loadedIDs: (store.message[sessionID] ?? []).map((message) => message.id),
              status: store.session_status[sessionID],
              paging: sessionMessagePaging.get(sessionID),
            })
          })()
          sessionMessageSyncInFlight.set(sessionID, run)
          try {
            await run
          } finally {
            if (sessionMessageSyncInFlight.get(sessionID) === run) sessionMessageSyncInFlight.delete(sessionID)
          }
        },
      },
      bootstrap,
    }

    let consumedRecoveryAt: number | undefined
    const unsubscribeConnection = sdk.event.on("event", (event) => {
      const recoveredHeartbeat =
        event.payload.type === "server.heartbeat" &&
        sdk.connection.recoveredAt !== undefined &&
        sdk.connection.recoveredAt !== consumedRecoveryAt
      if (event.payload.type !== "server.connected" && !recoveredHeartbeat) return
      if (recoveredHeartbeat) consumedRecoveryAt = sdk.connection.recoveredAt
      // A transport can reconnect without a reliable connection-state edge
      // (for example a worker-backed event source after system sleep). Once
      // the initial bootstrap completed, every connected handshake is safe to
      // use as a reconciliation point for missed prompts and session events.
      if (!sdk.connection.recoveringSince && store.status !== "complete") return
      const sessionID = activeSessionID
      void bootstrap({ fatal: false })
        .then(() => (sessionID ? result.session.sync(sessionID, { force: true }) : undefined))
        .catch((error) => {
          Log.Default.warn("tui recovery refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
    })
    onCleanup(unsubscribeConnection)
    return result
  },
})
