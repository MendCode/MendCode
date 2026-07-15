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
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@mendcode/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import * as Log from "@mendcode/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"
import { isRecentWorkingAssistant, sessionStatusExpiryDelay } from "../util/session-working"
import { appendLiveShellOutput, previewShellOutput } from "./shell-output"
import {
  isCurrentTuiBootstrap,
  syncBootstrapReadiness,
  syncReadyForStatus,
  tuiFastBootEnabled,
} from "../util/fast-boot"

type ShellOutputEvent = {
  type: "session.next.shell.output"
  properties: {
    sessionID: string
    callID: string
    delta: string
  }
}

export const TUI_SESSION_MESSAGE_SYNC_LIMIT = 50
export const TUI_SESSION_MESSAGE_STORE_LIMIT = 150
export const COMPACTED_TOOL_CALLS_KV_KEY = "compacted_tool_calls_visible"
const TUI_TEXT_PREVIEW_CHARS = 128 * 1024
const TUI_TOOL_OUTPUT_PREVIEW_CHARS = 16 * 1024
const TUI_METADATA_PREVIEW_CHARS = 4 * 1024
const TUI_FIELD_PREVIEW_CHARS = 2 * 1024
const trace = Log.create({ service: "tui.sync" })

function previewString(input: string | undefined, maxChars: number, label: string) {
  if (!input || input.length <= maxChars) return input
  const marker = `\n[${label} preview truncated: omitted ${input.length - maxChars} chars; showing start and latest tail.]\n`
  const budget = Math.max(0, maxChars - marker.length)
  if (budget <= 0) return input.slice(-maxChars)
  const head = Math.floor(budget / 3)
  const tail = budget - head
  return `${input.slice(0, head)}${marker}${input.slice(input.length - tail)}`
}

function previewUnknown(input: unknown, maxChars: number, label: string, depth = 0): unknown {
  if (typeof input === "string") return previewString(input, maxChars, label)
  if (!input || typeof input !== "object") return input
  if (depth >= 4) return input
  if (Array.isArray(input)) return input.map((item) => previewUnknown(item, maxChars, label, depth + 1))

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const nextMax =
      key === "output" || key === "diff" || key === "content" ? maxChars : Math.min(maxChars, TUI_FIELD_PREVIEW_CHARS)
    result[key] = previewUnknown(value, nextMax, `${label}.${key}`, depth + 1)
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

  const currentText = current.text
  const incomingText = incoming.text
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

function preserveLivePart(current: Part, incoming: Part) {
  return preserveRunningShellOutput(current, preserveAppendOnlyPartText(current, incoming))
}

function mergeFetchedParts(current: Part[] | undefined, incoming: Part[]) {
  if (!current?.length) return incoming

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

  return merged.toSorted((a, b) => a.id.localeCompare(b.id))
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
}

function trimLoadedSessionMessages(input: {
  messages: Message[]
  max: number
  drop: "oldest" | "newest"
  preserveIDs?: ReadonlySet<string>
}) {
  if (input.messages.length <= input.max) return { messages: input.messages, removed: [] as Message[] }
  const removeCount = input.messages.length - input.max
  const candidates = input.drop === "oldest" ? input.messages : input.messages.toReversed()
  const removedIDs = new Set(
    candidates
      .filter((message) => !input.preserveIDs?.has(message.id))
      .slice(0, removeCount)
      .map((message) => message.id),
  )
  return {
    messages: input.messages.filter((message) => !removedIDs.has(message.id)),
    removed: input.messages.filter((message) => removedIDs.has(message.id)),
  }
}

function visibleUserParts(parts: readonly Part[] | undefined) {
  if (!parts) return
  return parts.some(
    (part) => (part.type === "text" && !part.synthetic && part.text.trim().length > 0) || part.type === "file",
  )
}

function visibleAssistantParts(parts: readonly Part[] | undefined) {
  if (!parts) return false
  return parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim().length > 0)
}

function preserveSessionTailIDs(
  messages: readonly Message[],
  pinned?: ReadonlySet<string>,
  parts?: (messageID: string) => readonly Part[] | undefined,
) {
  const result = new Set(pinned)
  const users = messages.filter((message) => message.role === "user")
  const latestUser =
    users.findLast((message) => visibleUserParts(parts?.(message.id)) === true) ??
    users.findLast((message) => visibleUserParts(parts?.(message.id)) === undefined)
  if (latestUser) result.add(latestUser.id)
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
  max: number
  drop: "oldest" | "newest"
  preserveCurrent?: "all" | "newer-working-assistant"
  preserveIDs?: ReadonlySet<string>
}) {
  const byID = new Map<string, Message>()
  const currentByID = new Map((input.current ?? []).map((message) => [message.id, message]))
  const oldestIncomingID = input.incoming[0]?.id
  const newestIncomingID = input.incoming.at(-1)?.id
  const preserveAllCurrent = input.preserveCurrent === "all" || input.incoming.length === 0
  for (const message of input.current ?? []) {
    if (input.preserveIDs?.has(message.id)) {
      byID.set(message.id, message)
      continue
    }
    if (!preserveAllCurrent && input.preserveCurrent === "newer-working-assistant") {
      if (message.role === "user") {
        byID.set(message.id, message)
        continue
      }
      if (oldestIncomingID && message.id < oldestIncomingID) {
        byID.set(message.id, message)
        continue
      }
      if (!newestIncomingID || message.id <= newestIncomingID) continue
      if (message.role !== "assistant" || message.time.completed) continue
    }
    byID.set(message.id, message)
  }
  for (const message of input.incoming) byID.set(message.id, mergeMessageInfo(currentByID.get(message.id), message))
  const trimmed = trimLoadedSessionMessages({
    messages: [...byID.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    max: input.max,
    drop: input.drop,
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
    const [showCompactedToolCalls] = kv.signal(COMPACTED_TOOL_CALLS_KV_KEY, false)

    const sessionMessagePaging = new Map<
      string,
      {
        olderCursor?: string
        hasMoreOlder: boolean
        newerCursor?: string
        hasMoreNewer: boolean
        loadingOlder?: Promise<boolean>
        loadingNewer?: Promise<boolean>
      }
    >()
    const sessionMessageSyncGeneration = new Map<string, number>()
    const pinnedSessionMessages = new Map<string, Set<string>>()
    const sessionStatusTimers = new Map<string, Timer>()
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
        () => sdk.client.session.list({ start: recentStart, ...query }).then((x) => x.data ?? []),
        () => sdk.client.session.list(query).then((x) => x.data ?? []),
      ]

      if (query.path || query.scope !== "project") {
        attempts.push(
          () => sdk.client.session.list({ start: recentStart, scope: "project" }).then((x) => x.data ?? []),
          () => sdk.client.session.list({ scope: "project" }).then((x) => x.data ?? []),
        )
      }

      attempts.push(
        () => sdk.client.experimental.session.list({ start: recentStart, limit: 100 }).then((x) => x.data ?? []),
        () => sdk.client.experimental.session.list({ limit: 100 }).then((x) => x.data ?? []),
      )

      for (const attempt of attempts) {
        try {
          const sessions = await attempt()
          if (sessions.length > 0) return sort(sessions)
        } catch {
          // Try the next scope; Home should not look empty just because one listing path failed.
        }
      }

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
      url.searchParams.set("view", showCompactedToolCalls() ? "tui-all" : "tui")
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

    function rememberLatestAssistant(sessionID: string, messages: readonly Message[]) {
      const latest = messages.findLast((message): message is AssistantMessage => message.role === "assistant")
      if (!latest) return
      const current = store.session_latest_assistant[sessionID]
      if (!current || latest.id >= current.id) setStore("session_latest_assistant", sessionID, reconcile(latest))
    }

    function recomputeLatestAssistant(sessionID: string) {
      const latest = store.message[sessionID]?.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      )
      if (latest) {
        setStore("session_latest_assistant", sessionID, reconcile(latest))
        return
      }
      setStore(
        "session_latest_assistant",
        produce((draft) => delete draft[sessionID]),
      )
    }

    function removeSessionParts(messages: Message[]) {
      if (!messages.length) return
      setStore(
        "part",
        produce((draft) => {
          for (const message of messages) delete draft[message.id]
        }),
      )
    }

    function applySessionMessagePage(input: {
      sessionID: string
      items: SessionMessagePageItem[]
      drop: "oldest" | "newest"
      preserveCurrent?: "all" | "newer-working-assistant"
    }) {
      const current = store.message[input.sessionID]
      const incoming = input.items.map((item) => item.info)
      const incomingParts = new Map(
        input.items.map((item) => [item.info.id, mergeFetchedParts(store.part[item.info.id], item.parts)]),
      )
      const preserveIDs =
        input.drop === "oldest"
          ? preserveSessionTailIDs(
              [...(current ?? []), ...incoming].toSorted((a, b) => a.id.localeCompare(b.id)),
              pinnedSessionMessages.get(input.sessionID),
              (messageID) => incomingParts.get(messageID) ?? store.part[messageID],
            )
          : pinnedSessionMessages.get(input.sessionID)
      const preserveVisibleAssistantIDs = new Set(preserveIDs)
      const currentUserIDs = new Set((current ?? []).filter((message) => message.role === "user").map((message) => message.id))
      for (const message of current ?? []) {
        if (message.role !== "assistant") continue
        if (!message.parentID || !currentUserIDs.has(message.parentID)) continue
        if (!visibleAssistantParts(incomingParts.get(message.id) ?? store.part[message.id])) continue
        preserveVisibleAssistantIDs.add(message.id)
      }
      const merged = mergeSessionMessagePage({
        current,
        incoming,
        max: TUI_SESSION_MESSAGE_STORE_LIMIT,
        drop: input.drop,
        preserveCurrent: input.preserveCurrent ?? "all",
        preserveIDs: preserveVisibleAssistantIDs,
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
      for (const item of input.items) {
        if (!merged.messages.some((message) => message.id === item.info.id)) continue
        setStore(
          "part",
          item.info.id,
          reconcile(mergeFetchedParts(store.part[item.info.id], item.parts.map(previewPartForStore))),
        )
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

    async function refreshPendingInput() {
      const workspace = project.workspace.current()
      const [permissions, questions, planReviews] = await Promise.allSettled([
        sdk.client.permission.list({ workspace }),
        sdk.client.question.list({ workspace }),
        sdk.client.planReview.list({ workspace }),
      ])
      batch(() => {
        if (permissions.status === "fulfilled")
          setStore("permission", reconcile(groupBySession(permissions.value.data ?? [])))
        if (questions.status === "fulfilled")
          setStore("question", reconcile(groupBySession(questions.value.data ?? [])))
        if (planReviews.status === "fulfilled")
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

    function scheduleSessionStatusExpiry(sessionID: string, status: SessionStatus) {
      clearSessionStatusTimer(sessionID)
      const delay = sessionStatusExpiryDelay(status)
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
          if (current.type === "retry" && status.type === "retry" && current.next !== status.next) return
          setStore("session_status", sessionID, { type: "idle" })
        }, delay),
      )
    }

    function setSessionStatus(sessionID: string, status: SessionStatus) {
      setStore("session_status", sessionID, status)
      if (status.type === "idle") {
        clearSessionStatusTimer(sessionID)
        releaseCompletedPinnedMessages(sessionID)
      } else scheduleSessionStatusExpiry(sessionID, status)
    }

    function replaceSessionStatuses(statuses: Record<string, SessionStatus>) {
      for (const sessionID of sessionStatusTimers.keys()) {
        if (!(sessionID in statuses)) clearSessionStatusTimer(sessionID)
      }
      setStore("session_status", reconcile(statuses))
      for (const [sessionID, status] of Object.entries(statuses)) {
        if (status.type === "idle") releaseCompletedPinnedMessages(sessionID)
        else scheduleSessionStatusExpiry(sessionID, status)
      }
    }

    onCleanup(() => {
      if (pendingInputRefreshTimer) clearTimeout(pendingInputRefreshTimer)
      for (const timer of sessionStatusTimers.values()) clearTimeout(timer)
      sessionStatusTimers.clear()
    })

    event.subscribe((event) => {
      const eventProperties = (event as { properties?: Record<string, unknown> }).properties
      trace.trace("event", {
        type: event.type,
        sessionID: typeof eventProperties?.sessionID === "string" ? eventProperties.sessionID : undefined,
        messageID: typeof eventProperties?.messageID === "string" ? eventProperties.messageID : undefined,
        partID: typeof eventProperties?.partID === "string" ? eventProperties.partID : undefined,
        propertyKeys: eventProperties ? Object.keys(eventProperties) : [],
      })
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
          void bootstrap()
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
          sessionMessagePaging.delete(sessionID)
          pinnedSessionMessages.delete(sessionID)
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
          const messages = store.message[sessionID]
          if (!messages) {
            setStore("message", sessionID, [event.properties.info])
            rememberLatestAssistant(sessionID, [event.properties.info])
            break
          }
          const paging = sessionMessagePaging.get(sessionID)
          const newestLoaded = messages.at(-1)
          if (paging?.hasMoreNewer && newestLoaded && event.properties.info.id > newestLoaded.id) {
            rememberLatestAssistant(sessionID, [event.properties.info])
            break
          }

          let next: Message = event.properties.info
          setStore(
            "message",
            sessionID,
            produce((draft) => {
              const indexes = draft.flatMap((message, index) => (message.id === event.properties.info.id ? [index] : []))
              const index = indexes[0]
              if (index !== undefined) {
                next = mergeMessageInfo(draft[index], event.properties.info)
                draft[index] = next
                for (const duplicate of indexes.slice(1).toReversed()) draft.splice(duplicate, 1)
                return
              }
              const insertAt = draft.findIndex((message) => message.id > event.properties.info.id)
              draft.splice(insertAt < 0 ? draft.length : insertAt, 0, event.properties.info)
            }),
          )
          const updated = store.message[sessionID]
          const overflowed = updated.length > TUI_SESSION_MESSAGE_STORE_LIMIT
          if (overflowed) {
            const trimmed = trimLoadedSessionMessages({
              messages: [...updated],
              max: TUI_SESSION_MESSAGE_STORE_LIMIT,
              drop: "oldest",
              preserveIDs: preserveSessionTailIDs(
                updated,
                pinnedSessionMessages.get(event.properties.info.sessionID),
                (messageID) => store.part[messageID],
              ),
            })
            batch(() => {
              setStore("message", event.properties.info.sessionID, reconcile(trimmed.messages))
              removeSessionParts(trimmed.removed)
            })
          }
          rememberLatestAssistant(event.properties.info.sessionID, [event.properties.info])
          const first = store.message[event.properties.info.sessionID]?.[0]
          if (paging && first) {
            sessionMessagePaging.set(event.properties.info.sessionID, {
              ...paging,
              olderCursor: paging.hasMoreOlder ? paging.olderCursor : messageCursor(first),
              hasMoreOlder: paging.hasMoreOlder || overflowed,
              newerCursor: undefined,
              hasMoreNewer: false,
            })
          }
          break
        }
        case "message.removed": {
          if (pinnedSessionMessages.get(event.properties.sessionID)?.has(event.properties.messageID)) break
          const messages = store.message[event.properties.sessionID]
          if (!messages) break
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            batch(() => {
              setStore(
                "message",
                event.properties.sessionID,
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
              setStore(
                "part",
                produce((draft) => delete draft[event.properties.messageID]),
              )
            })
            recomputeLatestAssistant(event.properties.sessionID)
          }
          break
        }
        case "message.part.updated": {
          trace.trace("event-message-part-updated", {
            sessionID: event.properties.part.sessionID,
            messageID: event.properties.part.messageID,
            partID: event.properties.part.id,
            type: event.properties.part.type,
          })
          const incomingPart = previewPartForStore(event.properties.part)
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
            produce((draft) => {
              draft.splice(result.index, 0, incomingPart)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
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
        sessionMessagePaging.clear()
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
        hydrateProviderMetadata(),
        ...(readiness.blockProviderUxMetadata ? [hydrateProviderUxMetadata()] : []),
        ...(readiness.blockSessionList ? [hydrateSessionList()] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          if (!isCurrentBootstrap()) return
          if (store.status !== "complete") setStore("status", "partial")
          void Promise.all([
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
              setStore("status", "complete")
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
          if (!fatal) throw e
        })
    }

    onMount(() => {
      void bootstrap()
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
        async reloadMessages(sessionID: string) {
          sessionMessagePaging.delete(sessionID)
          await result.session.sync(sessionID, { force: true }).catch((error) => {
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
        async loadOlder(sessionID: string) {
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
              const merged = applySessionMessagePage({ sessionID, items: messages.items, drop: "newest" })
              const advancedOlderCursor = Boolean(messages.cursor && messages.cursor !== page.olderCursor)
              const newest = merged.messages.at(-1)
              sessionMessagePaging.set(sessionID, {
                olderCursor: messages.cursor,
                hasMoreOlder: messages.items.length > 0 && advancedOlderCursor,
                newerCursor: newest ? messageCursor(newest) : page.newerCursor,
                hasMoreNewer: page.hasMoreNewer || merged.removed.some((message) => newest && message.id > newest.id),
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
              const merged = applySessionMessagePage({ sessionID, items: messages.items, drop: "oldest" })
              const oldest = merged.messages[0]
              const latest = merged.messages.at(-1)
              const advancedNewerCursor = Boolean(messages.cursor && messages.cursor !== after)
              sessionMessagePaging.set(sessionID, {
                olderCursor: oldest ? messageCursor(oldest) : page.olderCursor,
                hasMoreOlder: page.hasMoreOlder || merged.removed.some((message) => oldest && message.id < oldest.id),
                newerCursor: latest ? messageCursor(latest) : messages.cursor,
                hasMoreNewer: messages.items.length > 0 && advancedNewerCursor,
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
        async sync(sessionID: string, options?: { force?: boolean }) {
          trace.trace("sync-start", {
            sessionID,
            force: options?.force ?? false,
            loadedIDs: (store.message[sessionID] ?? []).map((message) => message.id),
            paging: sessionMessagePaging.get(sessionID),
          })
          if (!options?.force && sessionMessagePaging.has(sessionID)) return
          const generation = beginSessionMessageSync(sessionID)
          const workspace = project.workspace.current()
          const [session, messages, todo, diff, statuses] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            fetchSessionMessageWindow(sessionID),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sdk.client.session.status({ workspace }),
          ])
          if (!isCurrentSessionMessageSync(sessionID, generation)) return
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
              drop: "oldest",
              preserveCurrent: "newer-working-assistant",
            })
            sessionMessagePaging.set(sessionID, {
              olderCursor: messages.cursor,
              hasMoreOlder: Boolean(messages.cursor),
              newerCursor: undefined,
              hasMoreNewer: false,
            })
            setStore("session_diff", sessionID, reconcile(diff.data ?? []))
            replaceSessionStatuses(statuses.data ?? {})
          })
          trace.trace("sync-end", {
            sessionID,
            loadedIDs: (store.message[sessionID] ?? []).map((message) => message.id),
            status: store.session_status[sessionID],
            paging: sessionMessagePaging.get(sessionID),
          })
        },
      },
      bootstrap,
    }
    return result
  },
})
