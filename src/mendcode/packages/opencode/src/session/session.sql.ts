import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "../v2/session-message"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID } from "./schema"
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
      | { type: "busy"; kind?: "mflow-wait" | "memory-extract"; message?: string; until?: number }
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

type LoopSpecData = {
  trigger?: {
    mode?: "manual" | "interval" | "adaptive" | "external-signal" | "self-paced"
    intervalMs?: number
  }
  budgetMode?: "fixed" | "max-goal" | "unbounded-monitor"
  completionCriteria?: string[]
  successChecks?: string[]
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
}

type LoopPolicyData = {
  maxTurns?: number
  maxRuntimeMs?: number
  maxChildren?: number
  maxDepth?: number
  requireApprovalFor?: string[]
}

type LoopMetricsData = {
  turns?: number
  children?: number
  failures?: number
  noProgress?: number
}

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
        evaluatorReason?: string
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
    trigger: text().$type<"manual" | "interval" | "adaptive" | "external-signal" | "self-paced" | "resume" | "run-once">().notNull(),
    phase: text().notNull(),
    next_wakeup: integer(),
    ...Timestamps,
    time_started: integer(),
    time_ended: integer(),
    data: text({ mode: "json" })
      .notNull()
      .$type<{
        evaluatorReason?: string
        budget?: LoopMetricsData
        checkpoint?: {
          status?: "complete" | "continue" | "needs_input" | "blocked" | "stop"
          summary?: string
          evidence?: string[]
          nextAction?: string
          confidence?: string
        }
      }>(),
  },
  (table) => [
    index("loop_run_workflow_idx").on(table.workflow_id),
    index("loop_run_state_idx").on(table.state),
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
