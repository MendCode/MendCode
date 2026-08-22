import { sqliteTable, text, integer, index, primaryKey, uniqueIndex, foreignKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "../v2/session-message"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID, AgentCommandID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import type { CompletionProgress } from "./completion-contract"
import type {
  WorkflowArtifact,
  WorkflowArtifactID,
  WorkflowDefinition,
  WorkflowDefinitionID,
  WorkflowEventID,
  WorkflowGateID,
  WorkflowPhase,
  WorkflowPhaseID,
  WorkflowPhaseState,
  WorkflowRevisionID,
  WorkflowRun,
  WorkflowRunID,
  WorkflowRunState,
  WorkflowPermissionMode,
  WorkflowSessionPermissionMode,
  WorkflowTask,
  WorkflowTaskAttempt,
  WorkflowTaskAttemptID,
  WorkflowTaskID,
  WorkflowTaskKind,
  WorkflowTaskState,
  WorkflowWorkspaceLease,
} from "./workflow"
import type { WorkflowPlan } from "./workflow-plan"
import { Timestamps } from "../storage/schema.sql"

// Omit is not distributive over unions. Keep each discriminator branch intact
// so JSON columns can be narrowed by `type` / `role` after a database read.
type StoredPart<T> = T extends MessageV2.Part ? Omit<T, "id" | "sessionID" | "messageID"> : never
type StoredInfo<T> = T extends MessageV2.Info ? Omit<T, "id" | "sessionID"> : never
type PartData = StoredPart<MessageV2.Part>
type InfoData = StoredInfo<MessageV2.Info>
type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    index("session_message_session_idx").on(table.session_id),
    index("session_message_session_type_idx").on(table.session_id, table.type),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionStatusTable = sqliteTable("session_status", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<
    | {
        type: "busy"
        kind?: "mflow-wait" | "memory-extract" | "subagent-wait" | "compaction"
        message?: string
        until?: number
        startedAt?: number
      }
    | { type: "retry"; attempt: number; message: string; next: number }
  >(),
})

export const BackgroundSessionTable = sqliteTable("background_session", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<{
    state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
    summary?: string
    error?: string
    pinned?: boolean
    process?: {
      pid: number
      started: number
    }
    writer?: {
      clientID: string
      acquired: number
      expires: number
    }
  }>(),
})

export const AgentViewMetadataTable = sqliteTable("agent_view_metadata", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<{
    title?: string
    tags?: readonly string[]
    group?: string
    priority?: "low" | "normal" | "high" | "urgent"
    notes?: string
    pinned?: boolean
    archived?: boolean
  }>(),
})

export const AgentCommandTable = sqliteTable(
  "agent_command",
  {
    id: text().$type<AgentCommandID>().primaryKey(),
    source_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    target_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    state: text()
      .$type<"pending" | "accepted" | "running" | "completed" | "rejected" | "failed" | "expired">()
      .notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    data: text({ mode: "json" }).notNull().$type<{
      type: "request_summary" | "rename" | "tag" | "pause_after_turn" | "stop" | "send_message" | "peer_message"
      payload:
        | { instructions?: string }
        | { title: string }
        | { tags: readonly string[] }
        | { reason?: string }
        | { text: string }
        | { text: string; sourceTitle?: string }
      permissions: readonly string[]
      policy?: {
        decision: "safe_auto" | "same_workspace" | "approval_required" | "denied"
        permissions: readonly string[]
        reason: string
        ownership?: {
          targetWriter?: {
            clientID: string
            expires: number
          }
        }
      }
      error?: string
      result?: string
      expiresAt?: number
    }>(),
  },
  (table) => [
    index("agent_command_source_idx").on(table.source_session_id),
    index("agent_command_target_idx").on(table.target_session_id),
    index("agent_command_state_idx").on(table.state),
    index("agent_command_time_updated_idx").on(table.time_updated),
  ],
)

type LoopSpecData = {
  trigger?: {
    mode?: "manual" | "interval" | "daily" | "adaptive" | "external-signal" | "self-paced"
    intervalMs?: number
    dailyAt?: string
    timezone?: string
  }
  workflow?: {
    revisionID?: string
    definitionID?: string
    overlapKey?: string
  }
  budgetMode?: "fixed" | "max-goal" | "unbounded-monitor"
  completionCriteria?: string[]
  successChecks?: string[]
  validationChecks?: Array<{
    id: string
    command: string
    timeoutMs?: number
  }>
  strategy?: {
    targetTurns?: number
    reserveTurns?: number
    notifyOwnerOnComplete?: boolean
  }
  stopWhen?: string[]
  gates?: string[]
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  agent?: string
  evaluation?: {
    mode?: "legacy" | "deterministic" | "independent"
    confirmation?: "same-run" | "next-run"
    evaluatorAgent?: string
    requireIndependentForCompletion?: boolean
    allowWorkerSelfComplete?: boolean
    maxEvaluatorRetries?: number
  }
  rubric?: {
    name?: string
    passThreshold?: number
    criteria?: Array<{
      id: string
      description: string
      weight?: number
      minScore?: number
      evidenceRequired?: string[]
    }>
    mandatoryBlockers?: string[]
  }
  workspace?: {
    mode?: "read-only" | "in-place" | "per-loop-worktree" | "per-run-worktree"
  }
  costBudget?: {
    maxCost?: number
    maxTokens?: number
  }
  approvalPolicy?: {
    requireApprovalFor?: string[]
    approvedActions?: string[]
  }
  memory?: {
    enabled?: boolean
    sections?: Array<"tried" | "verified" | "open" | "decisions" | "rejected">
  }
  retention?: {
    maxArtifacts?: number
    maxAgeMs?: number
    maxBytes?: number
  }
}

type LoopPolicyData = {
  maxTurns?: number
  maxRuntimeMs?: number
  maxChildren?: number
  maxDepth?: number
  requireApprovalFor?: string[]
  approvedActions?: string[]
}

type LoopMetricsData = {
  turns?: number
  children?: number
  failures?: number
  noProgress?: number
  cost?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

type LoopSchedulerData = {
  lastWakeAttempt?: number
  nextWakeup?: number
  lastError?: string
  lastRunID?: string
  lastRunState?: "queued" | "working" | "needs_input" | "blocked" | "completed" | "failed" | "stopped"
  lastResult?: string
  degraded?: boolean
}

type LoopUsageData = {
  providerID?: string
  modelID?: string
  variant?: string
  cost?: number
  durationMs?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

type LoopMemoryData = {
  entries: Array<{
    section: "tried" | "verified" | "open" | "decisions" | "rejected"
    summary: string
    source?: string
    runID?: string
    time: {
      created: number
    }
  }>
}

type LoopWorkspaceLeaseData = {
  id: string
  workflowID: string
  runID?: string
  mode: "read-only" | "in-place" | "per-loop-worktree" | "per-run-worktree"
  path: string
  branch?: string
  state: "active" | "dirty" | "promoted" | "retained" | "cleaning" | "cleaned" | "failed"
  retention: "delete_on_success" | "retain_on_failure" | "manual"
  created: number
  error?: string
}

type LoopArtifactMetadataValue =
  | string
  | number
  | boolean
  | null
  | LoopArtifactMetadataValue[]
  | { [key: string]: LoopArtifactMetadataValue }
type LoopArtifactMetadata = { [key: string]: LoopArtifactMetadataValue }

export const LoopWorkflowTable = sqliteTable(
  "loop_workflow",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    owner_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    root_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    name: text().notNull(),
    objective: text().notNull(),
    state: text()
      .$type<
        | "draft"
        | "active"
        | "sleeping"
        | "working"
        | "needs_input"
        | "blocked"
        | "paused"
        | "completed"
        | "failed"
        | "stopped"
      >()
      .notNull(),
    source: text().$type<"converted-session" | "objective" | "template" | "manual">().notNull(),
    template_id: text(),
    phase: text().notNull(),
    next_wakeup: integer(),
    ...Timestamps,
    time_activated: integer(),
    time_archived: integer(),
    data: text({ mode: "json" }).notNull().$type<{
      spec: LoopSpecData
      policy: LoopPolicyData
      metrics: LoopMetricsData
      memory?: LoopMemoryData
      scheduler?: LoopSchedulerData
      evaluatorReason?: string
      failureClass?: "none" | "transient" | "environment" | "policy" | "quality" | "budget" | "user_input" | "terminal"
    }>(),
  },
  (table) => [
    index("loop_workflow_project_idx").on(table.project_id),
    index("loop_workflow_state_idx").on(table.state),
    index("loop_workflow_root_session_idx").on(table.root_session_id),
    index("loop_workflow_owner_session_idx").on(table.owner_session_id),
  ],
)

export const LoopRunTable = sqliteTable(
  "loop_run",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => LoopWorkflowTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    state: text()
      .$type<"queued" | "working" | "needs_input" | "blocked" | "completed" | "failed" | "stopped">()
      .notNull(),
    trigger: text()
      .$type<"manual" | "interval" | "daily" | "adaptive" | "external-signal" | "self-paced" | "resume" | "run-once">()
      .notNull(),
    phase: text().notNull(),
    next_wakeup: integer(),
    ...Timestamps,
    time_started: integer(),
    time_ended: integer(),
    data: text({ mode: "json" }).notNull().$type<{
      evaluatorReason?: string
      failureClass?: "none" | "transient" | "environment" | "policy" | "quality" | "budget" | "user_input" | "terminal"
      budget?: LoopMetricsData
      checkpoint?: {
        status?: "complete" | "continue" | "needs_input" | "blocked" | "stop"
        summary?: string
        evidence?: string[]
        nextAction?: string
        confidence?: string
      }
      judgment?: {
        status?: "pass" | "fail" | "uncertain" | "blocked" | "needs_human"
        summary?: string
        evidence?: string[]
        recommendedNextAction?: string
        confidence?: string
        failureClass?:
          | "none"
          | "transient"
          | "environment"
          | "policy"
          | "quality"
          | "budget"
          | "user_input"
          | "terminal"
      }
      rubricResult?: {
        status: "pass" | "fail" | "blocked"
        score: number
        threshold: number
        criteria: Array<{
          id: string
          score: number
          maxScore: number
          passed: boolean
          reason: string
          evidence: string[]
        }>
        blockers: Array<{
          id: string
          present: boolean
          reason: string
        }>
      }
      usage?: LoopUsageData
      gateResults?: Array<{
        id: string
        status: "pass" | "fail" | "skip" | "blocked" | "awaiting_approval"
        summary?: string
        failureClass?:
          | "none"
          | "transient"
          | "environment"
          | "policy"
          | "quality"
          | "budget"
          | "user_input"
          | "terminal"
        evidenceArtifacts?: string[]
        waiver?: {
          action: "waive" | "accept"
          actor: string
          reason: string
          time: number
        }
      }>
      lease?: {
        holder: string
        acquired: number
        heartbeat: number
        expires: number
      }
      retry?: {
        attempt: number
        backoffMs?: number
        nextWakeup?: number
      }
      workspaceLease?: LoopWorkspaceLeaseData
      completion?: CompletionProgress
    }>(),
  },
  (table) => [index("loop_run_workflow_idx").on(table.workflow_id), index("loop_run_state_idx").on(table.state)],
)

export const LoopArtifactTable = sqliteTable(
  "loop_artifact",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => LoopWorkflowTable.id, { onDelete: "cascade" }),
    run_id: text().references(() => LoopRunTable.id, { onDelete: "set null" }),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    sequence: integer().notNull(),
    kind: text()
      .$type<
        | "checkpoint"
        | "judgment"
        | "gate"
        | "evidence"
        | "command-output"
        | "diff"
        | "signal"
        | "memory"
        | "cost"
        | "override"
        | "completion-candidate"
        | "completion-audit"
      >()
      .notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<{
      source?: string
      status?: string
      contentType?: string
      text?: string
      evidence?: string[]
      metadata?: LoopArtifactMetadata
    }>(),
  },
  (table) => [
    index("loop_artifact_workflow_sequence_idx").on(table.workflow_id, table.sequence),
    index("loop_artifact_workflow_time_idx").on(table.workflow_id, table.time_created),
    index("loop_artifact_run_idx").on(table.run_id),
    index("loop_artifact_kind_idx").on(table.kind),
  ],
)

export const LoopEventTable = sqliteTable(
  "loop_event",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => LoopWorkflowTable.id, { onDelete: "cascade" }),
    run_id: text().references(() => LoopRunTable.id, { onDelete: "set null" }),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    sequence: integer().notNull(),
    level: text().$type<"debug" | "info" | "warning" | "error" | "decision">().notNull(),
    type: text()
      .$type<
        | "created"
        | "activated"
        | "started"
        | "completed"
        | "wake"
        | "signal"
        | "phase"
        | "session"
        | "child"
        | "gate"
        | "budget"
        | "action"
        | "monitor"
        | "paused"
        | "resumed"
        | "stopped"
        | "failed"
      >()
      .notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("loop_event_workflow_sequence_idx").on(table.workflow_id, table.sequence),
    index("loop_event_workflow_time_idx").on(table.workflow_id, table.time_created),
  ],
)

export const LoopThreadTable = sqliteTable(
  "loop_thread",
  {
    workflow_id: text()
      .notNull()
      .references(() => LoopWorkflowTable.id, { onDelete: "cascade" }),
    run_id: text().references(() => LoopRunTable.id, { onDelete: "set null" }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    role: text().$type<"root" | "implementer" | "reviewer" | "verifier" | "monitor" | "research">().notNull(),
    purpose: text().notNull(),
    state: text().$type<"queued" | "working" | "needs_input" | "completed" | "failed" | "stopped">().notNull(),
    parent_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    ...Timestamps,
    data: text({ mode: "json" }).$type<{
      budget?: LoopMetricsData
      worktree?: string
      branch?: string
    }>(),
  },
  (table) => [
    primaryKey({ columns: [table.workflow_id, table.session_id] }),
    index("loop_thread_workflow_idx").on(table.workflow_id),
    index("loop_thread_session_idx").on(table.session_id),
  ],
)

type WorkflowRunData = {
  counts?: {
    phases?: number
    tasks?: number
    completed?: number
    active?: number
    blocked?: number
  }
  blocker?: string
  nextAction?: string
  resultArtifactID?: WorkflowArtifactID
  workspaceLease?: WorkflowWorkspaceLease
  permissionMode?: WorkflowPermissionMode
  sessionPermissionMode?: WorkflowSessionPermissionMode
  completion?: CompletionProgress
  completionUsage?: {
    inputTokens?: number
    outputTokens?: number
    cost?: number
  }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cost?: number
  }
  budget?: {
    inputTokens?: number
    outputTokens?: number
    cost?: number
  }
}

type WorkflowEventLevel = "debug" | "info" | "warning" | "error" | "decision"
type WorkflowEventType =
  | "workflow.definition.created"
  | "workflow.plan.validated"
  | "workflow.run.created"
  | "workflow.run.updated"
  | "workflow.phase.updated"
  | "workflow.task.updated"
  | "workflow.artifact.created"
  | "workflow.gate.updated"
  | "workflow.input.required"
  | "workflow.run.completed"
  | "workflow.run.failed"
  | "workflow.run.stopped"

type WorkflowGateState = "pending" | "pass" | "fail" | "blocked" | "awaiting_approval" | "waived"

export const WorkflowDefinitionTable = sqliteTable(
  "workflow_definition",
  {
    id: text().$type<WorkflowDefinitionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    owner_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    name: text().notNull(),
    description: text().notNull(),
    source: text().$type<WorkflowDefinition["source"]>().notNull(),
    current_revision: integer(),
    saved: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [
    index("workflow_definition_project_idx").on(table.project_id),
    index("workflow_definition_owner_session_idx").on(table.owner_session_id),
    index("workflow_definition_saved_idx").on(table.saved),
  ],
)

export const WorkflowRevisionTable = sqliteTable(
  "workflow_revision",
  {
    id: text().$type<WorkflowRevisionID>().primaryKey(),
    definition_id: text()
      .$type<WorkflowDefinitionID>()
      .notNull()
      .references(() => WorkflowDefinitionTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    plan_hash: text().notNull(),
    plan: text({ mode: "json" }).notNull().$type<WorkflowPlan>(),
    immutable: integer({ mode: "boolean" })
      .notNull()
      .$default(() => true),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("workflow_revision_definition_revision_idx").on(table.definition_id, table.revision),
    index("workflow_revision_definition_idx").on(table.definition_id),
  ],
)

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().$type<WorkflowRunID>().primaryKey(),
    definition_id: text()
      .$type<WorkflowDefinitionID>()
      .notNull()
      .references(() => WorkflowDefinitionTable.id, { onDelete: "cascade" }),
    revision_id: text()
      .$type<WorkflowRevisionID>()
      .notNull()
      .references(() => WorkflowRevisionTable.id, { onDelete: "restrict" }),
    revision: integer().notNull(),
    origin_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    root_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    loop_id: text().references(() => LoopWorkflowTable.id, { onDelete: "set null" }),
    loop_run_id: text().references(() => LoopRunTable.id, { onDelete: "set null" }),
    state: text().$type<WorkflowRunState>().notNull(),
    current_phase_id: text().$type<WorkflowPhaseID>(),
    overlap_key: text(),
    lease_holder: text(),
    lease_acquired_at: integer(),
    lease_heartbeat_at: integer(),
    lease_expires_at: integer(),
    time_started: integer(),
    time_ended: integer(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<WorkflowRunData>(),
  },
  (table) => [
    index("workflow_run_definition_idx").on(table.definition_id),
    index("workflow_run_revision_idx").on(table.revision_id),
    index("workflow_run_state_idx").on(table.state),
    index("workflow_run_origin_session_idx").on(table.origin_session_id),
    index("workflow_run_loop_idx").on(table.loop_id),
    index("workflow_run_lease_idx").on(table.lease_expires_at),
    uniqueIndex("workflow_run_overlap_key_idx").on(table.overlap_key),
  ],
)

export const WorkflowPhaseTable = sqliteTable(
  "workflow_phase",
  {
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    id: text().$type<WorkflowPhaseID>().notNull(),
    ordinal: integer().notNull(),
    name: text().notNull(),
    description: text(),
    state: text().$type<WorkflowPhaseState>().notNull(),
    barrier: text({ mode: "json" }).notNull().$type<WorkflowPhase["barrier"]>(),
    task_count: integer().notNull().default(0),
    queued_count: integer().notNull().default(0),
    working_count: integer().notNull().default(0),
    completed_count: integer().notNull().default(0),
    failed_count: integer().notNull().default(0),
    blocked_count: integer().notNull().default(0),
    time_started: integer(),
    time_ended: integer(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.id] }),
    uniqueIndex("workflow_phase_run_ordinal_idx").on(table.run_id, table.ordinal),
    index("workflow_phase_run_state_idx").on(table.run_id, table.state),
  ],
)

export const WorkflowTaskTable = sqliteTable(
  "workflow_task",
  {
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    id: text().$type<WorkflowTaskID>().notNull(),
    phase_id: text().$type<WorkflowPhaseID>().notNull(),
    name: text().notNull(),
    kind: text().$type<WorkflowTaskKind>().notNull(),
    prompt: text().notNull(),
    state: text().$type<WorkflowTaskState>().notNull(),
    depends_on: text({ mode: "json" }).notNull().$type<WorkflowTask["dependsOn"]>(),
    inputs: text({ mode: "json" }).$type<WorkflowTask["inputs"]>(),
    output: text({ mode: "json" }).notNull().$type<WorkflowTask["output"]>(),
    model: text({ mode: "json" }).$type<WorkflowTask["model"]>(),
    agent_profile: text(),
    allowed_tools: text({ mode: "json" }).$type<WorkflowTask["allowedTools"]>(),
    workspace: text({ mode: "json" }).$type<WorkflowTask["workspace"]>(),
    permissions: text({ mode: "json" }).$type<WorkflowTask["permissions"]>(),
    retry: text({ mode: "json" }).$type<WorkflowTask["retry"]>(),
    budget: text({ mode: "json" }).$type<WorkflowTask["budget"]>(),
    map: text({ mode: "json" }).$type<WorkflowTask["map"]>(),
    attempt: integer().notNull().default(0),
    time_started: integer(),
    time_ended: integer(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.id] }),
    foreignKey({
      columns: [table.run_id, table.phase_id],
      foreignColumns: [WorkflowPhaseTable.run_id, WorkflowPhaseTable.id],
      name: "workflow_task_phase_fk",
    }),
    index("workflow_task_run_state_idx").on(table.run_id, table.state),
    index("workflow_task_run_phase_idx").on(table.run_id, table.phase_id),
  ],
)

export const WorkflowTaskDependencyTable = sqliteTable(
  "workflow_task_dependency",
  {
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    task_id: text().$type<WorkflowTaskID>().notNull(),
    depends_on_task_id: text().$type<WorkflowTaskID>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.task_id, table.depends_on_task_id] }),
    foreignKey({
      columns: [table.run_id, table.task_id],
      foreignColumns: [WorkflowTaskTable.run_id, WorkflowTaskTable.id],
      name: "workflow_task_dependency_task_fk",
    }),
    foreignKey({
      columns: [table.run_id, table.depends_on_task_id],
      foreignColumns: [WorkflowTaskTable.run_id, WorkflowTaskTable.id],
      name: "workflow_task_dependency_parent_fk",
    }),
    index("workflow_task_dependency_dependency_idx").on(table.run_id, table.depends_on_task_id),
  ],
)

export const WorkflowTaskAttemptTable = sqliteTable(
  "workflow_task_attempt",
  {
    id: text().$type<WorkflowTaskAttemptID>().primaryKey(),
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    task_id: text().$type<WorkflowTaskID>().notNull(),
    attempt: integer().notNull(),
    state: text().$type<WorkflowTaskState>().notNull(),
    background_task_id: text().$type<SessionID>(),
    background_generation: integer(),
    failure_class: text(),
    reason: text(),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<WorkflowTaskAttempt>(),
  },
  (table) => [
    foreignKey({
      columns: [table.run_id, table.task_id],
      foreignColumns: [WorkflowTaskTable.run_id, WorkflowTaskTable.id],
      name: "workflow_task_attempt_task_fk",
    }),
    uniqueIndex("workflow_task_attempt_task_attempt_idx").on(table.run_id, table.task_id, table.attempt),
    index("workflow_task_attempt_run_idx").on(table.run_id),
    index("workflow_task_attempt_background_idx").on(table.background_task_id, table.background_generation),
  ],
)

export const WorkflowArtifactTable = sqliteTable(
  "workflow_artifact",
  {
    id: text().$type<WorkflowArtifactID>().primaryKey(),
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    task_id: text().$type<WorkflowTaskID>(),
    attempt_id: text()
      .$type<WorkflowTaskAttemptID>()
      .references(() => WorkflowTaskAttemptTable.id, { onDelete: "set null" }),
    sequence: integer().notNull(),
    kind: text().notNull(),
    summary: text().notNull(),
    status: text().$type<WorkflowArtifact["status"]>().notNull(),
    schema_validated: integer({ mode: "boolean" }).notNull(),
    output_refs: text({ mode: "json" }).notNull().$type<WorkflowArtifact["outputRefs"]>(),
    evidence: text({ mode: "json" }).notNull().$type<WorkflowArtifact["evidence"]>(),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    attempt: integer(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    foreignKey({
      columns: [table.run_id, table.task_id],
      foreignColumns: [WorkflowTaskTable.run_id, WorkflowTaskTable.id],
      name: "workflow_artifact_task_fk",
    }),
    index("workflow_artifact_run_sequence_idx").on(table.run_id, table.sequence),
    index("workflow_artifact_task_idx").on(table.run_id, table.task_id),
    index("workflow_artifact_attempt_idx").on(table.attempt_id),
    index("workflow_artifact_kind_idx").on(table.kind),
  ],
)

export const WorkflowEventTable = sqliteTable(
  "workflow_event",
  {
    id: text().$type<WorkflowEventID>().primaryKey(),
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    level: text().$type<WorkflowEventLevel>().notNull(),
    type: text().$type<WorkflowEventType>().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("workflow_event_run_sequence_idx").on(table.run_id, table.sequence),
    index("workflow_event_run_time_idx").on(table.run_id, table.time_created),
    index("workflow_event_type_idx").on(table.type),
  ],
)

export const WorkflowGateTable = sqliteTable(
  "workflow_gate",
  {
    run_id: text()
      .$type<WorkflowRunID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    id: text().$type<WorkflowGateID>().notNull(),
    phase_id: text().$type<WorkflowPhaseID>(),
    task_id: text().$type<WorkflowTaskID>(),
    state: text().$type<WorkflowGateState>().notNull(),
    required: integer({ mode: "boolean" }).notNull(),
    actor: text(),
    reason: text(),
    ...Timestamps,
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.id] }),
    foreignKey({
      columns: [table.run_id, table.phase_id],
      foreignColumns: [WorkflowPhaseTable.run_id, WorkflowPhaseTable.id],
      name: "workflow_gate_phase_fk",
    }),
    foreignKey({
      columns: [table.run_id, table.task_id],
      foreignColumns: [WorkflowTaskTable.run_id, WorkflowTaskTable.id],
      name: "workflow_gate_task_fk",
    }),
    index("workflow_gate_run_state_idx").on(table.run_id, table.state),
    index("workflow_gate_task_idx").on(table.run_id, table.task_id),
  ],
)

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.StoreData>(),
})
