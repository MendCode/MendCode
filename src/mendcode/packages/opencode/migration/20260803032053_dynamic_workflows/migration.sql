CREATE TABLE `workflow_definition` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `owner_session_id` text,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `source` text NOT NULL,
  `current_revision` integer,
  `saved` integer NOT NULL DEFAULT 0,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`owner_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_definition_project_idx` ON `workflow_definition` (`project_id`);
--> statement-breakpoint
CREATE INDEX `workflow_definition_owner_session_idx` ON `workflow_definition` (`owner_session_id`);
--> statement-breakpoint
CREATE INDEX `workflow_definition_saved_idx` ON `workflow_definition` (`saved`);
--> statement-breakpoint
CREATE TABLE `workflow_revision` (
  `id` text PRIMARY KEY NOT NULL,
  `definition_id` text NOT NULL,
  `revision` integer NOT NULL,
  `plan_hash` text NOT NULL,
  `plan` text NOT NULL,
  `immutable` integer NOT NULL DEFAULT 1,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`definition_id`) REFERENCES `workflow_definition`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_revision_definition_revision_idx` ON `workflow_revision` (`definition_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `workflow_revision_definition_idx` ON `workflow_revision` (`definition_id`);
--> statement-breakpoint
CREATE TABLE `workflow_run` (
  `id` text PRIMARY KEY NOT NULL,
  `definition_id` text NOT NULL,
  `revision_id` text NOT NULL,
  `revision` integer NOT NULL,
  `origin_session_id` text,
  `root_session_id` text,
  `loop_id` text,
  `loop_run_id` text,
  `state` text NOT NULL,
  `current_phase_id` text,
  `overlap_key` text,
  `lease_holder` text,
  `lease_acquired_at` integer,
  `lease_heartbeat_at` integer,
  `lease_expires_at` integer,
  `time_started` integer,
  `time_ended` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  FOREIGN KEY (`definition_id`) REFERENCES `workflow_definition`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`revision_id`) REFERENCES `workflow_revision`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`origin_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`loop_id`) REFERENCES `loop_workflow`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`loop_run_id`) REFERENCES `loop_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_run_definition_idx` ON `workflow_run` (`definition_id`);
--> statement-breakpoint
CREATE INDEX `workflow_run_revision_idx` ON `workflow_run` (`revision_id`);
--> statement-breakpoint
CREATE INDEX `workflow_run_state_idx` ON `workflow_run` (`state`);
--> statement-breakpoint
CREATE INDEX `workflow_run_origin_session_idx` ON `workflow_run` (`origin_session_id`);
--> statement-breakpoint
CREATE INDEX `workflow_run_loop_idx` ON `workflow_run` (`loop_id`);
--> statement-breakpoint
CREATE INDEX `workflow_run_lease_idx` ON `workflow_run` (`lease_expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_overlap_key_idx` ON `workflow_run` (`overlap_key`);
--> statement-breakpoint
CREATE TABLE `workflow_phase` (
  `run_id` text NOT NULL,
  `id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `state` text NOT NULL,
  `barrier` text NOT NULL,
  `task_count` integer NOT NULL DEFAULT 0,
  `queued_count` integer NOT NULL DEFAULT 0,
  `working_count` integer NOT NULL DEFAULT 0,
  `completed_count` integer NOT NULL DEFAULT 0,
  `failed_count` integer NOT NULL DEFAULT 0,
  `blocked_count` integer NOT NULL DEFAULT 0,
  `time_started` integer,
  `time_ended` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  PRIMARY KEY (`run_id`, `id`),
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_phase_run_ordinal_idx` ON `workflow_phase` (`run_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `workflow_phase_run_state_idx` ON `workflow_phase` (`run_id`,`state`);
--> statement-breakpoint
CREATE TABLE `workflow_task` (
  `run_id` text NOT NULL,
  `id` text NOT NULL,
  `phase_id` text NOT NULL,
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `prompt` text NOT NULL,
  `state` text NOT NULL,
  `depends_on` text NOT NULL,
  `inputs` text,
  `output` text NOT NULL,
  `model` text,
  `agent_profile` text,
  `allowed_tools` text,
  `workspace` text,
  `permissions` text,
  `retry` text,
  `budget` text,
  `map` text,
  `attempt` integer NOT NULL DEFAULT 0,
  `time_started` integer,
  `time_ended` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  PRIMARY KEY (`run_id`, `id`),
  FOREIGN KEY (`run_id`,`phase_id`) REFERENCES `workflow_phase`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_task_run_state_idx` ON `workflow_task` (`run_id`,`state`);
--> statement-breakpoint
CREATE INDEX `workflow_task_run_phase_idx` ON `workflow_task` (`run_id`,`phase_id`);
--> statement-breakpoint
CREATE TABLE `workflow_task_dependency` (
  `run_id` text NOT NULL,
  `task_id` text NOT NULL,
  `depends_on_task_id` text NOT NULL,
  PRIMARY KEY (`run_id`, `task_id`, `depends_on_task_id`),
  FOREIGN KEY (`run_id`,`task_id`) REFERENCES `workflow_task`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`,`depends_on_task_id`) REFERENCES `workflow_task`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_task_dependency_dependency_idx` ON `workflow_task_dependency` (`run_id`,`depends_on_task_id`);
--> statement-breakpoint
CREATE TABLE `workflow_task_attempt` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `task_id` text NOT NULL,
  `attempt` integer NOT NULL,
  `state` text NOT NULL,
  `background_task_id` text,
  `background_generation` integer,
  `failure_class` text,
  `reason` text,
  `time_started` integer,
  `time_completed` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  FOREIGN KEY (`run_id`,`task_id`) REFERENCES `workflow_task`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_task_attempt_task_attempt_idx` ON `workflow_task_attempt` (`run_id`,`task_id`,`attempt`);
--> statement-breakpoint
CREATE INDEX `workflow_task_attempt_run_idx` ON `workflow_task_attempt` (`run_id`);
--> statement-breakpoint
CREATE INDEX `workflow_task_attempt_background_idx` ON `workflow_task_attempt` (`background_task_id`,`background_generation`);
--> statement-breakpoint
CREATE TABLE `workflow_artifact` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `task_id` text,
  `attempt_id` text,
  `sequence` integer NOT NULL,
  `kind` text NOT NULL,
  `summary` text NOT NULL,
  `status` text NOT NULL,
  `schema_validated` integer NOT NULL,
  `output_refs` text NOT NULL,
  `evidence` text NOT NULL,
  `session_id` text,
  `attempt` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`,`task_id`) REFERENCES `workflow_task`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`attempt_id`) REFERENCES `workflow_task_attempt`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_artifact_run_sequence_idx` ON `workflow_artifact` (`run_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `workflow_artifact_task_idx` ON `workflow_artifact` (`run_id`,`task_id`);
--> statement-breakpoint
CREATE INDEX `workflow_artifact_attempt_idx` ON `workflow_artifact` (`attempt_id`);
--> statement-breakpoint
CREATE INDEX `workflow_artifact_kind_idx` ON `workflow_artifact` (`kind`);
--> statement-breakpoint
CREATE TABLE `workflow_event` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `level` text NOT NULL,
  `type` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_event_run_sequence_idx` ON `workflow_event` (`run_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `workflow_event_run_time_idx` ON `workflow_event` (`run_id`,`time_created`);
--> statement-breakpoint
CREATE INDEX `workflow_event_type_idx` ON `workflow_event` (`type`);
--> statement-breakpoint
CREATE TABLE `workflow_gate` (
  `run_id` text NOT NULL,
  `id` text NOT NULL,
  `phase_id` text,
  `task_id` text,
  `state` text NOT NULL,
  `required` integer NOT NULL,
  `actor` text,
  `reason` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  PRIMARY KEY (`run_id`, `id`),
  FOREIGN KEY (`run_id`,`phase_id`) REFERENCES `workflow_phase`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`,`task_id`) REFERENCES `workflow_task`(`run_id`,`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_gate_run_state_idx` ON `workflow_gate` (`run_id`,`state`);
--> statement-breakpoint
CREATE INDEX `workflow_gate_task_idx` ON `workflow_gate` (`run_id`,`task_id`);
