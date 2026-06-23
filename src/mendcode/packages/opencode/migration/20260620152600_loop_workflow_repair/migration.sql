CREATE TABLE IF NOT EXISTS `loop_run` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `root_session_id` text,
  `state` text NOT NULL,
  `trigger` text NOT NULL,
  `phase` text NOT NULL,
  `next_wakeup` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_started` integer,
  `time_ended` integer,
  `data` text NOT NULL,
  FOREIGN KEY (`workflow_id`) REFERENCES `loop_workflow`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_run_workflow_idx` ON `loop_run` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_run_state_idx` ON `loop_run` (`state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `loop_event` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `run_id` text,
  `session_id` text,
  `sequence` integer NOT NULL,
  `level` text NOT NULL,
  `type` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  FOREIGN KEY (`workflow_id`) REFERENCES `loop_workflow`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `loop_run`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_event_workflow_sequence_idx` ON `loop_event` (`workflow_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_event_workflow_time_idx` ON `loop_event` (`workflow_id`,`time_created`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `loop_thread` (
  `workflow_id` text NOT NULL,
  `run_id` text,
  `session_id` text NOT NULL,
  `role` text NOT NULL,
  `purpose` text NOT NULL,
  `state` text NOT NULL,
  `parent_session_id` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  PRIMARY KEY(`workflow_id`,`session_id`),
  FOREIGN KEY (`workflow_id`) REFERENCES `loop_workflow`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `loop_run`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_thread_workflow_idx` ON `loop_thread` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `loop_thread_session_idx` ON `loop_thread` (`session_id`);
