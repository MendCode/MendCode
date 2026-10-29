import { z } from "zod"
import { lazySchema } from "./lazy"

export {
  AGENT_MODES,
  DEFAULT_COMPACT_AT_TOKENS,
  DEFAULT_FOOTER,
  DREAM_DEFAULT_MAX_TOKENS,
  EVENTS_PAGE_DEFAULT,
  EVENTS_PAGE_MAX,
  EVOLUTION_MODES,
  EXPORT_MAX_CHARS,
  PROMPT_CACHE_MODES,
  type AgentMode,
  type PromptCacheMode,
  FOOTER_SEGMENTS,
  GOAL_INLINE_OBJECTIVE_CHARS,
  GOAL_MAX_OBJECTIVE_CHARS,
  GOAL_MAX_TOKEN_BUDGET,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
  MAX_DRAFT_CHARS,
  TEXT_PUT_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  MAX_PINNED_MEMORIES,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_IDS,
  MEMORY_POLICIES,
  memoryCategoryId,
  memoryPolicyFor,
  MODEL_ROLES,
  PROTOCOL_VERSION,
  REASONING_EFFORTS,
  TIMELINE_PREVIEW_CHARS,
  TURN_SNAPSHOT_MAX_BYTES,
  type EvolutionMode,
  type FooterSegment,
  type MemoryCategoryId,
  type MemoryPolicyValue,
  type ModelRole,
} from "./constants"

/** Foreground session state. Only the SessionActor emits changes to it. */
export const ForegroundState = z.enum([
  "idle",
  "queued",
  "generating",
  "tool",
  "waiting_approval",
  "compacting",
  "cancelling",
  "error",
])
export type ForegroundState = z.infer<typeof ForegroundState>

/**
 * How one message meets a running turn. `queue`: wait for the response to finish. `steer`: join the running turn after its
 * next tool result (native engine; other engines queue it). `restart`: interrupt the turn and send this next.
 * Unset: the session's queue policy decides.
 */
export const QueueDelivery = z.enum(["queue", "steer", "restart"])
export type QueueDelivery = z.infer<typeof QueueDelivery>
export const QueueEntryKind = z.enum(["message", "shell", "compact", "notice"])
export type QueueEntryKind = z.infer<typeof QueueEntryKind>

/** Background job state. Only the JobScheduler emits changes to it. */
export const JobState = z.enum(["scheduled", "running", "sleeping", "waiting_input", "paused", "done", "error"])
export type JobState = z.infer<typeof JobState>

export const JobType = z.enum(["dream", "loop", "workflow", "maintenance", "pr_review"])
export type JobType = z.infer<typeof JobType>

/** P0 (user input) is highest; background jobs P3–P6 yield to foreground work. */
export const Priority = z.enum(["P0", "P1", "P2", "P3", "P4", "P5", "P6"])
export type Priority = z.infer<typeof Priority>

export const ItemKind = z.enum([
  "user_message",
  "agent_message",
  "reasoning",
  "tool_call",
  "approval",
  "artifact",
  "compaction",
])
export type ItemKind = z.infer<typeof ItemKind>

export const ItemStatus = z.enum(["ok", "error", "cancelled", "interrupted", "unknown"])
export type ItemStatus = z.infer<typeof ItemStatus>

export const ResourceMode = z.enum(["low", "normal", "high"])
export type ResourceMode = z.infer<typeof ResourceMode>

/**
 * ask: edits and commands need approval · edits: file edits run, commands ask · full: nothing asks ·
 * plan: read-only; the agent proposes a plan for approval before anything changes ·
 * smart: low-risk actions (reads, edits inside the project, allow-listed commands) run, risky ones ask (docs/permissions.md).
 */
export const PermissionMode = z.enum(["ask", "edits", "full", "plan", "smart"])
export type PermissionMode = z.infer<typeof PermissionMode>

export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "protocol_version",
  "invalid_command",
  "unknown_session",
  "target_mismatch",
  "not_subscribed",
  "duplicate_command",
  "request_already_resolved",
  "busy",
  "not_git",
  "internal",
  "unsupported",
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Largest inline text payload in any event. Larger content must be stored as a blob (P11). */
export const MAX_INLINE_TEXT = 64 * 1024

/** Most queued messages that may join the first one in a single turn (`turn.started.joinedQueueIds`). */
export const MAX_JOINED_QUEUE_ENTRIES = 63

/** Most messages one session's queue holds (`queue.changed`); one more is refused before anything is stored. */
export const MAX_QUEUE_ENTRIES = 256

/** Largest JSON Schema a prompt may require its answer to match (serialized). */
export const MAX_FORMAT_SCHEMA_BYTES = 16 * 1024

/**
 * Per-prompt options of one turn; they only narrow or shape that turn and never persist beyond it.
 * `noReply`: record the message without calling the model. `excludeTools`: tool names (wildcards allowed) the turn may not use;
 * a prompt can remove tools, never add them. `format`: the answer must be a call of a `StructuredOutput` tool whose arguments
 * match `schema` (an object JSON Schema); `retries` more attempts after an invalid or missing answer (default 2).
 */
export const TurnOptions = lazySchema(() => z.strictObject({
  noReply: z.literal(true).optional(),
  excludeTools: z.array(z.string().min(1).max(100)).max(200).optional(),
  format: z.strictObject({
    schema: z.record(z.string(), z.unknown()).refine((schema) => schema.type === "object" && JSON.stringify(schema).length <= MAX_FORMAT_SCHEMA_BYTES, "schema must be an object JSON Schema within 16 KB"),
    retries: z.number().int().min(0).max(10).optional(),
  }).optional(),
}))
export type TurnOptions = z.infer<typeof TurnOptions>
