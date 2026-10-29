import { ContinuitySummary } from "./continuity"
import { z } from "zod"
import { AttachmentDescription, TranscriptMetadata } from "./session-transfer"
import { PlanReview, PlanReviewReply } from "./plan-review"
import { PermissionContext } from "./interaction-http"
import { QuestionBatch } from "./questions"
import { RequestProfile } from "./support"
import { ModelChoice } from "./queries"
import { AsideThread, SidebarSpec } from "./sidebar"
import { BlobRef, ClientId, ItemId, JobId, MemoryId, QueueId, RequestId, SessionId, TurnId } from "./ids"
import { ErrorCode, ForegroundState, ItemKind, ItemStatus, JobState, JobType, MAX_INLINE_TEXT, MAX_JOINED_QUEUE_ENTRIES, MAX_QUEUE_ENTRIES, PermissionMode, QueueDelivery, QueueEntryKind, TurnOptions } from "./states"
import { Goal, GoalBy, GoalChange } from "./goals"
import { UsageLimitState } from "./usage-limit"
import { Loop } from "./loops"
import { WorkflowSummary } from "./workflows"
import { DreamRun } from "./dream"
import { RenderNode } from "./render"
import { TuiProfilePatch } from "./tui"
import { ReviewSnapshot } from "./review"
import { TuiRequest } from "./tui-actions"
import { lazySchema } from "./lazy"
import { SessionDraft, SessionLifecycle } from "./session-lifecycle"

const InlineText = z.string().max(MAX_INLINE_TEXT)

/**
 * Session-scoped events share one contiguous `seq` per session (I4).
 * Payloads are small deltas; full snapshots are never embedded (oc#33356, FC-36).
 */
const sessionBase = {
  sessionId: SessionId,
  seq: z.number().int().positive(),
  at: z.number().int().nonnegative(),
}

export const SessionCreated = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("session.created"),
  directory: z.string().min(1).max(4096),
  title: z.string().max(200),
  parentId: SessionId.optional(),
  imported: z.strictObject({ sourceSessionId: z.string().min(1).max(200), truncated: z.boolean(), sanitized: z.boolean() }).optional(),
}))

/** Full content of a queued message, so the queue survives a daemon restart (FC-08). */
export const QueueAdded = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("queue.added"),
  queueId: QueueId,
  text: InlineText,
  attachments: z.array(BlobRef).max(32),
  /** A queued manual compaction (/compact) instead of a user message. */
  compact: z.literal(true).optional(),
  /** With `compact`: what the summary should focus on. */
  instructions: z.string().min(1).max(8_000).optional(),
  /** A notice from the system (a background task finished), not typed by the user; the agent answers it like a message. */
  notice: z.literal(true).optional(),
  /** The user's own `!command`: runs in the shell without a model call. `text` is the command. */
  shell: z.literal(true).optional(),
  /** With `shell`: `!!command`, whose output is not added to the model's history. */
  local: z.literal(true).optional(),
  messageId: ItemId.optional(),
  /** The original user request when an extension expanded or rewrote `text`. */
  authorityText: InlineText.optional(),
  selection: z.strictObject({ model: z.lazy(() => ModelChoice).optional(), agent: z.string().min(1).max(100).optional() }).optional(),
  displayText: InlineText.optional(),
  turnOptions: TurnOptions.optional(),
}))

export const QueueChanged = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("queue.changed"),
  queue: z.array(z.strictObject({ queueId: QueueId, preview: z.string().max(200), attachments: z.number().int().nonnegative(), kind: QueueEntryKind.optional(), delivery: QueueDelivery.optional() })).max(MAX_QUEUE_ENTRIES),
}))

/** A queued message's text was replaced in place; the entry keeps its place, id and attachments. Persisted, so the edit survives a restart. */
export const QueueEdited = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("queue.edited"),
  queueId: QueueId,
  text: InlineText,
  byClientId: ClientId.optional(),
}))

export const ForegroundStateChanged = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("foreground.state"),
  state: ForegroundState,
  turnId: TurnId.optional(),
}))

export const TurnStarted = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.started"),
  turnId: TurnId,
  queueId: QueueId,
  /** Further queued messages that started with `queueId` in this same turn (each keeps its own user message item). */
  joinedQueueIds: z.array(QueueId).max(MAX_JOINED_QUEUE_ENTRIES).optional(),
  importedMetadata: TranscriptMetadata.optional(),
}))

/** Every queued entry a `turn.started` carries: its own `queueId` first, then the messages that joined it. */
export function startedQueueIds(event: { queueId: QueueId; joinedQueueIds?: readonly QueueId[] | undefined }): QueueId[] {
  return [event.queueId, ...(event.joinedQueueIds ?? [])]
}

export const TurnCompleted = lazySchema(() => z.strictObject({ ...sessionBase, type: z.literal("turn.completed"), turnId: TurnId }))

/** Only deliberate cancels. Connection/sleep loss is `turn.interrupted`, never a user cancel (FC-15). */
export const TurnCancelled = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.cancelled"),
  turnId: TurnId,
  by: z.enum(["user", "promotion"]),
}))

export const TurnInterrupted = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.interrupted"),
  turnId: TurnId,
  reason: z.enum(["restart", "transport", "stream_idle"]),
}))

/** The engine is waiting to retry a failed model call (rate limit, 5xx, stalled stream); the turn is still running. */
export const TurnRetrying = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.retrying"),
  turnId: TurnId,
  /** 1 for the first retry. */
  attempt: z.number().int().min(1),
  /** When the next attempt starts (ms since epoch). */
  nextAt: z.number(),
  message: z.string().max(500),
  /** Set while the connection itself is down (offline, asleep): when the current run of network failures began. */
  offlineSince: z.number().optional(),
}))

export const TurnFailed = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.failed"),
  turnId: TurnId,
  error: z.strictObject({ code: z.string().max(64), message: z.string().max(4000) }),
}))

/**
 * The user undid this turn (`session.undo`): its items are hidden from the transcript and from the model's history.
 * The log stays append-only; `turn.restored` (`session.redo`) brings the turn back.
 */
export const TurnReverted = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.reverted"),
  turnId: TurnId,
  byClientId: ClientId.optional(),
}))

export const TurnRestored = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("turn.restored"),
  turnId: TurnId,
  byClientId: ClientId.optional(),
}))

export const ItemStarted = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("item.started"),
  turnId: TurnId,
  itemId: ItemId,
  kind: ItemKind,
  /** Small descriptive metadata only (tool name, short title). Never full content. */
  meta: z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean()])).optional(),
}))

export const ItemDelta = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("item.delta"),
  itemId: ItemId,
  text: InlineText,
  /** A tool call whose input the model is still writing (a whole file, a long script): how much it has written; `done` once the input is whole and the tool runs. */
  input: ToolInputProgress.optional(),
}))

export const ToolInputProgress = lazySchema(() => z.strictObject({ chars: z.number().int().nonnegative(), lines: z.number().int().nonnegative(), done: z.boolean().optional() }))
export type ToolInputProgress = z.infer<typeof ToolInputProgress>

export const ItemCompleted = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("item.completed"),
  itemId: ItemId,
  status: ItemStatus,
  /** Final text when it fits inline; otherwise `blob` holds the content and `text` a truncated preview. */
  text: InlineText.optional(),
  /** Redacted native tool arguments for transcript exports; absent on older events. */
  toolInput: z.string().max(4000).optional(),
  blob: BlobRef.optional(),
  /** User message attachments; the store keeps a reference so blob GC never deletes them. */
  attachments: z.array(BlobRef).max(32).optional(),
  /** How a tool call's result is drawn (renderSpec@1); clients fall back to `text` when they cannot. */
  render: RenderNode.optional(),
  /** Small facts about a tool call's result for display (exit code, duration, a sub-agent's tool calls). */
  meta: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((meta) => Object.keys(meta).length <= 16, "at most 16 meta fields")
    .optional(),
  /** Original user authority, independent of extension-expanded display text. */
  authorityText: InlineText.optional(),
  /** Descriptions retained by transcript imports; these do not claim a local blob exists. */
  attachmentDescriptions: z.array(AttachmentDescription).max(32).optional(),
}))

export const ServerRequest = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("server.request"),
  requestId: RequestId,
  turnId: TurnId,
  kind: z.enum(["approval", "question"]),
  title: z.string().max(500),
  detail: InlineText,
  /** For a tool approval: the tool call's item (its card), the tool name and what it may do. */
  itemId: ItemId.optional(),
  tool: z.string().max(200).optional(),
  permission: z.enum(["read", "write", "execute"]).optional(),
  /** For a question: up to 9 choices (the answer is still text; the user may type their own), and multi-select. */
  options: z.array(z.strictObject({ label: z.string().min(1).max(120), description: z.string().max(300).optional() })).max(9).optional(),
  multiple: z.boolean().optional(),
  questions: QuestionBatch.optional(),
  async: z.boolean().optional(),
  planReview: PlanReview.optional(),
  permissionContext: PermissionContext.optional(),
  /** The engine itself flagged this call as dangerous although the session is in full access: only "allow once" and "reject" apply (never "always"), and an unattended `--approve` run rejects it. */
  engineFlagged: z.literal(true).optional(),
}))

/** The first resolution wins; later answers from other clients are rejected (FC-12). */
export const ServerRequestResolved = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("server.request.resolved"),
  requestId: RequestId,
  resolution: z.enum(["approved", "denied", "answered", "abandoned"]),
  byClientId: ClientId.optional(),
  planReview: PlanReviewReply.optional(),
}))

export const SessionPermissionChanged = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("session.permission"),
  mode: PermissionMode,
  byClientId: ClientId.optional(),
}))

/**
 * The session's goal changed (docs/goals.md): every change carries the whole goal as it is now, so a client needs no
 * history to show it. `cleared` carries the goal's last state and means the session has none now. `progress` is usage
 * moving and draws no card. Not tied to a turn: a goal outlives the turns that work on it.
 */
export const GoalChanged = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("goal.changed"),
  change: GoalChange,
  goal: Goal,
  by: GoalBy.optional(),
  /** Short human reason for a status change or a stall ("token budget reached", "the turn failed: …"). */
  reason: z.string().max(500).optional(),
}))

/**
 * The turn's provider usage limit changed (docs/usage-limit.md). Every event carries the whole pause as it is now: a
 * client shows the bar for the last event of a session while its state is open (`paused`, `scheduled`, `snoozed`,
 * `ready`). Written by the daemon only.
 */
export const UsageLimitChanged = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("usage.limit"),
  turnId: TurnId.optional(),
  state: UsageLimitState,
  provider: z.string().min(1).max(64).optional(),
  message: z.string().max(500),
  resetsAt: z.number().int().nonnegative().optional(),
  by: z.enum(["system", "user"]),
}))

/** One model call's token usage. The store folds it into usage projections in the same transaction. */
export const UsageRecorded = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("usage.recorded"),
  turnId: TurnId,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  /** Estimated API cost in micro-USD; absent when the provider has no known price (never guessed as 0). */
  costMicros: z.number().int().nonnegative().optional(),
  profile: RequestProfile.optional(),
  /** The call asked for reasoning but it was left off: earlier tool steps carry no signed thinking from this model. */
  thinkingDropped: z.literal(true).optional(),
  /** The call asked the provider to keep what it cached for an hour (Anthropic `ttl: "1h"`) and was answered; absent for the provider's default lifetime. */
  cacheTtl: z.literal("1h").optional(),
  /**
   * Tokens the conversation occupies after this call (its prompt plus its answer). External engines report counts
   * that sum a whole turn, so they say it themselves; without it the view derives it from one call's counts.
   */
  context: z.number().int().nonnegative().optional(),
  /** The window the engine itself reports for the model; the context meter's limit when the engine compacts on its own. */
  contextWindow: z.number().int().positive().optional(),
  /** `context` was clamped to `contextWindow` because the engine's figures disagreed; shown as `~`. */
  contextApprox: z.literal(true).optional(),
  /** The turn ended without the engine's own total (cancelled, the process gone): these are the sums of the calls it reported. */
  partial: z.literal(true).optional(),
  /**
   * Where MendCode will pack this session's history, in tokens, for the model and window of this call (the user's `compactAtTokens`,
   * or the threshold percentage of the model's window). The context meter's limit when the engine does not compact on its own.
   */
  compactAt: z.number().int().positive().optional(),
}))

/** Compaction milestones and its persisted follow-up; `packed` means history replacement succeeded. */
export const CompactionUpdated = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("compaction.updated"),
  turnId: TurnId,
  reason: z.enum(["auto", "manual"]),
  /** An automatic compaction the daemon started in an idle session, before the provider's prompt cache expired (docs/compaction.md). */
  idle: z.literal(true).optional(),
  state: z.enum(["writing", "packed", "skipped", "failed", "cancelled", "interrupted"]),
  followUp: z.string().max(8_000),
  followUpQueueId: QueueId.optional(),
  /** Why a compaction was skipped, when the engine knows (nothing of this session on that engine yet, ...). */
  note: z.string().max(500).optional(),
}))

export const ContinuityUpdated = lazySchema(() => z.strictObject({ ...sessionBase, type: z.literal("continuity.updated"), record: ContinuitySummary }))
export const LimitCheckpointSaved = lazySchema(() => z.strictObject({ ...sessionBase, type: z.literal("limit.checkpoint") }))
/** Immutable revision; the previous content remains in the log, never in a mutation acknowledgement. */
export const MessageRevised = lazySchema(() => z.strictObject({
  ...sessionBase,
  type: z.literal("message.revised"),
  itemId: ItemId,
  turnId: TurnId,
  revision: z.number().int().positive(),
  deleted: z.boolean(),
  snapshot: ItemCompleted.omit({ sessionId: true, seq: true, at: true, type: true, itemId: true }),
  byClientId: ClientId.optional(),
}))
export type MessageRevision = z.infer<typeof MessageRevised>

export const SessionWorkspaceChanged = lazySchema(() => z.strictObject({ ...sessionBase, type: z.literal("session.workspace.changed"), directory: z.string().min(1).max(4096), workspaceID: z.string().nullable() }))

export const OrchestrationSummary = lazySchema(() => z.strictObject({ ...sessionBase, type: z.literal("session.orchestration"), groupId: z.string().max(64), text: z.string().max(8000) }))

export const SessionEvent = lazySchema(() => z.discriminatedUnion("type", [
  LimitCheckpointSaved,
  OrchestrationSummary,
  UsageRecorded,
  SessionCreated,
  QueueAdded,
  QueueChanged,
  QueueEdited,
  ForegroundStateChanged,
  TurnStarted,
  TurnCompleted,
  TurnCancelled,
  TurnInterrupted,
  TurnRetrying,
  TurnFailed,
  TurnReverted,
  TurnRestored,
  ItemStarted,
  ItemDelta,
  ItemCompleted,
  ServerRequest,
  ServerRequestResolved,
  SessionPermissionChanged,
  GoalChanged,
  UsageLimitChanged,
  CompactionUpdated,
  ContinuityUpdated,
  MessageRevised,
  SessionWorkspaceChanged,
]))
export type SessionEvent = z.infer<typeof SessionEvent>

/**
 * Global events are not tied to a session and carry their own `gseq`.
 * By construction they cannot carry a ForegroundState (I3).
 */
const globalBase = { gseq: z.number().int().positive(), at: z.number().int().nonnegative() }

export const JobStateChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("job.state"),
  jobId: JobId,
  jobType: JobType,
  state: JobState,
  detail: z.string().max(500).optional(),
}))

export const QuotaWindow = lazySchema(() => z.strictObject({
  id: z.string().max(64),
  label: z.string().max(32),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().nonnegative().optional(),
  windowMinutes: z.number().int().positive().optional(),
}))

export const QuotaSnapshot = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("quota.snapshot"),
  provider: z.string().min(1).max(64),
  plan: z.string().max(64).optional(),
  windows: z.array(QuotaWindow).max(8),
  credits: z
    .strictObject({
      remaining: z.number().optional(),
      limit: z.number().optional(),
      unit: z.enum(["usd", "credits"]),
      resetKind: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
    })
    .optional(),
  status: z.enum(["allowed", "warning", "rejected"]).optional(),
  fetchedAt: z.number().int().nonnegative(),
  source: z.string().min(1).max(200),
}))

/** Pushed on every memory mutation so open memory views refresh without polling (P12). */
export const MemoryChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("memory.changed"),
  memoryId: MemoryId,
  change: z.enum(["added", "updated", "deleted", "linked"]),
  /** What changed, so a client can say it: absent for links and for drafts that are not memories yet. `text` is the memory flattened and cut at 200 characters. */
  scope: z.enum(["user", "project", "session"]).optional(),
  status: z.enum(["saved", "pending", "archived"]).optional(),
  text: z.string().max(200).optional(),
}))

/** Full settings after a change, so every terminal applies theme/view without asking again. */
export const SettingsChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("settings.changed"),
  settings: z.record(z.string(), z.unknown()),
}))

/**
 * Live state of one top-level session, pushed to every terminal so the session panel needs no polling.
 * Ephemeral: broadcast only and never persisted, so `gseq` is always 0 and must not be used for ordering.
 * Throttled per session by the daemon.
 */
/** One colored piece of a script-backed status line. `fg` is a hex color from the script, drawn as is. */
export const StatusSegment = lazySchema(() => z.strictObject({
  prepend: z.boolean().optional(),
  text: z.string().max(240),
  fg: z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
  bold: z.boolean().optional(),
}))
export type StatusSegment = z.infer<typeof StatusSegment>

/**
 * Script-backed status for a project (a layer's `statusline.json`), sent only to clients watching that directory
 * (`status.watch`) and never persisted. `problems` explains a script that could not run.
 */
export const StatusLineChanged = lazySchema(() => z.strictObject({
  gseq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  type: z.literal("status.line"),
  directory: z.string().max(4096),
  left: z.array(StatusSegment).max(12),
  right: z.array(StatusSegment).max(12),
  problems: z.array(z.string().max(500)).max(10),
  leftRows: z.array(z.array(StatusSegment).max(32)).max(4).optional(),
  rightRows: z.array(z.array(StatusSegment).max(32)).max(4).optional(),
}))

export const SessionActivity = lazySchema(() => z.strictObject({
  gseq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  type: z.literal("session.activity"),
  lifecycle: SessionLifecycle.optional(),
  sessionId: SessionId,
  directory: z.string().max(4096),
  title: z.string().max(200),
  state: ForegroundState,
  updatedAt: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative().optional(),
  /** Live detail of a running turn, present only while it lasts: epoch ms it started, the tool in flight, and the request it waits on. */
  since: z.number().int().nonnegative().optional(),
  tool: z.string().max(200).optional(),
  pending: z.string().max(200).optional(),
  /** True while the session is paused (`session.control`); omitted otherwise. */
  paused: z.boolean().optional(),
  /** Null explicitly clears the archive timestamp; omitted by older daemons. */
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  /** The session's unsent draft, so other terminals can label an untitled session; null says it was cleared; omitted by older daemons and for peers. */
  draft: SessionDraft.nullable().optional(),
}))

/** A loop changed (created, woke, finished a run, paused…); carries the whole bounded record. */
export const LoopChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("loop.changed"),
  loop: Loop,
  deleted: z.boolean().optional(),
}))

/** A workflow changed (started, a task moved, verified, paused…); carries the bounded summary, coalesced per run. */
export const WorkflowChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("workflow.changed"),
  workflow: WorkflowSummary,
  deleted: z.boolean().optional(),
}))

export const DreamChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("dream.changed"),
  run: DreamRun,
}))

/**
 * Today's usage across every session, pushed (throttled to 1/s) when usage is recorded and once on connect.
 * Ephemeral like session.activity: `gseq` is always 0. `costMicros` is absent while nothing has a known price.
 */
export const UsageToday = lazySchema(() => z.strictObject({
  gseq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  type: z.literal("usage.today"),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  costMicros: z.number().int().positive().optional(),
}))

/** MCP status changed; clients refresh mcp.status for this directory. */
export const McpChanged = lazySchema(() => z.strictObject({
  ...globalBase,
  type: z.literal("mcp.changed"),
  directory: z.string().min(1).max(4096),
  server: z.string().min(1).max(200),
}))

export const AsideChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("aside.changed"), gseq: z.number().int().nonnegative(), sessionId: SessionId, thread: AsideThread }))
export const SidebarChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("sidebar.changed"), directory: z.string().optional(), widgets: SidebarSpec }))

export const TuiChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("tui.changed"), profile: TuiProfilePatch }))
export const ExtensionsChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("extensions.changed"), revision: z.number().int().nonnegative() }))
/** A short note from an extension for the terminal's toast line: never stored, never part of the model's context or the transcript; local terminals only. */
export const ExtensionFeedback = lazySchema(() => z.strictObject({ ...globalBase, gseq: z.number().int().nonnegative(), type: z.literal("extension.feedback"), extension: z.string().max(64), text: z.string().min(1).max(300), level: z.enum(["info", "success", "warning", "error"]) }))
/**
 * The code graph of one project directory, for a footer: counts when the index changed, never per request. Sent on the wire only (gseq 0, not stored), and again to a client that connects.
 * `none`: a first build ended without a graph, or a skip no longer holds. `skipped`: the folder is not indexed, and `reason` says why in a few words (`large folder`).
 */
export const CodegraphStatus = lazySchema(() => z.strictObject({
  ...globalBase,
  gseq: z.number().int().nonnegative(),
  type: z.literal("codegraph.status"),
  directory: z.string().max(4096),
  state: z.enum(["indexing", "indexed", "none", "skipped"]),
  files: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  partial: z.boolean(),
  reason: z.string().max(40).optional(),
}))
export const ReviewChanged =lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("review.changed"), gseq: z.number().int().nonnegative(), sessionId: SessionId, review: ReviewSnapshot, reload: z.boolean().optional() }))
export const AgentCommandsChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("agent-commands.changed"), sourceSessionId: SessionId, targetSessionId: SessionId }))
export const SessionBackgroundChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("session.background.changed"), sessionId: SessionId }))
export const ChildTaskChanged = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("task.changed"), sessionId: SessionId, parentId: SessionId }))
export const ServerLifecycle = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("server.lifecycle"), change: z.enum(["disposed", "upgraded"]), directory: z.string().optional(), version: z.string().optional() }))
export const ReleaseAvailable = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("release.available"), version: z.string().max(100), channel: z.enum(["stable", "beta", "dev", "nightly"]), installed: z.boolean() }))
export const MflowWaiting = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("mflow.waiting"), sessionId: SessionId, file: z.string().max(4096).nullable(), deadlineAt: z.number().int().nonnegative().nullable() }))
export const TuiControlRequest = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("tui.control.request"), directory: z.string().max(4096), ...TuiRequest.shape }))
/** An on-device dictation of this terminal, live: the microphone level (0..1) and the transcript so far. Sent only to the terminal that records. */
export const VoiceLive = lazySchema(() => z.strictObject({ ...globalBase, type: z.literal("voice.live"), level: z.number().min(0).max(1).optional(), text: z.string().max(20_000).optional() }))
export const GlobalEvent = lazySchema(() => z.discriminatedUnion("type", [VoiceLive, ExtensionsChanged, ExtensionFeedback, CodegraphStatus, TuiChanged, AsideChanged, SidebarChanged, UsageToday, JobStateChanged, QuotaSnapshot, MemoryChanged, SettingsChanged, SessionActivity, LoopChanged, WorkflowChanged, DreamChanged, StatusLineChanged, McpChanged, ReviewChanged, AgentCommandsChanged, SessionBackgroundChanged, ChildTaskChanged, ServerLifecycle, ReleaseAvailable, MflowWaiting, TuiControlRequest]))
export type GlobalEvent = z.infer<typeof GlobalEvent>

export const ErrorPayload = lazySchema(() => z.strictObject({
  code: ErrorCode,
  message: z.string().max(4000),
  supported: z.array(z.number().int()).optional(),
}))
export type ErrorPayload = z.infer<typeof ErrorPayload>
