/**
 * `mendcode app-server`: the types of its JSON-RPC 2.0 conversation (one message per line on stdio), the way a
 * third-party UI drives MendCode. Zod-free on purpose (types and constants only), so a host can import it cheaply.
 * See docs/embedding.md. Additive changes only inside `mendcode-app-server@1`: new methods, fields and notifications;
 * a host ignores what it does not know. Times are epoch milliseconds.
 */
import type { PermissionMode } from "./states"

export const APP_SERVER_PROTOCOL = "mendcode-app-server@1"

/** JSON-RPC error codes the server uses (the first five are the standard ones). */
export const APP_SERVER_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  unknownThread: -32004,
  /** The daemon refused the command; `data.code` has its error code (busy, unknown_session, target_mismatch, ...). */
  daemon: -32010,
} as const

export type AppServerStatus = "inProgress" | "completed" | "failed" | "cancelled" | "interrupted"

export type AppServerThread = {
  id: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  /** The foreground state: idle, queued, generating, tool, waiting_approval, compacting, cancelling or error. */
  state: string
  queued: number
  approvalPolicy?: PermissionMode
  model?: string
  agent?: string
  parentId?: string
  archived?: boolean
  /** The newest event sequence number the thread had when it was read. */
  lastSeq: number
}

export type AppServerItem =
  | { id: string; type: "userMessage"; text: string }
  | { id: string; type: "agentMessage"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "commandExecution"; tool: string; command: string; status: AppServerStatus; output?: string; meta?: Record<string, string | number | boolean> }
  | { id: string; type: "fileChange"; tool: string; title: string; status: AppServerStatus; output?: string; meta?: Record<string, string | number | boolean> }
  | { id: string; type: "toolCall"; tool: string; title: string; status: AppServerStatus; output?: string; meta?: Record<string, string | number | boolean> }
  | { id: string; type: "contextCompaction"; text: string }
  | { id: string; type: "other"; kind: string; text: string }

export type AppServerTurn = {
  id: string
  status: AppServerStatus
  /** Why a turn did not complete: `failed` has the error, `interrupted` the reason (user, restart, transport, stream_idle). */
  error?: { code: string; message: string }
  reason?: string
  items?: AppServerItem[]
}

/** What the host may put in a turn's `input`. Text and mentions become the prompt; images become attachments. */
export type AppServerInput =
  | { type: "text"; text: string }
  | { type: "mention"; path: string; name?: string }
  | { type: "localImage"; path: string }
  | { type: "image"; name: string; data: string }

export type AppServerTokenUsage = { inputTokens: number; outputTokens: number; reasoningOutputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; totalTokens: number; costMicros?: number }

export type AppServerModel = { id: string; name: string; provider?: string; efforts: string[]; defaultEffort?: string; contextWindow?: number }

export type AppServerMethods = {
  initialize: {
    params: { clientInfo: { name: string; version?: string }; capabilities?: Record<string, unknown> }
    result: { protocol: typeof APP_SERVER_PROTOCOL; serverInfo: { name: "MendCode"; version: string }; methods: string[]; cwd: string }
  }
  "thread/start": {
    params: { cwd?: string; title?: string; model?: string; effort?: string; agent?: string; approvalPolicy?: PermissionMode }
    result: { thread: AppServerThread }
  }
  /** Attaches to an existing thread so its next events stream here. Events of a turn already running are not replayed; read them with `thread/read`. */
  "thread/resume": { params: { threadId: string; approvalPolicy?: PermissionMode }; result: { thread: AppServerThread } }
  "thread/fork": { params: { threadId: string; title?: string }; result: { thread: AppServerThread } }
  "thread/list": { params: { cwd?: string; limit?: number; search?: string; archived?: boolean }; result: { data: AppServerThread[] } }
  /** `includeTurns` adds a page of finished turns, newest last; `before`/`after` are the `older`/`newer` cursors of the previous page. */
  "thread/read": {
    params: { threadId: string; includeTurns?: boolean; limit?: number; before?: number; after?: number }
    result: { thread: AppServerThread; turns?: AppServerTurn[]; older?: number; newer?: number }
  }
  "thread/name/set": { params: { threadId: string; name: string }; result: Record<string, never> }
  "thread/archive": { params: { threadId: string; restore?: boolean }; result: Record<string, never> }
  "thread/compact/start": { params: { threadId: string; instructions?: string }; result: Record<string, never> }
  /** Without a `turn`, the turn started at once (`turn` set); a busy thread queues the message (`queued: true`, `turn: null`) and `turn/started` carries the same `queueId` later. */
  "turn/start": {
    params: { threadId: string; input: AppServerInput[]; model?: string; effort?: string; agent?: string; approvalPolicy?: PermissionMode }
    result: { queueId: string; queued: boolean; turn: AppServerTurn | null }
  }
  "turn/interrupt": { params: { threadId: string; turnId?: string }; result: Record<string, never> }
  "model/list": { params: { threadId?: string }; result: { data: AppServerModel[]; default?: string } }
}

export type AppServerNotifications = {
  initialized: Record<string, never>
  "thread/started": { thread: AppServerThread }
  "thread/tokenUsage/updated": { threadId: string; turnId: string; model: string; last: AppServerTokenUsage }
  "thread/compaction/updated": { threadId: string; turnId: string; reason: "auto" | "manual"; state: string }
  "thread/approvalPolicy/changed": { threadId: string; approvalPolicy: PermissionMode }
  /** A request only another client can answer (a plan review): the host may show it or open the TUI. */
  "thread/attention": { threadId: string; turnId: string; requestId: string; reason: "planReview"; title: string }
  /** `joinedQueueIds`: further queued messages that started in this same turn. */
  "turn/started": { threadId: string; turn: AppServerTurn; queueId: string; joinedQueueIds?: string[] }
  "turn/completed": { threadId: string; turn: AppServerTurn }
  /** A failed model call is waiting to be retried; the turn is still running. */
  "turn/retrying": { threadId: string; turnId: string; attempt: number; nextAt: number; message: string }
  "item/started": { threadId: string; turnId: string; item: AppServerItem }
  "item/completed": { threadId: string; turnId: string; item: AppServerItem }
  "item/agentMessage/delta": { threadId: string; itemId: string; delta: string }
  "item/reasoning/textDelta": { threadId: string; itemId: string; delta: string }
  "item/commandExecution/outputDelta": { threadId: string; itemId: string; delta: string }
  "item/fileChange/outputDelta": { threadId: string; itemId: string; delta: string }
  "item/toolCall/outputDelta": { threadId: string; itemId: string; delta: string }
  "serverRequest/resolved": { threadId: string; requestId: string; resolution: "approved" | "denied" | "answered" | "abandoned" }
}

export type AppServerDecision = "accept" | "acceptForSession" | "decline" | "cancel"

type ApprovalParams = { threadId: string; turnId: string; itemId?: string; requestId: string; tool?: string; title: string; detail: string; reason?: string }

/** Requests the server sends to the host; the host answers each one (an error reply counts as `decline`). */
export type AppServerServerRequests = {
  "item/commandExecution/requestApproval": { params: ApprovalParams; result: { decision: AppServerDecision } }
  "item/fileChange/requestApproval": { params: ApprovalParams; result: { decision: AppServerDecision } }
  /** Any other tool that asks (a read outside the project, a network fetch, an MCP tool). */
  "item/tool/requestApproval": { params: ApprovalParams & { permission?: "read" | "write" | "execute" }; result: { decision: AppServerDecision } }
  "item/tool/requestUserInput": {
    params: {
      threadId: string
      turnId: string
      itemId?: string
      requestId: string
      questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; isOther?: boolean }>
    }
    result: { answers: Record<string, { answers: string[] }> }
  }
}

export type AppServerMessage = {
  jsonrpc?: "2.0"
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
