CREATE TABLE `loop_workflow` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `owner_session_id` text,
  `root_session_id` text,
  `name` text NOT NULL,
  `objective` text NOT NULL,
  `state` text NOT NULL,
  `source` text NOT NULL,
  `template_id` text,
  `phase` text NOT NULL,
  `next_wakeup` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_activated` integer,
  `time_archived` integer,
  `data` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`owner_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `loop_workflow_project_idx` ON `loop_workflow` (`project_id`);
--> statement-breakpoint
CREATE INDEX `loop_workflow_state_idx` ON `loop_workflow` (`state`);
--> statement-breakpoint
CREATE INDEX `loop_workflow_root_session_idx` ON `loop_workflow` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `loop_workflow_owner_session_idx` ON `loop_workflow` (`owner_session_id`);

--> statement-breakpoint
CREATE TABLE `loop_run` (
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
CREATE INDEX `loop_run_workflow_idx` ON `loop_run` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `loop_run_state_idx` ON `loop_run` (`state`);

--> statement-breakpoint
CREATE TABLE `loop_event` (
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
CREATE INDEX `loop_event_workflow_sequence_idx` ON `loop_event` (`workflow_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `loop_event_workflow_time_idx` ON `loop_event` (`workflow_id`,`time_created`);

--> statement-breakpoint
CREATE TABLE `loop_thread` (
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
CREATE INDEX `loop_thread_workflow_idx` ON `loop_thread` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `loop_thread_session_idx` ON `loop_thread` (`session_id`);
