CREATE TABLE `background_task` (
  `task_id` text PRIMARY KEY NOT NULL,
  `parent_session_id` text NOT NULL,
  `origin_message_id` text,
  `origin_call_id` text,
  `current_generation` integer NOT NULL,
  `title` text NOT NULL,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_dismissed` integer,
  `time_expires` integer,
  FOREIGN KEY (`task_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `background_task_parent_idx` ON `background_task` (`parent_session_id`);
--> statement-breakpoint
CREATE INDEX `background_task_updated_idx` ON `background_task` (`time_updated`);
--> statement-breakpoint
CREATE TABLE `background_task_run` (
  `task_id` text NOT NULL,
  `generation` integer NOT NULL,
  `revision` integer NOT NULL,
  `state` text NOT NULL,
  `control_intent` text NOT NULL,
  `owner_runtime_id` text,
  `lease_expires_at` integer,
  `result` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_queued` integer NOT NULL,
  `time_started` integer,
  `time_finished` integer,
  PRIMARY KEY (`task_id`, `generation`),
  FOREIGN KEY (`task_id`) REFERENCES `background_task`(`task_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `background_task_run_state_idx` ON `background_task_run` (`state`);
--> statement-breakpoint
CREATE INDEX `background_task_run_lease_idx` ON `background_task_run` (`lease_expires_at`);
--> statement-breakpoint
CREATE TABLE `background_task_event` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `generation` integer NOT NULL,
  `revision` integer NOT NULL,
  `type` text NOT NULL,
  `payload` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_delivered` integer,
  `time_acknowledged` integer,
  FOREIGN KEY (`task_id`) REFERENCES `background_task`(`task_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_task_event_transition_idx` ON `background_task_event` (`task_id`,`generation`,`revision`,`type`);
--> statement-breakpoint
CREATE INDEX `background_task_event_created_idx` ON `background_task_event` (`time_created`);
