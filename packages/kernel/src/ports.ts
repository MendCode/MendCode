import type {
  BlobRef,
  ContextReport,
  GlobalEvent,
  ItemId,
  ItemKind,
  ItemStatus,
  PermissionMode,
  RenderNode,
  RequestId,
  SessionEvent,
  SessionId,
  TurnId,
} from "@mendcode/protocol"

export type TaskPort = {
  run(parentId: SessionId, input: import("@mendcode/protocol").TaskInput, signal: AbortSignal): Promise<import("@mendcode/protocol").TaskRecord>
  status(parentId: SessionId, input: { task_id?: string | undefined; action?: "list" | "get" | "wait" | "cancel" | undefined; timeout_ms?: number | undefined }, signal: AbortSignal): Promise<string>
  isChild(sessionId: SessionId): boolean
  /** The parent of a child launched with `fork: true`, whose first turn starts from that parent's context. */
  forkOf?(sessionId: SessionId): SessionId | undefined
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Events the kernel produces; the sink assigns `seq`/`gseq` and persists them (single writer = store). */
export type SessionEventDraft = DistributiveOmit<SessionEvent, "seq" | "at">
export type GlobalEventDraft = DistributiveOmit<GlobalEvent, "gseq" | "at">

export interface SessionEventSink {
  append(event: SessionEventDraft): SessionEvent
}

export interface GlobalEventSink {
  append(event: GlobalEventDraft): GlobalEvent
}

export type EngineRequest = {
  kind: "approval" | "question"
  title: string
  detail: string
  /** For a tool approval: the tool call's item, the tool and what it may do. */
  itemId?: ItemId
  tool?: string
  permission?: "read" | "write" | "execute"
  /** For a question: choices to pick from (the user may still type an answer), and whether several may be picked. */
  options?: Array<{ label: string; description?: string }>
  multiple?: boolean
  questions?: import("@mendcode/protocol").QuestionInfo[]
  planReview?: import("@mendcode/protocol").PlanReview
  permissionContext?: import("@mendcode/protocol").PermissionContext
  /** The engine flagged this call as dangerous although the session is in full access (Claude Code in bypass mode); shown as an ordinary approval without "always". */
  engineFlagged?: true
  /** Host-local cancellation of a bounded nested operation; never serialized to clients. */
  signal?: AbortSignal
}
export type EngineResolution =
  | { kind: "approve"; scope: "once" | "session"; memoryText?: string | undefined; memoryAlways?: boolean | undefined }
  | { kind: "deny"; reason?: string | undefined }
  | { kind: "answer"; text: string; answers?: string[][] | undefined }
  | import("@mendcode/protocol").PlanReviewReply
  | { kind: "abandoned" }

/** What an engine reports while running a turn. Item ids come from the kernel's id factory. */
export type EngineEvent =
  | { type: "item.started"; itemId: ItemId; kind: ItemKind; meta?: Record<string, string | number | boolean> }
  | { type: "item.delta"; itemId: ItemId; text: string; input?: import("@mendcode/protocol").ToolInputProgress }
  | { type: "item.completed"; itemId: ItemId; status: ItemStatus; text?: string; toolInput?: string; blob?: BlobRef; attachments?: BlobRef[]; render?: RenderNode; meta?: Record<string, string | number | boolean> }
  | { type: "usage"; provider: string; model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; costMicros?: number; profile?: import("@mendcode/protocol").RequestProfile; thinkingDropped?: true; cacheTtl?: "1h"; context?: number; contextWindow?: number; contextApprox?: true; partial?: true; compactAt?: number }
  /** A failed model call will be retried after `delayMs`; `attempt` counts retries from 1; `offline`: the connection itself failed. */
  | { type: "retrying"; attempt: number; delayMs: number; message: string; offline?: boolean }

export type TurnInput = {
  /** Daemon-owned, process-only MCP configuration. Never accepted from a protocol client or persisted. */
  externalMcp?: { args: string[]; servers?: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>; cwd: string; scrub(text: string): string; waiting?(): boolean; stream?(): { push(text: string): string; flush(): string } } | undefined
  sessionId: SessionId
  turnId: TurnId
  text: string
  attachments: BlobRef[]
  /** Original user authority, before file expansion or synthetic notices. */
  authority?: { sourceId: string; text: string; synthetic?: boolean }
  selection?: { model?: import("@mendcode/protocol").ModelChoice | undefined; agent?: string | undefined } | undefined
  /** Narrowing options of this turn only (`noReply`, `excludeTools`, `format`); the daemon refuses them for engines that cannot honour them. */
  turnOptions?: import("@mendcode/protocol").TurnOptions | undefined
  /** With `runShell` (`!!command`): the command and its output are shown, not added to the model's history. */
  localShell?: true
  /** Frozen workflow restrictions supplied by the daemon, never by a user.submit payload. */
  workflow?: {
    execution: import("@mendcode/protocol").WorkflowTaskExecution
    beforeCall(): string | undefined
    reserveChild(): boolean
  }
  signal: AbortSignal
  newItemId(): ItemId
  emit(event: EngineEvent): void
  ask(request: EngineRequest): Promise<EngineResolution>
  /** The session's current permission mode; read at each tool call, so a change applies mid-turn. */
  permissionMode(): PermissionMode
  /** Asks the session owner to switch mode (an approved plan leaves plan mode); recorded as an event. */
  setPermissionMode(mode: PermissionMode): void
  /**
   * Native engines call only after every tool result in an iteration is persisted, before the next model call. A reply with no
   * `authority` is a notice about the session's own background work: context for the model, read as it is, and the turn keeps its own.
   */
  takeQueued?(options?: { /** Only a message of the user's: a notice about the session's background work waits for its own turn. */ userOnly?: boolean }): Promise<Pick<TurnInput, "text" | "attachments" | "authority"> | undefined>
  /**
   * An engine that can take a message mid-turn without stopping what the turn started (Claude Code: a plain interrupt also stops its
   * background agents) registers how. "Send now" then hands it the message: the handler returns true when it took it, and the turn
   * ends on its own soon after; the message stays first in the queue and its turn picks up what the engine already began.
   */
  onSendNow?(handler: (message: Pick<TurnInput, "text" | "attachments">) => boolean): void
}

/**
 * The session's `/env` credentials for an engine that runs its own tools (Claude Code, Codex, pi, ACP): the values go into its process
 * environment, and `note` tells its model which names exist. A value changed later reaches the next process the engine starts.
 */
export type EngineEnvironment = { values: Record<string, string>; note: string }

/** A stable digest of an environment, so an engine can tell that the credentials changed without keeping them twice. */
export function environmentKey(environment: EngineEnvironment | undefined): string {
  return environment ? String(Bun.hash(JSON.stringify(Object.entries(environment.values).sort(([a], [b]) => a.localeCompare(b))))) : ""
}

export type TurnOutcome = { status: "ok"; /** Only a successful history replacement sets this. */ compacted?: boolean; continueAfterCompact?: boolean; /** Why a compaction did nothing, for the user. */ note?: string; /** The engine has no history of this session yet (it never ran a turn of it). */ empty?: true } | { status: "error"; code: string; message: string }

/**
 * An engine runs one turn at a time for a session. It must stop promptly when `signal` aborts;
 * the actor forces completion after a grace period regardless (I6).
 */
export interface EnginePort {
  /** The full permission-filtered native tool catalog; discovery never executes a tool or calls a model. */
  catalogTools?(input: { directory: string; provider?: string; model?: string }): Promise<import("@mendcode/protocol").RestTool[]>
  /**
   * The native tools another harness (Claude Code) may call through the daemon's loopback bridge: everything the session's tier,
   * agent and limits offer, minus what that harness already has of its own (files, shell, search, questions, plans, sub-agents).
   */
  hostTools?(input: { directory: string; sessionId: SessionId }): Promise<Array<{ name: string; description: string; parameters: unknown }>>
  /** One such call inside the other harness's turn: the same approvals, authority, masking, output limits and card as a native call. */
  hostCall?(input: { turn: TurnInput; name: string; args: unknown }): Promise<{ output: string; isError: boolean; images?: Array<{ mime: "image/png" | "image/jpeg"; bytes: Uint8Array }> }>
  runTurn(input: TurnInput): Promise<TurnOutcome>
  /** Optional: runs the user's own `!command` (`input.text`) without a model call; engines without it reject shell mode. */
  runShell?(input: TurnInput): Promise<TurnOutcome>
  /** Checked after each turn; compaction then runs inside the same turn, before the queue advances (I2, I5). */
  needsCompaction(sessionId: SessionId): boolean
  /** Optional read-only breakdown of what fills the session's context (`/context`). */
  contextReport?(sessionId: SessionId): Promise<ContextReport>
  /** `instructions` steer a manual summary; `selection.model` summarises on another model (both: a portable summary, no native checkpoint). */
  compact(input: { sessionId: SessionId; turnId: TurnId; signal: AbortSignal; newItemId(): ItemId; emit(event: EngineEvent): void; instructions?: string; selection?: TurnInput["selection"]; /** The daemon started it in an idle session to beat the prompt cache's expiry: an automatic compaction, and one that is only worth running when its request repeats the session's last request (the cached prefix). An engine that cannot do that skips it. */ idle?: true }): Promise<TurnOutcome>
  /**
   * An engine that keeps the conversation itself (Claude Code) takes `turnId`'s message and everything after it out of that
   * conversation, as an undo of that message does to MendCode's own history. True when it did; the next turn sees the cut history.
   */
  rewind?(input: { sessionId: SessionId; turnId: TurnId }): Promise<boolean>
  /** The session is idle and no client shows it: an engine may free what it keeps for it (an external agent's process). */
  release?(sessionId: SessionId): void
  /** The session was deleted: an engine drops everything it still keeps for it (unlike `release`, nothing of it is needed again). */
  forget?(sessionId: SessionId): void
  /** User-invoked agent inspection or one tool call through the native tools, including hosted tasks. */
  debugAgent?(input: { directory: string; sessionId: SessionId; agent: import("@mendcode/protocol").AgentInfo & { prompt: string }; run?: { turn: TurnInput; tool: string; params: Record<string, unknown> } }): Promise<{ tools: Record<string, boolean>; result?: { output: string; truncated: boolean; title: string; isError: boolean } }>
}

export type RequestHandle = { requestId: RequestId; resolve(resolution: EngineResolution): void }
