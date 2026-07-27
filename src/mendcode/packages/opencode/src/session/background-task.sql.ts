import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { MessageID, SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import { Timestamps } from "../storage/schema.sql"

export type BackgroundTaskState =
  | "queued"
  | "running"
  | "needs_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export type BackgroundTaskControlIntent = "none" | "pause_after_turn" | "cancel"

export type BackgroundTaskResultData = {
  summary?: string
  error?: string
  changedFiles: string[]
  truncated?: boolean
  transcriptSessionID: SessionID
}

export const BackgroundTaskTable = sqliteTable(
  "background_task",
  {
    task_id: text()
      .$type<SessionID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    origin_message_id: text().$type<MessageID>(),
    origin_call_id: text(),
    current_generation: integer().notNull(),
    title: text().notNull(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      providerID: string
      modelID: string
      variant?: string
    }>(),
    root_session_id: text().$type<SessionID>(),
    depth: integer().notNull().default(1),
    ...Timestamps,
    time_dismissed: integer(),
    time_expires: integer(),
  },
  (table) => [
    index("background_task_parent_idx").on(table.parent_session_id),
    index("background_task_root_idx").on(table.root_session_id),
    index("background_task_updated_idx").on(table.time_updated),
  ],
)

export const BackgroundTaskRunTable = sqliteTable(
  "background_task_run",
  {
    task_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => BackgroundTaskTable.task_id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    revision: integer().notNull(),
    state: text().$type<BackgroundTaskState>().notNull(),
    control_intent: text().$type<BackgroundTaskControlIntent>().notNull(),
    owner_runtime_id: text(),
    lease_expires_at: integer(),
    result: text({ mode: "json" }).$type<BackgroundTaskResultData>(),
    ...Timestamps,
    time_queued: integer().notNull(),
    time_started: integer(),
    time_finished: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.generation] }),
    index("background_task_run_state_idx").on(table.state),
    index("background_task_run_lease_idx").on(table.lease_expires_at),
  ],
)

export const BackgroundTaskEventTable = sqliteTable(
  "background_task_event",
  {
    id: text().primaryKey(),
    task_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => BackgroundTaskTable.task_id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    revision: integer().notNull(),
    type: text().$type<"needs_input" | "completed" | "failed" | "cancelled" | "interrupted">().notNull(),
    payload: text({ mode: "json" }).$type<{
      parentSessionID: SessionID
      title?: string
      summary?: string
      error?: string
      background?: boolean
    }>(),
    ...Timestamps,
    time_delivered: integer(),
    time_acknowledged: integer(),
  },
  (table) => [
    uniqueIndex("background_task_event_transition_idx").on(table.task_id, table.generation, table.revision, table.type),
    index("background_task_event_created_idx").on(table.time_created),
  ],
)
