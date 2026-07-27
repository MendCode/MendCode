import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "../v2/session-message"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID, AgentCommandID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import { Timestamps } from "../storage/schema.sql"

type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">
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
  data: text({ mode: "json" })
    .notNull()
    .$type<
      | { type: "busy"; kind?: "mflow-wait" | "memory-extract" | "subagent-wait"; message?: string; until?: number }
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
    state: text().$type<"pending" | "accepted" | "running" | "completed" | "rejected" | "failed" | "expired">().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    data: text({ mode: "json" }).notNull().$type<{
      type: "request_summary" | "rename" | "tag" | "pause_after_turn" | "stop" | "send_message"
      payload: { instructions?: string } | { title: string } | { tags: readonly string[] } | { reason?: string } | { text: string }
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

type LoopArtifactMetadataValue = string | number | boolean | null | LoopArtifactMetadataValue[] | { [key: string]: LoopArtifactMetadataValue }
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
    owner_session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
    root_session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
    name: text().notNull(),
    objective: text().notNull(),
    state: text()
      .$type<"draft" | "active" | "sleeping" | "working" | "needs_input" | "blocked" | "paused" | "completed" | "failed" | "stopped">()
      .notNull(),
    source: text().$type<"converted-session" | "objective" | "template" | "manual">().notNull(),
    template_id: text(),
    phase: text().notNull(),
    next_wakeup: integer(),
    ...Timestamps,
    time_activated: integer(),
    time_archived: integer(),
    data: text({ mode: "json" })
      .notNull()
      .$type<{
        spec: LoopSpecData
        policy: LoopPolicyData
        metrics: LoopMetricsData
        memory?: LoopMemoryData
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
    root_session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
    state: text().$type<"queued" | "working" | "needs_input" | "blocked" | "completed" | "failed" | "stopped">().notNull(),
    trigger: text().$type<"manual" | "interval" | "daily" | "adaptive" | "external-signal" | "self-paced" | "resume" | "run-once">().notNull(),
    phase: text().notNull(),
    next_wakeup: integer(),
    ...Timestamps,
    time_started: integer(),
    time_ended: integer(),
    data: text({ mode: "json" })
      .notNull()
      .$type<{
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
          failureClass?: "none" | "transient" | "environment" | "policy" | "quality" | "budget" | "user_input" | "terminal"
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
          failureClass?: "none" | "transient" | "environment" | "policy" | "quality" | "budget" | "user_input" | "terminal"
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
      }>(),
  },
  (table) => [
    index("loop_run_workflow_idx").on(table.workflow_id),
    index("loop_run_state_idx").on(table.state),
  ],
)

export const LoopArtifactTable = sqliteTable(
  "loop_artifact",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => LoopWorkflowTable.id, { onDelete: "cascade" }),
    run_id: text().references(() => LoopRunTable.id, { onDelete: "set null" }),
    session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
    sequence: integer().notNull(),
    kind: text().$type<"checkpoint" | "judgment" | "gate" | "evidence" | "command-output" | "diff" | "signal" | "memory" | "cost" | "override">().notNull(),
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
    session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
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
    parent_session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
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

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})
