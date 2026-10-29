import { ConsoleUrl } from "./console"
import { ProjectRestInput } from "./project-rest"
import { ProjectControlInput } from "./project"
import { ProviderOptions } from "./model-config"
import { BudgetPolicy, SetupPreset } from "./setup"
import { DebugInput } from "./debug"
import { MemoryModelInput, MemoryAssistantSelection } from "./memory-model"
import { ServerHealth, ServerMemory, ServerConfigGet, ServerConfigUpdate, ServerDispose, AppLog, ServerUpgrade } from "./server-rest"
import { MemoryControlInput, DreamControlInput } from "./memory-control"
import { MemoryWorkspaceList, MemoryBrowse, MemorySharingStatus, MemorySharingConfigure, MemorySharingExport, MemorySharingImport } from "./memory-sharing"
import { z } from "zod"
import { attachmentPlacementProblem } from "./attachment-layout"
import { MessagePart, MessagePartId, MessageTarget } from "./message-parts"
import { PlanReviewReply } from "./plan-review"
import { AIConfigInput } from "./ai-config"
import { ReasoningPolicy } from "./reasoning"
import { QuestionAnswers } from "./questions"
import { AgentCommandRequest, AgentCommandState } from "./agent-commands"
import { AGENT_CREATE_NAME, AGENT_CREATE_PERMISSIONS } from "./agent-data"
import { TaskInput } from "./tasks"
import { SidebarAction } from "./sidebar"
import { BACKLOG_LIMITS } from "./backlog-data"
import { TuiControlInput } from "./tui"
import { EVENTS_PAGE_MAX, MODEL_ROLES, MAX_DRAFT_CHARS, MEMORY_CATEGORY_IDS, MEMORY_POLICIES } from "./constants"
import { BlobRef, ClientId, CommandId, ItemId, JobId, LoopId, MemoryId, QueueId, RequestId, SessionId, TurnId, WorkflowId } from "./ids"
import { GoalObjective, GoalTokenBudget } from "./goals"
import { UsageLimitAction } from "./usage-limit"
import { LoopBudget, LoopTrigger, LoopCostBudget, LoopRubric, LoopApprovalPolicy, LoopApprovalAction } from "./loops"
import { ProviderBaseUrl, ProviderId, ProviderModel, ProviderType, ProviderSdkModule } from "./providers"
import { MemoryLinkKind, MemoryScope, MemoryStatus, ModelChoice } from "./queries"
import { JobType, MAX_INLINE_TEXT, PermissionMode, PROTOCOL_VERSION, QueueDelivery, ResourceMode, TurnOptions } from "./states"
import { WORKFLOW_SCRIPT_MAX_BYTES, WorkflowDefinition, WorkflowDefinitionId, WorkflowPlanInput, WorkflowRevisionId, WorkflowScriptBudget, WorkflowSlug } from "./workflows"
import { RestWorkflowPlan } from "./workflow-http"
import { LedgerQuery } from "./automation-ledger"
import { CompactionOverride } from "./compaction"
import { LspInput } from "./lsp"
import { ReviewRead, ReviewChange } from "./review"
import { PromptFocusChoice, PromptMode } from "./prompt"
import { CatalogAuthMode, CatalogProvider, McpConfigInput } from "./catalog"
import { LoopDraft, LoopSnapshotQuery, LoopEventsQuery, LoopActivate, LoopTick } from "./loop-control"
import { SessionNotesInput, SessionRecallReadInput, SessionRecallSearchInput } from "./session-recall"
import { AgentViewMetadataPatch, SessionBackgroundPatch } from "./session-background"
import { WorktreeRead, WorktreeChange } from "./worktrees"
import { CacheMutation, CacheTarget } from "./cache"
import { CompoundConfig, CompoundRunInput } from "./compound"
import { PackagesSearch, PackagesShow, PackagesPreview, PackagesSources, PackagesAddSource, PackagesRemoveSource, PackagesInstallCatalog, PackagesInstallSource, PackagesDisableAll, PackagesAssets, PackagesRefresh, PackagesConfig, PackagesResource } from "./packages"
import { PackagesCreate, PackagesUpdate, PackagesDeleteLocal } from "./package-authoring"
import { WorkspaceQuery, WorkspaceCreate, WorkspaceRemove } from "./http"
import { InteractionKind, MemorySideChatPayload } from "./interaction-http"
import { SessionRestRead, SessionRestUpdate, SessionRestControl, SessionRestMutate } from "./session-rest"
import { ProviderAuthMethod } from "./provider-auth"
import { ReleaseChannel } from "./release"
import { ActivityAudioInput } from "./activity-audio"
import { VoiceControlInput } from "./voice"
import { PetInput } from "./pet"
import { TraceSample } from "./tracing"
import { TsmRead, TsmChange } from "./tsm"
import { GithubInstallInput, GithubRunInput } from "./github"
import { ComputerCaptureInput, ComputerKeyInput } from "./computer"
import { ComputerSessionInput, ComputerObserveInput, ComputerCodeInput } from "./computer-session"

import { MflowRead, MflowChange, MflowLease } from "./mflow"
import { ChannelsChange } from "./channels"
import { CatalogRest } from "./catalog-rest"
import { TuiControlRegister, TuiControlSend, TuiControlNext, TuiControlResponse } from "./tui-actions"
import { FileEdit, FileRestRead } from "./file-rest"
import { FileViewCommand } from "./file-view"
import { GitCommitCommand } from "./git-commit"
import { GitPrCreateCommand, GitPrViewCommand, GitPublishCommand, GitPushCommand } from "./git-actions"
import { GitInitCommand } from "./git-init"
import { CODEGRAPH_OVERVIEW } from "./codegraph-overview-data"
import { PtyShells, PtyList, PtyCreate, PtyGet, PtyUpdate, PtyRemove, PtyTicket } from "./pty"
import { lazySchema, lazyValue } from "./lazy"
import { SessionMetaInput } from "./session-lifecycle"

export const SessionMeta = lazySchema(() => z.strictObject({ id: CommandId, clientId: ClientId, type: z.literal("session.meta"), sessionId: SessionId, input: SessionMetaInput }))
export const SessionFanout = lazySchema(() => z.strictObject({ id: CommandId, clientId: ClientId, type: z.literal("session.fanout"), sessionId: SessionId, action: z.enum(["start", "compare"]), prompt: z.string().min(1).max(8000).optional(), models: z.array(z.string().min(1).max(200)).min(2).max(8).optional() }))

/** Every command carries a client-generated id so retries after reconnect are idempotent. */
const base = { id: CommandId, clientId: ClientId }

export const Hello = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  client: z.strictObject({ name: z.string().max(64), version: z.string().max(64) }),
  capabilities: z.array(z.string().max(64)).max(64),
}))

export const SessionCreate = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.create"),
  directory: z.string().min(1).max(4096),
  title: z.string().max(200).optional(),
  parentId: SessionId.optional(),
  agent: z.string().min(1).max(100).optional(),
  choice: ModelChoice.optional(),
  /**
   * A terminal's "new chat": answers with the project's empty chat (nothing typed, no title or setting) when there is one, and
   * creates one otherwise, so repeated new chats never pile up blank sessions. Ack: `{ sessionId, reused? }`. Without it the
   * session is made on purpose, always new, and never treated as an empty chat.
   */
  reuseEmpty: z.boolean().optional(),
}))

/**
 * A new session that continues from this one's conversation (the model keeps the context; the new transcript starts
 * empty). `readOnly` starts it in plan mode, for a side chat about the work. Ack: `{ sessionId, copied }`, where
 * `copied` is how many history messages came along (0 for engines whose history lives elsewhere).
 *
 * With `atItemId` (a user message, see `session.timeline`) the fork is a branch from that message: its transcript holds
 * the events of every turn up to and including that message's turn, and the model history is cut to the same point, so
 * later turns are absent. Ack then also has `events` (transcript events copied). Refused with `target_mismatch` when the
 * item is not a user message, its turn is undone or unfinished, or the history of that point no longer exists (compacted).
 * `beforeItemId` is exclusive (user or an assistant with a retained history boundary); `transcript` copies the finished
 * conversation when no point is given. These CLI options preserve the original `atItemId` and side-chat behaviour.
 */
export const SessionFork = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.fork"),
  sessionId: SessionId,
  /** Focused, bounded context instead of copying the transcript. Does not submit a turn. Local only. */
  handoffGoal: z.string().trim().min(1).max(2000).optional(),
  title: z.string().max(200).optional(),
  readOnly: z.boolean().optional(),
  atItemId: ItemId.optional(),
  beforeItemId: ItemId.optional(),
  transcript: z.boolean().optional(),
}))

/**
 * Undo the last finished user turn (and any system-notice turns after it): its items leave the transcript and the model
 * history (`turn.reverted` events), and files changed by its write/edit/apply_patch calls go back to what a pre-change
 * snapshot holds. Refused with `busy` while a turn runs. Files changed after the turn (edited by hand, by a shell command)
 * are not overwritten unless `force`; refused with `target_mismatch` naming them. Ack: a RewindReport.
 */
export const SessionUndo = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.undo"),
  sessionId: SessionId,
  force: z.boolean().optional(),
  /** Revert this user message and every later turn, atomically. */
  atItemId: ItemId.optional(),
  /**
   * Revert from one part (item) of a turn on: the files that write/edit/apply_patch calls from that part to the end of the
   * turn changed go back, the transcript stays (`partial: true` in the report). A part with no earlier text or tool call in
   * its turn means the whole message, like `atItemId`. Not combined with `atItemId`.
   */
  atPartId: ItemId.optional(),
  /** The terminal's v1 undo action stops its running turn before rewinding. */
  cancelRunning: z.boolean().optional(),
}))

/**
 * Redo the last undone turn(s): events, history and files. Only while nothing new happened since the undo (no turn started).
 * `all` restores every waiting undo group (and part-level revert), newest undo first; the report merges them.
 * Ack: a RewindReport.
 */
export const SessionRedo = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.redo"),
  sessionId: SessionId,
  force: z.boolean().optional(),
  all: z.boolean().optional(),
}))

/** The session's user messages to jump to (or fork at), oldest first. Ack: `{ entries: TimelineEntry[] }`. */
export const SessionTimeline = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.timeline"),
  sessionId: SessionId,
}))

export const SessionHistory = lazySchema(() => z.strictObject({
  ...base, type: z.literal("session.history"), sessionId: SessionId,
  before: z.number().int().positive().optional(), after: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(), turnId: TurnId.optional(),
}).refine((value) => !(value.before !== undefined && value.after !== undefined) && !(value.turnId && (value.before !== undefined || value.after !== undefined))))
export const SkillsList = lazySchema(() => z.strictObject({ ...base, type: z.literal("skills.list"), directory: z.string().min(1).max(4096) }))
export const SkillsSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("skills.set"), directory: z.string().min(1).max(4096), name: z.string().min(1).max(100), enabled: z.boolean() }))
export const SkillsLoad = lazySchema(() => z.strictObject({ ...base, type: z.literal("skills.load"), directory: z.string().min(1).max(4096), name: z.string().min(1).max(100) }))

/**
 * The session as text, bounded (see EXPORT_MAX_CHARS): undone turns left out, attachments listed by name, secrets as
 * markers, tool output truncated, reasoning left out. Ack: `{ format, text, turns, truncated }`.
 */
export const SessionExport = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.export"),
  sessionId: SessionId,
  format: z.enum(["markdown", "json", "html"]),
  reasoning: z.boolean().optional(),
  toolDetails: z.boolean().optional(),
  assistantMetadata: z.boolean().optional(),
  timestamps: z.boolean().optional(),
  sanitize: z.boolean().optional(),
}))

export const UserSubmit = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("user.submit"),
  sessionId: SessionId,
  text: z.string().max(MAX_INLINE_TEXT),
  attachments: z.array(BlobRef).max(32),
  selection: z.strictObject({ model: ModelChoice.optional(), agent: z.string().min(1).max(100).optional() }).optional(),
  displayText: z.string().max(MAX_INLINE_TEXT).optional(),
  /** A caller-chosen id for the user message item: a queued prompt keeps one stable id from admission to the transcript. Refused when taken. */
  messageId: ItemId.optional(),
  /** Narrowing options of this one turn (no model call, fewer tools, a required answer shape); native engine only. */
  turnOptions: TurnOptions.optional(),
  /** Per-message delivery against a running turn (`queue` | `steer` | `restart`); unset follows the queue policy. */
  delivery: QueueDelivery.optional(),
  /** A caller-chosen id for retries: the same id on the same session returns the first answer instead of queueing twice. */
  clientRequestId: z.string().min(1).max(128).optional(),
}).superRefine((value, ctx) => {
  // Positions are optional; the ones that are sent must be in range and name distinct tokens (an unplaced attachment is sent after the text).
  const problem = attachmentPlacementProblem(value.text, value.attachments)
  if (problem) ctx.addIssue({ code: "custom", path: ["attachments"], message: problem })
}))

/**
 * `!command`: queue the user's own shell command. It runs in order like a message, without a model call or an
 * approval, and its output joins the history for the next answer. Rejected when the engine has no shell mode.
 * `local` (`!!command`): the same, but the command and its output stay out of the model's history; they only show in the transcript.
 */
export const UserShell = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("user.shell"),
  sessionId: SessionId,
  command: z.string().min(1).max(8_000),
  local: z.literal(true).optional(),
  messageId: ItemId.optional(),
}))

/** "Send now": interrupt the active turn and start this queued message next (FC-03). */
export const QueuePromote = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.promote"),
  sessionId: SessionId,
  queueId: QueueId,
}))

export const QueueRemove = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.remove"),
  sessionId: SessionId,
  queueId: QueueId,
}))

/**
 * Moves a queued message: `up`/`down` one place, `top`/`bottom`, or to a zero-based position (clamped).
 * Ack: `{ position }`. Not read-only for peers.
 */
export const QueueReorder = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.reorder"),
  sessionId: SessionId,
  queueId: QueueId,
  to: z.union([z.enum(["up", "down", "top", "bottom"]), z.number().int().min(0).max(255)]),
}))

/** Replaces the text of a queued message or `!command` in place (entries a client expanded or an extension rewrote are refused). */
export const QueueEdit = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.edit"),
  sessionId: SessionId,
  queueId: QueueId,
  text: z.string().min(1).max(MAX_INLINE_TEXT),
}))

/**
 * Joins this queued message to the running turn after its next tool result. Ack: `{ steered }`; false when the turn cannot
 * take it (no running turn, or an engine without an injection boundary): it then waits its place in the queue, or starts at once when idle.
 */
export const QueueSteer = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.steer"),
  sessionId: SessionId,
  queueId: QueueId,
}))

/** The session's queue in order with full text, delivery and whether it can be edited. Ack: `{ entries, held, paused }`. */
export const QueueList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("queue.list"),
  sessionId: SessionId,
}))

/** Explicit target: a cancel for a different or finished turn is rejected, never redirected (FC-09, FC-10). */
export const TurnCancel = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("turn.cancel"),
  sessionId: SessionId,
  turnId: TurnId,
}))

export const RequestResolve = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("request.resolve"),
  sessionId: SessionId,
  requestId: RequestId,
  decision: z.discriminatedUnion("kind", [
    /** `remember` also saves an allow rule (a command prefix for `bash`, the tool for edits) for the project or for the user; the daemon derives the rule from the request. */
    z.strictObject({ kind: z.literal("approve"), scope: z.enum(["once", "session"]), memoryText: z.string().trim().min(1).max(2000).optional(), memoryAlways: z.boolean().optional(), remember: z.strictObject({ level: z.enum(["project", "user"]) }).optional() }),
    z.strictObject({ kind: z.literal("deny"), reason: z.string().max(2000).optional() }),
    z.strictObject({ kind: z.literal("answer"), text: z.string().max(MAX_INLINE_TEXT), answers: QuestionAnswers.optional() }),
    PlanReviewReply,
  ]),
}))

export const ClientSubscribe = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("client.subscribe"),
  sessionId: SessionId,
  afterSeq: z.number().int().nonnegative(),
}))

export const ClientUnsubscribe = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("client.unsubscribe"),
  sessionId: SessionId,
}))

export const JobSchedule = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("job.schedule"),
  jobType: JobType,
  spec: z.record(z.string(), z.unknown()),
}))

export const JobCancel = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("job.cancel"),
  jobId: JobId,
}))

export const ResourceModeSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("resource.mode.set"),
  mode: ResourceMode,
}))

/** Ack result: `{ sessions: SessionSummary[] }`, most recently updated first. */
export const SessionList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.list"),
  limit: z.number().int().positive().max(500).optional(),
  directory: z.string().max(4096).optional(),
  roots: z.boolean().optional(),
  project: z.string().min(1).max(4096).optional(),
  since: z.number().int().nonnegative().optional(),
  search: z.string().max(200).optional(),
  agent: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  active: z.boolean().optional(),
  /** Include archived sessions; the default listing hides them. */
  archived: z.boolean().optional(),
  /** Leave out the empty chats terminals open (see `session.create` `reuseEmpty`); the default listing shows every session. */
  hideEmpty: z.boolean().optional(),
}))

/** Ack. Changes the picker title of a session; unknown sessions are refused with `unknown_session`. */
export const SessionRename = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.rename"),
  sessionId: SessionId,
  title: z.string().min(1).max(200),
}))

/** Ack. Removes the session and its events; refused with `busy` while a turn runs and `unknown_session` if absent. */
export const SessionDelete = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.delete"),
  sessionId: SessionId,
}))

/** Read-only. Ack result: `{ secrets: SecretInfo[] }`, the secrets pasted into the session (marker number, kind, last characters; never values). */
export const PrivacyGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("privacy.get") }))
export const PrivacySet = lazySchema(() => z.strictObject({ ...base, type: z.literal("privacy.set"), enabled: z.boolean() }))
export const EnvList = lazySchema(() => z.strictObject({ ...base, type: z.literal("env.list"), sessionId: SessionId }))
export const EnvSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("env.set"), sessionId: SessionId, name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), value: z.string().min(1).max(16_384), scope: z.enum(["session", "project", "global"]) }))
export const EnvImport = lazySchema(() => z.strictObject({ ...base, type: z.literal("env.import"), sessionId: SessionId, path: z.string().min(1).max(4096), scope: z.enum(["session", "project", "global"]), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }))
export const EnvRemove = lazySchema(() => z.strictObject({ ...base, type: z.literal("env.remove"), sessionId: SessionId, name: z.string().max(128), scope: z.enum(["session", "project", "global"]) }))

export const SecretsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("secrets.list"),
  sessionId: SessionId,
}))

/**
 * A user action only (the agent has no way to send it): shows one pasted secret in the clear. Ack result: `{ value }`;
 * `target_mismatch` when the session has no such secret. The reply is never kept for retries.
 */
export const SecretsReveal = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("secrets.reveal"),
  sessionId: SessionId,
  n: z.number().int().positive().max(999_999),
}))

/** Ack. Deletes the stored value of one secret; its marker stays in the transcript but no longer resolves. `target_mismatch` when absent. */
export const SecretsForget = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("secrets.forget"),
  sessionId: SessionId,
  n: z.number().int().positive().max(999_999),
}))

/** Ack. Keeps the unsent prompt of a session so it survives a closed terminal; empty text and no attachments clears it. */
export const DraftSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("draft.set"),
  sessionId: SessionId,
  text: z.string().max(MAX_DRAFT_CHARS),
  attachments: z.array(BlobRef).max(16).optional(),
}))

/** Ack result: `{ draft?: { text, attachments, updatedAt } }`, absent when the session has none. */
export const DraftGet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("draft.get"),
  sessionId: SessionId,
}))

/**
 * Ack result: `{ drafts: DraftSummary[] }`, newest first, each with a one-line preview (the whole text comes from `draft.get`).
 * `maxAgeDays` first deletes every draft, in any project, last written longer ago than that.
 */
export const DraftList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("draft.list"),
  directory: z.string().min(1).max(4096).optional(),
  excludeSessionId: SessionId.optional(),
  limit: z.number().int().positive().max(100).optional(),
  maxAgeDays: z.number().int().min(1).max(3650).optional(),
}))

/** Ack result: `UsageReport` for the inclusive local-day range. */
export const UsageQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("usage.query"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: z.enum(["global", "project", "directory"]).optional(),
  directory: z.string().min(1).max(4096).optional(),
  project: z.string().min(1).max(4096).optional(),
  toolLimit: z.number().int().min(0).max(10000).optional(),
}))

/** Ack result: `UsageWasteReport` for the inclusive local-day range, in the same scopes as `usage.query`. */
export const UsageWasteQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("usage.waste"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: z.enum(["global", "project", "directory"]).optional(),
  directory: z.string().min(1).max(4096).optional(),
  project: z.string().min(1).max(4096).optional(),
}))

/** Graceful stop. Refused with `busy` while any turn is running unless `force` is set. */
export const DaemonShutdown = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("daemon.shutdown"),
  force: z.boolean().optional(),
  /** Busy: instead of refusing, stop as soon as the running turns and jobs end (a restart that cuts nothing). Ack `{ pending: true }`. */
  whenIdle: z.boolean().optional(),
}))

/** Read-only. Ack: `DaemonInfoReport` (engine, data directory, pid, and the subscription login check when the engine uses one). */
export const DaemonInfo = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("daemon.info"),
}))

/** Local clients only (not a read-only peer command). Ack: `SandboxStatus` (the OS sandbox setting and whether this system enforces it). */
export const SandboxStatusCommand = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("sandbox.status"),
}))

/** Local clients only (never a read-only or remote peer command). Ack: `ChannelsReport`. */
export const ChannelsStatusCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("channels.status") }))
/** Local clients only. Enables or disables the chat bridge, creates a pair code or unpairs chats. Ack: `ChannelsReport`, plus `{ code, expiresAt }` for `pair`. */
export const ChannelsChangeCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("channels.change"), change: ChannelsChange }))

/** Read-only. Ack: `ModelsReport` (the catalog, role settings and, with `sessionId`, that session's choice). */
export const ModelsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("models.list"),
  sessionId: SessionId.optional(),
}))

/** Sets (or with `choice: null`, clears) a session's own model; it applies from the session's next model call. Ack: `ModelsReport`. */
export const SessionModelSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.model.set"),
  sessionId: SessionId,
  choice: ModelChoice.nullable(),
}))

/** Read-only. Ack: `AgentsReport`, the built-in and custom agents of the project (with `sessionId`, also that session's current one). */
export const AgentsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("agents.list"),
  directory: z.string().min(1).max(4096).optional(),
  sessionId: SessionId.optional(),
}))

/**
 * Selects the primary agent a session runs as (`null` = the default, `build`); it applies from the session's next turn.
 * `plan` is plan mode (it sets the session's permission mode, so every client sees `session.permission`) and `build`
 * leaves plan mode. Ack: `AgentsReport`; `target_mismatch` for an unknown, untrusted or subagent-only agent.
 */
export const SessionAgentSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.agent.set"),
  sessionId: SessionId,
  agent: z.string().min(1).max(64).nullable(),
}))

/**
 * Reads a window of the session's event log, for clients that render the newest events first. Without `before`/`after`
 * it is the newest `limit` events; `before: seq` the `limit` events just older than `seq`; `after: seq` the first `limit`
 * newer than `seq` (the two are exclusive). Events of undone turns are left out unless `includeReverted`, like
 * `visibleEvents`. Ack: `EventsWindow`. A window is also cut to what one frame can carry (`more` then says so).
 */
export const SessionEvents = lazySchema(() => z
  .strictObject({
    ...base,
    type: z.literal("session.events"),
    sessionId: SessionId,
    before: z.number().int().positive().optional(),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(EVENTS_PAGE_MAX).optional(),
    includeReverted: z.boolean().optional(),
  })
  .refine((command) => command.before === undefined || command.after === undefined, { message: "before and after are exclusive", path: ["before"] }))

/**
 * Queues a manual compaction; it runs when the session is free, like any queued message. Ack: `{ queueId }`.
 * `instructions` steer the summary and `model` runs this compaction on another model; either one makes the native
 * engine write a portable summary instead of a native checkpoint.
 */
export const SessionCompact = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.compact"),
  sessionId: SessionId,
  instructions: z.string().min(1).max(8_000).optional(),
  model: ModelChoice.optional(),
}))

/**
 * Read-only. Ack: `{ goal?: Goal, history?: Goal[] }`: the session's current goal (absent when it has none) and, with
 * `history`, its earlier goals, newest first.
 */
export const GoalGet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("goal.get"),
  sessionId: SessionId,
  history: z.boolean().optional(),
}))

/**
 * Sets the session's goal (docs/goals.md) and, when the session is free, starts working on it. A finished goal
 * (complete, budget_limited) is replaced; an unfinished one is refused with `busy` unless `replace`. An objective past
 * GOAL_INLINE_OBJECTIVE_CHARS is saved as a file and the goal points at it. Ack: `{ goal, replaced?: Goal }`.
 */
export const GoalSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("goal.set"),
  sessionId: SessionId,
  objective: GoalObjective,
  tokenBudget: GoalTokenBudget.optional(),
  replace: z.boolean().optional(),
}))

/**
 * The user's control of the current goal: `status` active (resume; also kicks a goal whose continuation stopped) or
 * paused, `objective` (edit: the agent is told on its next turn), `tokenBudget` (a number, or null for none). At least
 * one is required. Ack: `{ goal }`. Refused with `target_mismatch` when the session has no goal.
 */
export const GoalUpdate = lazySchema(() => z
  .strictObject({
    ...base,
    type: z.literal("goal.update"),
    sessionId: SessionId,
    status: z.enum(["active", "paused"]).optional(),
    objective: GoalObjective.optional(),
    tokenBudget: GoalTokenBudget.nullable().optional(),
  })
  .refine((command) => command.status !== undefined || command.objective !== undefined || command.tokenBudget !== undefined, { message: "goal.update needs a status, an objective or a tokenBudget", path: ["status"] }))

/** Removes the session's goal (kept in its history). Ack: `{ cleared: boolean }`. */
export const GoalClear = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("goal.clear"),
  sessionId: SessionId,
}))

/**
 * The user's choice on a turn paused by the provider's usage limit (docs/usage-limit.md): `schedule` (Resume at reset:
 * the daemon continues the turn when the window resets; armed by the daemon already when the reset time is known),
 * `cancel` (disarm an armed auto-resume; the pause stays open), `snooze` (hide the bar until the reset), `resume` (continue
 * now) or `dismiss` (forget the pause). Ack: `{ state, resetsAt? }`. Refused with `target_mismatch` when the session
 * has no open pause.
 */
export const UsageLimitSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("usage.limit"),
  sessionId: SessionId,
  action: UsageLimitAction,
}))

/**
 * The session's pull request watches (docs/pr-watch.md), run by the daemon through the user's own `gh`: `watch` links a PR
 * (`pr`: number, `#number`, a github.com pull URL or a branch; the session's current branch when omitted) and reads its
 * state once, `unwatch` stops one (all of the session's watches when `pr` is omitted), `list` shows them, `check` reads
 * one now without waking the session. Needs `experimental.pr_watch`; local clients only (it runs `gh` here). Ack: `{ text, watches }`.
 */
export const PrWatchControl = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("pr.watch"),
  sessionId: SessionId,
  action: z.enum(["watch", "unwatch", "list", "check"]),
  pr: z.string().min(1).max(300).optional(),
}))

/**
 * The PR reviewer (docs/pr-review.md), run by the daemon through the user's own `gh`: `watch-repo` reviews every new pull request and
 * new head of the session's repository (`directory` when given), `unwatch-repo` stops that, `review` reviews one PR now (`pr`: a
 * number, `#number` or a github.com pull URL; the current branch's PR when omitted), `list` shows the watches, `publish-on` and
 * `publish-off` answer the one question asked before the first post to a repository; `role` is whose PRs a `watch-repo` takes. Notices go to `sessionId`. Needs
 * `experimental.pr_review`; local clients only. Ack: `{ text, watches }`.
 */
export const PrReviewControl = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("pr.review"),
  sessionId: SessionId,
  action: z.enum(["watch-repo", "unwatch-repo", "review", "list", "publish-on", "publish-off"]),
  directory: z.string().min(1).max(4096).optional(),
  pr: z.string().min(1).max(300).optional(),
  /** `watch-repo` only: `all` reviews every PR, `requested` only the ones that request this daemon's gh login; unset, the repo config's `reviewers`. */
  role: z.enum(["all", "requested"]).optional(),
}))

/** Applies from the next tool call of the session; every subscribed client sees `session.permission`. */
export const SessionPermissionSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.permission.set"),
  sessionId: SessionId,
  mode: PermissionMode,
}))

/**
 * Scripted-run limits of one session, kept in daemon memory (never persisted, gone when the session is deleted or the
 * daemon stops) and read by the native engine before each turn. Every field only narrows what the session may do:
 * `tools` is an allow-list intersected with the tools the agent and permission rules already allow, `excludeTools`
 * removes more, `offline` removes the tools that need the network, `noContextFiles` keeps the instruction files
 * (AGENTS.md and the like) out of the system prompt, `maxSteps` caps model calls per turn (the turn
 * fails with code `max_steps`). `systemPrompt` replaces the project system prompt, `appendSystemPrompt` extends it.
 * `addDirs` is the one field that widens, for this session only: absolute directories treated like
 * `additionalDirectories` (local clients only; the daemon refuses it from a remote connection).
 * Fields left out keep their value; `null` clears one. Ack: `{ limits }`.
 */
export const SessionRunConfigure = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.run.configure"),
  sessionId: SessionId,
  maxSteps: z.number().int().min(1).max(1_000).nullable().optional(),
  tools: z.array(z.string().min(1).max(100)).max(200).nullable().optional(),
  excludeTools: z.array(z.string().min(1).max(100)).max(200).nullable().optional(),
  offline: z.boolean().nullable().optional(),
  noContextFiles: z.boolean().nullable().optional(),
  addDirs: z.array(z.string().min(1).max(4096)).max(20).nullable().optional(),
  systemPrompt: z.string().max(MAX_INLINE_TEXT).nullable().optional(),
  appendSystemPrompt: z.string().max(MAX_INLINE_TEXT).nullable().optional(),
}))

/** Read-only. Ack: `{ grants: PermissionGrant[] }`, the tools the user approved "for this session" (oldest first). */
export const PermissionsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("permissions.list"),
  sessionId: SessionId,
}))

/** Takes back one session grant (by `grantId`) or all of them. Ack: `{ revoked: number }`; `target_mismatch` for an unknown grant id. */
export const PermissionsRevoke = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("permissions.revoke"),
  sessionId: SessionId,
  grantId: z.union([z.string().min(1).max(200), z.literal("all")]),
}))

/**
 * Approves one retry of the call the permission reviewer last denied in the session (Codex `/approve`): the next identical
 * call runs once without the reviewer or a prompt. Local clients only. Ack: `{ tool, summary, reason }`; `target_mismatch`
 * when the reviewer has denied nothing recently.
 */
export const PermissionsRetry = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("permissions.retry"),
  sessionId: SessionId,
}))

/**
 * Ack result: `{ prompts: string[], entries: { id, kind, text, at }[] }`, distinct, newest first, for ↑ recall in a project
 * (`kind` is sent, command, shell or draft). Local clients only: a peer or remote connection is refused (`forbidden`).
 */
export const PromptHistory = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("prompt.history"),
  directory: z.string().min(1).max(4096),
  limit: z.number().int().positive().max(2000).optional(),
}))

/** Ack result: `{ kept?: kind }`. Adds what the user typed in a client (a slash command, a discarded draft) to the project's recall list; secrets become markers, blank or marker-only text is not stored (`kept` absent). Local only. */
export const PromptRecord = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("prompt.record"),
  sessionId: SessionId,
  text: z.string().max(MAX_DRAFT_CHARS),
  kind: z.enum(["command", "draft"]),
}))

/** Ack result: `{ removed: number }`. Deletes one recall entry by `entryId`, or every draft entry of the project with `drafts: true`. Local only. */
export const PromptHistoryDelete = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("prompt.history.delete"),
  directory: z.string().min(1).max(4096),
  entryId: z.number().int().positive().optional(),
  drafts: z.literal(true).optional(),
}).refine((command) => (command.entryId === undefined) !== (command.drafts === undefined), { message: "give an entryId or drafts: true", path: ["entryId"] }))

/** Ack: `{ branch?: string; detached?: boolean }` read from `.git/HEAD` (no git process); empty when `directory` is not in a repository. */
export const GitBranch = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("git.branch"),
  directory: z.string().min(1).max(4096),
}))

/**
 * Read-only fuzzy file/directory search under `directory`, for the `@` mention picker. Ack: `{ files: FileEntry[] }`,
 * ranked best match first; an empty `query` lists entries unranked. Never reaches outside `directory`.
 */
export const FilesSearch = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("files.search"),
  directory: z.string().min(1).max(4096),
  query: z.string().max(300),
  limit: z.number().int().positive().max(200).optional(),
}))

/** Ack result: `StorageReport`. */
export const StorageReportQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("storage.report"),
}))

/**
 * Removes sessions idle for `olderThanDays` (default: the retentionDays setting, else 90; 0 = none),
 * then orphan blobs, then checkpoints the WAL. `vacuum` also rewrites the database file (needs free disk).
 * Never touches a session with an active turn, a queued message, a live loop or an open view. Ack: `StorageCleanResult`.
 */
export const StorageClean = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("storage.clean"),
  olderThanDays: z.number().int().min(0).max(36_500).optional(),
  dryRun: z.boolean().optional(),
  vacuum: z.boolean().optional(),
  /** Also moves old data into the compact forms (compression, shared snapshot content) and drops the streaming deltas of finished messages in sessions idle `deltaIdleDays` (default 3). */
  compact: z.boolean().optional(),
  deltaIdleDays: z.number().int().min(0).max(3650).optional(),
  /** Also removes the daemon's merged, clean, unused worktrees idle `worktreeIdleDays` (default 14) and old trash. Local only. */
  worktrees: z.boolean().optional(),
  worktreeIdleDays: z.number().int().min(0).max(3650).optional(),
}))

/** Lists the worktrees the daemon created (size, state, whether cleaning would remove them) and the trash. Local only. Ack: `StorageWorktreesReport`. */
export const StorageWorktrees = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("storage.worktrees"),
  idleDays: z.number().int().min(0).max(3650).optional(),
}))

/** Ack result: `ContextReport`; `invalid_command` when the engine cannot report its context. */
export const ContextQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("context.query"),
  sessionId: SessionId,
}))

export const ContextRecent = lazySchema(() => z.strictObject({ ...base, type: z.literal("context.recent"), sessionId: SessionId, limit: z.number().int().min(1).max(100).optional() }))
/**
 * Ack result: `SystemReport`. `generate` answers with a page of the schema entry list (`facts.contract.index`; `index` picks
 * the page, default 0); `entry` (one frame kind or command, e.g. `command:tui.query`) returns that piece's schema and
 * `page` one byte-bounded slice of the whole document (`facts.contract.page`), so no reply depends on the full schema
 * fitting one frame. The three are ignored by other operations.
 */
export const SystemQuery =lazySchema(() => z.strictObject({ ...base, type: z.literal("system.query"), directory: z.string().min(1).max(4096), operation: z.enum(["status", "doctor", "check", "toolchain", "config-paths", "adapter-status", "config-layers", "precedence", "ai-env", "ai-status", "generate"]), entry: z.string().min(1).max(200).optional(), page: z.number().int().min(0).max(1000).optional(), index: z.number().int().min(0).max(1000).optional() }))
export const FilesQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("files.query"), directory: z.string().min(1).max(4096), operation: z.enum(["files", "tree", "search"]), query: z.string().max(1000).optional(), glob: z.array(z.string().min(1).max(500)).max(20).optional(), limit: z.number().int().min(1).max(10000).optional() }))

/** Ack result: `ChangesReport`; error `not_git` when the directory is not inside a repository. */
export const ChangesQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("changes.query"),
  directory: z.string().min(1).max(4096),
}))

/** Session-scope memories in a listing or search: one session's (its id) or every session's of the directory (`all`, for management views). Absent = none, so user and project views are unchanged. */
const MemorySessions = lazySchema(() => z.union([SessionId, z.literal("all")]))

/** Ack result: `{ memories: MemoryEntry[] }` — user scope plus the project scope of `directory` (and session-scope memories per `session`). */
export const MemoryList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.list"),
  directory: z.string().max(4096).optional(),
  status: MemoryStatus.optional(),
  session: MemorySessions.optional(),
}))

/**
 * User-authored memories are saved directly; the agent's go through the category policy (pending, saved or dropped).
 * Session scope needs `sessionId`. Ack: `{ memoryId }`.
 */
export const MemoryAdd = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.add"),
  scope: MemoryScope,
  directory: z.string().max(4096).optional(),
  sessionId: SessionId.optional(),
  text: z.string().min(1).max(2_000),
  category: z.string().max(64).optional(),
  pinned: z.boolean().optional(),
}))

/**
 * Edit, approve (pending → saved), reject/archive, pin or unpin (saved memories only; at most MAX_PINNED_MEMORIES).
 * `scope` moves the memory to another scope keeping its id, text, status and graph links: project needs `directory`,
 * session needs `sessionId` of an existing session (its project becomes the memory's directory), user takes neither.
 * A pending Dream revision (update/archive) cannot change scope. A pinned memory must fit the pin cap of its new place.
 */
export const MemoryUpdate = lazySchema(() => z
  .strictObject({
    ...base,
    type: z.literal("memory.update"),
    memoryId: MemoryId,
    text: z.string().min(1).max(2_000).optional(),
    category: z.string().max(64).optional(),
    status: MemoryStatus.optional(),
    pinned: z.boolean().optional(),
    scope: MemoryScope.optional(),
    directory: z.string().min(1).max(4096).optional(),
    sessionId: SessionId.optional(),
  })
  .refine((command) => command.scope !== "project" || command.directory !== undefined, { message: "project scope needs a directory", path: ["directory"] })
  .refine((command) => command.scope !== "session" || command.sessionId !== undefined, { message: "session scope needs a sessionId", path: ["sessionId"] })
  .refine((command) => command.scope !== undefined || (command.directory === undefined && command.sessionId === undefined), { message: "directory and sessionId only go with scope", path: ["scope"] })
  .refine((command) => command.scope !== "user" || (command.directory === undefined && command.sessionId === undefined), { message: "user scope takes neither directory nor sessionId", path: ["scope"] })
  .refine((command) => command.scope !== "project" || command.sessionId === undefined, { message: "project scope takes no sessionId", path: ["sessionId"] })
  .refine((command) => command.scope !== "session" || command.directory === undefined, { message: "session scope takes its directory from the session", path: ["directory"] }))

/** Read-only. Ack: `{ categories: MemoryCategoryInfo[] }` with the policy in force for each. */
export const MemoryCategories = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.categories"),
}))

/** Sets what happens to agent proposals in a category (auto = saved, review = Pending, never = dropped). Ack: `{ categories }`. */
export const MemoryPolicySet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.policy"),
  category: z.enum(MEMORY_CATEGORY_IDS),
  policy: z.enum(MEMORY_POLICIES),
}))

/** Ack: `{ mode, suggestions: EvolutionSuggestion[], observed }` — Evolution's mode, its suggestions for `directory` (newest first, last 50) and what it has seen there. */
export const EvolutionList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("evolution.list"),
  directory: z.string().min(1).max(4096),
  status: z.enum(["pending", "accepted", "rejected", "blocked", "rolled_back"]).optional(),
}))

/**
 * Accepts or rejects a suggestion. Accepting a `skill` writes `.mendcode/skills/<name>/SKILL.md` in its project
 * (never overwriting one); an `instruction` is only marked accepted and its text is in the reply. Ack: `{ suggestion, path? }`.
 */
export const EvolutionResolve = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("evolution.resolve"),
  suggestionId: z.number().int().positive(),
  decision: z.enum(["accept", "reject"]),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}))

export const MemoryDelete = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.delete"),
  memoryId: MemoryId,
}))

/** Full-text search over saved memories visible from `directory`. Ack: `{ memories: MemoryEntry[] }`. */
export const MemorySearch = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.search"),
  query: z.string().min(1).max(500),
  directory: z.string().max(4096).optional(),
  session: MemorySessions.optional(),
  limit: z.number().int().positive().max(100).optional(),
}))

/** Read-only. Ack: `MemoryGraphReport` for the saved memories visible from `directory` (profile-aware). */
export const MemoryGraph = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.graph"),
  directory: z.string().max(4096).optional(),
}))

/** Links two saved memories (replacing any link between them). Ack: `{ link }`. */
export const MemoryLinkSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.link"),
  from: MemoryId,
  to: MemoryId,
  kind: MemoryLinkKind,
}))

/** Removes the link between two memories, whichever way it points. Ack: `{ removed: boolean }`. */
export const MemoryUnlink = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("memory.unlink"),
  from: MemoryId,
  to: MemoryId,
}))

/** One file's diff with a larger byte budget, for files the report cut. Ack: `ChangedFile` (or `{}` if unchanged now). */
export const ChangesFile = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("changes.file"),
  directory: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
}))

/**
 * Stores a local file (an image dropped or pasted as a path) in the blob store for the next
 * `user.submit`. Ack: `{ attachment: BlobRef, name }`; `invalid_command` when it is missing, too large
 * or not a supported image/PDF. PDFs are capped at 5 MiB; existing image limits are unchanged.
 */
export const AttachmentAdd = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("attachment.add"),
  path: z.string().min(1).max(4096),
}))

/**
 * Stores bytes the client sends (base64, at most ATTACHMENT_PUT_MAX_BASE64 characters) in the blob store for the next
 * `user.submit`; nothing is read from the machine. Same type check as `attachment.add` (PNG, JPEG, GIF, WebP or PDF by
 * their bytes); a `.txt` name also takes UTF-8 text (a long paste, `text/plain`, up to TEXT_PUT_MAX_BYTES). Ack:
 * `{ attachment: BlobRef, name }`; `invalid_command` for other content.
 *
 * `part` sends one file in pieces, for text longer than one frame carries: pieces of one `upload` come in order from index 0,
 * each acked with `{ received }`, and the one marked `last` is checked and stored as a whole and acked like a single put.
 */
export const ATTACHMENT_PUT_MAX_BASE64 = 190_000
export const AttachmentPut = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("attachment.put"),
  name: z.string().min(1).max(255),
  data: z.string().min(1).max(ATTACHMENT_PUT_MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  part: z.strictObject({ upload: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), index: z.number().int().min(0).max(63), last: z.boolean() }).optional(),
}))

/**
 * Reads an image from the system clipboard and stores it like `attachment.add`. Ack:
 * `{ attachment: BlobRef, name }`; `invalid_command` when the clipboard has no image, the image is too
 * large, or the platform has no supported clipboard tool.
 */
export const AttachmentClipboard = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("attachment.clipboard"),
  text: z.boolean().optional(),
}))

/**
 * One chunk of an image or document the session already holds (a user attachment, a tool's image), for drawing it in the
 * transcript. Only blobs the session's own events reference are served, never a path; local clients only. Ack:
 * `{ sha256, mime, bytes, offset, data (base64, at most ATTACHMENT_READ_CHUNK bytes), done }`; `target_mismatch` for an unknown blob.
 */
export const ATTACHMENT_READ_CHUNK = 96 * 1024
export const AttachmentRead = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("attachment.read"),
  sessionId: SessionId,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().nonnegative().optional(),
}))

/**
 * Classifies one pasted/dropped local path for the prompt. An image (checked by its bytes first,
 * regardless of location) becomes an attachment like `attachment.add`; a non-image file inside
 * `directory` becomes a `mention` (its project-relative path, for the client to insert as `@path`); a
 * non-image file elsewhere is inlined as `text` when it is at most 200 KB and valid UTF-8. Ack:
 * `{ kind: "image" | "document", attachment: BlobRef, name } | { kind: "mention", path } | { kind: "text", name, content }`.
 * PDFs are sniffed before text and stored as documents (5 MiB cap). Project directories become mentions;
 * external directories become bounded text listings. `invalid_command` when missing, too large or unreadable.
 */
export const AttachmentPaste = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("attachment.paste"),
  path: z.string().min(1).max(4096),
  directory: z.string().max(4096).optional(),
  allowDirectory: z.boolean().optional(),
}))

/** Ack: `{ commands: Array<{ name, description, argumentHint, source }> }` from .mendcode/commands and the user folder. */
export const CustomCommandsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("commands.list"),
  directory: z.string().min(1).max(4096),
}))

/** Expands a custom command with its arguments. Ack: `{ prompt }`; `target_mismatch` when unknown. */
export const CustomCommandExpand = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("commands.expand"),
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(200),
  args: z.string().max(MAX_INLINE_TEXT),
}))

/** Per-project scratchpad, persisted by the daemon and excluded from model history. */
export const ScratchpadGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("scratchpad.get"), directory: z.string().min(1).max(4096) }))
export const ScratchpadSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("scratchpad.set"), directory: z.string().min(1).max(4096), text: z.string().max(8_000) }))

/**
 * The project backlog (feature `backlog`): the user's own pending items for a project, kept across sessions. Result of both:
 * `{ directory, items }` (BacklogReport); an `add` also returns `added`, the new item's id. `backlog.change` is the user's
 * alone: a session's own shell may read the list and never write it (agent-origin.ts).
 */
export const BacklogGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("backlog.get"), directory: z.string().min(1).max(4096) }))
const backlogId = z.number().int().min(1).max(1_000_000_000)
export const BacklogChange = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("backlog.change"),
  directory: z.string().min(1).max(4096),
  change: z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("add"),
      text: z.string().min(1).max(BACKLOG_LIMITS.text),
      origin: z.strictObject({ sessionId: z.string().min(1).max(100).optional(), path: z.string().min(1).max(BACKLOG_LIMITS.path).optional(), commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional() }).optional(),
    }),
    z.strictObject({ op: z.enum(["done", "reopen", "remove"]), id: backlogId }),
    z.strictObject({ op: z.literal("clear-done") }),
  ]),
}))

/** Ack: `{ settings }`. */
export const SettingsGet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("settings.get"),
}))

export const AcpRegistry = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("acp.registry"),
  operation: z.enum(["list", "add"]),
  agentId: z.string().min(1).max(64).optional(),
}).refine((value) => value.operation === "list" || value.agentId !== undefined, "agentId required to add"))

/** Merges `patch` (a `null` field resets it to default). Ack: `{ settings }`; everyone gets `settings.changed`. */
export const SettingsSet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("settings.set"),
  patch: z.record(z.string(), z.unknown()),
}))

/** Read-only: never starts a server. Ack: `McpStatusReport` (configured servers of `directory` plus config issues). */
export const McpStatus = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("mcp.status"),
  directory: z.string().min(1).max(4096),
}))

/** Stops and restarts one server with the current config. Ack: `{ server: McpServerStatus }` (a failed start is reported in it). */
export const McpRestart = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("mcp.restart"),
  directory: z.string().min(1).max(4096),
  server: z.string().min(1).max(200),
}))

/** Starts OAuth and returns `{ url }`; cancel stops it, forget returns `{ server }`. */
export const McpAuth = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("mcp.auth"),
  directory: z.string().min(1).max(4096),
  server: z.string().min(1).max(200),
  action: z.enum(["start", "cancel", "forget"]).optional(),
}))

/** Lists the custom tools of a project root (and the user's), trusted or not. Ack: `CustomToolsReport`. */
export const ToolsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("tools.list"),
  directory: z.string().min(1).max(4096),
}))

/** Trusts (or stops trusting) the project's `.mendcode/tools` for `directory`. Ack: `CustomToolsReport`; everyone gets `settings.changed`. */
export const ToolsTrust = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("tools.trust"),
  directory: z.string().min(1).max(4096),
  trusted: z.boolean(),
}))

/**
 * Lists the extensions (TypeScript modules: hooks, tools, commands, terminal slots) of a project root: the user's,
 * packages' and the project's own. Loads them on first use; project ones only when the directory is trusted
 * (`tools.trust`). Ack: `ExtensionsReport`.
 */
export const ExtensionsList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("extensions.list"),
  directory: z.string().min(1).max(4096),
}))

/**
 * Lists the shell command hooks (`hooks.json`) configured for a project root: the user's, packages' and the project's own,
 * which of them run (project ones only when the directory is trusted, `tools.trust`), the recent runs, and what in the
 * project still waits for trust. Local clients only; never a read-only (remote) command. Ack: `HooksReport`.
 */
export const HooksList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("hooks.list"),
  directory: z.string().min(1).max(4096),
}))

export const ExtensionsReload = lazySchema(() => z.strictObject({ ...base, type: z.literal("extensions.reload"), directory: z.string().min(1).max(4096) }))
export const ExtensionsReportUi = lazySchema(() => z.strictObject({ ...base, type: z.literal("extensions.report"), revision: z.number().int().nonnegative(), errors: z.array(z.string().max(1000)).max(64) }))
/** Turns an extension off (or on) by name: persisted in `disabledExtensions`, applied at once. Local clients only. Ack: the reload report. */
export const ExtensionsDisable = lazySchema(() => z.strictObject({ ...base, type: z.literal("extensions.disable"), directory: z.string().min(1).max(4096), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), disabled: z.boolean() }))
/**
 * The extension flags a CLI invocation passed (`--name` true, `--name=value` a string) for the session it opens or runs, checked against
 * what the session's extensions declare (`api.registerFlag`): an unknown name or a wrong type refuses them all. Local clients only.
 * Ack: `{ flags }`, the values kept with the session.
 */
export const ExtensionsFlags = lazySchema(() => z.strictObject({ ...base, type: z.literal("extensions.flags"), sessionId: SessionId, flags: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.union([z.string().min(1).max(300), z.boolean()])).refine((flags) => Object.keys(flags).length <= 16, "at most 16 extension flags") }))
export const ExtensionsExport = lazySchema(() => z.strictObject({ ...base, type: z.literal("extensions.export"), directory: z.string().min(1).max(4096) }))

/** Lists installed packages for a project root (the user's and the project's). Ack: `PackagesReport`. */
export const PackagesList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.list"),
  directory: z.string().min(1).max(4096),
}))

/**
 * Installs a package from a local folder or git (`github:owner/repo#ref`, `git:<url>`, `https://…`). The daemon
 * stages, audits (manifest, links, secrets, size) and moves it into place. Ack: `PackagesReport` after the install.
 */
export const PackagesInstall = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.install"),
  directory: z.string().min(1).max(4096),
  source: z.string().min(1).max(2048),
  scope: z.enum(["user", "project"]),
  replace: z.boolean().optional(),
}))

/**
 * Saves the user's stored terminal profile as a user package named `name` whose activation sets those keys (`activate.tuiProfile`,
 * keys a package may set only), then installs it like `packages.install`: a look to switch to later from `/packages`. It copies no
 * code, keybindings or settings. Ack: `PackagesReport`.
 */
export const PackagesCapture = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.capture"),
  directory: z.string().min(1).max(4096),
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  replace: z.boolean().optional(),
}))

/** Removes an installed package: it moves to the Trash (restorable with `packages.restore` for 30 days) unless `purge` deletes it. Ack: `PackagesReport`. */
export const PackagesRemove = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.remove"),
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(64),
  scope: z.enum(["user", "project"]),
  purge: z.boolean().optional(),
}))

/** Brings the newest trashed copy of a removed package back (disabled until enabled). Ack: `PackagesReport`. */
export const PackagesRestore = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.restore"),
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(64),
  scope: z.enum(["user", "project"]),
}))

/**
 * Turns an installed package on or off without removing it. Enabling checks the package's `compatibility` and, when it
 * brings a look, claims it: another package that owns the look is replaced only with `switch`. Ack: `PackagesReport`;
 * everyone gets `settings.changed`.
 */
export const PackagesEnable = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("packages.enable"),
  directory: z.string().min(1).max(4096),
  key: z.string().min(1).max(200),
  enabled: z.boolean(),
  switch: z.boolean().optional(),
}))

/**
 * Starts or stops receiving `status.line` for a project. The daemon runs its status scripts only while at least one
 * connection watches it; closing the connection stops watching. Ack: `{}`.
 */
export const StatusWatch = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("status.watch"),
  directory: z.string().min(1).max(4096),
  watching: z.boolean(),
}))

/** Model recipes of every extension layer for a project, and which one matches the current roles. Ack: `RecipesReport`. */
export const RecipesList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("recipes.list"),
  directory: z.string().min(1).max(4096),
}))

/** Replaces the settings' model roles with a recipe's (each choice checked against the catalog). Ack: `RecipesReport`; everyone gets `settings.changed`. */
export const RecipesApply = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("recipes.apply"),
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(40),
}))

/** Read-only. Ack: `{ providers: ProviderInfo[] }`; keys never appear, only `hasKey` and a masked `keyTail`. */
export const ProvidersList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("providers.list"),
}))

/**
 * Adds or updates one API-key provider in providers.json (fields left out keep their value; `apiKey: ""` and `models: []`
 * clear theirs). A provider that is not a preset needs `providerType` and `baseUrl`. Ack: `{ provider: ProviderInfo }`.
 */
export const ProvidersSet = lazySchema(() => z.strictObject({
  ...ProviderOptions.shape,
  ...base,
  type: z.literal("providers.set"),
  npm: ProviderSdkModule.optional(),
  /** The provider's id (`anthropic`, `openrouter`, or a name of the user's own). `id` and `type` belong to the command envelope, hence `provider` and `providerType`. */
  provider: ProviderId,
  providerType: ProviderType.optional(),
  baseUrl: ProviderBaseUrl.optional(),
  apiKey: z.string().max(4096).optional(),
  /** Name of an environment variable holding the key (read on every request). */
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  headers: z.record(z.string().min(1).max(100), z.string().max(2048)).optional(),
  enabled: z.boolean().optional(),
  models: z.array(ProviderModel).max(1000).optional(),
  compaction: CompactionOverride.nullable().optional(),
}))

/** Removes a provider's entry from providers.json (a preset enabled by an environment key stays until the key goes). Ack: `{ providers: ProviderInfo[] }`. */
export const ProvidersRemove = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("providers.remove"),
  provider: ProviderId,
}))

/** One tiny streaming request (8 output tokens) to check the key and the endpoint; run by a user action only. Ack: `ProviderTestResult`. */
export const ProvidersTest = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("providers.test"),
  provider: ProviderId,
  /** A model of the provider to try; the first listed one when absent. */
  model: z.string().min(1).max(66).optional(),
}))

/** Asks the provider for its model list (`GET /models`, 10 s limit) and caches it in providers.json. Ack: `{ provider: ProviderInfo }`. */
export const ProvidersRefresh = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("providers.refresh"),
  provider: ProviderId,
}))

/** Theme files (`themes/<name>.json`) of every extension layer for a project, parsed but not validated. Ack: `ThemesReport`. */
export const ThemesList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("themes.list"),
  directory: z.string().min(1).max(4096),
}))

/** Starts a Dream run for a project as a background job. Ack: `{ runId }`; progress via `dream.changed`. */
export const DreamStart = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("dream.run"),
  directory: z.string().min(1).max(4096),
}))

/**
 * `/btw`: a side question about a session. It reads the conversation but never enters it and never waits for or
 * interrupts the running turn. Ack: `{ text }`, the answer.
 */
export const AsideGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.aside.get"), sessionId: SessionId }))
export const AsideClear = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.aside.clear"), sessionId: SessionId }))
export const GitStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("git.status"), directory: z.string().min(1).max(4096) }))
/**
 * The Galaxy panel's code mode: the project's most connected files and the import edges among them. An explicit request for the code
 * graph, so it builds or refreshes the index of `directory`; the home folder and above are refused without indexing. Ack: `CodegraphOverview`.
 */
export const CodegraphOverviewCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("codegraph.overview"), directory: z.string().min(1).max(4096), limit: z.number().int().min(1).max(CODEGRAPH_OVERVIEW.files).optional() }))
export const SidebarGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("sidebar.get"), directory: z.string().min(1).max(4096) }))
export const SidebarUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("sidebar.update"), directory: z.string().min(1).max(4096), change: SidebarAction }))

export const SessionAside = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.aside"),
  sessionId: SessionId,
  text: z.string().min(1).max(4_000),
}))

/** Ack: `{ runs: DreamRun[] }`, newest first (last 20; only the newest 5 carry their `report`). With `runId`, just that run, report included. */
export const DreamList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("dream.list"),
  directory: z.string().max(4096).optional(),
  runId: z.number().int().positive().optional(),
}))

/**
 * Ack: `{ loop }`. The loop gets its own root session; with `runNow` the first run starts immediately.
 * `template` (a `loop.templates` id) fills whatever is omitted (objective, trigger, budget, criteria, report-only);
 * without a template, objective, trigger and budget are required.
 */
const loopFields = lazyValue(() => ({
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(8_000).optional(),
  criteria: z.string().max(4_000).optional(),
  trigger: LoopTrigger.optional(),
  budget: LoopBudget.optional(),
  runNow: z.boolean().optional(),
  checks: z.array(z.string().min(1).max(300)).max(5).optional(),
  /** Goal loops default to "independent". */
  audit: z.enum(["independent", "none"]).optional(),
  template: z.string().min(1).max(40).optional(),
  /** A run reports but never edits: its session is read-only (no write or execute tools). */
  reportOnly: z.boolean().optional(),
  /** "worktree": each run works in its own git worktree (the directory must be a git checkout). */
  workspace: z.enum(["in-place", "worktree"]).optional(),
  costBudget: LoopCostBudget.optional(),
  rubric: LoopRubric.optional(),
  approvalPolicy: LoopApprovalPolicy.optional(),
}))

export const LoopCreate = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.create"),
  directory: z.string().min(1).max(4096),
  ...loopFields(),
}).refine((command) => command.template !== undefined || (command.objective !== undefined && command.trigger !== undefined && command.budget !== undefined), {
  message: "without a template, objective, trigger and budget are required",
  path: ["template"],
}))

/** Partial edit. Identity, directory, root session and lifecycle are retained. Ack: `{ loop }`. */
export const LoopUpdate = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.update"),
  loopId: LoopId,
  ...z.strictObject(loopFields()).partial().shape,
}))

/** Read-only. Ack: `{ templates: LoopTemplateInfo[] }`. */
export const LoopTemplates = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.templates") }))

/**
 * Fires an `external` loop (from cron, CI, a script: `mendcode loop fire <id>`). Starts a run now; while a run is in
 * progress the fire waits and starts the next run as soon as the loop is free (several fires in that time count once).
 * `note` (what happened, e.g. the CI run URL) is shown to the run. Ack: `{ loop }`; refused for a loop that is not external,
 * or that is paused, blocked, stopped or finished.
 */
export const LoopFire = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.fire"),
  loopId: LoopId,
  note: z.string().min(1).max(500).optional(),
}))

/** Ack: `{ loops: Loop[] }`, newest activity first; all projects when `directory` is omitted. */
export const LoopList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.list"),
  directory: z.string().max(4096).optional(),
}))

/** pause | resume | stop | run (now) | delete. Ack: `{ loop }` (delete: `{}`). */
export const LoopControl = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.control"),
  loopId: LoopId,
  /** accept: the user declares the goal met (needs `reason`, kept on the loop); not while a run is in progress. */
  action: z.enum(["pause", "resume", "stop", "run", "delete", "accept"]),
  reason: z.string().min(1).max(500).optional(),
}))

/** User review of one completed run. Not reachable from the agent's loop tool. */
export const LoopReview = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.review"),
  loopId: LoopId,
  action: z.enum(["waive", "accept", "approve"]),
  run: z.number().int().positive(),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  gateId: z.string().min(1).max(300).optional(),
  approvalAction: LoopApprovalAction.optional(),
  reviewer: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
}))

/**
 * Ack: `{ workflow: WorkflowSummary }`. `plan` is inline or `{ ref }` to a saved plan; a contract named by the plan is
 * resolved from the extension layers and frozen into the run. The applied permission is min(plan, `permission` ?? the setting).
 */
export const WorkflowStart = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.start"),
  directory: z.string().min(1).max(4096),
  plan: WorkflowPlanInput,
  permission: z.enum(["ask", "edits", "full"]).optional(),
  originSessionId: SessionId.optional(),
  startKey: z.string().trim().min(1).max(200).optional(),
  loopId: z.string().min(1).max(200).optional(),
  loopRunId: z.string().min(1).max(200).optional(),
}))

/** Read-only. Ack: `{ workflows: WorkflowSummary[] }`, newest activity first; all projects when `directory` is omitted. */
export const WorkflowList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.list"),
  directory: z.string().max(4096).optional(),
}))

/** Read-only. Ack: `{ workflow: WorkflowRun }`. */
export const WorkflowGet = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.get"),
  workflowId: WorkflowId,
}))

/**
 * pause (drain) | resume | stop | retry (one task and its dependents) | verify (the contract again) | accept (override) | delete (finished only)
 * | approve / reject (a human task that waits for the user; the reason is its note).
 * Ack: `{ workflow }` (delete: `{}`).
 */
export const WorkflowControl = lazySchema(() => z
  .strictObject({
    ...base,
    type: z.literal("workflow.control"),
    workflowId: WorkflowId,
    action: z.enum(["pause", "resume", "stop", "retry", "verify", "accept", "delete", "approve", "reject"]),
    /** retry, approve, reject: the task. */
    taskId: WorkflowSlug.optional(),
    /** accept: why the user declares the workflow done; kept on the run. */
    reason: z.string().min(1).max(500).optional(),
  })
  .refine((command) => !["retry", "approve", "reject"].includes(command.action) || command.taskId !== undefined, { message: "retry, approve and reject need a taskId", path: ["taskId"] })
  .refine((command) => command.action !== "accept" || command.reason !== undefined, { message: "accept needs a reason", path: ["reason"] }))

/** Read-only, creates nothing. Ack: `{ problems: string[], summary }`. */
export const WorkflowPreview = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.preview"),
  directory: z.string().min(1).max(4096),
  plan: WorkflowPlanInput,
}))

/** Saves a frozen v2 plan/contract; never creates a run. Ack: `{ receipt: WorkflowRevisionReceipt }`. */
export const WorkflowSave = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.save"),
  directory: z.string().min(1).max(4096),
  plan: WorkflowPlanInput,
  definitionId: WorkflowDefinitionId.optional(),
  name: WorkflowDefinition.shape.name.optional(),
  description: WorkflowDefinition.shape.description.optional(),
  source: WorkflowDefinition.shape.source.optional(),
  saved: z.boolean().optional(),
  ownerSessionId: SessionId.optional(),
  restPlan: RestWorkflowPlan.optional(),
}))
/** Metadata only; revision plans travel through workflow.revision.get. */
export const WorkflowDefinitions = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.definitions"), directory: z.string().min(1).max(4096), limit: z.number().int().min(1).max(100).default(50) }))
export const WorkflowRevisionGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.revision.get"), directory: z.string().min(1).max(4096), revisionId: WorkflowRevisionId }))

/** Read-only. Ack: `{ tasks: BackgroundTaskEntry[] }`, running first then the latest finished; one session's or all. */
export const SessionDetach = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.detach"), sessionId: SessionId }))
/**
 * Agent control (docs/agents.md). `pause`: the running turn finishes, then nothing new starts (queued prompts, notices,
 * goal steps wait) until `resume`; `resume` also releases a user-cancel hold; `stop` cancels the running turn and its
 * running child tasks and holds the queue. Ack: `{ paused, cancelledTurn, cancelledChildren }`. Not read-only for peers.
 */
export const SessionControlAction = z.enum(["pause", "resume", "stop"])
export const SessionControl = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.control"), sessionId: SessionId, action: SessionControlAction }))
export type SessionControlAction = z.infer<typeof SessionControlAction>
export const TaskList = lazySchema(() => z.strictObject({ ...base, type: z.literal("task.list"), sessionId: SessionId.optional() }))
export const TaskRun = lazySchema(() => z.strictObject({ ...base, type: z.literal("task.run"), sessionId: SessionId, input: TaskInput }))
export const TaskStatus = lazySchema(() => z.strictObject({
  ...base, type: z.literal("task.status"), sessionId: SessionId, taskId: SessionId,
  action: z.enum(["get", "wait", "cancel", "detach"]).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
}))
export const ExtractionList = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.extraction.list"), directory: z.string().optional() }))
export const ExtractionRetry = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.extraction.retry"), jobId: z.string().min(1).max(200) }))

export const BackgroundList = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("background.list"),
  sessionId: SessionId.optional(),
}))

/** Stops what runs in the background of a session: one item by the id `background.list` gave it, or every one without `taskId`. */
export const BackgroundStop = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("background.stop"),
  sessionId: SessionId,
  taskId: z.string().min(1).max(200).optional(),
}))

export const DiagnosticsResources = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("diagnostics.resources"),
}))

export const TuiQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.query"), operation: z.enum(["status", "schema", "profile"]) }))
export const TuiChange = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.change"), input: TuiControlInput }))

export const LspQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("lsp.query"), directory: z.string().min(1).max(4096), ...LspInput.shape }))
/** Downloads a builtin language server (TypeScript, Pyright, gopls) into the data dir's LSP cache: the explicit, online counterpart of the offline provisioning. Local only. */
export const LspInstall = lazySchema(() => z.strictObject({ ...base, type: z.literal("lsp.install"), directory: z.string().min(1).max(4096), server: z.enum(["typescript", "python", "go"]) }))

export const ReviewQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("review.query"), sessionId: SessionId, query: ReviewRead }))
export const ReviewUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("review.update"), sessionId: SessionId, change: ReviewChange }))

export const MemoryModel = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.model"), directory: z.string().min(1).max(4096), input: MemoryModelInput }))
export const MemoryAssistantGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.assistant.get"), directory: z.string().min(1).max(4096) }))
export const MemoryAssistantSend = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.assistant.send"), directory: z.string().min(1).max(4096), text: z.string().trim().min(1).max(4_000), selection: MemoryAssistantSelection.optional() }))
export const MemoryAssistantClear = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.assistant.clear"), directory: z.string().min(1).max(4096) }))
export const MemoryAssistantCancel = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.assistant.cancel"), directory: z.string().min(1).max(4096) }))
/** Chat archive: `archive` sets the live thread aside and starts a new one, `list` shows the archived chats, `restore` swaps one back in, `delete` forgets one. */
export const MemoryAssistantArchiveCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.assistant.archive"), directory: z.string().min(1).max(4096), action: z.enum(["archive", "list", "restore", "delete"]), archiveId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional() }).superRefine((command, ctx) => {
  if ((command.action === "restore" || command.action === "delete") && !command.archiveId) ctx.addIssue({ code: "custom", message: "archiveId is required", path: ["archiveId"] })
}))

export const MemoryControl = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.control"), directory: z.string().min(1).max(4096), input: MemoryControlInput }))
export const DreamControl = lazySchema(() => z.strictObject({ ...base, type: z.literal("dream.control"), directory: z.string().min(1).max(4096), input: DreamControlInput }))

export const PlanReviewList = lazySchema(() => z.strictObject({ ...base, type: z.literal("plan.review.list"), sessionId: SessionId }))
export const PromptStatusQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("prompt.status"), directory: z.string().min(1).max(4096), modelID: z.string().max(200).optional() }))
export const PromptSources = lazySchema(() => z.strictObject({ ...base, type: z.literal("prompt.sources"), directory: z.string().min(1).max(4096), modelID: z.string().max(200).optional() }))
export const PromptBuild = lazySchema(() => z.strictObject({ ...base, type: z.literal("prompt.build"), directory: z.string().min(1).max(4096), mode: PromptMode.optional(), focusID: PromptFocusChoice.optional(), modelID: z.string().max(200).optional(), role: z.string().max(100).optional(), workflow: z.string().max(100).optional(), showFull: z.boolean().optional() }))
export const PromptSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("prompt.set"), directory: z.string().min(1).max(4096), mode: PromptMode.optional(), focusID: PromptFocusChoice.optional() }).refine((input) => input.mode !== undefined || input.focusID !== undefined))
export const PromptCycle = lazySchema(() => z.strictObject({ ...base, type: z.literal("prompt.cycle"), directory: z.string().min(1).max(4096) }))

/** Follow-up scratchpad for the active compaction. Empty text clears it. */
export const SessionCompactionSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.compaction.set"), sessionId: SessionId, turnId: TurnId, text: z.string().max(8_000) }))
export const PermissionsStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("permissions.status") }))
export const PermissionsSetDefault = lazySchema(() => z.strictObject({ ...base, type: z.literal("permissions.set-default"), mode: z.enum(["approval", "smart", "full_access", "ask", "edits", "full"]) }))
export const PermissionsSetReviewerRole = lazySchema(() => z.strictObject({ ...base, type: z.literal("permissions.set-reviewer-role"), role: z.enum(MODEL_ROLES) }))
export const PermissionsHistory = lazySchema(() => z.strictObject({ ...base, type: z.literal("permissions.history"), sessionId: SessionId, limit: z.number().int().min(1).max(100).optional() }))

export const SessionAgentCommandCreate = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.create"), sessionId: SessionId, targetSessionId: SessionId, request: AgentCommandRequest, expiresAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional() }))
export const SessionAgentCommandList = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.list"), sessionId: SessionId.optional(), directory: z.string().max(4096).optional(), incoming: z.boolean().optional() }))
export const SessionAgentCommandUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.update"), sessionId: SessionId, commandId: CommandId, state: z.enum(["accepted", "rejected"]) }))
export const SessionAgentCommandPolicy = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.policy") }))
export const SessionGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.get"), sessionId: SessionId }))
export const SessionInspect = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.inspect"), sessionId: SessionId, limit: z.number().int().min(0).max(50).optional() }))
export const SessionStatsCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.stats"), sessionId: SessionId }))
export const DiagnosticsSnapshot = lazySchema(() => z.strictObject({ ...base, type: z.literal("diagnostics.snapshot") }))

export const ModelsConfigGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("models.config.get"), directory: z.string().min(1).max(4096) }))
export const ModelsDefaultSet = lazySchema(() => z.strictObject({
  ...base, type: z.literal("models.default.set"), directory: z.string().min(1).max(4096),
  provider: CatalogProvider.optional(), model: z.string().min(1).max(100).optional(), preset: z.string().min(1).max(100).optional(),
  authMode: CatalogAuthMode.optional(), dryRun: z.boolean().optional(),
}).refine((input) => input.preset ? !input.provider && !input.model && !input.authMode : Boolean(input.provider && input.model), "give preset or provider and model"))
export const ProvidersCatalog = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.catalog") }))
export const ProvidersLogout = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.logout"), provider: CatalogProvider }))
export const McpAdd = lazySchema(() => z.strictObject({
  ...base, type: z.literal("mcp.add"), directory: z.string().min(1).max(4096), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  scope: z.enum(["user", "project"]), config: McpConfigInput, replace: z.boolean().optional(), dryRun: z.boolean().optional(),
}))
export const McpDebug = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.debug"), directory: z.string().min(1).max(4096), server: z.string().min(1).max(100) }))
export const McpDecide = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.decide"), directory: z.string().min(1).max(4096), server: z.string().min(1).max(100), scope: z.enum(["user", "project"]), revision: z.string().min(1).max(100), approve: z.boolean() }))
export const CacheStatusQuery = lazySchema(() => CacheTarget.extend({ ...base, type: z.literal("cache.status") }))
export const CacheSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("cache.set"), input: CacheMutation }))

export const CompoundGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("compound.get"), directory: z.string().min(1).max(4096).optional(), runId: z.string().regex(/^[a-f0-9-]{36}$/).optional() }))
export const CompoundConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("compound.configure"), config: CompoundConfig, expectedHash: z.string().length(64) }))
export const CompoundStart = lazySchema(() => z.strictObject({ ...base, type: z.literal("compound.start"), input: CompoundRunInput }))
export const CompoundCancel = lazySchema(() => z.strictObject({ ...base, type: z.literal("compound.cancel"), runId: z.string().regex(/^[a-f0-9-]{36}$/) }))

export const FormatterStatusQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("formatter.status"), directory: z.string().min(1).max(4096) }))
export const FormatterFile = lazySchema(() => z.strictObject({ ...base, type: z.literal("formatter.file"), directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }))
export const ThemeValidate = lazySchema(() => z.strictObject({ ...base, type: z.literal("theme.validate"), file: z.string().min(1).max(4096) }))
export const ThemeInstall = lazySchema(() => z.strictObject({ ...base, type: z.literal("theme.install"), file: z.string().min(1).max(4096), directory: z.string().min(1).max(4096), name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(), scope: z.enum(["user", "project"]).default("project") }))
export const ThemeSelect = lazySchema(() => z.strictObject({ ...base, type: z.literal("theme.select"), directory: z.string().min(1).max(4096), name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i), scope: z.enum(["user", "project"]).default("project") }))

export const AgentCreate = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("agent.create"),
  directory: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096).optional(),
  scope: z.enum(["user", "project"]).default("user"),
  /** Optional when `generate` is set: the model proposes the identifier. */
  name: z.string().regex(AGENT_CREATE_NAME).optional(),
  description: z.string().trim().min(1).max(300),
  mode: z.enum(["all", "primary", "subagent"]),
  permissions: z.array(z.enum(AGENT_CREATE_PERMISSIONS)).max(AGENT_CREATE_PERMISSIONS.length),
  model: z.string().min(1).max(100).regex(/^\S+$/).optional(),
  /** Opt in: the configured model (or `model`) writes identifier, when-to-use text and system prompt from `description`; any failure falls back to the deterministic file. */
  generate: z.boolean().optional(),
}))
export const AgentDebug = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("agent.debug"),
  directory: z.string().min(1).max(4096),
  name: z.string().regex(AGENT_CREATE_NAME),
  tool: z.string().min(1).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}))

/**
 * `from` picks the reader: `mendcode` (native JSON or URL), `claude-code` / `codex` (their JSONL transcripts) or `auto`
 * (the default: sniffed from the content). `latest` takes the newest transcript of `directory` from that tool's default
 * location instead of `source`.
 */
export const SessionImport = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.import"),
  directory: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096).optional(),
  from: z.enum(["auto", "mendcode", "claude-code", "codex"]).optional(),
  latest: z.boolean().optional(),
}))

/**
 * `/import setup`: reads the other tool's setup (MCP servers, Codex prompts, global instructions) and reports what could be
 * taken over; `apply` writes it, never over an existing entry and never a secret value. `only` limits what `apply`
 * writes to the items whose `setupImportKey` is listed (no `only`: everything the preview shows as new; an empty list:
 * nothing). Local only. Ack: `SetupImportReport`.
 */
export const SetupImport = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("setup.import"),
  directory: z.string().min(1).max(4096),
  from: z.enum(["auto", "claude-code", "codex"]).optional(),
  apply: z.boolean().optional(),
  only: z.array(z.string().min(1).max(400)).max(400).optional(),
}))

/**
 * `/cd`: moves an idle session (with its child sessions) to another existing directory; a relative `path` resolves
 * against the session's current directory and `~` against the home directory. Local only: a remote peer is refused.
 * Ack: `{ directory, previous }`.
 */
export const SessionCd = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.cd"), sessionId: SessionId, path: z.string().min(1).max(4096) }))

export const SessionRecallSearch =z.strictObject({ ...base, type: z.literal("session.recall.search"), sessionId: SessionId, input: SessionRecallSearchInput })
export const SessionRecallRead = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.recall.read"), sessionId: SessionId, input: SessionRecallReadInput }))
export const SessionNotes = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.notes"), sessionId: SessionId, input: SessionNotesInput }))

/** Ack result: `{ session: SessionDetail }`. Changes visibility only; restore clears the archive timestamp. */
export const SessionArchive = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.archive"),
  sessionId: SessionId,
  restore: z.boolean().optional(),
}))

/**
 * Looks for `text` in the messages (the user's and the assistant's) of sessions, newest first. `regex` reads it as a
 * regular expression (case-insensitive, at most 200 characters); otherwise it is a plain phrase, case-insensitive.
 * Only the newest 300 messages within the last 3000 events of each session are scanned and at most 200 sessions are examined. It returns message text,
 * so it is local only: refused for remote clients and not in `READ_ONLY_COMMANDS`.
 * Ack: `{ hits: [{ sessionId, snippet }] }`.
 */
export const SessionSearch = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.search"),
  text: z.string().min(1).max(200),
  regex: z.boolean().optional(),
  sessionIds: z.array(SessionId).max(200).optional(),
  directory: z.string().max(4096).optional(),
  limit: z.number().int().positive().max(100).optional(),
}))

/**
 * Overrides the context window the session is measured and auto-compacted against (`tokens`), or with `tokens: null`
 * goes back to the model's own. A window above the model's known maximum (`maxContextWindow`) is lowered to it. `always`
 * also writes (or with `tokens: null` removes) the `window` of the session model's `modelContext` setting, so every session on
 * that model gets it, and the session's own window is cleared. Ack: `{ contextWindow?, requested?, maxContextWindow?, modelWindow?,
 * clamped?, model?, saved? }` (`modelWindow`: the model list's window; `model`: the setting's key; `saved`: `set` or `removed`). Refused with `unknown_session` for an absent session.
 */
export const SessionContextWindow = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.context-window"),
  sessionId: SessionId,
  tokens: z.number().int().min(1000).max(10_000_000).nullable(),
  always: z.boolean().optional(),
}))

/**
 * The fork family of a session: every ancestor and branch it shares a lineage with, depth first from the root, with the
 * labelled messages of each. Ack: `{ current, nodes: SessionTreeNode[] }`. Read only, but it returns titles and message
 * text, so it is not in the remote read-only set.
 */
export const SessionTree = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.tree"), sessionId: SessionId }))

/**
 * Merge-back: brings what a fork did since its branch point (its user and assistant messages and command outcomes,
 * bounded by the `handoffTokenCap` setting, never summarised by a model) into the session it was forked from, as context
 * for that session's next turn. No model call is made. `sessionId` is the fork; `intoSessionId` defaults to its parent and
 * must be a session of the same fork family. Merging again only brings the turns added since the last merge. Local only:
 * it reads a session's transcript. Ack: `SessionMergeReport`; refused with `target_mismatch` when the session is not a
 * fork, `unknown_session`, or `invalid_command` when there is nothing new to bring.
 */
export const SessionMerge = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.merge"), sessionId: SessionId, intoSessionId: SessionId.optional() }))

/** Labels (bookmarks) a user message; an empty or absent `label` removes it. Ack: `{ itemId, label? }`. Refused with `target_mismatch` when the item is not a message of the session. */
export const SessionLabel = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("session.label"),
  sessionId: SessionId,
  itemId: ItemId,
  label: z.string().max(400).optional(),
}))

/**
 * A short summary of the session so far, written by the model on demand from the transcript (the aside model role).
 * Ack: `{ text, at, cached }`; the text is cached until the session grows, `refresh` writes it again.
 */
export const SessionRecap = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.recap"), sessionId: SessionId, refresh: z.boolean().optional() }))

export const SessionChildren = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.children"), sessionId: SessionId }))
export const SessionBackgroundList = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.background.list"), directory: z.string().max(4096).optional() }))
export const SessionBackgroundRegister = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.background.register"), sessionId: SessionId, ...SessionBackgroundPatch.shape }))
export const SessionBackgroundRemove = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.background.remove"), sessionId: SessionId }))
export const SessionBackgroundWriterAcquire = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.background.writer.acquire"), sessionId: SessionId, ttlMs: z.number().int().min(1).max(86_400_000).optional() }))
export const SessionBackgroundWriterRelease = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.background.writer.release"), sessionId: SessionId }))
export const SessionMetadataList = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-view.metadata.list"), directory: z.string().max(4096).optional() }))
export const SessionMetadataGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-view.metadata.get"), sessionId: SessionId }))
export const SessionMetadataPatch = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-view.metadata.patch"), sessionId: SessionId, patch: AgentViewMetadataPatch }))
export const SessionAgentCommandListBySession = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.list-by-session"), sessionId: SessionId }))
export const SessionAgentCommandPatch = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.agent-command.patch"), sessionId: SessionId, commandId: CommandId, state: AgentCommandState.optional(), error: z.string().max(4000).nullable().optional(), result: z.string().max(4000).nullable().optional() }))
export const CustomCommandExecute = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("commands.execute"),
  sessionId: SessionId,
  name: z.string().min(1).max(200),
  args: z.string().max(MAX_INLINE_TEXT),
  attachments: z.array(BlobRef).max(32).optional(),
  contextText: z.string().max(MAX_INLINE_TEXT).optional(),
  selection: z.strictObject({ model: ModelChoice.optional(), agent: z.string().min(1).max(100).optional() }).optional(),
}))

export const CustomCommandsDiscover = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("commands.discover"),
  directory: z.string().min(1).max(4096),
}))

export const ProjectControl = lazySchema(() => z.strictObject({ ...base, type: z.literal("project.control"), directory: z.string().min(1).max(4096), input: ProjectControlInput }))
export const McpCatalogQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.catalog"), directory: z.string().min(1).max(4096) }))
export const McpResourcesList = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.resources.list"), directory: z.string().min(1).max(4096) }))
export const McpResourceRead = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.resource.read"), directory: z.string().min(1).max(4096), server: z.string().min(1).max(200), uri: z.string().min(1).max(8192) }))
export const McpPromptsList = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.prompts.list"), directory: z.string().min(1).max(4096) }))
export const McpPromptGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("mcp.prompt.get"), directory: z.string().min(1).max(4096), server: z.string().min(1).max(200), name: z.string().min(1).max(200), args: z.record(z.string().max(200), z.string().max(32_000)) }))

export const ContinuityList = lazySchema(() => z.strictObject({ ...base, type: z.literal("continuity.list"), sessionId: SessionId, kind: z.enum(["job", "question"]).optional() }))
export const ContinuityGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("continuity.get"), sessionId: SessionId, recordId: z.string().min(1).max(200), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() }))
export const ContinuityCancel = lazySchema(() => z.strictObject({ ...base, type: z.literal("continuity.cancel"), sessionId: SessionId, recordId: z.string().min(1).max(200) }))
export const ContinuityWait = lazySchema(() => z.strictObject({ ...base, type: z.literal("continuity.wait"), sessionId: SessionId, recordIds: z.array(z.string().min(1).max(200)).min(1).max(12), timeoutMs: z.number().int().min(0).max(60000).optional() }))
export const WorktreeQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("worktree.query"), directory: z.string().min(1).max(4096), query: WorktreeRead }))
export const WorktreeUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("worktree.change"), directory: z.string().min(1).max(4096), change: WorktreeChange }))
export const TsmQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("tsm.query"), directory: z.string().min(1).max(4096), query: TsmRead }))
export const TsmUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("tsm.change"), directory: z.string().min(1).max(4096), change: TsmChange }))

export const SessionChanges = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.changes"), sessionId: SessionId, atItemId: ItemId.optional() }))
export const SessionSavings = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.savings"), sessionId: SessionId }))

export const WorkflowEvents = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.events"), workflowId: WorkflowId, ...LedgerQuery.shape }))
export const WorkflowArtifacts = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.artifacts"), workflowId: WorkflowId, ...LedgerQuery.shape }))
export const WorkflowReceipt = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.receipt"), workflowId: WorkflowId, ...LedgerQuery.shape }))
export const WorkflowExport = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.export"), workflowId: WorkflowId, ...LedgerQuery.shape, format: z.enum(["json", "markdown"]).optional() }))
export const LoopEvents = lazySchema(() => LoopEventsQuery.extend({ ...LedgerQuery.shape, limit: LedgerQuery.shape.limit.default(50) }))
export const LoopArtifacts = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.artifacts"), loopId: LoopId, ...LedgerQuery.shape }))
export const LoopReceipt = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.receipt"), loopId: LoopId, ...LedgerQuery.shape }))
export const LoopExport = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.export"), loopId: LoopId, ...LedgerQuery.shape, format: z.enum(["json", "markdown"]).optional() }))

export const EvolutionPromote = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("evolution.promote"),
  suggestionId: z.number().int().positive(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  policyRevision: z.string().min(1).max(64),
}))
export const EvolutionRollback = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("evolution.rollback"),
  suggestionId: z.number().int().positive(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().positive(),
}))
export const SessionDeleteMessage = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.message.delete"), ...MessageTarget }))
export const SessionDeletePart = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.part.delete"), ...MessageTarget, partId: MessagePartId }))
export const SessionUpdatePart = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.part.update"), ...MessageTarget, partId: MessagePartId, part: MessagePart }))
export const PluginsInstall = lazySchema(() => z.strictObject({ ...base, type: z.literal("plugins.install"), directory: z.string().min(1).max(4096), spec: z.string().min(1).max(2048), global: z.boolean().optional(), force: z.boolean().optional() }))
export const PluginsAuthMethods = lazySchema(() => z.strictObject({ ...base, type: z.literal("plugins.auth-methods"), directory: z.string().min(1).max(4096) }))
export const PluginsAuthStart = lazySchema(() => z.strictObject({ ...base, type: z.literal("plugins.auth-start"), directory: z.string().min(1).max(4096), provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), method: z.int().min(0).max(63), inputs: z.record(z.string().max(64), z.string().max(4096)).optional() }))
export const PluginsAuthComplete = lazySchema(() => z.strictObject({ ...base, type: z.literal("plugins.auth-complete"), directory: z.string().min(1).max(4096), flowId: z.string().uuid(), code: z.string().max(4096).optional() }))
export const PluginsMetadata = lazySchema(() => z.strictObject({ ...base, type: z.literal("plugins.metadata"), directory: z.string().min(1).max(4096), plugin: z.string().regex(/^[\w.-]{1,64}$/), operation: z.enum(["get", "list", "patch"]), sessionId: SessionId.optional(), patch: z.record(z.string().max(128), z.json()).optional() }))

export const ProvidersAuthMethods = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.methods"), provider: CatalogProvider.optional() }))
export const ProvidersAuthStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.status"), provider: CatalogProvider.optional() }))
export const ProvidersAuthPlan = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.plan"), provider: CatalogProvider, method: ProviderAuthMethod.shape.id.optional() }))
export const ProvidersAuthAuthorize = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.authorize"), provider: CatalogProvider, method: ProviderAuthMethod.shape.id.optional(), open: z.boolean().optional() }))
export const ProvidersAuthAction = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.action"), provider: CatalogProvider, action: z.enum(["cancel", "refresh", "logout"]) }))
export const ProvidersAuthMetadata = lazySchema(() => z.strictObject({ ...base, type: z.literal("providers.auth.metadata"), url: z.string().url().max(2048), execute: z.boolean().optional() }))

export const BudgetStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("budget.status"), directory: z.string().min(1).max(4096) }))
export const BudgetDoctor = lazySchema(() => z.strictObject({ ...base, type: z.literal("budget.doctor"), directory: z.string().min(1).max(4096) }))
export const BudgetSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("budget.set"), policy: BudgetPolicy }))
export const SetupStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("setup.status"), directory: z.string().min(1).max(4096) }))
export const SetupPlan = lazySchema(() => z.strictObject({ ...base, type: z.literal("setup.plan"), directory: z.string().min(1).max(4096) }))
export const SetupDoctor = lazySchema(() => z.strictObject({ ...base, type: z.literal("setup.doctor"), directory: z.string().min(1).max(4096) }))
export const SetupApplyPreset = lazySchema(() => z.strictObject({ ...base, type: z.literal("setup.preset"), directory: z.string().min(1).max(4096), preset: SetupPreset }))
export const SetupAsk = lazySchema(() => z.strictObject({ ...base, type: z.literal("setup.ask"), directory: z.string().min(1).max(4096), text: z.string().min(1).max(4000), history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) })).max(12).default([]) }))

export const AIConfigCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("ai.config"), directory: z.string().min(1).max(4096), input: AIConfigInput }))
export const ReasoningStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("reasoning.status"), directory: z.string().min(1).max(4096), sessionId: SessionId.optional() }))
export const ReasoningConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("reasoning.configure"), directory: z.string().min(1).max(4096), expectedRevision: z.string().min(1).max(100), config: ReasoningPolicy, confirm: z.literal(true) }))

export const ReleaseInspect = lazySchema(() => z.strictObject({ ...base, type: z.literal("release.inspect") }))
export const ReleaseSet = lazySchema(() => z.strictObject({ ...base, type: z.literal("release.set"), channel: ReleaseChannel }))
export const ReleaseCheck = lazySchema(() => z.strictObject({ ...base, type: z.literal("release.check") }))

export const DaemonStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("daemon.status") }))
export const DaemonLogs = lazySchema(() => z.strictObject({ ...base, type: z.literal("daemon.logs"), lines: z.number().int().min(1).max(1000).optional() }))
export const DaemonTick = lazySchema(() => z.strictObject({ ...base, type: z.literal("daemon.tick"), scheduler: z.enum(["loops", "dream"]), execute: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }))

export const AudioPlay = lazySchema(() => z.strictObject({ ...base, type: z.literal("audio.play"), ...ActivityAudioInput.shape }))

/** Local clients only; never read-only (it opens the microphone and uploads audio). Ack: `VoiceReport` for `status`/`start`, `VoiceTranscript` for `stop`. */
export const VoiceControl = lazySchema(() => z.strictObject({ ...base, type: z.literal("voice.control"), ...VoiceControlInput.shape }))
export const PetManage = lazySchema(() => z.strictObject({ ...base, type: z.literal("pet.manage"), input: PetInput }))

export const TraceConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("trace.configure"), enabled: z.boolean() }))
export const TraceQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("trace.query"), sessionId: SessionId.optional(), limit: z.number().int().min(1).max(512).optional() }))
export const TraceRecord = lazySchema(() => z.strictObject({ ...base, type: z.literal("trace.record"), sample: TraceSample }))

export const DebugQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("debug.query"), directory: z.string().min(1).max(4096), input: DebugInput }))
export const DatabaseQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("db.query"), operation: z.enum(["path", "query"]), sql: z.string().trim().min(1).max(65536).optional() }))

/** Opt-in weather adapter. Disabled queries never call a service; ack: UsageWeatherReport. */
export const UsageWeatherQuery = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("usage.weather.query"),
  enabled: z.boolean().optional(),
  region: z.string().trim().min(1).max(120).refine((text) => !/[\x00-\x1f\x7f-\x9f]/.test(text)).optional(),
}))
export const IdeQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("ide.query"), directory: z.string().min(1).max(4096) }))
export const IdeConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("ide.configure"), directory: z.string().min(1).max(4096), enabled: z.boolean(), editor: z.enum(["zed", "vscode"]).optional(), dbPath: z.string().min(1).max(4096).optional() }))
export const IdeOpen = lazySchema(() => z.strictObject({ ...base, type: z.literal("ide.open"), directory: z.string().min(1).max(4096), filePath: z.string().min(1).max(4096), line: z.number().int().positive().max(10_000_000).optional(), character: z.number().int().positive().max(10_000_000).optional() }))
export const UrlOpen = lazySchema(() => z.strictObject({ ...base, type: z.literal("url.open"), url: z.string().max(2048).regex(/^https?:\/\/[\x21-\x7e]+$/i) }))
/** A generated image's buttons: opens the image (an absolute path to a PNG, JPEG, WebP or GIF file) in the system's viewer, or, with `reveal`, shows it in its folder. Local clients only. */
export const ImageOpen = lazySchema(() => z.strictObject({ ...base, type: z.literal("image.open"), path: z.string().min(2).max(4096).startsWith("/"), reveal: z.boolean().optional() }))
export const ComputerCapture = lazySchema(() => z.strictObject({ ...base, type: z.literal("computer.capture"), sessionId: SessionId, input: ComputerCaptureInput }))
export const ComputerKey = lazySchema(() => z.strictObject({ ...base, type: z.literal("computer.key"), sessionId: SessionId, input: ComputerKeyInput }))
export const ComputerSession = lazySchema(() => z.strictObject({ ...base, type: z.literal("computer.session"), sessionId: SessionId, input: ComputerSessionInput }))
export const ComputerObserve = lazySchema(() => z.strictObject({ ...base, type: z.literal("computer.observe"), sessionId: SessionId, input: ComputerObserveInput }))
export const ComputerCode = lazySchema(() => z.strictObject({ ...base, type: z.literal("computer.code"), sessionId: SessionId, input: ComputerCodeInput }))
export const MflowQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("mflow.query"), directory: z.string().min(1).max(4096), query: MflowRead }))
export const MflowUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("mflow.change"), directory: z.string().min(1).max(4096), change: MflowChange }))
export const MflowLeaseCommand = lazySchema(() => z.strictObject({ ...base, type: z.literal("mflow.lease"), directory: z.string().min(1).max(4096), lease: MflowLease }))

export const ConsoleGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.get") }))
export const ConsoleListOrgs = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.listOrgs") }))
export const ConsoleConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.configure"), enabled: z.boolean(), url: ConsoleUrl.optional(), tokenFile: z.string().min(1).max(4096).optional() }))
export const ConsoleLoginStart = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.login"), url: ConsoleUrl.optional() }))
export const ConsoleLoginPoll = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.poll"), loginID: z.string().min(1).max(100) }))
export const ConsoleLoginCancel = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.cancel"), loginID: z.string().min(1).max(100) }))
export const ConsoleLogout = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.logout"), accountID: z.string().min(1).max(200) }))
export const ConsoleSwitchOrg = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.switchOrg"), accountID: z.string().min(1).max(200), orgID: z.string().min(1).max(200) }))
export const ConsoleOpen = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.open"), target: z.enum(["console", "billing"]).optional(), loginID: z.string().min(1).max(100).optional() }))
export const SessionShareGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.share.get"), sessionId: SessionId }))
export const SessionShareCreate = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.share"), sessionId: SessionId }))
export const SessionShareSync = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.share.sync"), sessionId: SessionId }))
export const SessionUnshare = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.unshare"), sessionId: SessionId }))
/**
 * Console-free sharing, always an explicit action. `local` writes a public-data HTML page under the data directory;
 * `gist` uploads the public-data Markdown as a secret GitHub gist through `gh` and needs `confirm: true` to create.
 * Ack: `StaticShare`.
 */
export const SessionShareStatic = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.share.static"), sessionId: SessionId, target: z.enum(["local", "gist"]), action: z.enum(["create", "status", "remove"]), confirm: z.boolean().optional() }))

export const ProjectRest = lazySchema(() => z.strictObject({ ...base, type: z.literal("project.rest"), directory: z.string().min(1).max(4096), input: ProjectRestInput }))

export const WorkflowPermissions = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.permissions"), workflowId: WorkflowId, mode: z.enum(["report-only", "normal", "custom"]).optional(), sessionPermission: z.enum(["ask", "edits", "full"]).nullable().optional(), reason: z.string().max(500).optional() }))
export const WorkflowRetryPhase = lazySchema(() => z.strictObject({ ...base, type: z.literal("workflow.retry-phase"), workflowId: WorkflowId, phaseId: WorkflowSlug, reason: z.string().max(500).optional() }))
/**
 * Script runs only, local clients only. `budget` raises or sets the caps a paused run stopped at; `update` swaps in an edited
 * source (paused, failed or blocked runs: `resume` then replays the journal and re-runs only the calls whose prompt or options changed).
 * Ack: `{ workflow }`.
 */
export const WorkflowScriptCommand = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("workflow.script"),
  workflowId: WorkflowId,
  action: z.enum(["budget", "update"]),
  budget: WorkflowScriptBudget.optional(),
  script: z.string().min(1).max(WORKFLOW_SCRIPT_MAX_BYTES).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
}))

export const InteractionList = lazySchema(() => z.strictObject({ ...base, type: z.literal("interaction.list"), directory: z.string().min(1).max(4096), kind: InteractionKind }))
export const MemorySideChat = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.side-chat"), directory: z.string().min(1).max(4096), payload: MemorySideChatPayload }))

export const ConsoleAccounts = lazySchema(() => z.strictObject({ ...base, type: z.literal("console.accounts") }))

export const GithubInstall = lazySchema(() => z.strictObject({ ...base, type: z.literal("github.install"), directory: z.string().min(1).max(4096), input: GithubInstallInput }))
export const GithubRun = lazySchema(() => z.strictObject({ ...base, type: z.literal("github.run"), directory: z.string().min(1).max(4096), input: GithubRunInput, choice: ModelChoice.optional() }))
export const GithubFinish = lazySchema(() => z.strictObject({ ...base, type: z.literal("github.finish"), runId: z.string().uuid(), status: z.enum(["completed", "failed", "stopped"]) }))
export const PrCheckout = lazySchema(() => z.strictObject({ ...base, type: z.literal("pr.checkout"), directory: z.string().min(1).max(4096), number: z.number().int().positive().max(2147483647), token: z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value)).optional() }))

/**
 * Every command by its `type`. The daemon validates each incoming command with the one schema its `type` names, so a
 * command a session never sends never costs memory for its schema (docs/performance.md). `Command` is the full
 * discriminated union, built only when something needs all of it (documentation, an unknown `type`'s error message).
 */
export const COMMAND_SCHEMAS = {
  "tui.query": TuiQuery,
  "tui.change": TuiChange,
  "dream.run": DreamStart,
  "dream.list": DreamList,
  "session.aside": SessionAside,
  "session.aside.get": AsideGet,
  "session.aside.clear": AsideClear,
  "git.status": GitStatus,
  "codegraph.overview": CodegraphOverviewCommand,
  "sidebar.get": SidebarGet,
  "sidebar.update": SidebarUpdate,
  "loop.create": LoopCreate,
  "loop.update": LoopUpdate,
  "loop.list": LoopList,
  "loop.control": LoopControl,
  "loop.fire": LoopFire,
  "loop.templates": LoopTemplates,
  "workflow.start": WorkflowStart,
  "workflow.list": WorkflowList,
  "workflow.get": WorkflowGet,
  "workflow.control": WorkflowControl,
  "workflow.preview": WorkflowPreview,
  "hello": Hello,
  "session.create": SessionCreate,
  "session.fork": SessionFork,
  "session.undo": SessionUndo,
  "session.redo": SessionRedo,
  "session.timeline": SessionTimeline,
  "session.history": SessionHistory,
  "skills.list": SkillsList,
  "skills.set": SkillsSet,
  "skills.load": SkillsLoad,
  "session.export": SessionExport,
  "user.submit": UserSubmit,
  "user.shell": UserShell,
  "queue.promote": QueuePromote,
  "queue.remove": QueueRemove,
  "queue.reorder": QueueReorder,
  "queue.edit": QueueEdit,
  "queue.steer": QueueSteer,
  "queue.list": QueueList,
  "turn.cancel": TurnCancel,
  "request.resolve": RequestResolve,
  "client.subscribe": ClientSubscribe,
  "client.unsubscribe": ClientUnsubscribe,
  "job.schedule": JobSchedule,
  "job.cancel": JobCancel,
  "resource.mode.set": ResourceModeSet,
  "diagnostics.resources": DiagnosticsResources,
  "session.detach": SessionDetach,
  "session.control": SessionControl,
  "task.list": TaskList,
  "task.run": TaskRun,
  "task.status": TaskStatus,
  "memory.extraction.list": ExtractionList,
  "memory.extraction.retry": ExtractionRetry,
  "background.list": BackgroundList,
  "background.stop": BackgroundStop,
  "session.list": SessionList,
  "session.rename": SessionRename,
  "session.meta": SessionMeta,
  "session.fanout": SessionFanout,
  "session.delete": SessionDelete,
  "draft.set": DraftSet,
  "draft.get": DraftGet,
  "draft.list": DraftList,
  "privacy.get": PrivacyGet,
  "privacy.set": PrivacySet,
  "env.list": EnvList,
  "env.set": EnvSet,
  "env.remove": EnvRemove,
  "env.import": EnvImport,
  "secrets.list": SecretsList,
  "secrets.reveal": SecretsReveal,
  "secrets.forget": SecretsForget,
  "usage.query": UsageQuery,
  "usage.waste": UsageWasteQuery,
  "daemon.shutdown": DaemonShutdown,
  "daemon.info": DaemonInfo,
  "sandbox.status": SandboxStatusCommand,
  "channels.status": ChannelsStatusCommand,
  "channels.change": ChannelsChangeCommand,
  "models.list": ModelsList,
  "session.model.set": SessionModelSet,
  "agents.list": AgentsList,
  "session.agent.set": SessionAgentSet,
  "session.events": SessionEvents,
  "session.permission.set": SessionPermissionSet,
  "session.run.configure": SessionRunConfigure,
  "permissions.list": PermissionsList,
  "permissions.revoke": PermissionsRevoke,
  "permissions.retry": PermissionsRetry,
  "session.compact": SessionCompact,
  "goal.get": GoalGet,
  "goal.set": GoalSet,
  "goal.update": GoalUpdate,
  "goal.clear": GoalClear,
  "usage.limit": UsageLimitSet,
  "pr.watch": PrWatchControl,
  "pr.review": PrReviewControl,
  "prompt.history": PromptHistory,
  "prompt.record": PromptRecord,
  "prompt.history.delete": PromptHistoryDelete,
  "changes.query": ChangesQuery,
  "context.query": ContextQuery,
  "storage.report": StorageReportQuery,
  "git.branch": GitBranch,
  "files.search": FilesSearch,
  "storage.clean": StorageClean,
  "storage.worktrees": StorageWorktrees,
  "changes.file": ChangesFile,
  "attachment.add": AttachmentAdd,
  "attachment.put": AttachmentPut,
  "attachment.clipboard": AttachmentClipboard,
  "attachment.read": AttachmentRead,
  "attachment.paste": AttachmentPaste,
  "commands.list": CustomCommandsList,
  "commands.expand": CustomCommandExpand,
  "scratchpad.get": ScratchpadGet,
  "scratchpad.set": ScratchpadSet,
  "backlog.get": BacklogGet,
  "backlog.change": BacklogChange,
  "settings.get": SettingsGet,
  "acp.registry": AcpRegistry,
  "settings.set": SettingsSet,
  "memory.list": MemoryList,
  "memory.add": MemoryAdd,
  "memory.update": MemoryUpdate,
  "memory.delete": MemoryDelete,
  "memory.search": MemorySearch,
  "memory.graph": MemoryGraph,
  "memory.link": MemoryLinkSet,
  "memory.unlink": MemoryUnlink,
  "memory.categories": MemoryCategories,
  "memory.policy": MemoryPolicySet,
  "evolution.list": EvolutionList,
  "evolution.resolve": EvolutionResolve,
  "mcp.status": McpStatus,
  "mcp.restart": McpRestart,
  "mcp.auth": McpAuth,
  "tools.list": ToolsList,
  "tools.trust": ToolsTrust,
  "extensions.list": ExtensionsList,
  "hooks.list": HooksList,
  "extensions.reload": ExtensionsReload,
  "extensions.report": ExtensionsReportUi,
  "extensions.disable": ExtensionsDisable,
  "extensions.flags": ExtensionsFlags,
  "extensions.export": ExtensionsExport,
  "packages.list": PackagesList,
  "packages.install": PackagesInstall,
  "packages.capture": PackagesCapture,
  "packages.remove": PackagesRemove,
  "packages.restore": PackagesRestore,
  "packages.enable": PackagesEnable,
  "themes.list": ThemesList,
  "status.watch": StatusWatch,
  "recipes.list": RecipesList,
  "recipes.apply": RecipesApply,
  "providers.list": ProvidersList,
  "providers.set": ProvidersSet,
  "providers.remove": ProvidersRemove,
  "providers.test": ProvidersTest,
  "providers.refresh": ProvidersRefresh,
  "lsp.query": LspQuery,
  "lsp.install": LspInstall,
  "review.query": ReviewQuery,
  "review.update": ReviewUpdate,
  "memory.workspaces": MemoryWorkspaceList,
  "memory.browse": MemoryBrowse,
  "memory.sharing.status": MemorySharingStatus,
  "memory.sharing.configure": MemorySharingConfigure,
  "memory.sharing.export": MemorySharingExport,
  "memory.sharing.import": MemorySharingImport,
  "memory.model": MemoryModel,
  "memory.assistant.get": MemoryAssistantGet,
  "memory.assistant.send": MemoryAssistantSend,
  "memory.assistant.clear": MemoryAssistantClear,
  "memory.assistant.cancel": MemoryAssistantCancel,
  "memory.assistant.archive": MemoryAssistantArchiveCommand,
  "memory.control": MemoryControl,
  "dream.control": DreamControl,
  "plan.review.list": PlanReviewList,
  "prompt.status": PromptStatusQuery,
  "prompt.sources": PromptSources,
  "prompt.build": PromptBuild,
  "prompt.set": PromptSet,
  "prompt.cycle": PromptCycle,
  "session.compaction.set": SessionCompactionSet,
  "permissions.status": PermissionsStatus,
  "permissions.set-default": PermissionsSetDefault,
  "permissions.set-reviewer-role": PermissionsSetReviewerRole,
  "permissions.history": PermissionsHistory,
  "session.agent-command.create": SessionAgentCommandCreate,
  "session.agent-command.list": SessionAgentCommandList,
  "session.agent-command.update": SessionAgentCommandUpdate,
  "session.agent-command.policy": SessionAgentCommandPolicy,
  "session.get": SessionGet,
  "session.inspect": SessionInspect,
  "session.stats": SessionStatsCommand,
  "diagnostics.snapshot": DiagnosticsSnapshot,
  "context.recent": ContextRecent,
  "system.query": SystemQuery,
  "files.query": FilesQuery,
  "models.config.get": ModelsConfigGet,
  "models.default.set": ModelsDefaultSet,
  "providers.catalog": ProvidersCatalog,
  "providers.logout": ProvidersLogout,
  "mcp.add": McpAdd,
  "mcp.decide": McpDecide,
  "mcp.debug": McpDebug,
  "formatter.status": FormatterStatusQuery,
  "formatter.file": FormatterFile,
  "theme.validate": ThemeValidate,
  "theme.install": ThemeInstall,
  "theme.select": ThemeSelect,
  "agent.create": AgentCreate,
  "agent.debug": AgentDebug,
  "loop.draft": LoopDraft,
  "loop.snapshot": LoopSnapshotQuery,
  "loop.activate": LoopActivate,
  "loop.tick": LoopTick,
  "session.import": SessionImport,
  "setup.import": SetupImport,
  "session.recall.search": SessionRecallSearch,
  "session.recall.read": SessionRecallRead,
  "session.notes": SessionNotes,
  "session.archive": SessionArchive,
  "session.search": SessionSearch,
  "session.context-window": SessionContextWindow,
  "session.tree": SessionTree,
  "session.merge": SessionMerge,
  "session.label": SessionLabel,
  "session.recap": SessionRecap,
  "session.children": SessionChildren,
  "session.background.list": SessionBackgroundList,
  "session.background.register": SessionBackgroundRegister,
  "session.background.remove": SessionBackgroundRemove,
  "session.background.writer.acquire": SessionBackgroundWriterAcquire,
  "session.background.writer.release": SessionBackgroundWriterRelease,
  "session.agent-view.metadata.list": SessionMetadataList,
  "session.agent-view.metadata.get": SessionMetadataGet,
  "session.agent-view.metadata.patch": SessionMetadataPatch,
  "session.agent-command.list-by-session": SessionAgentCommandListBySession,
  "session.agent-command.patch": SessionAgentCommandPatch,
  "commands.execute": CustomCommandExecute,
  "commands.discover": CustomCommandsDiscover,
  "project.control": ProjectControl,
  "mcp.catalog": McpCatalogQuery,
  "mcp.resources.list": McpResourcesList,
  "mcp.resource.read": McpResourceRead,
  "mcp.prompts.list": McpPromptsList,
  "mcp.prompt.get": McpPromptGet,
  "continuity.list": ContinuityList,
  "continuity.get": ContinuityGet,
  "continuity.cancel": ContinuityCancel,
  "continuity.wait": ContinuityWait,
  "worktree.query": WorktreeQuery,
  "worktree.change": WorktreeUpdate,
  "session.changes": SessionChanges,
  "session.savings": SessionSavings,
  "workflow.save": WorkflowSave,
  "workflow.definitions": WorkflowDefinitions,
  "workflow.revision.get": WorkflowRevisionGet,
  "loop.review": LoopReview,
  "workflow.events": WorkflowEvents,
  "workflow.artifacts": WorkflowArtifacts,
  "workflow.receipt": WorkflowReceipt,
  "workflow.export": WorkflowExport,
  "loop.events": LoopEvents,
  "loop.artifacts": LoopArtifacts,
  "loop.receipt": LoopReceipt,
  "loop.export": LoopExport,
  "evolution.promote": EvolutionPromote,
  "evolution.rollback": EvolutionRollback,
  "cache.status": CacheStatusQuery,
  "cache.set": CacheSet,
  "compound.get": CompoundGet,
  "compound.configure": CompoundConfigure,
  "compound.start": CompoundStart,
  "compound.cancel": CompoundCancel,
  "session.message.delete": SessionDeleteMessage,
  "session.part.delete": SessionDeletePart,
  "session.part.update": SessionUpdatePart,
  "packages.search": PackagesSearch,
  "packages.show": PackagesShow,
  "packages.preview": PackagesPreview,
  "packages.sources": PackagesSources,
  "packages.add-source": PackagesAddSource,
  "packages.remove-source": PackagesRemoveSource,
  "packages.install-catalog": PackagesInstallCatalog,
  "packages.install-source": PackagesInstallSource,
  "packages.disable-all": PackagesDisableAll,
  "packages.assets": PackagesAssets,
  "packages.refresh": PackagesRefresh,
  "packages.config": PackagesConfig,
  "packages.resource": PackagesResource,
  "packages.create": PackagesCreate,
  "packages.update": PackagesUpdate,
  "packages.delete-local": PackagesDeleteLocal,
  "plugins.install": PluginsInstall,
  "plugins.auth-methods": PluginsAuthMethods,
  "plugins.auth-start": PluginsAuthStart,
  "plugins.auth-complete": PluginsAuthComplete,
  "plugins.metadata": PluginsMetadata,
  "workspace.query": WorkspaceQuery,
  "workspace.create": WorkspaceCreate,
  "workspace.remove": WorkspaceRemove,
  "session.rest.read": SessionRestRead,
  "session.rest.update": SessionRestUpdate,
  "session.rest.control": SessionRestControl,
  "session.rest.mutate": SessionRestMutate,
  "server.health": ServerHealth,
  "server.memory": ServerMemory,
  "server.config.get": ServerConfigGet,
  "server.config.update": ServerConfigUpdate,
  "server.dispose": ServerDispose,
  "app.log": AppLog,
  "server.upgrade": ServerUpgrade,
  "providers.auth.methods": ProvidersAuthMethods,
  "providers.auth.status": ProvidersAuthStatus,
  "providers.auth.plan": ProvidersAuthPlan,
  "providers.auth.authorize": ProvidersAuthAuthorize,
  "providers.auth.action": ProvidersAuthAction,
  "providers.auth.metadata": ProvidersAuthMetadata,
  "budget.status": BudgetStatus,
  "budget.doctor": BudgetDoctor,
  "budget.set": BudgetSet,
  "setup.status": SetupStatus,
  "setup.plan": SetupPlan,
  "setup.doctor": SetupDoctor,
  "setup.preset": SetupApplyPreset,
  "setup.ask": SetupAsk,
  "ai.config": AIConfigCommand,
  "reasoning.status": ReasoningStatus,
  "reasoning.configure": ReasoningConfigure,
  "release.inspect": ReleaseInspect,
  "release.set": ReleaseSet,
  "release.check": ReleaseCheck,
  "daemon.status": DaemonStatus,
  "daemon.logs": DaemonLogs,
  "daemon.tick": DaemonTick,
  "audio.play": AudioPlay,
  "voice.control": VoiceControl,
  "pet.manage": PetManage,
  "trace.configure": TraceConfigure,
  "trace.query": TraceQuery,
  "trace.record": TraceRecord,
  "debug.query": DebugQuery,
  "db.query": DatabaseQuery,
  "usage.weather.query": UsageWeatherQuery,
  "tsm.query": TsmQuery,
  "tsm.change": TsmUpdate,
  "github.install": GithubInstall,
  "github.run": GithubRun,
  "github.finish": GithubFinish,
  "pr.checkout": PrCheckout,
  "ide.query": IdeQuery,
  "ide.configure": IdeConfigure,
  "ide.open": IdeOpen,
  "url.open": UrlOpen,
  "image.open": ImageOpen,
  "computer.capture": ComputerCapture,
  "computer.key": ComputerKey,
  "computer.session": ComputerSession,
  "computer.observe": ComputerObserve,
  "computer.code": ComputerCode,
  "mflow.query": MflowQuery,
  "mflow.change": MflowUpdate,
  "mflow.lease": MflowLeaseCommand,
  "console.get": ConsoleGet,
  "console.listOrgs": ConsoleListOrgs,
  "console.configure": ConsoleConfigure,
  "console.login": ConsoleLoginStart,
  "console.poll": ConsoleLoginPoll,
  "console.cancel": ConsoleLoginCancel,
  "console.logout": ConsoleLogout,
  "console.switchOrg": ConsoleSwitchOrg,
  "console.open": ConsoleOpen,
  "session.share.get": SessionShareGet,
  "session.share": SessionShareCreate,
  "session.share.sync": SessionShareSync,
  "session.unshare": SessionUnshare,
  "session.share.static": SessionShareStatic,
  "session.cd": SessionCd,
  "catalog.rest": CatalogRest,
  "tui.control.register": TuiControlRegister,
  "tui.control.send": TuiControlSend,
  "tui.control.next": TuiControlNext,
  "tui.control.response": TuiControlResponse,
  "project.rest": ProjectRest,
  "workflow.permissions": WorkflowPermissions,
  "workflow.retry-phase": WorkflowRetryPhase,
  "workflow.script": WorkflowScriptCommand,
  "interaction.list": InteractionList,
  "memory.side-chat": MemorySideChat,
  "file.rest.read": FileRestRead,
  "file.edit": FileEdit,
  "file.view": FileViewCommand,
  "git.commit": GitCommitCommand,
  "git.push": GitPushCommand,
  "git.pr.view": GitPrViewCommand,
  "git.pr.create": GitPrCreateCommand,
  "git.publish": GitPublishCommand,
  "git.init": GitInitCommand,
  "pty.shells": PtyShells,
  "pty.list": PtyList,
  "pty.create": PtyCreate,
  "pty.get": PtyGet,
  "pty.update": PtyUpdate,
  "pty.remove": PtyRemove,
  "pty.connect-token": PtyTicket,
  "console.accounts": ConsoleAccounts,
} as const
type CommandSchemas = (typeof COMMAND_SCHEMAS)[keyof typeof COMMAND_SCHEMAS]
export const Command = lazySchema(() => z.discriminatedUnion("type", Object.values(COMMAND_SCHEMAS) as [CommandSchemas, ...CommandSchemas[]]))
export type Command = z.infer<typeof Command>
export type CommandType = Command["type"]

/**
 * Validates one command with the schema its `type` names. Same result and issues as `Command.safeParse`; only the
 * schema of that command is built. An unknown or missing `type` goes through the full union for its error message.
 */
export function parseCommand(input: unknown): z.ZodSafeParseResult<Command> {
  const type = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined
  const schema: z.ZodType<Command> = typeof type === "string" && Object.hasOwn(COMMAND_SCHEMAS, type) ? COMMAND_SCHEMAS[type as CommandType] : Command
  return schema.safeParse(input)
}

export function isCompatibleVersion(version: number) {
  return version === PROTOCOL_VERSION
}
